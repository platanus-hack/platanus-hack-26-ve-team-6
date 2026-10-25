import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('scoped proposal approval locks on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const proposalId = randomUUID();
  const otherProposalId = randomUUID();
  const otherApplicationId = randomUUID();
  const approvalIds = [randomUUID(), randomUUID()].sort();
  const otherApprovalId = randomUUID();
  const lock = 'SELECT id FROM gotchu.lock_proposal_approvals($1,$2,$3) AS id';
  beforeAll(async () => {
    f = await fixture();
    await f.admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Other app')", [f.a.organizationId,otherApplicationId]);
    for (const id of [proposalId, otherProposalId]) {
      await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind)
        VALUES($1,$2,$3,$4,'{}',1,2,'dependency_pull_request')`, [f.a.organizationId,f.a.applicationId,id,'a'.repeat(64)]);
    }
    // Reverse insertion order so result ordering cannot rely on heap order.
    for (const id of [...approvalIds].reverse().concat(otherApprovalId)) {
      await f.admin.query(`INSERT INTO gotchu.approvals
        (organization_id,id,proposal_id,action_hash,user_id,recovery_epoch,expires_at,proof_id,authorization_method)
        VALUES($1,$2,$3,$4,$5,1,clock_timestamp()-interval '1 minute',NULL,'owner_session')`,
      [f.a.organizationId,id,id === otherApprovalId ? otherProposalId : proposalId,'a'.repeat(64),f.a.userId]);
    }
  });
  afterAll(async () => { await f?.close(); });

  it.each(['gotchu_api', 'gotchu_executor'] as const)('%s locks only the requested tenant/application/proposal in ID order', async role => {
    const read = (tenant: string, organization: string, application: string, proposal: string) =>
      f.databases[role].tenant(tenant, tx => tx.query(lock, [organization,application,proposal]));
    expect((await read(f.a.organizationId,f.a.organizationId,f.a.applicationId,proposalId)).rows)
      .toEqual(approvalIds.map(id => ({ id })));
    expect((await read(f.b.organizationId,f.a.organizationId,f.a.applicationId,proposalId)).rows).toEqual([]);
    expect((await read(f.b.organizationId,f.b.organizationId,f.a.applicationId,proposalId)).rows).toEqual([]);
    expect((await read(f.a.organizationId,f.a.organizationId,otherApplicationId,proposalId)).rows).toEqual([]);
    expect((await read(f.a.organizationId,f.a.organizationId,f.a.applicationId,randomUUID())).rows).toEqual([]);
  });

  it('holds every matching approval lock without locking the proposal or unrelated approvals', async () => {
    await f.databases.gotchu_api.tenant(f.a.organizationId, async tx => {
      await tx.query(lock, [f.a.organizationId,f.a.applicationId,proposalId]);
      for (const id of approvalIds) {
        await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, other => other.query(
          'SELECT id FROM gotchu.approvals WHERE organization_id=$1 AND id=$2 FOR UPDATE NOWAIT', [f.a.organizationId,id])))
          .rejects.toMatchObject({ code: '55P03' });
      }
      await f.databases.gotchu_executor.tenant(f.a.organizationId, async other => {
        expect((await other.query('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE NOWAIT',
          [f.a.organizationId,proposalId])).rows).toEqual([{ id: proposalId }]);
        expect((await other.query('SELECT id FROM gotchu.approvals WHERE organization_id=$1 AND id=$2 FOR UPDATE NOWAIT',
          [f.a.organizationId,otherApprovalId])).rows).toEqual([{ id: otherApprovalId }]);
      });
    });
  });

  it('retains API mutation denial and excludes other runtime roles', async () => {
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(
      'UPDATE gotchu.approvals SET consumed_at=clock_timestamp() WHERE organization_id=$1 AND proposal_id=$2', [f.a.organizationId,proposalId])))
      .rejects.toMatchObject({ code: '42501' });
    for (const role of ['gotchu_ingest', 'gotchu_coordinator', 'gotchu_validator'] as const) {
      await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query(lock, [f.a.organizationId,f.a.applicationId,proposalId])))
        .rejects.toMatchObject({ code: '42501' });
    }
    const definition = await f.admin.query(`SELECT p.prosecdef,p.proconfig,r.rolname,r.rolbypassrls,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='gotchu.lock_proposal_approvals(uuid,uuid,uuid)'::regprocedure`);
    expect(definition.rows).toEqual([{ prosecdef:true, proconfig:['search_path=pg_catalog'], rolname:'gotchu_owner', rolbypassrls:false, public_execute:false }]);
    const policies = await f.admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('gotchu.approvals'::regclass,'gotchu.proposals'::regclass) ORDER BY relname`);
    expect(policies.rows).toEqual(['approvals','proposals'].map(relname => ({ relname, relrowsecurity:true, relforcerowsecurity:true })));
  });
});
