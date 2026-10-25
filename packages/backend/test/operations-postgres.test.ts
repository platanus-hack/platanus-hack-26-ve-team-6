import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MonitorClaim, RecordOperationObservation } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { canonicalJson, createBackend, sha256 } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('operations durable domain with real Postgres roles (synthetic adapter evidence)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture({ max: 10 }); api = createBackend({ database: f.databases.gotchu_api }); coordinator = createBackend({ database: f.databases.gotchu_coordinator }); });
  afterAll(async () => { await f?.close(); });
  async function customer() {
    const identity = { userId: `operations:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Operations' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Service' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    return { identity, scope };
  }
  async function monitored(extra: { repositoryKey?: string; source?: boolean } = {}) {
    const c = await customer();
    const source = extra.source ? await api.customers.uploadSource(c.identity, { ...c.scope, authorized: true, snapshot: { revision: 'fixture', files: [{ path: 'index.ts', content: 'export const value=1;' }] } }) : null;
    const input = { ...c.scope, enabled: true, intervalSeconds: 21600, providers: ['cloudflare' as const], repositoryKey: extra.repositoryKey ?? null, sourceSnapshotId: source?.id ?? null };
    await api.operations.configure(c.identity, input);
    // Isolate global scheduling order from other test tenants without editing their work.
    await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at='1990-01-01' WHERE organization_id=$1", [c.scope.organizationId]);
    const work = present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
    expect(work.organizationId).toBe(c.scope.organizationId);
    const claim: MonitorClaim = { ...c.scope, runId: work.runId, leaseToken: work.leaseToken };
    return { ...c, input, source, claim, work };
  }
  function outage(claim: MonitorClaim): RecordOperationObservation {
    const observedAt = new Date().toISOString();
    return { organizationId: claim.organizationId, applicationId: claim.applicationId, basis: { kind: 'monitor', runId: claim.runId, leaseToken: claim.leaseToken },
      idempotencyKey: randomUUID(), kind: 'upstream_outage', summary: 'Synthetic upstream incident; application impact unverified', severity: 'high', confidence: 'medium', observedAt, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      evidence: [{ source: 'provider_status', reference: 'cloudflare:fixture', checksum: sha256('synthetic-status'), collectedAt: observedAt, adapter: 'synthetic-test', adapterVersion: '1' }], upstreamImpact: 'unverified' };
  }
  it('authorizes config and reads by tenant/role and rejects reserved or forged scopes', async () => {
    const c = await customer(); const viewer = { userId: randomUUID() };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [c.scope.organizationId, viewer.userId]);
    const input = { ...c.scope, enabled: true, intervalSeconds: 3600, providers: ['railway' as const] };
    await expect(api.operations.configure(viewer, input)).rejects.toMatchObject({ status: 403 });
    await expect(api.operations.configure(c.identity, input)).resolves.toMatchObject({ providers: ['railway'], revision: 1 });
    expect(await api.operations.getConfig(viewer, c.scope)).toMatchObject({ enabled: true });
    await expect(api.operations.getConfig({ userId: f.b.userId }, c.scope)).rejects.toMatchObject({ status: 403 });
    await expect(api.operations.getConfig({ userId: 'demo:controlled-assessment' }, c.scope)).rejects.toMatchObject({ status: 403 });
    await expect(api.operations.configure(c.identity, { ...input, intervalSeconds: 3599 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(api.operations.claimDue()).rejects.toMatchObject({ status: 403 });
  });
  it('claims once concurrently and rotates expired lease without inventing a second run', async () => {
    const c = await monitored();
    const calls = await Promise.all([coordinator.operations.claimDue(), coordinator.operations.claimDue()]);
    expect(calls.flat().filter(x => x.organizationId === c.scope.organizationId)).toEqual([]);
    await f.admin.query("UPDATE gotchu.operation_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.claim.runId]);
    const second = present((await coordinator.operations.claimDue()).find(x => x.runId === c.claim.runId));
    expect(second.leaseToken).not.toBe(c.claim.leaseToken);
    await expect(coordinator.operations.getWatch(c.claim)).rejects.toMatchObject({ code: 'stale_lease' });
    await coordinator.operations.finishRun({ ...c.claim, leaseToken: second.leaseToken, status: 'degraded', reason: 'Synthetic expired work' });
  });
  it('materializes canonical request and outbox atomically and shares source digests/quotas', async () => {
    const c = await monitored({ repositoryKey: 'repo-fixture' });
    const snapshot = { revision: 'commit-fixture', files: [{ path: 'z.ts', content: 'export const z=1;' }, { path: 'A.ts', content: 'export const a=1;' }] };
    const result = await coordinator.operations.materialize({ ...c.claim, repositorySnapshot: snapshot });
    expect(await coordinator.operations.materialize({ ...c.claim, repositorySnapshot: snapshot })).toEqual(result);
    await expect(coordinator.operations.materialize({ ...c.claim, repositorySnapshot: { ...snapshot, revision: 'changed' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const stored = await f.admin.query('SELECT count(*)::int AS count FROM gotchu.outbox WHERE job_id=$1', [result.jobId]);
    expect(stored.rows[0]?.count).toBe(1);
    const claim = present(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId: present(result.jobId) }));
    const input = await coordinator.customers.getRequest({ ...c.scope, jobId: present(result.jobId), leaseToken: claim.leaseToken });
    expect(input.source?.files.map(x => x.path)).toEqual(['A.ts', 'z.ts']);
    const uploaded = await api.customers.uploadSource(c.identity, { ...c.scope, snapshot, authorized: true });
    expect(uploaded.id).toBe(input.source?.id);
    await expect(api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: uploaded.id })).rejects.toMatchObject({ code: 'source_in_use' });
    await expect(coordinator.operations.finishRun({ ...c.claim, status: 'completed' })).rejects.toMatchObject({ code: 'stale_lease' });
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE id=$1", [result.jobId]);
    await coordinator.operations.finishRun({ ...c.claim, status: 'degraded', reason: 'Synthetic scanner unavailable' });
    expect(await api.operations.getCoverage(c.identity, c.scope)).toMatchObject({ status: 'degraded' });
  });
  it('rolls back source, job and outbox when request insertion fails', async () => {
    const c = await monitored({ repositoryKey: 'repo-failure' });
    await f.admin.query(`CREATE FUNCTION gotchu.operations_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id='${c.scope.organizationId}'::uuid THEN RAISE EXCEPTION 'synthetic materialization failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER operations_test_fail BEFORE INSERT ON gotchu.customer_requests FOR EACH ROW EXECUTE FUNCTION gotchu.operations_test_fail()`);
    try {
      await expect(coordinator.operations.materialize({ ...c.claim, repositorySnapshot: { revision: 'fixture', files: [{ path: 'a.ts', content: 'a' }] } })).rejects.toThrow('synthetic materialization failure');
      const count = await f.admin.query('SELECT (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1) AS jobs,(SELECT count(*)::int FROM gotchu.outbox WHERE organization_id=$1) AS outbox,(SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1) AS sources', [c.scope.organizationId]);
      expect(count.rows[0]).toEqual({ jobs: 0, outbox: 0, sources: 0 });
    } finally { await f.admin.query('DROP TRIGGER operations_test_fail ON gotchu.customer_requests; DROP FUNCTION gotchu.operations_test_fail()'); }
  });
  it('fences configuration changes, cancels queued work once the lease expired and prevents new claims', async () => {
    const c = await monitored({ source: true });
    const queued = await coordinator.operations.materialize(c.claim);
    await expect(api.operations.configure(c.identity, { ...c.input, enabled: false })).rejects.toMatchObject({ code: 'monitor_work_in_progress' });
    await f.admin.query("UPDATE gotchu.operation_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [c.claim.runId]);
    await api.operations.configure(c.identity, { ...c.input, enabled: false });
    expect(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId: present(queued.jobId) })).toBeNull();
    await expect(coordinator.operations.getWatch(c.claim)).rejects.toMatchObject({ code: 'monitor_disabled' });
    expect((await coordinator.operations.claimDue()).some(w => w.runId === c.claim.runId)).toBe(false);
  });
  it('blocks future I/O after config author loses write membership or source is deleted', async () => {
    const c = await monitored({ source: true });
    const secondaryOwner = `secondary-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [c.scope.organizationId, secondaryOwner]);
    try {
      await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [c.scope.organizationId, c.identity.userId]);
      await expect(coordinator.operations.materialize(c.claim)).rejects.toMatchObject({ code: 'monitor_authorization_revoked' });
      await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [c.scope.organizationId, c.identity.userId]);
    } finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [c.scope.organizationId, secondaryOwner]); }
    await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: present(c.source).id });
    await expect(coordinator.operations.getWatch(c.claim)).rejects.toMatchObject({ code: 'source_unavailable' });
  });
  it('records exact observations and alerts once, rejects conflicts/stale evidence, and isolates alerts', async () => {
    const c = await monitored(); const input = outage(c.claim);
    const recorded = await coordinator.operations.recordObservation(input);
    expect(await coordinator.operations.recordObservation(input)).toEqual(recorded);
    await expect(coordinator.operations.recordObservation({ ...input, summary: 'different' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(coordinator.operations.recordObservation({ ...input, idempotencyKey: randomUUID(), observedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString() })).rejects.toMatchObject({ code: 'evidence_stale' });
    await expect(api.operations.recordObservation(input)).rejects.toMatchObject({ status: 403 });
    await expect(api.operations.updateAlert({ userId: f.b.userId }, { ...c.scope, alertId: present(recorded.alertId), state: 'resolved' })).rejects.toMatchObject({ status: 403 });
    expect(await api.operations.updateAlert(c.identity, { ...c.scope, alertId: present(recorded.alertId), state: 'acknowledged' })).toMatchObject({ id: recorded.alertId, state: 'acknowledged' });
    expect(await api.operations.updateAlert(c.identity, { ...c.scope, alertId: present(recorded.alertId), state: 'resolved', resolution: 'Self-reported triage' })).toMatchObject({ state: 'resolved', resolution: 'Self-reported triage' });
    const alerts = await api.operations.listAlerts(c.identity, c.scope);
    expect(alerts).toHaveLength(1); expect(alerts[0]).toMatchObject({ state: 'resolved', observation: { upstreamImpact: 'unverified', verification: 'trusted_observation' } });
  });
  it('binds plan revisions and hashes; checklist attestations never permit execution', async () => {
    const c = await monitored(); const observation = await coordinator.operations.recordObservation(outage(c.claim));
    let plan = await api.operations.createPlan(c.identity, { ...c.scope, kind: 'migration_readiness', observationIds: [observation.observationId] });
    expect(plan.steps.map(s => s.key)).toEqual(['inventory','data','secrets','destination','cost','health','rollback','cutover']);
    const binding = { ...c.scope, planId: plan.id, revision: plan.revision, actionHash: plan.actionHash };
    const viewer = { userId: randomUUID() };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [c.scope.organizationId, viewer.userId]);
    await expect(api.operations.requestPreparation(viewer, binding)).rejects.toMatchObject({ code: 'forbidden' });
    plan = await api.operations.requestPreparation(c.identity, binding);
    await expect(api.operations.checkReadiness(c.identity, binding)).rejects.toMatchObject({ code: 'plan_changed' });
    const preparedBinding = { ...binding, revision: plan.revision, actionHash: plan.actionHash };
    plan = await api.operations.attestStep(c.identity, { ...preparedBinding, key: 'inventory', attestation: 'Customer-provided inventory' });
    expect(plan.state).toBe('draft'); expect(plan.steps[0]?.state).toBe('self_reported');
    const finalBinding = { ...binding, revision: plan.revision, actionHash: plan.actionHash };
    expect(await api.operations.checkReadiness(c.identity, finalBinding)).toMatchObject({ ready: false, execution: 'disabled' });
    await expect(api.operations.requestExecution(c.identity, finalBinding)).rejects.toMatchObject({ code: 'operation_execution_unavailable' });
    expect((await api.operations.listPlans(c.identity, c.scope))[0]?.execution).toBe('disabled');
    await f.admin.query("UPDATE gotchu.operation_observations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [observation.observationId]);
    await expect(api.operations.requestPreparation(c.identity, finalBinding)).rejects.toMatchObject({ code: 'evidence_stale' });
    expect((await api.operations.checkReadiness(c.identity, finalBinding)).requirements).toContain('Referenced observation evidence has expired.');
  });
  it('rejects capacity plans from provider status, arbitrary event IDs and forged checksums', async () => {
    const c = await monitored(); const base = outage(c.claim); const observation = await coordinator.operations.recordObservation(base);
    await expect(api.operations.createPlan(c.identity, { ...c.scope, kind: 'investigate_capacity', observationIds: [observation.observationId] })).rejects.toMatchObject({ code: 'capacity_evidence_required' });
    await expect(coordinator.operations.recordObservation({ ...base, idempotencyKey: randomUUID(), basis: { kind: 'events', eventIds: [randomUUID()] } })).rejects.toMatchObject({ code: 'evidence_not_found' });
    const other = await customer();
    await expect(api.operations.createPlan(other.identity, { ...other.scope, kind: 'review_improvement', observationIds: [observation.observationId] })).rejects.toMatchObject({ code: 'evidence_not_found' });
  });


  it('requires real completion evidence, renews a valid lease, and retains healthy coverage without an alert', async () => {
    const c = await monitored();
    await coordinator.operations.heartbeatRun(c.claim);
    await expect(coordinator.operations.finishRun({ ...c.claim, status: 'completed' })).rejects.toMatchObject({ code: 'stale_lease' });
    const input: RecordOperationObservation = { ...outage(c.claim), kind: 'coverage_check', summary: 'Synthetic successful status read', severity: 'info', upstreamImpact: 'not_applicable' };
    const recorded = await coordinator.operations.recordObservation(input);
    expect(recorded.alertId).toBeNull(); expect(await coordinator.operations.recordObservation(input)).toEqual(recorded);
    expect(await api.operations.listAlerts(c.identity, c.scope)).toEqual([]);
    await coordinator.operations.finishRun({ ...c.claim, status: 'completed' });
    expect(await api.operations.getCoverage(c.identity, c.scope)).toMatchObject({ status: 'active', observations: { fresh: 1 }, lastRun: { runId: c.claim.runId, status: 'completed' } });
    await api.operations.configure(c.identity, { ...c.input, providers: ['railway'] });
    expect(await api.operations.getCoverage(c.identity, c.scope)).toMatchObject({ status: 'pending', lastRun: null });
    await expect(coordinator.operations.heartbeatRun(c.claim)).rejects.toMatchObject({ code: 'stale_lease' });
  });
  it('rejects target version drift and can disable invalid selected scope after work settles', async () => {
    const c = await customer(); const targetId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,requested_by,authorized_at,expires_at)
      VALUES($1,$2,$3,'https://example.com',1,'authorized',$4,clock_timestamp(),clock_timestamp()+interval '1 day')`, [c.scope.organizationId,c.scope.applicationId,targetId,c.identity.userId]);
    const input = { ...c.scope, enabled: true, intervalSeconds: 21600, targetId };
    await api.operations.configure(c.identity, input);
    await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at='1980-01-01' WHERE organization_id=$1", [c.scope.organizationId]);
    const work = present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
    const claim = { ...c.scope, runId: work.runId, leaseToken: work.leaseToken };
    // Operator fixture simulates target renewal while no canonical scan is queued.
    await f.admin.query('UPDATE gotchu.customer_targets SET version=2 WHERE id=$1', [targetId]);
    await expect(coordinator.operations.materialize(claim)).rejects.toMatchObject({ code: 'target_not_authorized' });
    await coordinator.operations.finishRun({ ...claim, status: 'degraded', reason: 'Authorization changed' });
    expect(await api.operations.getCoverage(c.identity, c.scope)).toMatchObject({ status: 'degraded', scopeCurrent: false });
    await f.admin.query("UPDATE gotchu.customer_targets SET status='revoked',expires_at=NULL,authorized_at=NULL WHERE id=$1", [targetId]);
    await expect(api.operations.configure(c.identity, { ...input, enabled: false })).resolves.toMatchObject({ enabled: false });
  });
  it('rolls back observation storage if alert persistence fails, and serializes concurrent exact delivery', async () => {
    const c = await monitored(); const input = outage(c.claim);
    await f.admin.query(`CREATE FUNCTION gotchu.operations_alert_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id='${c.scope.organizationId}'::uuid THEN RAISE EXCEPTION 'synthetic alert failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER operations_alert_fail BEFORE INSERT ON gotchu.operation_alerts FOR EACH ROW EXECUTE FUNCTION gotchu.operations_alert_fail()`);
    try {
      await expect(coordinator.operations.recordObservation(input)).rejects.toThrow('synthetic alert failure');
      expect((await f.admin.query('SELECT count(*)::int AS count FROM gotchu.operation_observations WHERE organization_id=$1', [c.scope.organizationId])).rows[0]?.count).toBe(0);
    } finally { await f.admin.query('DROP TRIGGER operations_alert_fail ON gotchu.operation_alerts; DROP FUNCTION gotchu.operations_alert_fail()'); }
    const [a,b] = await Promise.all([coordinator.operations.recordObservation(input), coordinator.operations.recordObservation(input)]);
    expect(a).toEqual(b);
    expect(await api.operations.listAlerts(c.identity, c.scope)).toHaveLength(1);
  });
  it('enforces the shared assessment quota for scheduled work', async () => {
    const c = await monitored({ source: true });
    const queued = await coordinator.operations.materialize(c.claim);
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE id=$1", [queued.jobId]);
    await coordinator.operations.finishRun({ ...c.claim, status: 'degraded', reason: 'Synthetic quota setup' });
    for (let i = 1; i < 20; i++) {
      const job = await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: present(c.source).id, targetId: null, idempotencyKey: randomUUID() });
      await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE id=$1", [job.jobId]);
    }
    await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at='1980-01-01' WHERE organization_id=$1", [c.scope.organizationId]);
    const next = present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
    await expect(coordinator.operations.materialize({ ...c.scope, runId: next.runId, leaseToken: next.leaseToken })).rejects.toMatchObject({ code: 'assessment_capacity_exceeded', status: 429 });
  });
  it('checks persisted signed-event provenance for measured capacity plans', async () => {
    const c = await customer(); const integration = randomUUID(); const jobId = randomUUID(); const eventId = randomUUID();
    await f.admin.query("INSERT INTO gotchu.integrations(organization_id,application_id,id,kind) VALUES($1,$2,$3,'signed_events')", [c.scope.organizationId,c.scope.applicationId,integration]);
    await f.admin.query("INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key) VALUES($1,$2,$3::uuid,'events.aggregate',$3::text)", [c.scope.organizationId,c.scope.applicationId,jobId]);
    const payload = { id: eventId, type: 'http.request', source: 'application', outcome: 'failure', occurredAt: new Date().toISOString(), attributes: { durationMs: 1500 } };
    const checksum = sha256(canonicalJson(payload));
    // Operator fixture represents already-authenticated persisted intake; this is not an HMAC test.
    await f.admin.query('INSERT INTO gotchu.events(organization_id,application_id,integration_id,id,payload,payload_hash,job_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)', [c.scope.organizationId,c.scope.applicationId,integration,eventId,JSON.stringify(payload),checksum,jobId]);
    const observedAt = new Date().toISOString();
    const input: RecordOperationObservation = { ...c.scope, idempotencyKey: randomUUID(), kind: 'traffic_pressure', basis: { kind: 'events', eventIds: [eventId] }, summary: 'Measured errors', severity: 'medium', confidence: 'high', observedAt, expiresAt: new Date(Date.now()+3600000).toISOString(),
      metrics: { windowStartedAt: new Date(Date.now()-60000).toISOString(), windowEndedAt: observedAt, requestCount: 1, errorCount: 1, latencyP95Ms: 1500, capacityUtilization: null }, evidence: [{ source: 'signed_event', reference: eventId, checksum, collectedAt: observedAt, adapter: 'trusted-aggregator', adapterVersion: 'test' }] };
    const volume = await coordinator.operations.recordObservation({ ...input, idempotencyKey: randomUUID(), metrics: { ...present(input.metrics), errorCount: 0, latencyP95Ms: 5, capacityUtilization: 0.1 } });
    await expect(api.operations.createPlan(c.identity, { ...c.scope, kind: 'investigate_capacity', observationIds: [volume.observationId] })).rejects.toMatchObject({ code: 'capacity_evidence_required' });
    const recorded = await coordinator.operations.recordObservation(input);
    expect(await api.operations.createPlan(c.identity, { ...c.scope, kind: 'investigate_capacity', observationIds: [recorded.observationId] })).toMatchObject({ kind: 'investigate_capacity', execution: 'disabled' });
    await expect(coordinator.operations.recordObservation({ ...input, idempotencyKey: randomUUID(), evidence: input.evidence.map(e => ({ ...e, checksum: 'a'.repeat(64) })) })).rejects.toMatchObject({ code: 'evidence_mismatch' });
  });
});
