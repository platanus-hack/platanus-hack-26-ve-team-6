import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('monitor claim settlement with real PostgreSQL roles (no adapter I/O)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    // The fixture migrates twice, checking fresh installation and checksum idempotency.
    f = await fixture();
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  });
  afterAll(async () => { await f?.close(); });

  async function scheduled(withTarget = false) {
    const author = { userId: `monitor-author:${randomUUID()}` };
    const owner = { userId: `monitor-owner:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(author, { name: 'Claim settlement' });
    const app = await api.customers.createApplication(author, { organizationId: workspace.id, name: 'Service' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [scope.organizationId, owner.userId]);
    const source = await api.customers.uploadSource(author, { ...scope, authorized: true, snapshot: { revision: 'fixture', files: [{ path: 'index.ts', content: 'export const fixture=1;' }] } });
    const targetId = withTarget ? randomUUID() : null;
    if (targetId) {
      // Operator fixture: no DNS resolution, HTTPS scan or provider request occurs.
      await f.admin.query(`INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,challenge_hash,challenge_expires_at,verified_at,expires_at)
        VALUES($1,$2,$3,'https://example.com',1,'verified',$4,repeat('a',64),clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day')`,
      [scope.organizationId, scope.applicationId, targetId, author.userId]);
    }
    const config = { ...scope, enabled: true, intervalSeconds: 21600, sourceSnapshotId: source.id, targetId };
    await api.operations.configure(author, config);
    await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at='1970-01-01' WHERE organization_id=$1", [scope.organizationId]);
    const run = present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
    expect(run.organizationId).toBe(scope.organizationId);
    const monitorClaim = { ...scope, runId: run.runId, leaseToken: run.leaseToken };
    const jobId = present((await coordinator.operations.materialize(monitorClaim)).jobId);
    return { author, owner, scope, source, targetId, config, monitorClaim, job: { organizationId: scope.organizationId, jobId } };
  }
  async function stored(c: Awaited<ReturnType<typeof scheduled>>) {
    return present((await f.admin.query<{ state: string; attempts: number; lease_token: string | null; lease_until: Date | null;
      completed_at: Date | null; result: unknown; run_status: string; run_reason: string | null; finished_at: Date | null }>(`SELECT j.state,j.attempts,j.lease_token,j.lease_until,j.completed_at,j.result,
      r.status AS run_status,r.reason AS run_reason,r.finished_at
      FROM gotchu.jobs j JOIN gotchu.operation_runs r ON r.organization_id=j.organization_id AND r.job_id=j.id
      WHERE j.organization_id=$1 AND j.id=$2`, [c.job.organizationId, c.job.jobId])).rows[0]);
  }

  it.each(['demoted', 'removed'] as const)('settles never-started work after its author is %s, freeing active quota and source erasure', async change => {
    const c = await scheduled();
    await expect(api.customers.deleteSource(c.owner, { ...c.scope, sourceSnapshotId: c.source.id })).rejects.toMatchObject({ code: 'source_in_use' });
    await f.admin.query(change === 'demoted'
      ? "UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2"
      : 'DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [c.scope.organizationId, c.author.userId]);
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
    expect(await stored(c)).toMatchObject({ state: 'failed', attempts: 0, lease_token: null, lease_until: null,
      result: { reasonCode: 'monitor_authorization_changed', reason: expect.any(String) }, completed_at: expect.any(Date),
      run_status: 'degraded', run_reason: 'monitor_authorization_changed', finished_at: expect.any(Date) });
    expect(await api.operations.getCoverage(c.owner, c.scope)).toMatchObject({ status: 'degraded', lastRun: { status: 'degraded', reason: 'monitor_authorization_changed' } });
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
    await expect(coordinator.operations.getWatch(c.monitorClaim)).rejects.toMatchObject({ code: 'monitor_authorization_revoked' });
    await api.customers.deleteSource(c.owner, { ...c.scope, sourceSnapshotId: c.source.id });
    expect((await f.admin.query('SELECT body,deleted_at FROM gotchu.customer_sources WHERE id=$1', [c.source.id])).rows[0]).toEqual({ body: null, deleted_at: expect.any(Date) });
    const replacement = await api.customers.uploadSource(c.owner, { ...c.scope, authorized: true, snapshot: { revision: 'replacement', files: [{ path: 'index.ts', content: 'export const fixture=2;' }] } });
    for (let i = 0; i < 3; i++) {
      await api.customers.queue(c.owner, { ...c.scope, mode: 'internal', sourceSnapshotId: replacement.id, targetId: null, idempotencyKey: randomUUID() });
    }
    await expect(api.customers.queue(c.owner, { ...c.scope, mode: 'internal', sourceSnapshotId: replacement.id, targetId: null, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'assessment_capacity_exceeded' });
  });

  it.each(['expired_target', 'renewed_target', 'revoked_target', 'deleted_source'] as const)('settles a never-started claim with %s scope', async change => {
    const c = await scheduled(true);
    // Simulates scope drift/expiry after materialization, without authorizing I/O.
    if (change === 'expired_target') await f.admin.query("UPDATE gotchu.customer_targets SET verified_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [c.targetId]);
    if (change === 'renewed_target') await f.admin.query('UPDATE gotchu.customer_targets SET version=version+1 WHERE id=$1', [c.targetId]);
    if (change === 'revoked_target') await f.admin.query("UPDATE gotchu.customer_targets SET status='revoked',verified_at=NULL,expires_at=NULL WHERE id=$1", [c.targetId]);
    if (change === 'deleted_source') await f.admin.query('UPDATE gotchu.customer_sources SET body=NULL,deleted_at=clock_timestamp() WHERE id=$1', [c.source.id]);
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
    expect(await stored(c)).toMatchObject({ state: 'failed', attempts: 0, result: { reasonCode: 'monitor_authorization_changed' }, run_status: 'degraded' });
    await expect(api.customers.revokeTarget(c.owner, { ...c.scope, targetId: present(c.targetId) })).resolves.toMatchObject({ status: 'revoked' });
  });

  it.each(['expired_running', 'requeued', 'running_zero_attempts'] as const)('preserves reconciliation quarantine for %s work after authorization loss', async previous => {
    const c = await scheduled(true);
    const first = present(await coordinator.jobs.claim(c.job));
    expect(first.attempts).toBe(1);
    if (previous === 'requeued') await f.admin.query("UPDATE gotchu.jobs SET state='queued',lease_until=NULL WHERE id=$1", [c.job.jobId]);
    else await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second',attempts=$2 WHERE id=$1", [c.job.jobId, previous === 'running_zero_attempts' ? 0 : 1]);
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [c.scope.organizationId, c.author.userId]);
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
    expect(await stored(c)).toMatchObject({ state: 'failed', lease_token: null, lease_until: null,
      result: { reasonCode: 'assessment_reconciliation_required' }, run_status: 'degraded', run_reason: 'assessment_reconciliation_required' });
    await expect(coordinator.customers.getRequest({ ...c.scope, jobId: c.job.jobId, leaseToken: first.leaseToken })).rejects.toMatchObject({ code: 'stale_lease' });
    await expect(coordinator.jobs.complete({ ...c.job, leaseToken: first.leaseToken })).rejects.toMatchObject({ code: 'stale_lease' });
    await expect(api.customers.revokeTarget(c.owner, { ...c.scope, targetId: present(c.targetId) })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
    await expect(api.customers.enrollTarget(c.owner, { ...c.scope, origin: 'https://example.com', authorized: true })).rejects.toMatchObject({ code: 'target_assessment_in_progress' });
    await expect(api.operations.configure(c.owner, { ...c.config, enabled: false })).rejects.toMatchObject({ code: 'monitor_work_in_progress' });
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
  });

  it('retains valid claims and cannot settle another tenant or gain membership reads', async () => {
    const c = await scheduled(true);
    expect(await coordinator.jobs.claim({ organizationId: f.b.organizationId, jobId: c.job.jobId })).toBeNull();
    expect(await stored(c)).toMatchObject({ state: 'queued', attempts: 0, run_status: 'running' });
    await expect(f.databases.gotchu_coordinator.tenant(c.scope.organizationId, tx => tx.query('SELECT * FROM gotchu.memberships'))).rejects.toMatchObject({ code: '42501' });
    await expect(api.jobs.claim(c.job)).rejects.toMatchObject({ code: '42501' });
    const claim = present(await coordinator.jobs.claim(c.job));
    expect(claim).toMatchObject({ attempts: 1, envelope: { id: c.job.jobId }, leaseToken: expect.any(String), leaseUntil: expect.any(Date) });
    expect((await coordinator.customers.getRequest({ ...c.scope, jobId: c.job.jobId, leaseToken: claim.leaseToken })).source?.id).toBe(c.source.id);
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
  });

  it('rolls back job settlement if the run update cannot commit', async () => {
    const c = await scheduled();
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [c.scope.organizationId, c.author.userId]);
    await f.admin.query(`CREATE FUNCTION gotchu.monitor_settlement_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${c.monitorClaim.runId}'::uuid THEN RAISE EXCEPTION 'synthetic settlement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER monitor_settlement_test_fail BEFORE UPDATE ON gotchu.operation_runs FOR EACH ROW EXECUTE FUNCTION gotchu.monitor_settlement_test_fail()`);
    try {
      await expect(coordinator.jobs.claim(c.job)).rejects.toThrow('synthetic settlement failure');
      expect(await stored(c)).toMatchObject({ state: 'queued', attempts: 0, result: null, run_status: 'running', finished_at: null });
    } finally {
      await f.admin.query('DROP TRIGGER monitor_settlement_test_fail ON gotchu.operation_runs; DROP FUNCTION gotchu.monitor_settlement_test_fail()');
    }
    expect(await coordinator.jobs.claim(c.job)).toBeNull();
    expect(await stored(c)).toMatchObject({ state: 'failed', run_status: 'degraded' });
  });
});
