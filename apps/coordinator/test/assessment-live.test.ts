import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, enqueue, type JobClaim } from '@gotchu/backend';
import type { AssessmentReport } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { assessmentReportFixture } from '../../../packages/backend/test/assessment-fixtures.js';
import { createCustomerAssessmentRunner, createDockerScanners } from '@gotchu/customer-assessment';
import { createCoordinatorTransport, dispatchOutbox, processDurableJob, reconcileDurableDeliveries, type AssessmentRunner } from '../src/index.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
live('live Postgres/Redis assessment delivery', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let backend: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    api = createBackend({ database: f.databases.gotchu_api });
    backend = createBackend({ database: f.databases.gotchu_coordinator });
    await f.admin.query("INSERT INTO gotchu.assessment_targets(organization_id,application_id,target_key,enabled) VALUES ($1,$2,'controlled-demo-store',true)", [f.a.organizationId, f.a.applicationId]);
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  const dependencies = () => ({ database: f.databases.gotchu_coordinator, backend });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  async function queue() {
    const { jobId } = await api.assessments.queue({ userId: f.a.userId }, { ...scope(), mode: 'both', revision: 'vulnerable', idempotencyKey: randomUUID() });
    return { version: 1 as const, id: jobId, ...scope(), kind: 'audit' as const };
  }
  async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const jobState = async (id: string) => (await f.admin.query<{ state: string }>('SELECT state FROM gotchu.jobs WHERE id=$1', [id])).rows[0]?.state;

  async function customerTargetJob() {
    let proof = '';
    const customerApi = createBackend({ database: f.databases.gotchu_api, customerDnsVerifier: { resolveTxt: async () => [[proof]] } });
    const identity = { userId: `credentials:${randomUUID()}` };
    const workspace = await customerApi.customers.createWorkspace(identity, { name: 'Uncertain scanner test' });
    const application = await customerApi.customers.createApplication(identity, { organizationId: workspace.id, name: 'Authorized target' });
    const customerScope = { organizationId: workspace.id, applicationId: application.applicationId };
    const enrollment = await customerApi.customers.enrollTarget(identity, { ...customerScope, origin: 'https://customer.example.com', authorized: true });
    proof = enrollment.challenge.value;
    await customerApi.customers.verifyTarget(identity, { ...customerScope, targetId: enrollment.target.id });
    const { jobId } = await customerApi.customers.queue(identity, { ...customerScope, mode: 'external', sourceSnapshotId: null, targetId: enrollment.target.id, idempotencyKey: randomUUID() });
    return { customerApi, identity, customerScope, targetId: enrollment.target.id, envelope: { version: 1 as const, id: jobId, ...customerScope, kind: 'audit' as const } };
  }

  it('quarantines an uncertain remote scanner outcome instead of releasing target authorization', async () => {
    const c = await customerTargetJob();
    let calls = 0;
    await processDurableJob({ ...dependencies(), customerAssessmentRunner: { run: async () => { calls++; throw new Error('Synthetic transport failure after remote admission'); } } }, c.envelope);
    expect(calls).toBe(1);
    expect(await c.customerApi.web.getJob(c.identity, { organizationId: c.customerScope.organizationId, jobId: c.envelope.id })).toMatchObject({ state: 'failed', reasonCode: 'assessment_reconciliation_required', reportId: null });
    await expect(c.customerApi.customers.revokeTarget(c.identity, { ...c.customerScope, targetId: c.targetId })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
    expect(await processDurableJob(dependencies(), c.envelope)).toEqual({ status: 'already_terminal' });
  });

  it('does not replay customer scanning after a consumer loses its durable claim', async () => {
    const c = await customerTargetJob();
    await backend.jobs.claim({ organizationId: c.customerScope.organizationId, jobId: c.envelope.id });
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [c.customerScope.organizationId, c.envelope.id]);
    let calls = 0;
    await processDurableJob({ ...dependencies(), customerAssessmentRunner: { run: async () => { calls++; throw new Error('Must not replay'); } } }, c.envelope);
    expect(calls).toBe(0);
    expect(await c.customerApi.web.getJob(c.identity, { organizationId: c.customerScope.organizationId, jobId: c.envelope.id })).toMatchObject({ state: 'failed', reasonCode: 'assessment_reconciliation_required' });
    await expect(c.customerApi.customers.revokeTarget(c.identity, { ...c.customerScope, targetId: c.targetId })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
    const unconfigured = await customerTargetJob();
    await backend.jobs.claim({ organizationId: unconfigured.customerScope.organizationId, jobId: unconfigured.envelope.id });
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [unconfigured.customerScope.organizationId, unconfigured.envelope.id]);
    await processDurableJob(dependencies(), unconfigured.envelope);
    expect(await unconfigured.customerApi.web.getJob(unconfigured.identity, { organizationId: unconfigured.customerScope.organizationId, jobId: unconfigured.envelope.id })).toMatchObject({ state: 'failed', reasonCode: 'assessment_reconciliation_required' });
    await expect(unconfigured.customerApi.customers.revokeTarget(unconfigured.identity, { ...unconfigured.customerScope, targetId: unconfigured.targetId })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
    await expect(unconfigured.customerApi.customers.enrollTarget(unconfigured.identity, { ...unconfigured.customerScope, origin: 'https://customer.example.com', authorized: true })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
  });

  it('fails unconfigured and malformed adapters visibly without storing a successful report', async () => {
    const unconfigured = await queue();
    await processDurableJob(dependencies(), unconfigured);
    expect(await api.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: unconfigured.id })).toMatchObject({ state: 'failed', reasonCode: 'audit_adapter_not_configured', reportId: null });
    const malformed = await queue();
    const runner: AssessmentRunner = { run: async input => ({ ...assessmentReportFixture(input), applicationId: randomUUID() }) };
    await processDurableJob({ ...dependencies(), assessmentRunner: runner }, malformed);
    expect(await api.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: malformed.id })).toMatchObject({ state: 'failed', reasonCode: 'assessment_scope_mismatch', reportId: null });
  });

  it('scans a public digest through the durable job and persists its CVE report', async () => {
    const customerApi = createBackend({ database: f.databases.gotchu_api });
    const identity = { userId: `credentials:${randomUUID()}` };
    const workspace = await customerApi.customers.createWorkspace(identity, { name: 'Container image live test' });
    const application = await customerApi.customers.createApplication(identity, { organizationId: workspace.id, name: 'Pinned image' });
    const customerScope = { organizationId: workspace.id, applicationId: application.applicationId };
    const reference = 'docker.io/library/alpine@sha256:a15790640a6690aa1730c38cf0a440e2aa44aaca9b0e8931a9f2b0d7cc90fd65';
    const { jobId } = await customerApi.customers.queue(identity, {
      ...customerScope, mode: 'internal', sourceSnapshotId: null, targetId: null, inputKind: 'container_image',
      containerImage: { kind: 'registry', reference }, idempotencyKey: randomUUID(),
    });
    const transport = createCoordinatorTransport({
      redisUrl: present(redisUrl), organizationIds: [workspace.id],
      dependencies: { ...dependencies(), customerAssessmentRunner: createCustomerAssessmentRunner({ scanners: createDockerScanners() }) },
      prefix: `container-image-live-${randomUUID()}`,
      report: () => undefined,
    });
    try {
      await transport.waitUntilReady();
      await dispatchOutbox(backend, workspace.id, transport.publish);
      await eventually(async () => (await customerApi.web.getJob(identity, { organizationId: workspace.id, jobId })).state === 'succeeded', 'container image assessment completion', 120_000);
      const job = await customerApi.web.getJob(identity, { organizationId: workspace.id, jobId });
      if (job.state !== 'succeeded' || !job.reportId) throw new Error('container_image_report_not_persisted');
      const report = await customerApi.customers.getReport(identity, { ...customerScope, reportId: job.reportId });
      expect(report.subject).toMatchObject({ containerImageDigest: reference.slice(reference.lastIndexOf('@sha256:') + 8), containerImageReference: reference });
      expect(report.internal?.findings.some(item => /^CVE-/.test(item.ruleId))).toBe(true);
      expect(report.internal?.coverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability: 'container_image_os_cves', state: 'inspected' }),
        expect.objectContaining({ capability: 'container_image_vulnerability_database', state: 'inspected' }),
      ]));
      const persisted = await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [workspace.id, application.applicationId, job.reportId]);
      expect(persisted.rows[0]?.count).toBe(1);
    } finally {
      await transport.close();
    }
  }, 180_000);

  it('runs reads outside database transactions and rejects stale completion without touching the new owner', async () => {
    const envelope = await queue();
    let reclaimed: JobClaim | null = null;
    const runner: AssessmentRunner = { run: async input => {
      const active = await f.admin.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename LIKE 'gotchu_coordinator_%' AND state='idle in transaction'");
      expect(active.rows[0]?.count).toBe(0);
      await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [input.jobId]);
      reclaimed = await backend.jobs.claim({ organizationId: input.organizationId, jobId: input.jobId });
      return assessmentReportFixture(input);
    } };
    await expect(processDurableJob({ ...dependencies(), assessmentRunner: runner }, envelope)).rejects.toMatchObject({ code: 'stale_lease' });
    expect(reclaimed).not.toBeNull();
    expect(await jobState(envelope.id)).toBe('running');
    expect((await f.admin.query('SELECT id FROM gotchu.assessment_reports WHERE job_id=$1', [envelope.id])).rowCount).toBe(0);
    await f.admin.query("UPDATE gotchu.jobs SET state='failed',lease_until=NULL WHERE id=$1", [envelope.id]);
  });

  it('reserves event capacity while one audit blocks, routes recovery into the audit lane and persists reports once', async () => {
    const first = await queue();
    const second = await queue();
    const pending: Array<{ report: AssessmentReport; finish: (report: AssessmentReport) => void }> = [];
    const runner: AssessmentRunner = { run: input => new Promise(resolve => { pending.push({ report: assessmentReportFixture(input), finish: resolve }); }) };
    const errors: unknown[] = [];
    const transport = createCoordinatorTransport({ redisUrl: present(redisUrl), organizationIds: [f.a.organizationId], dependencies: { ...dependencies(), assessmentRunner: runner },
      prefix: `assessment-test-${randomUUID()}`, report: (_event, error) => { errors.push(error); } });
    try {
      await transport.waitUntilReady();
      await dispatchOutbox(backend, f.a.organizationId, transport.publish);
      await eventually(async () => pending.length === 1, 'first audit start');
      expect(await transport.queues.assessment.getActiveCount()).toBe(1);
      expect(await transport.queues.assessment.getWaitingCount()).toBe(1);
      const eventId = randomUUID();
      await f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => enqueue(tx, { id: eventId, ...scope(), kind: 'events.aggregate', idempotencyKey: randomUUID() }));
      // Recovery uses the same route as outbox publication, even with an active audit.
      await reconcileDurableDeliveries(f.databases.gotchu_coordinator, f.a.organizationId, transport.publish);
      await eventually(async () => await jobState(eventId) === 'succeeded', 'event completion while audit is blocked');
      expect(pending).toHaveLength(1);
      expect(await jobState(first.id)).toBe('running');
      expect(await jobState(second.id)).toBe('queued');
      expect(await transport.queues.deterministic.getJob(first.id)).toBeUndefined();
      expect(await transport.queues.assessment.getJob(eventId)).toBeUndefined();
      present(pending[0]).finish(present(pending[0]).report);
      await eventually(async () => pending.length === 2, 'second bounded audit start');
      present(pending[1]).finish(present(pending[1]).report);
      await eventually(async () => await jobState(second.id) === 'succeeded', 'second assessment commit');
      expect(await processDurableJob({ ...dependencies(), assessmentRunner: runner }, first)).toEqual({ status: 'already_terminal' });
      expect((await f.admin.query('SELECT id FROM gotchu.assessment_reports WHERE job_id=ANY($1::uuid[])', [[first.id, second.id]])).rowCount).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      // Release test fixtures before draining; real adapters must settle their own bounded I/O.
      for (const item of pending) item.finish(item.report);
      runner.run = async input => assessmentReportFixture(input);
      await transport.close();
    }
  }, 20_000);
});
