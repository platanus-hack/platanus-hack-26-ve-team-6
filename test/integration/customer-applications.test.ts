import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCustomerAssessmentRunner, createDockerScanners, createOsvAdapter, profiles, type ScannerAdapter } from '@gotchu/customer-assessment';
import { createScannerServer, signScannerBody } from '@gotchu/scanner';
import {
  customerApplicationSchema, customerAssessmentReportSchema, customerEnrollmentSchema,
  customerReportSummarySchema, customerSourceSummarySchema, customerTargetSchema, customerWorkspaceSchema,
  type CustomerAssessmentReport, type CustomerSourceSnapshot,
} from '../../packages/contracts/src/index.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';

const live = liveUrl && process.env.GOTCHU_TEST_REDIS_URL ? describe : describe.skip;
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const queuedSchema = z.object({ jobId: z.uuid() }).strict();
const jobSchema = z.object({ id: z.uuid(), applicationId: z.uuid(), kind: z.string(), state: z.enum(['queued', 'running', 'succeeded', 'failed']), reportId: z.uuid().nullable(), reasonCode: z.string().nullable() });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const sessionSchema = z.object({ user: z.object({ id: z.string() }).nullable(), localAuthEnabled: z.boolean(), registrationEnabled: z.boolean() });
// Fast protocol tests deliberately return unavailable coverage, never fabricated scanner findings.
const unavailableScanners: ScannerAdapter = {
  async run() { throw new Error('explicitly_unavailable_in_fast_protocol_test'); },
  async readiness() { return { ready: false, tools: [{ name: 'test-tools-unavailable', available: false }] }; },
};
const minimalSource = (revision = 'customer-change-1'): CustomerSourceSnapshot => ({ revision, files: [{ path: 'src/customer.ts', content: 'export const double = (n: number) => n * 2;\n' }] });

async function json<T>(response: Response, status: number, schema: z.ZodType<T>): Promise<T> {
  // Do not put response bodies/cookies/credentials in failed status assertions.
  expect(response.status).toBe(status);
  return schema.parse(await response.json());
}
async function rejected(response: Response, status: number, code: string) {
  expect((await json(response, status, errorSchema)).error.code).toBe(code);
}
async function eventually(check: () => Promise<boolean>, label: string, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a loopback port');
  return address.port;
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
async function unusedPort() { const server = createServer(); const port = await listen(server); await closeServer(server); return port; }

function cookieClient(origin: string) {
  const cookies = new Map<string, string>();
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      if (init.method && init.method !== 'GET') headers.set('origin', origin);
      const response = await fetch(`${origin}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';')[0] ?? '';
        const equals = pair.indexOf('=');
        if (equals > 0) {
          const name = pair.slice(0, equals); const value = pair.slice(equals + 1);
          if (!value || /max-age=0/i.test(line)) cookies.delete(name); else cookies.set(name, value);
        }
      }
      return response;
    },
    async api(path: string, method = 'GET', body?: unknown, key?: string) {
      return this.request(`/api/customer${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    hasSession() { return [...cookies.keys()].some(name => name.startsWith('authjs.session-token')); },
  };
}

// A minimal authoritative UDP fixture: only TXT/IN questions for the exact enrolled name.
// No resolver or network fallback exists, and records start empty.
async function dnsFixture() {
  const socket = createSocket('udp4');
  const records = new Map<string, string>(); const questions: string[] = []; const failures: Error[] = [];
  socket.on('error', error => failures.push(error));
  socket.on('message', (packet, peer) => {
    if (packet.length < 17 || packet.readUInt16BE(4) !== 1) return;
    let offset = 12; const labels: string[] = [];
    while (offset < packet.length && packet[offset] !== 0) {
      const length = packet[offset];
      if (!length || length > 63 || offset + length + 1 >= packet.length) return;
      labels.push(packet.subarray(offset + 1, offset + 1 + length).toString('ascii'));
      offset += length + 1;
    }
    offset++;
    if (offset + 4 > packet.length) return;
    const name = labels.join('.'); questions.push(name);
    const txt = packet.readUInt16BE(offset) === 16 && packet.readUInt16BE(offset + 2) === 1 && name === '_gotchu.customer.org' ? records.get(name) : undefined;
    const header = Buffer.alloc(12);
    packet.copy(header, 0, 0, 2); header.writeUInt16BE(0x8500, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(txt ? 1 : 0, 6);
    const answer = Buffer.alloc(txt ? 13 + Buffer.byteLength(txt) : 0);
    if (txt) {
      answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(16, 2); answer.writeUInt16BE(1, 4);
      answer.writeUInt16BE(Buffer.byteLength(txt) + 1, 10); answer[12] = Buffer.byteLength(txt); answer.write(txt, 13);
    }
    socket.send(Buffer.concat([header, packet.subarray(12, offset + 4), answer]), peer.port, peer.address, error => { if (error) failures.push(error); });
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { records, questions, failures, nameserver: `127.0.0.1:${socket.address().port}`, close: () => new Promise<void>(resolve => socket.close(resolve)) };
}

live('customer applications through built Nitro, coordinator main, HMAC scanner and real data services', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let directory: string; let origin: string; let scannerOrigin: string; let secret: Buffer;
  let dns: Awaited<ReturnType<typeof dnsFixture>>;
  let owner: ReturnType<typeof cookieClient>; let stranger: ReturnType<typeof cookieClient>;
  let coordinator: ChildProcess;
  let engine = createCustomerAssessmentRunner({ scanners: unavailableScanners });
  let realEngine: ReturnType<typeof createCustomerAssessmentRunner>;
  let corrected = false;
  const httpsRequests: Array<{ method: string | undefined; path: string | undefined; hostname: string | undefined; hasCredentials: boolean }> = [];
  const lookups: string[] = [];
  const children: Array<{ child: ChildProcess; name: string; port: number }> = [];
  const cleanup: Array<() => Promise<void>> = [];

  function childProcess(name: string, entry: string, port: number, env: NodeJS.ProcessEnv) {
    // Deliberate allowlist: children never inherit migration credentials, provider secrets or test DB URLs.
    const child = spawn(process.execPath, [entry], { cwd: root, env: { PATH: process.env.PATH, TZ: 'UTC', ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push({ child, name, port });
    const events: string[] = [];
    // Consume bounded diagnostics without exposing arbitrary stdout, connection strings or auth cookies.
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => {
      for (const match of chunk.toString('utf8', 0, Math.min(chunk.length, 8192)).matchAll(/"event":"([a-z_]+)"/g)) {
        events.push(present(match[1])); if (events.length > 10) events.shift();
      }
    });
    let processError = false; child.on('error', () => { processError = true; });
    cleanup.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGCONT'); child.kill('SIGTERM');
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); })]); }
      finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) await exited;
    });
    return {
      child,
      async ready(path: string) {
        await eventually(async () => {
          if (processError || child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} PID ${child.pid ?? 'unstarted'} on port ${port} exited; events: ${events.join(',')}`);
          try { return (await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) })).status === 200; }
          catch { return false; }
        }, `${name} readiness`, 30_000);
      },
    };
  }

  async function registerAndSignIn() {
    const client = cookieClient(origin); const email = `http-${randomUUID()}@example.com`; const password = randomBytes(24).toString('base64url');
    const account = await json(await client.api('/register', 'POST', { email, password }), 201, z.object({ id: z.uuid() }));
    const csrf = await json(await client.request('/api/auth/csrf'), 200, z.object({ csrfToken: z.string().min(1) }));
    const callback = (csrfToken: string) => client.request('/api/auth/callback/credentials', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' }, body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${origin}/dashboard` }) });
    const denied = await json(await callback('invalid-csrf-token'), 200, z.object({ url: z.string() }));
    expect(denied.url).toContain('MissingCSRF'); expect(client.hasSession()).toBe(false);
    await json(await callback(csrf.csrfToken), 200, z.object({ url: z.string() }));
    expect(client.hasSession()).toBe(true);
    expect(await json(await client.api('/session'), 200, sessionSchema)).toMatchObject({ user: { id: `credentials:${account.id}` }, localAuthEnabled: true, registrationEnabled: true });
    return client;
  }

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    directory = await mkdtemp(join(tmpdir(), 'gotchu-customer-http-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    secret = randomBytes(32); const secretFile = join(directory, 'scanner.secret');
    await writeFile(secretFile, secret, { mode: 0o600, flag: 'wx' });
    dns = await dnsFixture(); cleanup.push(dns.close);
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'], { timeout: 10_000, maxBuffer: 65_536 });
    const cert = await readFile(join(directory, 'cert.pem'), 'utf8'); const key = await readFile(join(directory, 'key.pem'), 'utf8');
    const tls = createTlsServer({ cert, key }, (request, response) => {
      httpsRequests.push({ method: request.method, path: request.url, hostname: request.headers.host, hasCredentials: Boolean(request.headers.cookie || request.headers.authorization) });
      response.writeHead(200, corrected ? { 'content-security-policy': "default-src 'none'", 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff' } : { server: 'Untrusted-Fixture/1.0' }).end('fixture root; not customer data');
    });
    const tlsPort = await listen(tls); cleanup.push(() => closeServer(tls));
    const https = { lookup: async (hostname: string) => { if (hostname !== 'customer.org') throw new Error('unexpected_fixture_hostname'); lookups.push(hostname); return [{ address: '127.0.0.1', family: 4 }]; }, testFixture: { hostname: 'customer.org', port: tlsPort, ca: cert } };
    engine = createCustomerAssessmentRunner({ scanners: unavailableScanners, https });
    realEngine = createCustomerAssessmentRunner({ scanners: createDockerScanners(), advisory: createOsvAdapter(), https });
    const scanner = createScannerServer({ secret, runner: { run: input => engine.run(input), readiness: () => engine.readiness() } });
    scannerOrigin = `http://127.0.0.1:${await listen(scanner)}`; cleanup.push(() => closeServer(scanner));
    const webPort = await unusedPort(); origin = `http://127.0.0.1:${webPort}`;
    const web = childProcess('Nitro web', 'apps/web/.output/server/index.mjs', webPort, {
      NODE_ENV: 'development', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PUBLIC_APP_URL: origin,
      GOTCHU_API_DATABASE_URL: f.runtimeConnectionString('gotchu_api'), GOTCHU_INGEST_DATABASE_URL: f.runtimeConnectionString('gotchu_ingest'),
      AUTH_SECRET: randomBytes(48).toString('base64url'), GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true', GOTCHU_DNS_SERVERS_JSON: JSON.stringify([dns.nameserver]),
    });
    const worker = childProcess('coordinator', 'apps/coordinator/dist/main.js', await unusedPort(), {
      NODE_ENV: 'test', GOTCHU_CUSTOMER_DISCOVERY: 'true', GOTCHU_COORDINATOR_HOST: '127.0.0.1',
      GOTCHU_COORDINATOR_DATABASE_URL: f.runtimeConnectionString('gotchu_coordinator'), GOTCHU_REDIS_URL: present(process.env.GOTCHU_TEST_REDIS_URL),
      GOTCHU_SCANNER_ORIGIN: scannerOrigin, GOTCHU_SCANNER_SECRET_FILE: secretFile,
      // No GOTCHU_ORGANIZATION_IDS: all workspaces below are created after coordinator startup.
    });
    coordinator = worker.child;
    await Promise.all([web.ready('/api/ready'), worker.ready('/health/ready')]);
    const health = await fetch(`http://127.0.0.1:${present(children.find(child => child.name === 'coordinator')).port}/health/ready`);
    expect(await health.json()).toMatchObject({ assignedOrganizations: 0, customerDiscovery: true, customerScannerConfigured: true });
    owner = await registerAndSignIn(); stranger = await registerAndSignIn();
  }, 90_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    try { await f?.close(); } catch (error) { errors.push(error); }
    expect(dns?.failures ?? []).toEqual([]);
    expect(errors).toEqual([]);
  }, 30_000);

  async function application(label: string, client = owner) {
    const workspace = await json(await client.api('/workspaces', 'POST', { name: `${label}-${randomUUID()}` }), 201, customerWorkspaceSchema);
    const base = `/workspaces/${workspace.id}`;
    const app = await json(await client.api(`${base}/applications`, 'POST', { name: label }), 201, customerApplicationSchema);
    return { workspace, app, base, path: `${base}/applications/${app.applicationId}` };
  }
  async function upload(path: string, snapshot = minimalSource(), client = owner) {
    return json(await client.api(`${path}/sources`, 'POST', { snapshot, authorized: true }), 201, customerSourceSummarySchema);
  }
  async function target(path: string) {
    dns.records.clear();
    const enrollment = await json(await owner.api(`${path}/targets`, 'POST', { origin: 'https://customer.org', authorized: true }), 201, customerEnrollmentSchema);
    const verify = `${path}/targets/${enrollment.target.id}/verify`;
    await rejected(await owner.api(verify, 'POST', {}), 409, 'dns_verification_failed');
    expect(enrollment.challenge.name).toBe('_gotchu.customer.org');
    dns.records.set(enrollment.challenge.name, enrollment.challenge.value);
    const verified = await json(await owner.api(verify, 'POST', {}), 200, customerTargetSchema);
    expect(verified.status).toBe('verified'); expect(verified.verifiedAt).not.toBeNull();
    expect(dns.questions.slice(-2)).toEqual(['_gotchu.customer.org', '_gotchu.customer.org']);
    return verified;
  }
  async function queue(path: string, body: { mode: 'internal' | 'external' | 'both'; sourceSnapshotId: string | null; targetId: string | null }, key = randomUUID()) {
    return json(await owner.api(`${path}/assessments`, 'POST', body, key), 202, queuedSchema);
  }
  async function finished(base: string, path: string, jobId: string, state: 'succeeded' | 'failed' = 'succeeded') {
    let result: z.infer<typeof jobSchema> | undefined;
    await eventually(async () => {
      result = await json(await owner.api(`${base}/jobs/${jobId}`), 200, jobSchema);
      if (result.state !== 'succeeded' && result.state !== 'failed') return false;
      expect(result.state, `job reason: ${result.reasonCode ?? 'none'}`).toBe(state); return true;
    }, `customer job ${jobId}`, 80_000);
    const job = present(result);
    if (state === 'failed') { expect(job.reportId).toBeNull(); return null; }
    expect(job.reasonCode).toBeNull();
    const report = await json(await owner.api(`${path}/reports/${present(job.reportId)}`), 200, customerAssessmentReportSchema);
    expect(report.jobId).toBe(jobId);
    const saved = await f.admin.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND job_id=$2', [report.organizationId, jobId]);
    expect(saved.rows).toHaveLength(1); expect(customerAssessmentReportSchema.parse(saved.rows[0]?.body)).toEqual(report);
    const delivered = await f.admin.query('SELECT id FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2 AND delivered_at IS NOT NULL', [report.organizationId, jobId]);
    expect(delivered.rowCount).toBe(1);
    return report;
  }

  it('requires a real session and same-origin writes; authenticates and rejects replay at the scanner HTTP boundary', async () => {
    const anonymous = cookieClient(origin);
    await rejected(await anonymous.api('/workspaces'), 401, 'unauthenticated');
    const denied = await fetch(`${origin}/api/customer/register`, { method: 'POST', headers: { origin: 'https://other.org', 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    await rejected(denied, 403, 'origin_rejected');
    const body = Buffer.from('{}'); const timestamp = String(Math.floor(Date.now() / 1000));
    const send = (signature: string) => fetch(`${scannerOrigin}/v1/assessments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gotchu-timestamp': timestamp, 'x-gotchu-signature': signature }, body, signal: AbortSignal.timeout(5000) });
    expect((await send('0'.repeat(64))).status).toBe(401);
    const signature = signScannerBody(secret, timestamp, body);
    expect((await send(signature)).status).toBe(400); // Authenticated but invalid contract; no runner execution.
    expect((await send(signature)).status).toBe(409);
    expect((await fetch(`${scannerOrigin}/readyz`, { signal: AbortSignal.timeout(5000) })).status).toBe(503);
  });

  it('discovers a self-service workspace, persists a report, and enforces identity, workspace and application scope', async () => {
    const first = await application('HTTP customer'); const other = await application('Other workspace', stranger);
    const sibling = await json(await owner.api(`${first.base}/applications`, 'POST', { name: 'Sibling' }), 201, customerApplicationSchema);
    const siblingPath = `${first.base}/applications/${sibling.applicationId}`;
    const source = await upload(first.path); expect(await upload(first.path)).toEqual(source);
    const source2 = await upload(first.path, minimalSource('customer-change-2'));
    const body = { mode: 'internal', sourceSnapshotId: source.id, targetId: null } as const;
    const key = randomUUID(); const queued = await queue(first.path, body, key);
    expect(await queue(first.path, body, key)).toEqual(queued);
    await rejected(await owner.api(`${first.path}/assessments`, 'POST', { ...body, sourceSnapshotId: source2.id }, key), 409, 'idempotency_conflict');
    const report = present(await finished(first.base, first.path, queued.jobId));
    expect(report).toMatchObject({ organizationId: first.workspace.id, applicationId: first.app.applicationId, external: null, responseMode: 'observation', actionsPerformed: [] });
    expect(report.internal?.findings).toEqual([]);
    for (const capability of ['semgrep', 'gitleaks', 'trivy']) expect(report.internal?.coverage).toContainEqual(expect.objectContaining({ capability, state: 'unavailable' }));
    const summaries = await json(await owner.api(`${first.path}/reports`), 200, z.array(customerReportSummarySchema));
    expect(summaries.map(item => item.id)).toContain(report.id);
    for (const path of [`${first.base}/applications`, `${first.path}/sources`, `${first.path}/targets`, `${first.path}/reports/${report.id}`, `${first.base}/jobs/${queued.jobId}`]) await rejected(await stranger.api(path), 403, 'forbidden');
    await rejected(await stranger.api(`${first.path}/sources/${source.id}/delete`, 'POST', {}), 403, 'forbidden');
    await rejected(await owner.api(`${other.base}/applications/${first.app.applicationId}/reports/${report.id}`), 403, 'forbidden');
    await rejected(await owner.api(`${siblingPath}/reports/${report.id}`), 404, 'not_found');
    await rejected(await owner.api(`${siblingPath}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    await rejected(await stranger.api(`${other.path}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    await rejected(await owner.api(`${siblingPath}/sources/${source.id}/delete`, 'POST', {}), 404, 'not_found');
    const workspaces = await json(await stranger.api('/workspaces'), 200, z.array(customerWorkspaceSchema));
    expect(workspaces.some(item => item.id === first.workspace.id)).toBe(false);
    await json(await owner.api(`${first.path}/sources/${source.id}/delete`, 'POST', {}), 200, z.object({ deleted: z.literal(true) }));
    await rejected(await owner.api(`${first.path}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    expect((await json(await owner.api(`${first.path}/sources`), 200, z.array(customerSourceSummarySchema))).map(item => item.id)).not.toContain(source.id);
    expect((await json(await owner.api(`${first.path}/reports/${report.id}`), 200, customerAssessmentReportSchema)).id).toBe(report.id);
  }, 30_000);

  it('uses real DNS verification, revokes target authorization, and restores archived applications', async () => {
    const app = await application('Authorization lifecycle');
    const verified = await target(app.path);
    const body = { mode: 'external', sourceSnapshotId: null, targetId: verified.id } as const;
    const key = randomUUID(); const queued = await queue(app.path, body, key);
    const report = present(await finished(app.base, app.path, queued.jobId));
    expect(report.internal).toBeNull(); expect(report.external?.coverage).toContainEqual(expect.objectContaining({ capability: 'tls_https', state: 'inspected' }));
    await rejected(await stranger.api(`${app.path}/targets/${verified.id}/revoke`, 'POST', {}), 403, 'forbidden');
    const revoked = await json(await owner.api(`${app.path}/targets/${verified.id}/revoke`, 'POST', {}), 200, customerTargetSchema);
    expect(revoked).toMatchObject({ status: 'revoked', version: verified.version + 1, verifiedAt: null });
    await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, randomUUID()), 409, 'target_not_verified');
    await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, key), 409, 'idempotency_conflict');
    const renewed = await target(app.path); expect(renewed.version).toBeGreaterThan(revoked.version);
    await json(await owner.api(app.path, 'PATCH', { archived: true }), 200, customerApplicationSchema);
    await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, randomUUID()), 409, 'application_archived');
    await rejected(await owner.api(`${app.path}/sources`, 'POST', { snapshot: minimalSource(), authorized: true }), 409, 'application_archived');
    await json(await owner.api(app.path, 'PATCH', { archived: false }), 200, customerApplicationSchema);
    const restored = await queue(app.path, body); await finished(app.base, app.path, restored.jobId);
  }, 30_000);

  it('bounds source uploads and unfinished work, rejects deletion in use, and rechecks authorization when queued work runs', async () => {
    const app = await application('Admission limits'); const sources = [];
    for (let index = 0; index < 10; index++) sources.push(await upload(app.path, minimalSource(`snapshot-${index}`)));
    await rejected(await owner.api(`${app.path}/sources`, 'POST', { snapshot: minimalSource('eleventh'), authorized: true }), 429, 'source_limit');
    const source = present(sources[0]); expect(await upload(app.path, minimalSource('snapshot-0'))).toEqual(source);
    await rejected(await owner.api(`${app.path}/sources`, 'POST', { snapshot: { revision: 'bad-path', files: [{ path: '../escape.ts', content: '' }] }, authorized: true }), 400, 'invalid_input');
    await rejected(await owner.api(`${app.path}/sources`, 'POST', { snapshot: { revision: 'oversized', files: [{ path: 'large.ts', content: 'x'.repeat(1_048_577) }] }, authorized: true }), 400, 'invalid_input');
    const verified = await target(app.path);
    const body = { mode: 'both', sourceSnapshotId: source.id, targetId: verified.id } as const;
    const requestsBefore = httpsRequests.length;
    expect(coordinator.kill('SIGSTOP')).toBe(true);
    const jobs: string[] = [];
    try {
      for (let index = 0; index < 3; index++) jobs.push((await queue(app.path, body)).jobId);
      await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, randomUUID()), 429, 'assessment_capacity_exceeded');
      await rejected(await owner.api(`${app.path}/sources/${source.id}/delete`, 'POST', {}), 409, 'source_in_use');
      await json(await owner.api(`${app.path}/targets/${verified.id}/revoke`, 'POST', {}), 200, customerTargetSchema);
    } finally { coordinator.kill('SIGCONT'); }
    for (const job of jobs) await finished(app.base, app.path, job, 'failed');
    expect(httpsRequests).toHaveLength(requestsBefore);
    await json(await owner.api(`${app.path}/sources/${source.id}/delete`, 'POST', {}), 200, z.object({ deleted: z.literal(true) }));
    expect((await upload(app.path, minimalSource('replacement-after-delete'))).id).not.toBe(source.id);
    expect(await json(await owner.api(`${app.path}/reports`), 200, z.array(customerReportSummarySchema))).toEqual([]);
  }, 45_000);

  it.skipIf(process.env.GOTCHU_TEST_SCANNERS !== '1')('persists six real mode/revision reports using cached Docker profiles, actual OSV and local TLS (no simulated findings)', async () => {
    engine = realEngine;
    expect(await realEngine.readiness()).toEqual({ ready: true, tools: expect.arrayContaining(['semgrep', 'gitleaks', 'trivy', 'npm_advisories'].map(name => ({ name, available: true }))) });
    const app = await application('Real customer scans'); const verified = await target(app.path);
    const reports: CustomerAssessmentReport[] = [];
    const fakeSecret = 'FAKE_ONLY_INTEGRATION_1234567890';
    for (const revision of ['before', 'after'] as const) {
      corrected = revision === 'after';
      const snapshot: CustomerSourceSnapshot = { revision, files: [
        { path: 'src/customer.ts', content: corrected ? 'export function evaluate(input: string) { return JSON.parse(input); }\n' : `export function evaluate(input: string) { return eval(input); }\nconst password = "${fakeSecret}";\nconst fakeKey = "-----BEGIN PRIVATE KEY-----fixture-not-a-key";\n` },
        { path: 'client.js', content: 'export const message = "uploaded customer application";\n' },
        { path: 'deployment.yaml', content: corrected
          ? 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\n  namespace: customer\nspec:\n  automountServiceAccountToken: false\n  securityContext:\n    runAsNonRoot: true\n    runAsUser: 10001\n    runAsGroup: 10001\n    seccompProfile:\n      type: RuntimeDefault\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: false\n        allowPrivilegeEscalation: false\n        readOnlyRootFilesystem: true\n        capabilities:\n          drop: [ALL]\n      resources:\n        limits:\n          cpu: "100m"\n          memory: "64Mi"\n        requests:\n          cpu: "100m"\n          memory: "64Mi"\n'
          : 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n' },
        { path: 'package.json', content: JSON.stringify({ name: 'customer-upload', scripts: { postinstall: 'exit 99' }, dependencies: { lodash: corrected ? '4.17.21' : '4.17.20' } }) },
        { path: 'package-lock.json', content: JSON.stringify({ name: 'customer-upload', lockfileVersion: 3, packages: { '': { name: 'customer-upload', dependencies: { lodash: corrected ? '4.17.21' : '4.17.20' } }, 'node_modules/lodash': { version: corrected ? '4.17.21' : '4.17.20' } } }) },
      ] };
      const source = await upload(app.path, snapshot);
      for (const mode of ['internal', 'external', 'both'] as const) {
        const requestsBefore = httpsRequests.length;
        const body = { mode, sourceSnapshotId: mode === 'external' ? null : source.id, targetId: mode === 'internal' ? null : verified.id };
        const key = randomUUID(); const queued = await queue(app.path, body, key);
        expect(await queue(app.path, body, key)).toEqual(queued);
        const report = present(await finished(app.base, app.path, queued.jobId)); reports.push(report);
        expect(report).toMatchObject({ organizationId: app.workspace.id, applicationId: app.app.applicationId, mode, responseMode: 'observation', actionsPerformed: [], subject: { sourceSnapshotId: body.sourceSnapshotId, sourceDigest: mode === 'external' ? null : source.digest, targetId: body.targetId, targetVersion: mode === 'internal' ? null : verified.version, origin: mode === 'internal' ? null : 'https://customer.org' } });
        expect(report.internal === null).toBe(mode === 'external'); expect(report.external === null).toBe(mode === 'internal');
        if (report.internal) {
          for (const capability of ['semgrep', 'gitleaks', 'npm_advisories']) expect(report.internal.coverage).toContainEqual(expect.objectContaining({ capability, state: 'inspected' }));
          // Trivy inspects the Pod but does not recognize the two npm JSON files as Kubernetes.
          // Keep that omitted coverage unknown even though real configuration evidence exists.
          expect(report.internal.coverage).toContainEqual(expect.objectContaining({ capability: 'trivy', state: 'unavailable', detail: expect.stringContaining('2 candidate YAML/JSON configuration files') }));
          const rules = report.internal.findings.map(finding => finding.ruleId);
          expect(rules.some(rule => rule.endsWith('javascript.eval'))).toBe(!corrected);
          expect(rules.includes('gotchu-assigned-secret')).toBe(!corrected); expect(rules.includes('gotchu-private-key')).toBe(!corrected);
          expect(rules.includes('osv.GHSA-35jh-r3h4-6jhm')).toBe(!corrected);
          if (!corrected) expect(rules.some(rule => rule.startsWith('AVD-KSV'))).toBe(true);
          for (const name of ['semgrep', 'gitleaks', 'trivy'] as const) {
            const profile = present(report.internal.evidence.find(evidence => evidence.locator === `scanner-profile:${name}`));
            expect(profile.tool).toEqual({ name, version: profiles[name].version });
            expect(JSON.parse(profile.excerpt)).toMatchObject({ image: profiles[name].image, sourceDigest: source.digest, redacted: true });
          }
          expect(JSON.stringify(report)).not.toContain(fakeSecret);
          expect(JSON.stringify(report)).not.toContain('fixture-not-a-key');
        }
        if (report.external) {
          expect(report.external.coverage).toContainEqual(expect.objectContaining({ capability: 'tls_https', state: 'inspected' }));
          expect(report.external.findings.some(finding => finding.ruleId.includes('content-security-policy'))).toBe(!corrected);
          expect(report.external.findings.some(finding => finding.ruleId === 'https.technology-banner')).toBe(!corrected);
          const evidence = present(report.external.evidence.find(item => item.kind === 'http_response'));
          expect(JSON.parse(evidence.excerpt)).toMatchObject({ status: 200, tlsVerified: true, incomplete: null });
        }
        expect(httpsRequests.length - requestsBefore).toBe(mode === 'internal' ? 0 : 1);
        for (const analysis of [report.internal, report.external]) for (const evidence of analysis?.evidence ?? []) {
          expect(evidence.checksum).toBe(hash(evidence.excerpt)); expect(evidence.snapshotRef).toBe(analysis?.snapshotRef);
        }
        const findings = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
        expect(findings.every(finding => finding.exploitability === 'unknown')).toBe(true);
        expect(report.comparison.flatMap(row => [...row.internalFindingIds, ...row.externalFindingIds]).sort()).toEqual(findings.map(finding => finding.id).sort());
        expect(report.limitations.join(' ')).toContain('not proven to match deployment');
      }
    }
    expect(reports).toHaveLength(6);
    for (const request of httpsRequests) expect(request).toEqual({ method: 'GET', path: '/', hostname: 'customer.org', hasCredentials: false });
    expect(lookups).toHaveLength(httpsRequests.length);
    const before = present(reports.find(report => report.mode === 'internal'));
    const after = present(reports.filter(report => report.mode === 'internal')[1]);
    expect(before.subject.sourceDigest).not.toBe(after.subject.sourceDigest);
    const beforeK8s = before.internal?.findings.filter(finding => finding.ruleId.startsWith('AVD-KSV')).length ?? 0;
    const afterK8s = after.internal?.findings.filter(finding => finding.ruleId.startsWith('AVD-KSV')).length ?? 0;
    expect(afterK8s).toBeLessThan(beforeK8s); // Corrected fixture removes known risks without claiming universal safety.
    expect(await json(await owner.api(`${app.path}/reports`), 200, z.array(customerReportSummarySchema))).toHaveLength(6);
    const writes = await f.admin.query<{ count: number }>('SELECT ((SELECT count(*) FROM gotchu.proposals WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.approvals WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.executions WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.agent_runs WHERE organization_id=$1))::int AS count', [app.workspace.id]);
    expect(writes.rows[0]?.count).toBe(0);
  }, 360_000);
});
