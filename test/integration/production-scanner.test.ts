import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '@gotchu/backend';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';
import { z } from 'zod';

// Docker-backed production profiles stay explicitly skipped without disposable services and opt-in.
const enabled = liveUrl && process.env.GOTCHU_TEST_REDIS_URL && process.env.GOTCHU_TEST_SCANNERS === '1';
const live = enabled ? describe : describe.skip;
const root = fileURLToPath(new URL('../../', import.meta.url));
const pinnedImage = 'semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af';
const groundtruth = {
  revision: 'production-scanner-groundtruth-1',
  files: [{
    path: 'src/security.ts',
    content: 'export const requestOptions = { rejectUnauthorized: false };\nexport function evaluate(input: string) { return eval(input); }\n',
  }],
};
const readinessSchema = z.object({
  ready: z.boolean(),
  tools: z.array(z.object({ name: z.string(), available: z.boolean() }).passthrough()),
}).passthrough();
const diagnosticsSchema = z.object({ status: z.literal('ready'), assignedOrganizations: z.number(), customerDiscovery: z.boolean(), customerScannerConfigured: z.boolean() }).passthrough();

async function eventually<T>(work: () => Promise<T | undefined>, label: string, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await work();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

interface OwnedChild {
  child: ChildProcess;
  name: string;
  port: number;
  events: string[];
  closed: Promise<void>;
  isClosed(): boolean;
  hasProcessError(): boolean;
}

function startChild(name: string, entry: string, port: number, env: NodeJS.ProcessEnv, cleanups: Array<() => Promise<void>>): OwnedChild {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TZ: 'UTC', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: string[] = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => {
    for (const match of chunk.toString('utf8', 0, Math.min(chunk.length, 8192)).matchAll(/"event":"([a-z_]+)"/g)) {
      events.push(match[1] ?? 'unknown');
      if (events.length > 12) events.shift();
    }
  });
  let closed = false;
  const settled = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  let processError = false;
  child.on('error', () => { processError = true; });
  const owned = { child, name, port, events, closed: settled, isClosed: () => closed };
  cleanups.push(async () => {
    if (!closed) child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!closed) child.kill('SIGKILL');
    await settled;
  });
  return { ...owned, hasProcessError: () => processError };
}

function assertAlive(service: OwnedChild) {
  if (service.hasProcessError() || service.isClosed()) {
    throw new Error(`${service.name} PID ${service.child.pid ?? 'unstarted'} on port ${service.port} exited; events: ${service.events.join(',')}`);
  }
}

function getScannerJson(port: number, ca: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: 'localhost', port, path: '/readyz', method: 'GET', ca,
      rejectUnauthorized: true, servername: 'localhost', agent: false,
      signal: AbortSignal.timeout(2_000),
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262_144) { response.destroy(); reject(new Error('Scanner readiness response exceeded its limit')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: response.statusCode ?? 0, body });
        } catch { reject(new Error('Scanner readiness returned invalid JSON')); }
      });
      response.on('error', () => reject(new Error('Scanner readiness response failed')));
    });
    request.on('error', () => reject(new Error('Scanner TLS readiness request failed')));
    request.end();
  });
}

live('production scanner TLS and durable customer assessment', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let directory: string;
  let coordinator: ReturnType<typeof createBackend>;
  let scope: { organizationId: string; applicationId: string };
  let source: { id: string; digest: string };
  let jobId: string;
  let scanner: OwnedChild;
  let coordinatorProcess: OwnedChild;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    coordinator = createBackend({ database: f.databases.gotchu_api });
    const identity = { userId: f.a.userId };
    const workspace = await coordinator.customers.createWorkspace(identity, { name: `Production scanner ${randomUUID()}` });
    const application = await coordinator.customers.createApplication(identity, { organizationId: workspace.id, name: 'Groundtruth TLS application' });
    scope = { organizationId: workspace.id, applicationId: application.applicationId };
    source = await coordinator.customers.uploadSource(identity, { ...scope, snapshot: groundtruth, authorized: true });
    ({ jobId } = await coordinator.customers.queue(identity, {
      ...scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID(),
    }));

    directory = await mkdtemp(join(tmpdir(), 'gotchu-production-scanner-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const caKey = join(directory, 'operator-ca.key');
    const caFile = join(directory, 'operator-ca.pem');
    const keyFile = join(directory, 'scanner.key');
    const requestFile = join(directory, 'scanner.csr');
    const certFile = join(directory, 'scanner.pem');
    const extensionFile = join(directory, 'scanner.ext');
    const secretFile = join(directory, 'scanner.secret');
    await writeFile(extensionFile, 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', { mode: 0o600, flag: 'wx' });
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caFile, '-days', '1', '-subj', '/CN=Gotchu test operator CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { timeout: 10_000, maxBuffer: 65_536 });
    await promisify(execFile)('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', requestFile, '-subj', '/CN=localhost'], { timeout: 10_000, maxBuffer: 65_536 });
    await promisify(execFile)('openssl', ['x509', '-req', '-in', requestFile, '-CA', caFile, '-CAkey', caKey, '-CAcreateserial', '-out', certFile, '-days', '1', '-extfile', extensionFile], { timeout: 10_000, maxBuffer: 65_536 });
    await writeFile(secretFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    await Promise.all([chmod(caKey, 0o600), chmod(keyFile, 0o600), chmod(secretFile, 0o600)]);
    const ca = await readFile(caFile, 'utf8');
    const scannerPort = await loopbackPort();
    scanner = startChild('production scanner', join(root, 'apps/scanner/dist/main.js'), scannerPort, {
      NODE_ENV: 'production', GOTCHU_SCANNER_TLS_CERT_FILE: certFile, GOTCHU_SCANNER_TLS_KEY_FILE: keyFile,
      GOTCHU_SCANNER_HOST: '127.0.0.1', GOTCHU_SCANNER_PORT: String(scannerPort), GOTCHU_SCANNER_SECRET_FILE: secretFile,
    }, cleanups);
    await eventually(async () => {
      assertAlive(scanner);
      let response: Awaited<ReturnType<typeof getScannerJson>>;
      try {
        response = await getScannerJson(scannerPort, ca);
      } catch { return undefined; }
      if (response.status !== 200 && response.status !== 503) throw new Error('Scanner readiness returned an unexpected status');
      const state = readinessSchema.parse(response.body);
      const pinnedTools = ['semgrep', 'gitleaks', 'trivy'];
      return pinnedTools.every(name => state.tools.some(tool => tool.name === name && tool.available)) ? state : undefined;
    }, 'production pinned Docker scanner readiness');

    const coordinatorPort = await loopbackPort();
    coordinatorProcess = startChild('production coordinator', join(root, 'apps/coordinator/dist/main.js'), coordinatorPort, {
      NODE_ENV: 'production', PORT: String(coordinatorPort), GOTCHU_COORDINATOR_HOST: '127.0.0.1',
      GOTCHU_COORDINATOR_DATABASE_URL: f.runtimeConnectionString('gotchu_coordinator'),
      GOTCHU_REDIS_URL: present(process.env.GOTCHU_TEST_REDIS_URL), GOTCHU_CUSTOMER_DISCOVERY: 'true',
      GOTCHU_SCANNER_ORIGIN: `https://localhost:${scannerPort}`, GOTCHU_SCANNER_CA_FILE: caFile,
      GOTCHU_SCANNER_SECRET_FILE: secretFile,
    }, cleanups);
    await eventually(async () => {
      assertAlive(coordinatorProcess);
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${coordinatorPort}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      } catch { return undefined; }
      if (response.status !== 200) return undefined;
      const state = diagnosticsSchema.parse(await response.json());
      return state.customerDiscovery && state.customerScannerConfigured && state.assignedOrganizations > 0 ? state : undefined;
    }, 'production coordinator readiness', 30_000);
  }, 180_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    try { await f?.close(); } catch (error) { errors.push(error); }
    expect(errors).toEqual([]);
  }, 30_000);

  it('scans original source over scoped TLS and persists one tenant-bound report and delivery', async () => {
    const identity = { userId: present(f).a.userId };
    const job = await eventually(async () => {
      assertAlive(coordinatorProcess);
      const current = await present(coordinator).web.getJob(identity, { ...scope, jobId });
      if (current.state === 'failed') throw new Error(`Production scanner job failed: ${current.reasonCode ?? 'unknown'}`);
      if (current.state !== 'succeeded') return undefined;
      const delivery = await present(f).admin.query<{ delivered_at: Date | null }>(
        "SELECT delivered_at FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2 AND envelope->>'kind'='audit'",
        [scope.organizationId, jobId],
      );
      return delivery.rows[0]?.delivered_at ? current : undefined;
    }, 'durable production scanner job completion', 120_000);
    expect(job).toMatchObject({ state: 'succeeded', kind: 'audit', outcome: 'completed', reportId: expect.any(String), attempts: 1 });
    const reportId = present(job.reportId);
    const report = await present(coordinator).customers.getReport(identity, { ...scope, reportId });
    expect(report).toMatchObject({ version: 2, id: reportId, jobId, mode: 'internal', subject: { sourceSnapshotId: source.id, sourceDigest: source.digest, targetId: null } });
    const internal = present(report.internal);
    expect(internal.findings.map(finding => finding.ruleId)).toEqual(expect.arrayContaining(['gotchu.javascript.eval', 'gotchu.javascript.tls-disabled']));
    const semgrep = internal.evidence.find(evidence => evidence.locator === 'scanner-profile:semgrep');
    expect(semgrep?.tool).toEqual({ name: 'semgrep', version: '1.182.0' });
    const profile: unknown = JSON.parse(present(semgrep).excerpt);
    expect(z.object({ image: z.string(), sourceDigest: z.string() }).parse(profile)).toMatchObject({ image: pinnedImage, sourceDigest: source.digest });

    const persistedSource = await present(f).admin.query<{ digest: string; body: unknown }>(
      'SELECT digest,body FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3',
      [scope.organizationId, scope.applicationId, source.id],
    );
    expect(persistedSource.rows).toHaveLength(1);
    expect(persistedSource.rows[0]).toMatchObject({ digest: source.digest, body: groundtruth });
    const request = await present(f).admin.query<{ source_id: string; input: unknown }>(
      'SELECT source_id,input FROM gotchu.customer_requests WHERE organization_id=$1 AND application_id=$2 AND job_id=$3',
      [scope.organizationId, scope.applicationId, jobId],
    );
    expect(request.rows).toHaveLength(1);
    expect(request.rows[0]).toMatchObject({ source_id: source.id, input: { jobId, source: { id: source.id, digest: source.digest } } });
    const outbox = await present(f).admin.query<{ organization_id: string; job_id: string; envelope: unknown; delivered_at: Date | null }>(
      "SELECT organization_id,job_id,envelope,delivered_at FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2 AND envelope->>'kind'='audit'",
      [scope.organizationId, jobId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      organization_id: scope.organizationId, job_id: jobId,
      envelope: { version: 1, id: jobId, organizationId: scope.organizationId, applicationId: scope.applicationId, kind: 'audit' },
    });
    expect(outbox.rows[0]?.delivered_at).not.toBeNull();
    const persistedReport = await present(f).admin.query<{ id: string; job_id: string; body: unknown }>(
      'SELECT id,job_id,body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND job_id=$3',
      [scope.organizationId, scope.applicationId, jobId],
    );
    expect(persistedReport.rows).toEqual([{ id: reportId, job_id: jobId, body: report }]);
    const persistedJob = await present(f).admin.query<{ state: string; result: unknown; attempts: number }>(
      'SELECT state,result,attempts FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3',
      [scope.organizationId, scope.applicationId, jobId],
    );
    expect(persistedJob.rows).toEqual([{ state: 'succeeded', result: { status: 'completed', reportId }, attempts: 1 }]);
    const reports = await present(f).admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND job_id=$3',
      [scope.organizationId, scope.applicationId, jobId],
    );
    expect(reports.rows[0]?.count).toBe(1);

    const stranger = { userId: present(f).b.userId };
    await expect(present(coordinator).customers.getReport(stranger, { ...scope, reportId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(present(coordinator).web.getJob(stranger, { ...scope, jobId })).rejects.toMatchObject({ code: 'forbidden' });
  }, 180_000);
});
