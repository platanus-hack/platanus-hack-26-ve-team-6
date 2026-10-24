import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBackend, DEMO_ASSESSMENT_SCOPE, DEMO_ASSESSMENT_TARGET_KEY } from '@gotchu/backend';
import { createCoordinatorTransport, dispatchOutbox } from '@gotchu/coordinator';
import { createControlledAssessmentRunner } from '../../packages/assessment/dist/index.js';
import { startDemoTargetServer } from '../../apps/demo-target/dist/index.js';
import { assessmentQueuedSchema, assessmentReportSchema, demoAssessmentJobSchema, demoWorkspaceSchema, type AssessmentReport, type AssessmentRequest } from '../../packages/contracts/src/index.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';
import { bindDemoAssessmentServices, createDemoAssessmentApi } from '../../apps/web/src/server/demo.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
const { organizationId, applicationId, userId } = DEMO_ASSESSMENT_SCOPE;
const request = { mode: 'both', revision: 'vulnerable' } satisfies AssessmentRequest;
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const captureSchema = z.object({
  url: z.url(), method: z.literal('GET'), status: z.literal(200),
  selectedHeaders: z.array(z.object({ name: z.string(), valueBase64: z.string() }).strict()),
  bodyBase64: z.string(), bodyComplete: z.literal(true), problem: z.null(),
}).strict();

async function eventually(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${description}`);
}

live('controlled assessment over HTTP, Postgres and BullMQ (real bounded runner)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let web: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  const cleanups: Array<() => Promise<void>> = [];
  const errors: unknown[] = [];

  beforeAll(async () => {
    f = await fixture({ max: 6 });
    web = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    // Exercise the operator seed itself; runtime operations below use restricted roles.
    for (let i = 0; i < 2; i++) await promisify(execFile)(process.execPath, ['scripts/assessment-demo-seed.mjs'], {
      cwd: root, env: { ...process.env, GOTCHU_MIGRATION_DATABASE_URL: present(liveUrl) },
    });
  });

  beforeEach(async () => {
    // Only this suite's fixed demo tenant is reset, inside the disposable test database.
    for (const table of ['assessment_reports', 'outbox', 'assessment_requests', 'jobs', 'audit_records']) {
      await f.admin.query(`DELETE FROM gotchu.${table} WHERE organization_id=$1`, [organizationId]);
    }
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const close of cleanups.splice(0).reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    const actions = await f.admin.query<{ count: number }>(`SELECT (
      (SELECT count(*) FROM gotchu.proposals WHERE organization_id=$1)
      + (SELECT count(*) FROM gotchu.approvals WHERE organization_id=$1)
      + (SELECT count(*) FROM gotchu.executions WHERE organization_id=$1)
      + (SELECT count(*) FROM gotchu.agent_runs WHERE organization_id=$1)
    )::int AS count`, [organizationId]);
    expect(actions.rows[0]?.count).toBe(0);
    expect([...failures, ...errors.splice(0)]).toEqual([]);
  });
  afterAll(async () => { await f?.close(); });

  async function httpApi(enabled = true) {
    let api: ReturnType<typeof createDemoAssessmentApi>;
    let origin: string;
    // Test-only Node HTTP bridge; the actual web Request/Response handler and service binding run unchanged.
    const server = createServer((incoming, outgoing) => {
      async function serve() {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const method = incoming.method ?? 'GET';
        const response = await api(new Request(`${origin}${incoming.url ?? '/'}`, {
          method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
        }));
        response.headers.forEach((value, name) => outgoing.setHeader(name, value));
        outgoing.writeHead(response.status);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
      serve().catch(error => { errors.push(error); outgoing.writeHead(500).end(); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP bridge did not bind a loopback port');
    origin = `http://127.0.0.1:${address.port}`;
    api = createDemoAssessmentApi({ enabled, origin, services: bindDemoAssessmentServices(web) });
    return {
      origin,
      get: (path: string) => fetch(`${origin}/api/demo/${path}`, { signal: AbortSignal.timeout(5000) }),
      post: (payload: unknown = request, key: string = randomUUID(), headers: Record<string, string> = {}) => fetch(`${origin}/api/demo/assessments`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': key, ...headers },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
      }),
    };
  }

  async function target() {
    const value = await startDemoTargetServer({ port: 0 });
    cleanups.push(value.close);
    return value;
  }

  async function transport(runner: ReturnType<typeof createControlledAssessmentRunner>) {
    const value = createCoordinatorTransport({
      redisUrl: present(redisUrl), prefix: `gotchu-demo-e2e-${randomUUID()}`,
      organizationIds: [organizationId, f.a.organizationId],
      dependencies: { database: f.databases.gotchu_coordinator, backend: coordinator, assessmentRunner: runner },
      report: (event, error) => errors.push(new Error(event, { cause: error })),
    });
    cleanups.push(value.close);
    await value.waitUntilReady();
    return value;
  }

  async function queued(response: Response) {
    expect(response.status).toBe(202);
    return assessmentQueuedSchema.parse(await response.json());
  }

  async function finished(api: Awaited<ReturnType<typeof httpApi>>, jobId: string) {
    let reportId: string | null = null;
    await eventually(async () => {
      const response = await api.get(`jobs/${jobId}`);
      expect(response.status).toBe(200);
      const job = demoAssessmentJobSchema.parse(await response.json());
      expect(job.id).toBe(jobId);
      if (job.state === 'failed') throw new Error(`Assessment failed: ${job.reasonCode}`);
      if (job.state !== 'succeeded') return false;
      expect(job.reasonCode).toBeNull();
      reportId = job.reportId;
      return true;
    }, `assessment ${jobId} to persist its report`);
    const response = await api.get(`reports/${present(reportId)}`);
    expect(response.status).toBe(200);
    return assessmentReportSchema.parse(await response.json());
  }

  async function checkEvidence(report: AssessmentReport, targetOrigin: string) {
    for (const evidence of report.internal?.evidence ?? []) {
      const path = evidence.locator.split('/').at(-1);
      expect(path).toBeDefined();
      const source = evidence.kind === 'advisory'
        ? new URL(`../../packages/assessment/advisories/${path}`, import.meta.url)
        : new URL(`../../apps/demo-target/src/fixtures/${report.revision}/${path}`, import.meta.url);
      const bytes = await readFile(source);
      expect(evidence.checksum).toBe(sha256(bytes));
      expect(evidence.snapshotRef).toBe(`sha256:${sha256(bytes)}`);
      expect(evidence.excerpt).toBe(bytes.toString('utf8').slice(0, 4096));
    }
    for (const evidence of report.external?.evidence ?? []) {
      expect(evidence.kind).toBe('http_response');
      expect(evidence.checksum).toBe(sha256(evidence.excerpt));
      expect(evidence.snapshotRef).toBe(`sha256:${evidence.checksum}`);
      const capture = captureSchema.parse(JSON.parse(evidence.excerpt));
      expect(capture.url).toBe(`${targetOrigin}/${report.revision}`);
      // Compare persisted capture to another actual response, not a fabricated finding fixture.
      const actual = await fetch(capture.url, { signal: AbortSignal.timeout(5000) });
      expect(actual.status).toBe(200);
      expect(capture.bodyBase64).toBe(Buffer.from(await actual.arrayBuffer()).toString('base64'));
      for (const header of capture.selectedHeaders) expect(Buffer.from(header.valueBase64, 'base64').toString()).toBe(actual.headers.get(header.name));
    }
    const findings = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
    expect(report.comparison.flatMap(row => [...row.internalFindingIds, ...row.externalFindingIds]).sort()).toEqual(findings.map(item => item.id).sort());
    expect(findings.every(item => item.exploitability === 'not_demonstrated')).toBe(true);
    expect(report).toMatchObject({ organizationId, applicationId, responseMode: 'observation', actionsPerformed: [] });
    expect(report.limitations.join(' ')).toContain('not a comprehensive audit');
    for (const analysis of [report.internal, report.external]) {
      if (!analysis) continue;
      expect(analysis.status).toBe('completed');
      expect(analysis.coverage.some(item => item.state === 'unsupported')).toBe(true);
      for (const finding of analysis.findings) expect(finding.evidenceIds.every(id => analysis.evidence.some(item => item.id === id))).toBe(true);
    }
  }

  it.each(['internal', 'external', 'both'] as const)('persists real %s evidence for both revisions through the full live pipeline', async mode => {
    const api = await httpApi();
    const demo = await target();
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin }));
    const reports: AssessmentReport[] = [];
    for (const revision of ['vulnerable', 'corrected'] as const) {
      const { jobId } = await queued(await api.post({ mode, revision }));
      const pending = demoAssessmentJobSchema.parse(await (await api.get(`jobs/${jobId}`)).json());
      expect(pending).toMatchObject({ id: jobId, state: 'queued', reportId: null });
      await dispatchOutbox(coordinator, organizationId, bus.publish);
      const report = await finished(api, jobId);
      reports.push(report);
      expect(report).toMatchObject({ jobId, mode, revision });
      expect(report.internal === null).toBe(mode === 'external');
      expect(report.external === null).toBe(mode === 'internal');
      if (report.internal) expect(report.internal.findings.map(item => item.correlationKey).sort()).toEqual(revision === 'vulnerable'
        ? ['dependency:lodash:GHSA-35jh-r3h4-6jhm', 'http:content-security-policy', 'source:audit-email'] : []);
      if (report.external) expect(report.external.findings.map(item => item.correlationKey).sort()).toEqual(revision === 'vulnerable'
        ? ['http:content-security-policy', 'http:technology-banner'] : ['http:technology-banner']);
      if (mode === 'both') expect(report.comparison.map(row => [row.key, row.classification])).toEqual(revision === 'vulnerable' ? [
        ['source:audit-email', 'internal_only'], ['http:content-security-policy', 'both'],
        ['dependency:lodash:GHSA-35jh-r3h4-6jhm', 'internal_only'], ['http:technology-banner', 'external_only'],
      ] : [['http:technology-banner', 'external_only']]);
      else expect(report.comparison.every(row => row.classification === 'unverified')).toBe(true);
      await checkEvidence(report, demo.origin);
      const persisted = await f.admin.query<{ body: unknown }>('SELECT body FROM gotchu.assessment_reports WHERE organization_id=$1 AND job_id=$2', [organizationId, jobId]);
      expect(persisted.rows).toHaveLength(1);
      expect(assessmentReportSchema.parse(persisted.rows[0]?.body)).toEqual(report);
      expect((await f.admin.query('SELECT id FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2 AND delivered_at IS NOT NULL', [organizationId, jobId])).rowCount).toBe(1);
      await eventually(async () => await (await bus.queues.assessment.getJob(jobId))?.getState() === 'completed', 'BullMQ completion');
      expect((await bus.queues.assessment.getJob(jobId))?.id).toBe(jobId);
      expect(await bus.queues.deterministic.getJob(jobId)).toBeUndefined();
      expect(await bus.queues.investigation.getJob(jobId)).toBeUndefined();
    }
    if (mode !== 'external') expect(reports[0]?.internal?.snapshotRef).not.toBe(reports[1]?.internal?.snapshotRef);
    if (mode !== 'internal') expect(reports[0]?.external?.snapshotRef).not.toBe(reports[1]?.external?.snapshotRef);
    const workspaceResponse = await api.get('workspace');
    expect(workspaceResponse.status).toBe(200);
    const workspace = demoWorkspaceSchema.parse(await workspaceResponse.json());
    expect(workspace).toMatchObject({ targetConfigured: true, application: { id: applicationId }, responseMode: 'observation', providerRequired: false });
    expect(workspace.reports.map(item => item.id).sort()).toEqual(reports.map(item => item.id).sort());
  });

  it('runs external mode without any repository access through the durable worker', async () => {
    const api = await httpApi();
    const demo = await target();
    let sourceReads = 0;
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin, repository: {
      readFile: async () => { sourceReads++; throw new Error('Repository is unavailable to this external-only runner'); },
    } }));
    const { jobId } = await queued(await api.post({ mode: 'external', revision: 'vulnerable' }));
    await dispatchOutbox(coordinator, organizationId, bus.publish);
    const report = await finished(api, jobId);
    expect(sourceReads).toBe(0);
    expect(report.internal).toBeNull();
    expect(report.external?.status).toBe('completed');
    expect(report.external?.findings).toHaveLength(2);
    expect(report.comparison.every(row => row.classification === 'unverified')).toBe(true);
    await checkEvidence(report, demo.origin);
  });

  it('reuses the durable job across API instances and duplicate BullMQ delivery without creating another report', async () => {
    const first = await httpApi();
    const second = await httpApi();
    const demo = await target();
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin }));
    const key = randomUUID();
    const accepted = await Promise.all([first.post(request, key), second.post(request, key)]);
    const a = await queued(present(accepted[0]));
    expect(await queued(present(accepted[1]))).toEqual(a);
    await dispatchOutbox(coordinator, organizationId, bus.publish);
    const report = await finished(first, a.jobId);
    await eventually(async () => await (await bus.queues.assessment.getJob(a.jobId))?.getState() === 'completed', 'first transport completion');
    expect(await queued(await second.post(request, key))).toEqual(a);
    // Expire Redis retention, then redeliver the exact durable envelope through the real worker.
    await present(await bus.queues.assessment.getJob(a.jobId)).remove();
    await bus.publish({ version: 1, id: a.jobId, organizationId, applicationId, kind: 'audit' });
    await eventually(async () => await (await bus.queues.assessment.getJob(a.jobId))?.getState() === 'completed', 'duplicate transport completion');
    expect(await finished(second, a.jobId)).toEqual(report);
    const third = await httpApi();
    const conflict = await third.post({ ...request, revision: 'corrected' }, key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });
    for (const table of ['jobs', 'outbox', 'assessment_requests', 'assessment_reports']) expect((await f.admin.query(`SELECT 1 FROM gotchu.${table} WHERE organization_id=$1`, [organizationId])).rowCount).toBe(1);
    expect((await f.admin.query<{ attempts: number }>('SELECT attempts FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [organizationId, a.jobId])).rows[0]?.attempts).toBe(1);
  });

  it('requires explicit public-demo opt-in even when the real services and target are configured', async () => {
    const api = await httpApi(false);
    for (const response of [await api.get('workspace'), await api.post()]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'demo_not_enabled' } });
    }
    expect((await f.admin.query('SELECT 1 FROM gotchu.jobs WHERE organization_id=$1', [organizationId])).rowCount).toBe(0);
  });

  it.each([
    { url: 'http://169.254.169.254/latest/meta-data' }, { origin: 'http://127.0.0.1:9999' },
    { organizationId: randomUUID() }, { applicationId: randomUUID() }, { userId: 'operator' },
    { responseMode: 'automatic_limited' }, { targetKey: 'other-target' }, { revision: '../corrected' },
  ])('rejects caller scope, targets and response permissions: %j', async extra => {
    const api = await httpApi();
    const response = await api.post({ ...request, ...extra });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
    expect((await f.admin.query('SELECT 1 FROM gotchu.jobs WHERE organization_id=$1', [organizationId])).rowCount).toBe(0);
    expect((await f.admin.query('SELECT 1 FROM gotchu.outbox WHERE organization_id=$1', [organizationId])).rowCount).toBe(0);
  });

  it('enforces same-origin and body bounds before queueing', async () => {
    const api = await httpApi();
    expect((await api.post(request, randomUUID(), { origin: 'https://elsewhere.invalid' })).status).toBe(403);
    expect((await api.post(request, randomUUID(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await api.post(request, 'not-a-uuid')).status).toBe(400);
    expect((await api.post({ ...request, padding: 'x'.repeat(1024) })).status).toBe(413);
    expect((await f.admin.query('SELECT 1 FROM gotchu.jobs WHERE organization_id=$1', [organizationId])).rowCount).toBe(0);
  });

  it('keeps actual customer reports and jobs outside the public demo scope', async () => {
    const api = await httpApi();
    const demo = await target();
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin }));
    await f.admin.query('INSERT INTO gotchu.assessment_targets(organization_id,application_id,target_key,enabled) VALUES ($1,$2,$3,true)', [f.a.organizationId, f.a.applicationId, DEMO_ASSESSMENT_TARGET_KEY]);
    const foreign = await web.assessments.queue({ userId: f.a.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, ...request, idempotencyKey: randomUUID() });
    await dispatchOutbox(coordinator, f.a.organizationId, bus.publish);
    await eventually(async () => (await web.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: foreign.jobId })).state === 'succeeded', 'customer report completion');
    const job = await web.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: foreign.jobId });
    expect((await api.get(`reports/${present(job.reportId)}`)).status).toBe(404);
    // The fixed demo principal is denied when the job lookup has no authorized demo app.
    expect((await api.get(`jobs/${foreign.jobId}`)).status).toBe(403);
    expect(demoWorkspaceSchema.parse(await (await api.get('workspace')).json()).reports).toEqual([]);
    await expect(web.assessments.get({ userId: f.b.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, reportId: present(job.reportId) })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await f.databases.gotchu_api.tenant(organizationId, async tx => (await tx.query('SELECT id FROM gotchu.assessment_reports WHERE id=$1', [job.reportId])).rowCount)).toBe(0);
    await expect(web.assessments.queue({ userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, ...request, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(web.web.queueAudit({ userId }, { organizationId, applicationId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' });
    for (const database of [f.databases.gotchu_api, f.databases.gotchu_coordinator]) {
      await expect(database.tenant(organizationId, tx => tx.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [organizationId]))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('honors operator target revocation before delivery without persisting a fabricated success', async () => {
    const api = await httpApi();
    const demo = await target();
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin }));
    const { jobId } = await queued(await api.post());
    await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [organizationId]);
    try {
      const denied = await api.post();
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: 'demo_target_not_configured' } });
      await dispatchOutbox(coordinator, organizationId, bus.publish);
      await eventually(async () => demoAssessmentJobSchema.parse(await (await api.get(`jobs/${jobId}`)).json()).state === 'failed', 'revoked job failure');
      expect(demoAssessmentJobSchema.parse(await (await api.get(`jobs/${jobId}`)).json())).toMatchObject({ state: 'failed', reasonCode: 'assessment_target_changed', reportId: null });
      expect((await f.admin.query('SELECT id FROM gotchu.assessment_reports WHERE organization_id=$1', [organizationId])).rowCount).toBe(0);
    } finally { await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=true WHERE organization_id=$1', [organizationId]); }
  });

  it('admits only three unfinished jobs across HTTP instances and permits exact retries at capacity', async () => {
    const apis = [await httpApi(), await httpApi()];
    const submissions = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const key = randomUUID();
      const response = await present(apis[index % apis.length]).post(request, key);
      return { key, response };
    }));
    expect(submissions.filter(item => item.response.status === 202)).toHaveLength(3);
    expect(submissions.filter(item => item.response.status === 429)).toHaveLength(3);
    for (const { key, response } of submissions) {
      if (response.status === 202) {
        const original = await queued(response);
        expect(await queued(await present(apis[0]).post(request, key))).toEqual(original);
      } else expect(await response.json()).toMatchObject({ error: { code: 'assessment_capacity_exceeded' } });
    }
    const jobs = await f.admin.query<{ state: string }>('SELECT state FROM gotchu.jobs WHERE organization_id=$1', [organizationId]);
    expect(jobs.rows).toEqual([{ state: 'queued' }, { state: 'queued' }, { state: 'queued' }]);
    expect((await f.admin.query('SELECT 1 FROM gotchu.outbox WHERE organization_id=$1', [organizationId])).rowCount).toBe(3);
  });

  it('enforces the 100-job lifetime bound across API instances while preserving completed-job retries', async () => {
    const api = await httpApi();
    const demo = await target();
    const bus = await transport(createControlledAssessmentRunner({ origin: demo.origin }));
    const key = randomUUID();
    const original = await queued(await api.post(request, key));
    await dispatchOutbox(coordinator, organizationId, bus.publish);
    await finished(api, original.jobId);
    // Historical terminal jobs are quota fixtures, not claimed as 98 executed assessments.
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,state)
      SELECT $1,$2,gen_random_uuid(),'audit','lifetime-fixture-'||i,'failed' FROM generate_series(1,98) AS i`, [organizationId, applicationId]);
    const second = await httpApi();
    const attempts = await Promise.all([api.post(), second.post()]);
    expect(attempts.map(item => item.status).sort()).toEqual([202, 429]);
    const rejected = present(attempts.find(item => item.status === 429));
    expect(await rejected.json()).toMatchObject({ error: { code: 'demo_assessment_limit' } });
    expect(await queued(await second.post(request, key))).toEqual(original);
    expect((await f.admin.query('SELECT 1 FROM gotchu.jobs WHERE organization_id=$1', [organizationId])).rowCount).toBe(100);
  });
});
