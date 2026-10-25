import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { httpRequestEvent, signEventBatch } from '@gotchu/sdk';
import { prepareCorrectionResponseSchema, reportRecommendationsResponseSchema } from '@gotchu/scenarios/contracts';
import {
  apiCheckEvidenceSchema, customerApplicationSchema, customerAssessmentReportSchema, customerEnrollmentSchema,
  customerReportSummarySchema, customerSourceSummarySchema, customerTargetSchema, customerWorkspaceSchema,
  telemetryConnectionSchema, operationAlertSchema, operationCoverageSchema, monitorConfigSchema,
  type CustomerAssessmentReport, type CustomerSourceSnapshot, type CustomerScanProfile,
} from '../../packages/contracts/src/index.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';

const live = liveUrl && process.env.GOTCHU_TEST_REDIS_URL ? describe : describe.skip;
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const queuedSchema = z.object({ jobId: z.uuid() }).strict();
const jobSchema = z.object({ id: z.uuid(), applicationId: z.uuid(), kind: z.string(), state: z.enum(['queued', 'running', 'succeeded', 'failed']), reportId: z.uuid().nullable(), reasonCode: z.string().nullable() });
const coordinatorReadinessSchema = z.object({ status: z.literal('ready'), assignedOrganizations: z.number().int().nonnegative(), investigatorConfigured: z.boolean(), customerDiscovery: z.literal(true), customerScannerConfigured: z.literal(true), scheduledMonitoring: z.boolean() });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const sessionSchema = z.object({ user: z.object({ id: z.string() }).nullable(), localAuthEnabled: z.boolean(), registrationEnabled: z.boolean() });
const publicSurfaceEvidenceSchema = z.object({ profile: z.literal('public_surface'), path: z.string() }).passthrough();
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

live('customer applications through built Nitro, coordinator main, HMAC scanner and real data services', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let directory: string; let origin: string; let scannerOrigin: string; let secret: Buffer;
  let owner: ReturnType<typeof cookieClient>; let stranger: ReturnType<typeof cookieClient>;
  let coordinator: ChildProcess;
  let engine = createCustomerAssessmentRunner({ scanners: unavailableScanners });
  let realEngine: ReturnType<typeof createCustomerAssessmentRunner>;
  let corrected = false;
  let publicSurfaceFixture = false;
  let apiChecksFixture = false;
  let holdHttpsLookup: (() => Promise<void>) | undefined;
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
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'], { timeout: 10_000, maxBuffer: 65_536 });
    const cert = await readFile(join(directory, 'cert.pem'), 'utf8'); const key = await readFile(join(directory, 'key.pem'), 'utf8');
    const tls = createTlsServer({ cert, key }, (request, response) => {
      httpsRequests.push({ method: request.method, path: request.url, hostname: request.headers.host, hasCredentials: Boolean(request.headers.cookie || request.headers.authorization) });
      const path = request.url ?? '/';
      if (apiChecksFixture) {
        const cors = { 'access-control-allow-origin': 'https://gotchu.invalid', 'access-control-allow-credentials': 'true' };
        if (request.method === 'OPTIONS') return response.writeHead(204, { ...cors, allow: 'GET, HEAD, OPTIONS', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization' }).end();
        if (request.method === 'HEAD') return response.writeHead(path === '/api/account' ? 401 : 200, cors).end();
        if (path === '/openapi.json') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ openapi: '3.0.3', security: [{ bearer: [] }], paths: { '/api/account': { get: { description: 'API_BODY_MUST_NOT_PERSIST' } } } }));
        return response.writeHead(404).end('API_BODY_MUST_NOT_PERSIST');
      }
      const headers = corrected ? { 'content-security-policy': "default-src 'none'", 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff' } : { server: 'Untrusted-Fixture/1.0' };
      if (publicSurfaceFixture) {
        if (path === '/') return response.writeHead(200, { ...headers, 'content-type': 'text/html' }).end('<a href="/public-app">App</a><a href="/redirect">Redirect</a><a href="/search?token=BODY_MUST_NOT_PERSIST">Search</a><a href="https://other.example/private">External</a>');
        if (path === '/robots.txt') return response.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('Sitemap: /sitemap.xml');
        if (path === '/sitemap.xml') return response.writeHead(200, { ...headers, 'content-type': 'application/xml' }).end('<urlset><url><loc>https://customer.org/from-sitemap</loc></url><url><loc>https://customer.org/private?token=BODY_MUST_NOT_PERSIST</loc></url><url><loc>https://other.example/offsite</loc></url></urlset>');
        if (path === '/redirect') return response.writeHead(302, { ...headers, location: 'https://169.254.169.254/latest/meta-data' }).end();
        return response.writeHead(path === '/.well-known/security.txt' || path === '/security.txt' || path === '/public-app' || path === '/from-sitemap' ? 200 : 404, { ...headers, 'content-type': 'text/plain' }).end('controlled public-surface fixture');
      }
      response.writeHead(200, headers).end('fixture root; not customer data');
    });
    const tlsPort = await listen(tls); cleanup.push(() => closeServer(tls));
    const https = { lookup: async (hostname: string) => { if (hostname !== 'customer.org') throw new Error('unexpected_fixture_hostname'); lookups.push(hostname); await holdHttpsLookup?.(); return [{ address: '127.0.0.1', family: 4 }]; }, testFixture: { hostname: 'customer.org', port: tlsPort, ca: cert } };
    engine = createCustomerAssessmentRunner({ scanners: unavailableScanners, https });
    realEngine = createCustomerAssessmentRunner({ scanners: createDockerScanners(), advisory: createOsvAdapter(), https });
    const scanner = createScannerServer({ secret, runner: { run: input => engine.run(input), readiness: () => engine.readiness() } });
    scannerOrigin = `http://127.0.0.1:${await listen(scanner)}`; cleanup.push(() => closeServer(scanner));
    const webPort = await unusedPort(); origin = `http://localhost:${webPort}`;
    const web = childProcess('Nitro web', 'apps/web/.output/server/index.mjs', webPort, {
      NODE_ENV: 'production', GOTCHU_AUTH_MODE: 'public', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PUBLIC_APP_URL: origin,
      GOTCHU_API_DATABASE_URL: f.runtimeConnectionString('gotchu_api'), GOTCHU_INGEST_DATABASE_URL: f.runtimeConnectionString('gotchu_ingest'),
      AUTH_SECRET: randomBytes(48).toString('base64url'),
      GOTCHU_EVENT_CREDENTIAL_DIRECTORY: join(directory, 'event-credentials'),
    });
    const worker = childProcess('coordinator', 'apps/coordinator/dist/main.js', await unusedPort(), {
      NODE_ENV: 'test', GOTCHU_CUSTOMER_DISCOVERY: 'true', GOTCHU_COORDINATOR_HOST: '127.0.0.1',
      GOTCHU_COORDINATOR_DATABASE_URL: f.runtimeConnectionString('gotchu_coordinator'), GOTCHU_REDIS_URL: present(process.env.GOTCHU_TEST_REDIS_URL),
      GOTCHU_SCANNER_ORIGIN: scannerOrigin, GOTCHU_SCANNER_SECRET_FILE: secretFile,
      GOTCHU_MONITORING_ENABLED: 'true',
      // No GOTCHU_ORGANIZATION_IDS: all workspaces below are created after coordinator startup.
    });
    coordinator = worker.child;
    await Promise.all([web.ready('/api/ready'), worker.ready('/health/ready')]);
    const health = await fetch(`http://127.0.0.1:${present(children.find(child => child.name === 'coordinator')).port}/health/ready`);
    expect(await json(health, 200, coordinatorReadinessSchema)).toMatchObject({ customerDiscovery: true, customerScannerConfigured: true, scheduledMonitoring: true });
    owner = await registerAndSignIn(); stranger = await registerAndSignIn();
  }, 90_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    try { await f?.close(); } catch (error) { errors.push(error); }
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
  async function target(path: string, scanProfile: CustomerScanProfile = 'root') {
    const targetPath = `${path}/targets`;
    await rejected(await owner.api(targetPath, 'POST', { origin: 'https://customer.org', authorized: true }), 400, 'invalid_input');
    const enrollment = await json(await owner.api(targetPath, 'POST', { origin: 'https://customer.org', scanProfile }), 201, customerEnrollmentSchema);
    const requested = enrollment.target;
    expect(requested.status).toBe('authorized');
    expect(requested.requestedBy).toMatch(/^credentials:/);
    expect(Date.parse(requested.requestedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(requested.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(requested.authorizedAt).not.toBeNull();
    expect(requested.scanProfile ?? 'root').toBe(scanProfile);
    return requested;
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
    const dashboard = await fetch(`${origin}/dashboard`, { signal: AbortSignal.timeout(5000) });
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get('content-type')).toContain('text/html');
    expect(await dashboard.text()).toContain('Espacio de trabajo');
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
    const settings = { enabled: true, intervalSeconds: 21600, sourceSnapshotId: source.id, targetId: null, repositoryKey: null, providers: [] };
    await json(await owner.api(`${first.path}/monitoring`, 'PUT', settings), 200, monitorConfigSchema);
    await eventually(async () => {
      const coverage = await json(await owner.api(`${first.path}/monitoring`), 200, operationCoverageSchema);
      return coverage.lastRun?.status === 'degraded' && coverage.lastRun.jobId !== queued.jobId && coverage.lastRun.finishedAt !== null;
    }, 'actual main-process scheduled assessment');
    await json(await owner.api(`${first.path}/monitoring`, 'PUT', { ...settings, enabled: false }), 200, monitorConfigSchema);
    const telemetry = await json(await owner.api(`${first.path}/telemetry`, 'POST', {}), 201, telemetryConnectionSchema);
    const signed = signEventBatch({ integrationId: telemetry.integration.id, secret: Buffer.from(telemetry.signingKey, 'base64'), batch: { applicationId: first.app.applicationId,
      events: Array.from({ length: 30 }, () => httpRequestEvent({ route: '/api/orders/:id', statusCode: 503, durationMs: 1800 })),
    } });
    expect((await fetch(`${origin}/api/v1/events`, { method: 'POST', headers: signed.headers, body: signed.body })).status).toBe(202);
    let pressure: z.infer<typeof operationAlertSchema> | undefined;
    await eventually(async () => {
      const alerts = await json(await owner.api(`${first.path}/alerts`), 200, z.array(operationAlertSchema));
      pressure = alerts.find(alert => alert.observation.kind === 'traffic_pressure'); return Boolean(pressure);
    }, 'signed events to actual dashboard alerts');
    const acknowledged = await json(await owner.api(`${first.path}/alerts/${present(pressure).id}`, 'PATCH', { state: 'acknowledged' }), 200, operationAlertSchema);
    expect(acknowledged.state).toBe('acknowledged');
    expect((await owner.api(`${first.path}/telemetry/${telemetry.integration.id}`, 'DELETE')).status).toBe(204);
    for (const path of [`${first.base}/applications`, `${first.path}/sources`, `${first.path}/targets`, `${first.path}/reports/${report.id}`, `${first.base}/jobs/${queued.jobId}`]) await rejected(await stranger.api(path), 403, 'forbidden');
    await rejected(await stranger.api(`${first.path}/sources/${source.id}`, 'DELETE'), 403, 'forbidden');
    await rejected(await cookieClient(origin).api(`${first.path}/sources/${source.id}`, 'DELETE'), 401, 'unauthenticated');
    await rejected(await owner.api(`${other.base}/applications/${first.app.applicationId}/reports/${report.id}`), 403, 'forbidden');
    await rejected(await owner.api(`${siblingPath}/reports/${report.id}`), 404, 'not_found');
    await rejected(await owner.api(`${siblingPath}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    await rejected(await stranger.api(`${other.path}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    await rejected(await owner.api(`${siblingPath}/sources/${source.id}`, 'DELETE'), 404, 'not_found');
    const workspaces = await json(await stranger.api('/workspaces'), 200, z.array(customerWorkspaceSchema));
    expect(workspaces.some(item => item.id === first.workspace.id)).toBe(false);
    const viewer = present((await json(await stranger.api('/session'), 200, sessionSchema)).user);
    // Operator fixture grants read-only membership; the DELETE still uses the real session and backend.
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'viewer')", [first.workspace.id, viewer.id]);
    try {
      await rejected(await stranger.api(`${first.path}/sources/${source.id}`, 'DELETE'), 403, 'forbidden');
    } finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [first.workspace.id, viewer.id]); }
    const deleted = await owner.request(`/api/customer${first.path}/sources/${source.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();
    expect(await deleted.text()).toBe('');
    const repeated = await owner.api(`${first.path}/sources/${source.id}`, 'DELETE');
    expect(repeated.status).toBe(204);
    await json(await owner.api(`${first.path}/sources/${source.id}/delete`, 'POST', {}), 200, z.object({ deleted: z.literal(true) }));
    await rejected(await owner.api(`${first.path}/assessments`, 'POST', body, randomUUID()), 404, 'not_found');
    expect((await json(await owner.api(`${first.path}/sources`), 200, z.array(customerSourceSummarySchema))).map(item => item.id)).not.toContain(source.id);
    expect((await json(await owner.api(`${first.path}/reports/${report.id}`), 200, customerAssessmentReportSchema)).id).toBe(report.id);
  }, 30_000);

  it('authorizes a bounded Analyze request, revokes target scope, and restores archived applications', async () => {
    const app = await application('Authorization lifecycle');
    const requested = await target(app.path);
    const body = { mode: 'external', sourceSnapshotId: null, targetId: requested.id } as const;
    let releaseLookup = () => {};
    let lookupEntered = false;
    const pausedLookup = new Promise<void>(resolve => { releaseLookup = resolve; });
    holdHttpsLookup = () => { lookupEntered = true; return pausedLookup; };
    const beforeProbe = httpsRequests.length;
    const key = randomUUID(); const queued = await queue(app.path, body, key);
    try {
      await eventually(async () => lookupEntered, 'scanner DNS admission');
      expect(httpsRequests).toHaveLength(beforeProbe);
      await rejected(await owner.api(`${app.path}/targets/${requested.id}/revoke`, 'POST', {}), 409, 'target_assessment_in_progress');
      await rejected(await owner.api(`${app.path}/targets`, 'POST', { origin: requested.origin }), 409, 'target_assessment_in_progress');
    } finally { holdHttpsLookup = undefined; releaseLookup(); }
    const report = present(await finished(app.base, app.path, queued.jobId));
    expect(report.internal).toBeNull(); expect(report.external?.coverage).toContainEqual(expect.objectContaining({ capability: 'tls_https', state: 'inspected' }));
    await rejected(await stranger.api(`${app.path}/targets/${requested.id}/revoke`, 'POST', {}), 403, 'forbidden');
    const revoked = await json(await owner.api(`${app.path}/targets/${requested.id}/revoke`, 'POST', {}), 200, customerTargetSchema);
    expect(revoked).toMatchObject({ status: 'revoked', version: requested.version + 1, authorizedAt: null });
    await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, randomUUID()), 409, 'target_not_authorized');
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
    const requested = await target(app.path);
    const body = { mode: 'both', sourceSnapshotId: source.id, targetId: requested.id } as const;
    const requestsBefore = httpsRequests.length;
    expect(coordinator.kill('SIGSTOP')).toBe(true);
    const jobs: string[] = [];
    try {
      for (let index = 0; index < 3; index++) jobs.push((await queue(app.path, body)).jobId);
      await rejected(await owner.api(`${app.path}/assessments`, 'POST', body, randomUUID()), 429, 'assessment_capacity_exceeded');
      await rejected(await owner.api(`${app.path}/sources/${source.id}`, 'DELETE'), 409, 'source_in_use');
      await rejected(await owner.api(`${app.path}/targets/${requested.id}/revoke`, 'POST', {}), 409, 'target_assessment_in_progress');
      // Archival stops admission and makes queued work fail its fresh-state check.
      await json(await owner.api(app.path, 'PATCH', { archived: true }), 200, customerApplicationSchema);
    } finally { coordinator.kill('SIGCONT'); }
    for (const job of jobs) await finished(app.base, app.path, job, 'failed');
    expect(httpsRequests).toHaveLength(requestsBefore);
    await json(await owner.api(`${app.path}/targets/${requested.id}/revoke`, 'POST', {}), 200, customerTargetSchema);
    await json(await owner.api(app.path, 'PATCH', { archived: false }), 200, customerApplicationSchema);
    await json(await owner.api(`${app.path}/sources/${source.id}/delete`, 'POST', {}), 200, z.object({ deleted: z.literal(true) }));
    expect((await upload(app.path, minimalSource('replacement-after-delete'))).id).not.toBe(source.id);
    expect(await json(await owner.api(`${app.path}/reports`), 200, z.array(customerReportSummarySchema))).toEqual([]);
  }, 45_000);

  it.skipIf(process.env.GOTCHU_TEST_SCANNERS !== '1')('persists real Docker/OSV mode reports and a combined public_surface report with local TLS', async () => {
    engine = realEngine;
    expect(await realEngine.readiness()).toEqual({ ready: true, tools: expect.arrayContaining(['semgrep', 'gitleaks', 'trivy', 'npm_advisories'].map(name => ({ name, available: true }))) });
    const app = await application('Real customer scans'); const requestedTarget = await target(app.path);
    const reports: CustomerAssessmentReport[] = [];
    const fakeSecret = 'b47c9f28e3d16a0c5b79f2e4d8a63c10';
    const fakePrivateKey = `-----BEGIN PRIVATE KEY-----\n${'test-only-placeholder-'.repeat(4)}\n-----END PRIVATE KEY-----`;
    const fakePrivateKeyComments = fakePrivateKey.split('\n').map(line => `// ${line}`).join('\n');
    let baselineSourceId: string | undefined;
    for (const revision of ['before', 'after'] as const) {
      corrected = revision === 'after';
      const snapshot: CustomerSourceSnapshot = { revision, files: [
        { path: 'src/tls.ts', content: `export const options = { rejectUnauthorized: ${corrected ? 'true' : 'false'} };\n` },
        { path: 'src/customer.ts', content: corrected ? 'export function evaluate(input: string) { return JSON.parse(input); }\n' : `export function evaluate(input: string) { return eval(input); }\nconst password = "${fakeSecret}";\n${fakePrivateKeyComments}\n` },
        { path: 'client.js', content: 'export const message = "uploaded customer application";\n' },
        { path: 'deployment.yaml', content: corrected
          ? 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\n  namespace: customer\nspec:\n  automountServiceAccountToken: false\n  securityContext:\n    runAsNonRoot: true\n    runAsUser: 10001\n    runAsGroup: 10001\n    seccompProfile:\n      type: RuntimeDefault\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: false\n        allowPrivilegeEscalation: false\n        readOnlyRootFilesystem: true\n        capabilities:\n          drop: [ALL]\n      resources:\n        limits:\n          cpu: "100m"\n          memory: "64Mi"\n        requests:\n          cpu: "100m"\n          memory: "64Mi"\n'
          : 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      image: nginx:1.27\n      securityContext:\n        privileged: true\n' },
        { path: 'package.json', content: JSON.stringify({ name: 'customer-upload', scripts: { postinstall: 'exit 99' }, dependencies: { lodash: corrected ? '4.17.21' : '4.17.20' } }) },
        { path: 'package-lock.json', content: JSON.stringify({ name: 'customer-upload', lockfileVersion: 3, packages: { '': { name: 'customer-upload', dependencies: { lodash: corrected ? '4.17.21' : '4.17.20' } }, 'node_modules/lodash': { version: corrected ? '4.17.21' : '4.17.20' } } }) },
      ] };
      const source = await upload(app.path, snapshot);
      if (revision === 'before') baselineSourceId = source.id;
      for (const mode of ['internal', 'external', 'both'] as const) {
        const requestsBefore = httpsRequests.length;
        const body = { mode, sourceSnapshotId: mode === 'external' ? null : source.id, targetId: mode === 'internal' ? null : requestedTarget.id };
        const key = randomUUID(); const queued = await queue(app.path, body, key);
        expect(await queue(app.path, body, key)).toEqual(queued);
        const report = present(await finished(app.base, app.path, queued.jobId)); reports.push(report);
        expect(report).toMatchObject({ organizationId: app.workspace.id, applicationId: app.app.applicationId, mode, responseMode: 'observation', actionsPerformed: [], subject: { sourceSnapshotId: body.sourceSnapshotId, sourceDigest: mode === 'external' ? null : source.digest, targetId: body.targetId, targetVersion: mode === 'internal' ? null : requestedTarget.version, origin: mode === 'internal' ? null : 'https://customer.org' } });
        expect(report.internal === null).toBe(mode === 'external'); expect(report.external === null).toBe(mode === 'internal');
        if (report.internal) {
          for (const capability of ['semgrep', 'gitleaks', 'dependency_advisories']) expect(report.internal.coverage).toContainEqual(expect.objectContaining({ capability, state: 'inspected' }));
          // npm JSON files are not Kubernetes candidates; the manifest remains fully inspected.
          expect(report.internal.coverage).toContainEqual(expect.objectContaining({ capability: 'trivy', state: 'inspected' }));
          const rules = report.internal.findings.map(finding => finding.ruleId);
          expect(rules.some(rule => rule.endsWith('javascript.eval'))).toBe(!corrected);
          expect(rules.some(rule => rule.endsWith('gotchu.javascript.tls-disabled'))).toBe(!corrected);
          expect(rules.includes('generic-api-key')).toBe(!corrected); expect(rules.includes('private-key')).toBe(!corrected);
          expect(rules.includes('osv.GHSA-35jh-r3h4-6jhm')).toBe(!corrected);
          if (!corrected) expect(rules.some(rule => rule.startsWith('AVD-KSV'))).toBe(true);
          for (const name of ['semgrep', 'gitleaks', 'trivy'] as const) {
            const profile = present(report.internal.evidence.find(evidence => evidence.locator === `scanner-profile:${name}`));
            expect(profile.tool).toEqual({ name, version: profiles[name].version });
            expect(JSON.parse(profile.excerpt)).toMatchObject({ image: profiles[name].image, sourceDigest: source.digest, redacted: true });
          }
          expect(JSON.stringify(report)).not.toContain(fakeSecret);
          expect(JSON.stringify(report)).not.toContain(fakePrivateKey);
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
        if (mode === 'external') expect(report.limitations.join(' ')).not.toContain('Uploaded source');
        else expect(report.limitations.join(' ')).toContain('not proven to match deployment');
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
    const recommendations = await json(await owner.api(`${app.path}/reports/${before.id}/recommendations`), 200, reportRecommendationsResponseSchema);
    const tlsRecipe = present(recommendations.recommendations.find(recipe => recipe.recipeId === 'tls-certificate-verification'));
    expect(tlsRecipe.availability).toBe('candidate_patch');
    const selection = { recipeId: tlsRecipe.recipeId, findingId: present(tlsRecipe.evidenceFindingIds[0]), expectedSourceDigest: present(before.subject.sourceDigest) };
    await rejected(await stranger.api(`${app.path}/reports/${before.id}/corrections`, 'POST', selection), 403, 'forbidden');
    await rejected(await owner.api(`${app.path}/reports/${before.id}/corrections`, 'POST', { ...selection, expectedSourceDigest: 'f'.repeat(64) }), 409, 'expected_source_digest_mismatch');
    const candidate = await json(await owner.api(`${app.path}/reports/${before.id}/corrections`, 'POST', selection), 201, prepareCorrectionResponseSchema);
    expect(await json(await owner.api(`${app.path}/reports/${before.id}/corrections`, 'POST', selection), 201, prepareCorrectionResponseSchema)).toEqual(candidate);
    expect(candidate.changes).toEqual([{ path: 'src/tls.ts', description: expect.any(String) }]);
    const rescanned = present(await finished(app.base, app.path, candidate.jobId));
    expect(rescanned.internal?.coverage).toContainEqual(expect.objectContaining({ capability: 'semgrep', state: 'inspected' }));
    expect(rescanned.internal?.findings.some(finding => finding.ruleId.endsWith('gotchu.javascript.tls-disabled'))).toBe(false);
    expect(rescanned.internal?.findings.some(finding => finding.ruleId.endsWith('gotchu.javascript.eval'))).toBe(true);
    const privilegedFinding = present(before.internal?.findings.find(finding => finding.ruleId === 'AVD-KSV-0017'));
    const kubernetesRecipe = present(recommendations.recommendations.find(recipe => recipe.recipeId === 'kubernetes-config-hardening' && recipe.evidenceFindingIds.includes(privilegedFinding.id)));
    expect(kubernetesRecipe.availability).toBe('candidate_patch');
    expect(privilegedFinding.location).toBe('deployment.yaml:10');
    const kubernetesCandidate = await json(await owner.api(`${app.path}/reports/${before.id}/corrections`, 'POST', {
      recipeId: kubernetesRecipe.recipeId,
      findingId: privilegedFinding.id,
      expectedSourceDigest: present(before.subject.sourceDigest),
    }), 201, prepareCorrectionResponseSchema);
    expect(kubernetesCandidate.sourceId).not.toBe(before.subject.sourceSnapshotId);
    expect(kubernetesCandidate.changes).toEqual([{ path: 'deployment.yaml', description: expect.any(String) }]);
    const kubernetesRescan = present(await finished(app.base, app.path, kubernetesCandidate.jobId));
    expect(kubernetesRescan.subject.sourceSnapshotId).toBe(kubernetesCandidate.sourceId);
    expect(kubernetesRescan.internal?.findings.some(finding => finding.ruleId === 'AVD-KSV-0017')).toBe(false);
    const privateCandidate = await f.admin.query<{ body: CustomerSourceSnapshot }>('SELECT body FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3', [app.workspace.id, app.app.applicationId, kubernetesCandidate.sourceId]);
    expect(privateCandidate.rows[0]?.body.files.find(file => file.path === 'deployment.yaml')?.content).toContain('privileged: false');
    const original = await f.admin.query<{ body: CustomerSourceSnapshot }>('SELECT body FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3', [app.workspace.id, app.app.applicationId, before.subject.sourceSnapshotId]);
    expect(original.rows[0]?.body.files.find(file => file.path === 'src/tls.ts')?.content).toContain('rejectUnauthorized: false');
    expect(original.rows[0]?.body.files.find(file => file.path === 'deployment.yaml')?.content).toContain('privileged: true');
    const writes = await f.admin.query<{ count: number }>('SELECT ((SELECT count(*) FROM gotchu.proposals WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.approvals WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.executions WHERE organization_id=$1) + (SELECT count(*) FROM gotchu.agent_runs WHERE organization_id=$1))::int AS count', [app.workspace.id]);
    expect(writes.rows[0]?.count).toBe(0);

    await json(await owner.api(`${app.path}/targets/${requestedTarget.id}/revoke`, 'POST', {}), 200, customerTargetSchema);
    const surfaceTarget = await target(app.path, 'public_surface');
    corrected = false;
    publicSurfaceFixture = true;
    try {
      const queued = await queue(app.path, { mode: 'both', sourceSnapshotId: present(baselineSourceId), targetId: surfaceTarget.id });
      const combined = present(await finished(app.base, app.path, queued.jobId));
      expect(combined.internal?.findings.some(finding => finding.ruleId.endsWith('javascript.eval'))).toBe(true);
      expect(combined.external?.coverage).toContainEqual(expect.objectContaining({ capability: 'same_origin_link_discovery', state: 'inspected' }));
      const pathEvidence = present(combined.external?.evidence.find(item => item.kind === 'http_response' && publicSurfaceEvidenceSchema.parse(JSON.parse(item.excerpt)).path === '/public-app'));
      expect(combined.external?.findings.some(finding => finding.location === pathEvidence.locator && finding.evidenceIds.includes(pathEvidence.id))).toBe(true);
    } finally { publicSurfaceFixture = false; }
  }, 360_000);

  it('runs external-only public_surface through authenticated enrollment, scanner HTTP and the durable report pipeline', async () => {
    const app = await application('Public surface only');
    const requestedTarget = await target(app.path, 'public_surface');
    publicSurfaceFixture = true;
    try {
      const requestStart = httpsRequests.length;
      const lookupStart = lookups.length;
      const queued = await queue(app.path, { mode: 'external', sourceSnapshotId: null, targetId: requestedTarget.id });
      const report = present(await finished(app.base, app.path, queued.jobId));
      const requests = httpsRequests.slice(requestStart);
      expect(report).toMatchObject({ mode: 'external', subject: { sourceSnapshotId: null, sourceDigest: null, targetId: requestedTarget.id, origin: 'https://customer.org' }, internal: null });
      expect(report.external?.snapshotRef).toContain(':public_surface');
      expect(report.external?.coverage).toContainEqual(expect.objectContaining({ capability: 'public_surface_known_paths', state: 'inspected' }));
      expect(report.external?.coverage).toContainEqual(expect.objectContaining({ capability: 'same_origin_link_discovery', state: 'inspected' }));
      expect(requests.length).toBeGreaterThan(5);
      expect(requests.length).toBeLessThanOrEqual(10);
      expect(requests.every(request => request.method === 'GET' && request.hostname === 'customer.org' && !request.hasCredentials)).toBe(true);
      expect(requests.map(request => request.path)).toContain('/public-app');
      expect(requests.map(request => request.path)).toContain('/from-sitemap');
      expect(requests.map(request => request.path)).not.toContain('/search?token=BODY_MUST_NOT_PERSIST');
      expect(requests.map(request => request.path)).not.toContain('/private?token=BODY_MUST_NOT_PERSIST');
      expect(requests.map(request => request.path)).not.toContain('/latest/meta-data');
      expect(lookups.slice(lookupStart)).toEqual(Array.from({ length: requests.length }, () => 'customer.org'));

      const evidence = present(report.external).evidence.filter(item => item.kind === 'http_response');
      expect(evidence).toHaveLength(requests.length);
      const evidenceById = new Map(evidence.map(item => [item.id, item]));
      for (const finding of present(report.external).findings) {
        for (const evidenceId of finding.evidenceIds) {
          const item = present(evidenceById.get(evidenceId));
          const observation = publicSurfaceEvidenceSchema.parse(JSON.parse(item.excerpt));
          expect(item.locator).toBe(`https://customer.org${observation.path}`);
          expect(finding.location).toBe(item.locator);
          expect(item.checksum).toBe(hash(item.excerpt));
        }
      }
      const appEvidence = present(evidence.find(item => publicSurfaceEvidenceSchema.parse(JSON.parse(item.excerpt)).path === '/public-app'));
      expect(present(report.external).findings.some(finding => finding.location === appEvidence.locator && finding.evidenceIds.includes(appEvidence.id))).toBe(true);
      expect(JSON.stringify(report)).not.toContain('BODY_MUST_NOT_PERSIST');
      await rejected(await stranger.api(`${app.path}/reports/${report.id}`), 403, 'forbidden');
      const job = await json(await owner.api(`${app.base}/jobs/${queued.jobId}`), 200, jobSchema);
      expect(job).toMatchObject({ id: queued.jobId, applicationId: app.app.applicationId });
      await rejected(await stranger.api(`${app.base}/jobs/${queued.jobId}`), 403, 'forbidden');
    } finally { publicSurfaceFixture = false; }
  }, 60_000);
  it('executes and persists API scenarios for manual and scheduled external jobs without source access', async () => {
    apiChecksFixture = true;
    try {
      const app = await application('API protocol checks');
      const requested = await target(app.path, 'api_checks');
      const start = httpsRequests.length;
      const queued = await queue(app.path, { mode: 'external', sourceSnapshotId: null, targetId: requested.id });
      const report = present(await finished(app.base, app.path, queued.jobId));
      const observed = present(report.external);
      const checks = observed.evidence.map(item => {
        expect(item.checksum).toBe(hash(item.excerpt));
        return apiCheckEvidenceSchema.parse(JSON.parse(item.excerpt));
      });
      expect(checks).toHaveLength(8);
      expect(checks.find(item => item.path === '/openapi.json')?.signals.operations).toContainEqual({ path: '/api/account', method: 'GET', authentication: 'declared', probeEligible: true });
      expect(httpsRequests.slice(start)).toHaveLength(8);
      expect(httpsRequests.slice(start).every(item => !item.hasCredentials && item.hostname === 'customer.org')).toBe(true);
      expect(httpsRequests.slice(start)).not.toContainEqual(expect.objectContaining({ method: 'GET', path: '/api/account' }));
      expect(observed.findings.map(item => item.ruleId)).toEqual(['api.credentialed-probe-origin']);
      expect(observed.snapshotRef).toContain(':api_checks');
      expect(JSON.stringify(report)).not.toContain('API_BODY_MUST_NOT_PERSIST');
      await rejected(await stranger.api(`${app.path}/reports/${report.id}`), 403, 'forbidden');
      const settings = { enabled: true, intervalSeconds: 21600, sourceSnapshotId: null, targetId: requested.id, repositoryKey: null, providers: [] };
      try {
        await json(await owner.api(`${app.path}/monitoring`, 'PUT', settings), 200, monitorConfigSchema);
        let scheduledJobId: string | null = null;
        await eventually(async () => {
          const coverage = await json(await owner.api(`${app.path}/monitoring`), 200, operationCoverageSchema);
          scheduledJobId = coverage.lastRun?.jobId ?? null;
          return scheduledJobId !== null && coverage.lastRun?.finishedAt !== null;
        }, 'scheduled API profile assessment', 60_000);
        const scheduled = present(await finished(app.base, app.path, present(scheduledJobId)));
        expect(scheduled.external?.snapshotRef).toBe(observed.snapshotRef);
        expect(scheduled.external?.evidence.map(item => apiCheckEvidenceSchema.parse(JSON.parse(item.excerpt)))).toHaveLength(8);
      } finally {
        await json(await owner.api(`${app.path}/monitoring`, 'PUT', { ...settings, enabled: false }), 200, monitorConfigSchema);
      }
    } finally { apiChecksFixture = false; }
  }, 90_000);
});
