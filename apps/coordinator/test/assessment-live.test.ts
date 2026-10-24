import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, enqueue, type JobClaim } from '@gotchu/backend';
import type { AssessmentReport } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { assessmentReportFixture } from '../../../packages/backend/test/assessment-fixtures.js';
import { createCoordinatorTransport, dispatchOutbox, processDurableJob, reconcileDurableDeliveries, type AssessmentRunner } from '../src/index.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
live('live Postgres/Redis assessment delivery (synthetic bounded runner)', () => {
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
  async function eventually(predicate: () => Promise<boolean>, label: string) {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  const jobState = async (id: string) => (await f.admin.query<{ state: string }>('SELECT state FROM gotchu.jobs WHERE id=$1', [id])).rows[0]?.state;

  it('fails unconfigured and malformed adapters visibly without storing a successful report', async () => {
    const unconfigured = await queue();
    await processDurableJob(dependencies(), unconfigured);
    expect(await api.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: unconfigured.id })).toMatchObject({ state: 'failed', reasonCode: 'audit_adapter_not_configured', reportId: null });
    const malformed = await queue();
    const runner: AssessmentRunner = { run: async input => ({ ...assessmentReportFixture(input), applicationId: randomUUID() }) };
    await processDurableJob({ ...dependencies(), assessmentRunner: runner }, malformed);
    expect(await api.web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: malformed.id })).toMatchObject({ state: 'failed', reasonCode: 'assessment_scope_mismatch', reportId: null });
  });

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
