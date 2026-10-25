import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../src/index.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
live('workflow policy exception registry on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture({ max: 3 }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function repositoryLink(organizationId: string, applicationId: string) {
    const id = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source)
      VALUES($1,$2,$3,$4,'main','granted','not_granted','verified','operator')`, [organizationId, applicationId, id, `catalog:${randomUUID()}`]);
    return id;
  }

  it('requires exact Owner confirmation, audits versions, removes immediately, and isolates tenants', async () => {
    const repositoryLinkId = await repositoryLink(f.a.organizationId, f.a.applicationId);
    const scope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, repositoryLinkId,
      workflowPath: '.github/workflows/ci.yml', rule: 'pull_request_target' as const,
      justification: 'This existing deployment workflow is reviewed and constrained.' };
    const service = createBackend({ database:f.databases.gotchu_api }).workflowExceptions;
    const { actionHash } = await service.getHash({ userId:f.a.userId }, scope);
    await expect(service.create({userId:f.a.userId},scope)).rejects.toMatchObject({code:'invalid_input'});
    await expect(service.create({userId:f.a.userId},{...scope,actionHash,stepUpProof:'obsolete'})).rejects.toMatchObject({code:'invalid_input'});
    await expect(service.create({userId:f.a.userId},{...scope,actionHash:'f'.repeat(64)})).rejects.toMatchObject({code:'hash_mismatch'});
    await expect(service.create({userId:f.a.userId},{...scope,actionHash,justification:'A different reviewed exception justification.'})).rejects.toMatchObject({code:'hash_mismatch'});
    const operator=`exception-operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')",[f.a.organizationId,operator]);
    for(const userId of [operator,f.b.userId]) {
      await expect(service.create({userId},{...scope,actionHash})).rejects.toMatchObject({code:'forbidden'});
    }

    const first = await service.create({ userId: f.a.userId }, { ...scope, actionHash });
    expect(first).toMatchObject({ version: 1, workflowPath: scope.workflowPath, rule: scope.rule });
    await expect(service.create({ userId: f.a.userId }, { ...scope, actionHash }))
      .rejects.toMatchObject({ code: 'exception_already_active' });
    const auditCreated = await f.admin.query<{ detail: { exceptionHash: string; authorizationMethod:string; proofId:null } }>(`SELECT detail FROM gotchu.audit_records
      WHERE organization_id=$1 AND subject_id=$2 AND action='workflow.exception_created'`, [f.a.organizationId, first.id]);
    expect(auditCreated.rows[0]?.detail).toMatchObject({ exceptionHash: actionHash, authorizationMethod:'owner_session',proofId:null });

    const otherTenant = createBackend({ database: f.databases.gotchu_api }).workflowExceptions;
    await expect(otherTenant.getHash({ userId: f.b.userId }, { ...scope, organizationId: f.b.organizationId, applicationId: f.b.applicationId }))
      .rejects.toMatchObject({ code: 'repository_link_unavailable' });
    await expect(otherTenant.list({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.b.applicationId }))
      .resolves.toMatchObject({ repositories: [], exceptions: [] });

    await service.remove({ userId: f.a.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      repositoryLinkId, exceptionId: first.id, version: first.version });
    await expect(service.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))
      .resolves.toMatchObject({ exceptions: [] });
    await expect(service.create({userId:f.a.userId},{...scope,actionHash})).rejects.toMatchObject({code:'hash_mismatch'});
    const renewed=await service.getHash({userId:f.a.userId},scope);
    const second = await service.create({ userId: f.a.userId }, { ...scope, actionHash:renewed.actionHash });
    expect(second).toMatchObject({ id: first.id, version: 2 });
    const auditRemoved = await f.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.audit_records
      WHERE organization_id=$1 AND subject_id=$2 AND action='workflow.exception_removed'`, [f.a.organizationId, first.id]);
    expect(auditRemoved.rows[0]?.count).toBe(1);
  });
  it('rejects confirmation after repository revision changes or revocation', async () => {
    const repositoryLinkId=await repositoryLink(f.a.organizationId,f.a.applicationId);
    const scope={organizationId:f.a.organizationId,applicationId:f.a.applicationId,repositoryLinkId,
      workflowPath:'.github/workflows/build.yml',rule:'pull_request_target',justification:'This workflow has been reviewed for the exact repository.'};
    const identity={userId:f.a.userId};
    const service=createBackend({database:f.databases.gotchu_api}).workflowExceptions;
    const {actionHash}=await service.getHash(identity,scope);
    await f.admin.query("UPDATE gotchu.application_repository_links SET default_branch='release' WHERE organization_id=$1 AND id=$2",[scope.organizationId,repositoryLinkId]);
    await expect(service.create(identity,{...scope,actionHash})).rejects.toMatchObject({code:'hash_mismatch'});
    await f.admin.query("UPDATE gotchu.application_repository_links SET default_branch='main' WHERE organization_id=$1 AND id=$2",[scope.organizationId,repositoryLinkId]);
    await expect(service.create(identity,{...scope,actionHash})).rejects.toMatchObject({code:'hash_mismatch'});
    const fresh=await service.getHash(identity,scope);
    await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true WHERE organization_id=$1 AND id=$2',[scope.organizationId,repositoryLinkId]);
    await expect(service.create(identity,{...scope,actionHash:fresh.actionHash})).rejects.toMatchObject({code:'repository_link_unavailable'});
    expect((await f.admin.query("SELECT id FROM gotchu.audit_records WHERE organization_id=$1 AND detail->>'repositoryLinkId'=$2",[scope.organizationId,repositoryLinkId])).rowCount).toBe(0);
  });

});
