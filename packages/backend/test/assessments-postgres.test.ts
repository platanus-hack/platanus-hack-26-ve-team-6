import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessmentReportSchema } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, DEMO_ASSESSMENT_SCOPE, DEMO_ASSESSMENT_TARGET_KEY } from '../src/index.js';
import { assessmentReportFixture } from './assessment-fixtures.js';

const live = liveUrl ? describe : describe.skip;
live('real Postgres assessment authorization and storage (synthetic report evidence)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 8 });
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    for (const scope of [f.a, f.b]) await f.admin.query('INSERT INTO gotchu.assessment_targets(organization_id,application_id,target_key,enabled) VALUES ($1,$2,$3,true)', [scope.organizationId, scope.applicationId, DEMO_ASSESSMENT_TARGET_KEY]);
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  const identity = () => ({ userId: f.a.userId });
  const queueInput = () => ({ ...scope(), mode: 'both' as const, revision: 'vulnerable' as const, idempotencyKey: randomUUID() });
  async function queuedClaim() {
    const { jobId } = await api.assessments.queue(identity(), queueInput());
    const claim = present(await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId }));
    const input = await coordinator.assessments.getRequest({ ...scope(), jobId, leaseToken: claim.leaseToken });
    return { input, leaseToken: claim.leaseToken, report: assessmentReportFixture(input) };
  }

  it('commits the immutable request, job and outbox once, including concurrent retries', async () => {
    const input = queueInput();
    const results = await Promise.all(Array.from({ length: 4 }, () => api.assessments.queue(identity(), input)));
    expect(new Set(results.map(result => result.jobId)).size).toBe(1);
    const jobId = present(results[0]).jobId;
    const counts = await f.admin.query(`SELECT
      (SELECT count(*)::int FROM gotchu.jobs WHERE id=$1) AS jobs,
      (SELECT count(*)::int FROM gotchu.assessment_requests WHERE job_id=$1) AS requests,
      (SELECT count(*)::int FROM gotchu.outbox WHERE job_id=$1) AS outbox,
      (SELECT count(*)::int FROM gotchu.audit_records WHERE subject_id=$1) AS audit`, [jobId]);
    expect(counts.rows[0]).toEqual({ jobs: 1, requests: 1, outbox: 1, audit: 1 });
    await expect(api.assessments.queue(identity(), { ...input, mode: 'internal' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(api.assessments.queue(identity(), { ...input, revision: 'corrected' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [f.a.organizationId]);
    await f.admin.query("INSERT INTO gotchu.assessment_targets(organization_id,application_id,target_key,enabled) VALUES ($1,$2,'other-operator-target',true)", [f.a.organizationId, f.a.applicationId]);
    try { await expect(api.assessments.queue(identity(), input)).rejects.toMatchObject({ code: 'idempotency_conflict' }); }
    finally {
      await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [f.a.organizationId]);
      await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=true WHERE organization_id=$1 AND target_key=$2', [f.a.organizationId, DEMO_ASSESSMENT_TARGET_KEY]);
    }
    const legacy = queueInput();
    await api.web.queueAudit(identity(), { ...scope(), idempotencyKey: legacy.idempotencyKey });
    await expect(api.assessments.queue(identity(), legacy)).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('authorizes membership and role on queue, target lookup and report reads; refuses caller targets', async () => {
    const stranger = { userId: f.b.userId };
    await expect(api.assessments.queue(stranger, queueInput())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.assessments.list(stranger, scope())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.assessments.get(stranger, { ...scope(), reportId: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.assessments.getTarget(stranger, scope())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.assessments.queue(identity(), { ...queueInput(), applicationId: f.b.applicationId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.assessments.queue(identity(), Object.assign(queueInput(), { targetKey: 'http://127.0.0.1/' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(api.assessments.queue(identity(), Object.assign(queueInput(), { url: 'http://169.254.169.254/' }))).rejects.toMatchObject({ code: 'invalid_input' });
    const viewerId = `test:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'viewer')", [f.a.organizationId, viewerId]);
    await expect(api.assessments.queue({ userId: viewerId }, queueInput())).rejects.toMatchObject({ code: 'forbidden' });
    expect(await api.assessments.getTarget({ userId: viewerId }, scope())).toEqual({ targetKey: DEMO_ASSESSMENT_TARGET_KEY });
    await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [f.a.organizationId]);
    try {
      expect(await api.assessments.getTarget(identity(), scope())).toBeNull();
      await expect(api.assessments.queue(identity(), queueInput())).rejects.toMatchObject({ code: 'assessment_target_not_configured' });
    } finally { await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=true WHERE organization_id=$1 AND target_key=$2', [f.a.organizationId, DEMO_ASSESSMENT_TARGET_KEY]); }
  });

  it('rolls back job and outbox creation if assessment request persistence fails', async () => {
    const value = queueInput();
    const constraint = `assessment_request_failure_${randomUUID().replaceAll('-', '')}`;
    await f.admin.query(`ALTER TABLE gotchu.assessment_requests ADD CONSTRAINT ${constraint} CHECK (application_id<>'${f.a.applicationId}'::uuid) NOT VALID`);
    try { await expect(api.assessments.queue(identity(), value)).rejects.toMatchObject({ code: '23514' }); }
    finally { await f.admin.query(`ALTER TABLE gotchu.assessment_requests DROP CONSTRAINT ${constraint}`); }
    expect((await f.admin.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND idempotency_key=$2', [value.organizationId, value.idempotencyKey])).rowCount).toBe(0);
    const orphans = await f.admin.query('SELECT id FROM gotchu.outbox WHERE organization_id=$1 AND job_id NOT IN (SELECT id FROM gotchu.jobs WHERE organization_id=$1)', [value.organizationId]);
    expect(orphans.rowCount).toBe(0);
  });

  it.each(['internal', 'external', 'both'] as const)('persists both revisions with only the requested %s analyses', async mode => {
    for (const revision of ['vulnerable', 'corrected'] as const) {
      const { jobId } = await api.assessments.queue(identity(), { ...queueInput(), mode, revision });
      const claim = present(await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId }));
      const input = await coordinator.assessments.getRequest({ ...scope(), jobId, leaseToken: claim.leaseToken });
      const report = assessmentReportFixture(input);
      await coordinator.assessments.recordResult({ input, leaseToken: claim.leaseToken, report });
      expect(await api.assessments.get(identity(), { ...scope(), reportId: report.id })).toEqual(report);
    }
  });

  it('stores a validated report and completes its job atomically; viewers can read only their tenant', async () => {
    const result = await queuedClaim();
    expect(await coordinator.assessments.recordResult(result)).toEqual({ reportId: result.report.id });
    expect(await api.assessments.get(identity(), { ...scope(), reportId: result.report.id })).toEqual(result.report);
    expect(await api.assessments.list(identity(), { ...scope(), limit: 1 })).toEqual([expect.objectContaining({ id: result.report.id, findingCount: 2 })]);
    expect(await api.web.getJob(identity(), { organizationId: f.a.organizationId, jobId: result.input.jobId })).toMatchObject({ state: 'succeeded', reportId: result.report.id, outcome: 'completed' });
    expect((await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT id FROM gotchu.assessment_reports'))).rowCount).toBe(0);
    expect((await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT job_id FROM gotchu.assessment_requests'))).rowCount).toBe(0);
    await expect(api.assessments.get({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.b.applicationId, reportId: result.report.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(coordinator.assessments.recordResult(result)).rejects.toMatchObject({ code: 'stale_lease' });
  });

  it('keeps target configuration operator-only and report writes coordinator-only with tenant-aware FKs', async () => {
    const pending = await queuedClaim();
    for (const role of ['gotchu_api', 'gotchu_coordinator'] as const) {
      await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query('UPDATE gotchu.assessment_targets SET enabled=false'))).rejects.toMatchObject({ code: '42501' });
      await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query('DELETE FROM gotchu.assessment_reports'))).rejects.toMatchObject({ code: '42501' });
    }
    for (const role of ['gotchu_ingest', 'gotchu_executor'] as const) {
      for (const table of ['assessment_targets', 'assessment_requests', 'assessment_reports']) {
        await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query(`SELECT * FROM gotchu.${table}`))).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(api.assessments.recordResult(pending)).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('INSERT INTO gotchu.assessment_reports DEFAULT VALUES'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(`INSERT INTO gotchu.assessment_requests(organization_id,application_id,job_id,target_key,mode,revision)
      VALUES ($1,$2,$3,$4,'both','vulnerable')`, [f.a.organizationId, f.b.applicationId, randomUUID(), DEMO_ASSESSMENT_TARGET_KEY]))).rejects.toMatchObject({ code: '23503' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(`INSERT INTO gotchu.assessment_requests(organization_id,application_id,job_id,target_key,mode,revision)
      VALUES ($1,$2,$3,$4,'both','vulnerable')`, [f.b.organizationId, f.b.applicationId, randomUUID(), DEMO_ASSESSMENT_TARGET_KEY]))).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query(`INSERT INTO gotchu.assessment_reports(organization_id,application_id,id,job_id,target_key,mode,revision,body)
      VALUES ($1,$2,$3,$4,$5,'both','vulnerable',$6::jsonb)`, [f.a.organizationId, f.a.applicationId, pending.report.id, randomUUID(), DEMO_ASSESSMENT_TARGET_KEY,
      JSON.stringify({ ...pending.report, jobId: randomUUID() })]))).rejects.toMatchObject({ code: '23514' });
    const otherJob = randomUUID();
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query(`INSERT INTO gotchu.assessment_reports(organization_id,application_id,id,job_id,target_key,mode,revision,body)
      VALUES ($1,$2,$3,$4,$5,'both','vulnerable',$6::jsonb)`, [f.a.organizationId, f.a.applicationId, pending.report.id, otherJob, DEMO_ASSESSMENT_TARGET_KEY,
      JSON.stringify({ ...pending.report, jobId: otherJob })]))).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects mismatched output, changed target, mutated job intent, oversized reports and invented action status', async () => {
    const value = await queuedClaim();
    for (const change of [{ organizationId: f.b.organizationId }, { applicationId: f.b.applicationId }, { jobId: randomUUID() }, { revision: 'corrected' }]) {
      await expect(coordinator.assessments.recordResult({ ...value, report: { ...value.report, ...change } })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    }
    await expect(coordinator.assessments.recordResult({ ...value, report: assessmentReportFixture({ ...value.input, mode: 'internal' }) })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    await expect(coordinator.assessments.recordResult({ ...value, input: { ...value.input, targetKey: 'other-operator-target' } })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    await expect(coordinator.assessments.recordResult({ ...value, report: { ...value.report, actionsPerformed: ['fixed'] } })).rejects.toMatchObject({ code: 'assessment_invalid_report' });
    await expect(coordinator.assessments.recordResult({ ...value, report: { ...value.report, verified: true } })).rejects.toMatchObject({ code: 'assessment_invalid_report' });
    const report = structuredClone(value.report);
    for (const analysis of [report.internal, report.external]) {
      if (!analysis) continue;
      const evidence = present(analysis.evidence[0]);
      analysis.evidence.push(...Array.from({ length: 199 }, () => ({ ...evidence, id: randomUUID(), excerpt: 'x'.repeat(4096) })));
    }
    expect(assessmentReportSchema.safeParse(report).success).toBe(true);
    await expect(coordinator.assessments.recordResult({ ...value, report })).rejects.toMatchObject({ code: 'assessment_report_too_large' });
    await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=false WHERE organization_id=$1', [f.a.organizationId]);
    try { await expect(coordinator.assessments.recordResult(value)).rejects.toMatchObject({ code: 'assessment_target_changed' }); }
    finally { await f.admin.query('UPDATE gotchu.assessment_targets SET enabled=true WHERE organization_id=$1 AND target_key=$2', [f.a.organizationId, DEMO_ASSESSMENT_TARGET_KEY]); }
    await f.admin.query("UPDATE gotchu.jobs SET payload=jsonb_set(payload,'{revision}','\"corrected\"') WHERE organization_id=$1 AND id=$2", [f.a.organizationId, value.input.jobId]);
    await expect(coordinator.assessments.recordResult(value)).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    expect((await f.admin.query('SELECT id FROM gotchu.assessment_reports WHERE job_id=$1', [value.input.jobId])).rowCount).toBe(0);
  });

  it('rejects replaced leases and rolls back a report if the lease expires after its insert', async () => {
    const stale = await queuedClaim();
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [stale.input.jobId]);
    const current = present(await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId: stale.input.jobId }));
    await expect(coordinator.assessments.recordResult(stale)).rejects.toMatchObject({ code: 'stale_lease' });
    const triggerName = `assessment_expire_${randomUUID().replaceAll('-', '')}`;
    await f.admin.query(`CREATE FUNCTION gotchu.${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.job_id='${stale.input.jobId}'::uuid THEN UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=NEW.organization_id AND id=NEW.job_id; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON gotchu.assessment_reports FOR EACH ROW EXECUTE FUNCTION gotchu.${triggerName}()`);
    try { await expect(coordinator.assessments.recordResult({ ...stale, leaseToken: current.leaseToken })).rejects.toMatchObject({ code: 'stale_lease' }); }
    finally { await f.admin.query(`DROP TRIGGER ${triggerName} ON gotchu.assessment_reports; DROP FUNCTION gotchu.${triggerName}()`); }
    expect((await f.admin.query('SELECT id FROM gotchu.assessment_reports WHERE job_id=$1', [stale.input.jobId])).rowCount).toBe(0);
    expect(await api.web.getJob(identity(), { organizationId: f.a.organizationId, jobId: stale.input.jobId })).toMatchObject({ state: 'running', reportId: null });
    await coordinator.assessments.recordResult({ ...stale, leaseToken: current.leaseToken });
  });

  it('seeds only the fixed demo scope repeatably and enforces durable demo capacity before concurrent inserts', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (let i = 0; i < 2; i++) await promisify(execFile)(process.execPath, ['scripts/assessment-demo-seed.mjs'], { cwd: root, env: { ...process.env, GOTCHU_MIGRATION_DATABASE_URL: present(liveUrl) } });
    const demoIdentity = { userId: DEMO_ASSESSMENT_SCOPE.userId };
    const demoScope = { organizationId: DEMO_ASSESSMENT_SCOPE.organizationId, applicationId: DEMO_ASSESSMENT_SCOPE.applicationId };
    const input = { ...demoScope, mode: 'external' as const, revision: 'corrected' as const, idempotencyKey: 'demo-retry' };
    const first = await api.assessments.queue(demoIdentity, input);
    const contenders = await Promise.allSettled(Array.from({ length: 6 }, () => api.assessments.queue(demoIdentity, { ...input, idempotencyKey: randomUUID() })));
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    for (const rejected of contenders) if (rejected.status === 'rejected') expect(rejected.reason).toMatchObject({ code: 'assessment_capacity_exceeded', status: 429 });
    expect(await api.assessments.queue(demoIdentity, input)).toEqual(first);
    await expect(api.assessments.queue(demoIdentity, { ...input, mode: 'both' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await api.web.getJob(demoIdentity, { organizationId: demoScope.organizationId, jobId: first.jobId })).toMatchObject({ applicationId: demoScope.applicationId });
    await expect(api.web.listApplications(demoIdentity, { organizationId: demoScope.organizationId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.web.queueAudit(demoIdentity, { ...demoScope, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' });
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'owner')", [f.a.organizationId, demoIdentity.userId]);
    try { await expect(api.assessments.queue(demoIdentity, queueInput())).rejects.toMatchObject({ code: 'forbidden' }); }
    finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, demoIdentity.userId]); }
    const otherApp = randomUUID();
    await f.admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES ($1,$2,'Other app')", [demoScope.organizationId, otherApp]);
    await expect(api.assessments.list(demoIdentity, { ...demoScope, applicationId: otherApp })).rejects.toMatchObject({ code: 'forbidden' });
    const otherJob = randomUUID();
    await f.admin.query("INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key) VALUES ($1,$2,$3,'audit','other-app')", [demoScope.organizationId, otherApp, otherJob]);
    await expect(api.web.getJob(demoIdentity, { organizationId: demoScope.organizationId, jobId: otherJob })).rejects.toMatchObject({ code: 'forbidden' });
    await f.admin.query('DELETE FROM gotchu.jobs WHERE id=$1', [otherJob]);
    await f.admin.query('DELETE FROM gotchu.applications WHERE organization_id=$1 AND id=$2', [demoScope.organizationId, otherApp]);
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1", [demoScope.organizationId]);
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,state)
      SELECT $1,$2,gen_random_uuid(),'audit','quota-fixture-'||i,'failed' FROM generate_series(1,97) AS i`, [demoScope.organizationId, demoScope.applicationId]);
    await expect(api.assessments.queue(demoIdentity, { ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'demo_assessment_limit', status: 429 });
    expect(await api.assessments.queue(demoIdentity, input)).toEqual(first);
  }, 30_000);
});
