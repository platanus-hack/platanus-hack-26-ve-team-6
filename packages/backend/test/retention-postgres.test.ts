import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionV2Schema } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, hashActionV2 } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('workspace retention with real Postgres roles', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture(); api = createBackend({ database: f.databases.gotchu_api }); coordinator = createBackend({ database: f.databases.gotchu_coordinator }); });
  afterAll(async () => { await f?.close(); });

  async function customer() {
    const identity = { userId: `retention:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Retention' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Service' });
    return { identity, organizationId: workspace.id, applicationId: app.applicationId };
  }

  it('uses workspace defaults and lets only the owner shorten retention', async () => {
    const c = await customer();
    await expect(api.retention.getPolicy(c.identity, { organizationId: c.organizationId })).resolves.toMatchObject({
      sourceSnapshotDays: 90, containerImageDays: 30, reportDays: 365, observationDays: 30,
      runDays: 30, notificationDeliveryDays: 90, protectionEventDays: 30,
    });
    const viewer = { userId: `viewer:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [c.organizationId,viewer.userId]);
    const input = { sourceSnapshotDays: 14, containerImageDays: 14, reportDays: 180, observationDays: 14, runDays: 14, notificationDeliveryDays: 60, protectionEventDays: 14 };
    await expect(api.retention.updatePolicy(c.identity, { organizationId: c.organizationId, ...input })).resolves.toMatchObject(input);
    await expect(api.retention.getPolicy(viewer, { organizationId: c.organizationId })).resolves.toMatchObject(input);
    await expect(api.retention.updatePolicy(viewer, { organizationId: c.organizationId, ...input })).rejects.toMatchObject({ status: 403 });
    await expect(api.retention.updatePolicy(c.identity, { organizationId: c.organizationId, ...input, sourceSnapshotDays: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('claims durable purge work, preserves in-use source, and invalidates exact approvals before erasing their source', async () => {
    const c = await customer();
    const policy = { sourceSnapshotDays: 1, containerImageDays: 1, reportDays: 1, observationDays: 1, runDays: 1, notificationDeliveryDays: 1, protectionEventDays: 1 };
    await api.retention.updatePolicy(c.identity, { organizationId: c.organizationId, ...policy });
    const candidate = await api.customers.uploadSource(c.identity, { organizationId: c.organizationId, applicationId: c.applicationId,
      authorized: true, snapshot: { revision: 'candidate', files: [{ path: 'index.ts', content: 'export const privateValue="source-to-purge";' }] } });
    const active = await api.customers.uploadSource(c.identity, { organizationId: c.organizationId, applicationId: c.applicationId,
      authorized: true, snapshot: { revision: 'active', files: [{ path: 'index.ts', content: 'export const activeValue=1;' }] } });
    const executing = await api.customers.uploadSource(c.identity, { organizationId: c.organizationId, applicationId: c.applicationId,
      authorized: true, snapshot: { revision: 'executing', files: [{ path: 'index.ts', content: 'export const executionValue=1;' }] } });
    await api.customers.queue(c.identity, { organizationId: c.organizationId, applicationId: c.applicationId, mode: 'internal',
      sourceSnapshotId: active.id, targetId: null, idempotencyKey: `retention:${randomUUID()}` });
    const action = actionV2Schema.parse({ version: 2, kind: 'dependency_pull_request', capabilityId: 'repository.dependency_pr',
      organizationId: c.organizationId, applicationId: c.applicationId, policyVersion: 'gotchu-action-policy-v2',
      target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: 'retention-fixture', branch: 'main' },
      baseCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40), changes: [{ name: 'fixture-package', from: '1.0.0', to: '1.0.1' }],
      advisoryIds: ['GHSA-fixture'], lockfileSha256: 'c'.repeat(64), patchSha256: 'd'.repeat(64),
      rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID(),
      evidence: [{ id: candidate.id, sha256: candidate.digest, kind: 'dependency_candidate' }],
    });
    const actionHash = hashActionV2(action, '1');
    const proposalId = randomUUID(); const approvalId = randomUUID(); const proofId = randomUUID();
    const factorId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,source_ref)
      VALUES($1,$2,$3,$4,$5::jsonb,1,2,'dependency_pull_request','repository.dependency_pr','approved',$6::jsonb)`, [
      c.organizationId,c.applicationId,proposalId,actionHash,JSON.stringify(action),JSON.stringify({ type: 'dependency_candidate', candidateId: candidate.id }),
    ]);
    const executingAction = actionV2Schema.parse({ ...action, evidence: [{ id: executing.id, sha256: executing.digest, kind: 'dependency_candidate' }] });
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,source_ref)
      VALUES($1,$2,$3,$4,$5::jsonb,1,2,'dependency_pull_request','repository.dependency_pr','executing',$6::jsonb)`, [
      c.organizationId,c.applicationId,randomUUID(),hashActionV2(executingAction, '1'),JSON.stringify(executingAction),JSON.stringify({ type: 'dependency_candidate', candidateId: executing.id }),
    ]);
    await f.admin.query('INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,proof_id,recovery_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp()+interval \'1 hour\')',
      [c.organizationId,approvalId,proposalId,actionHash,c.identity.userId,proofId]);
    await f.admin.query('INSERT INTO gotchu.step_up_user_factors(user_id,id,credential_id,public_key,label) VALUES($1,$2,$3,$4,$5)',
      [c.identity.userId,factorId,`retention:${factorId}`,Buffer.from('test-key'),'retention fixture']);
    await f.admin.query(`INSERT INTO gotchu.step_up_proofs(organization_id,id,user_id,proof_hash,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id,factor_count,factor_ids)
      VALUES($1,$2,$3,$4,$5,1,clock_timestamp(),clock_timestamp()+interval '1 hour',$6,1,ARRAY[$6]::uuid[])`,
      [c.organizationId,proofId,c.identity.userId,'e'.repeat(64),actionHash,factorId]);
    await f.admin.query("UPDATE gotchu.customer_sources SET created_at=clock_timestamp()-interval '2 days' WHERE organization_id=$1 AND id IN ($2,$3)",
      [c.organizationId,candidate.id,active.id]);
    await f.admin.query('UPDATE gotchu.customer_sources SET created_at=clock_timestamp()-interval \'2 days\' WHERE organization_id=$1 AND id=$2', [c.organizationId,executing.id]);

    const claim = present((await coordinator.retention.claimDue({ organizationId: c.organizationId, limit: 10 }))[0]);
    expect(claim.application_id).toBe(c.applicationId);
    const result = await coordinator.retention.purge(claim);
    expect(result).toMatchObject({ sourceSnapshots: 1, proposalsInvalidated: 1 });
    const sourceRows = await f.admin.query('SELECT id,body,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [c.organizationId,[candidate.id,active.id,executing.id]]);
    expect(sourceRows.rows.find(row => row.id === candidate.id)).toMatchObject({ body: null });
    expect(sourceRows.rows.find(row => row.id === active.id)?.body).not.toBeNull();
    expect(sourceRows.rows.find(row => row.id === executing.id)?.body).not.toBeNull();
    const state = await f.admin.query(`SELECT p.state,p.invalidation_reason,a.consumed_at,proof.consumed_at AS proof_consumed_at
      FROM gotchu.proposals p JOIN gotchu.approvals a ON a.organization_id=p.organization_id AND a.proposal_id=p.id
      JOIN gotchu.step_up_proofs proof ON proof.organization_id=p.organization_id AND proof.id::text=a.proof_id
      WHERE p.organization_id=$1 AND p.id=$2`, [c.organizationId,proposalId]);
    expect(state.rows[0]).toMatchObject({ state: 'invalidated', invalidation_reason: 'retention_source_purged' });
    expect(state.rows[0]?.consumed_at).not.toBeNull();
    expect(state.rows[0]?.proof_consumed_at).not.toBeNull();
    const audit = await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action='retention.purged' AND subject_id=$2", [c.organizationId,c.applicationId]);
    expect(audit.rows[0]?.detail).toMatchObject({ sourceSnapshots: 1, proposalsInvalidated: 1 });
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('source-to-purge');
  });

  it('trims count quotas and exposes the remaining workspace application capacity', async () => {
    const c = await customer();
    await f.admin.query('INSERT INTO gotchu.operation_monitors(organization_id,application_id,enabled,interval_seconds,author_id) VALUES($1,$2,false,3600,$3)', [c.organizationId,c.applicationId,c.identity.userId]);
    await f.admin.query(`INSERT INTO gotchu.operation_runs(organization_id,application_id,id,monitor_revision,lease_token,lease_until,status)
      SELECT $1,$2,gen_random_uuid(),1,gen_random_uuid(),clock_timestamp(),'completed' FROM generate_series(1,1000)`, [c.organizationId,c.applicationId]);
    await f.admin.query(`WITH seeded AS (SELECT gen_random_uuid() AS id,n FROM generate_series(1,2000) n)
      INSERT INTO gotchu.operation_observations(organization_id,application_id,id,idempotency_key,content_hash,body,basis,expires_at)
      SELECT $1,$2,id,'quota-seed:'||n,repeat('a',64),jsonb_build_object('id',id::text,'organizationId',$1::uuid::text,'applicationId',$2::uuid::text,'verification','trusted_observation'),
        '{}'::jsonb,clock_timestamp()+interval '1 day' FROM seeded`, [c.organizationId,c.applicationId]);
    await f.admin.query(`WITH seeded AS (SELECT gen_random_uuid() AS id FROM generate_series(1,100))
      INSERT INTO gotchu.operation_plans(organization_id,application_id,id,revision,action_hash,body)
      SELECT $1,$2,id,1,repeat('b',64),jsonb_build_object('id',id::text,'organizationId',$1::uuid::text,'applicationId',$2::uuid::text,
        'revision',1,'actionHash',repeat('b',64),'execution','disabled','state','draft','observationIds','[]'::jsonb) FROM seeded`, [c.organizationId,c.applicationId]);

    const claim = present((await coordinator.retention.claimDue({ organizationId: c.organizationId }))[0]);
    const result = await coordinator.retention.purge(claim);
    expect(result).toMatchObject({ runsTrimmed: 1, observationsTrimmed: 1, plansTrimmed: 1 });
    await expect(api.operations.getCoverage(c.identity, { organizationId: c.organizationId, applicationId: c.applicationId })).resolves.toMatchObject({
      quotas: { runs: { used: 999, limit: 1000 }, observations: { used: 1999, limit: 2000 }, plans: { used: 99, limit: 100 } },
    });
  });
});
