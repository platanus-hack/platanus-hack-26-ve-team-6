import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend, type VerifiedStepUp } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('tenant application context on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture(); backend = createBackend({ database: f.databases.gotchu_api }); });
  beforeEach(async () => {
    await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    for (const table of ['application_origin_candidates', 'application_dependencies', 'application_deployments', 'application_repository_links', 'application_services', 'application_environments'] as const) {
      await f.admin.query(`DELETE FROM gotchu.${table} WHERE organization_id=$1 AND application_id=$2`, [f.a.organizationId, f.a.applicationId]);
    }
  });
  afterAll(async () => { await f?.close(); });
  const identity = () => ({ userId: f.a.userId });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  async function base() {
    const environment = await backend.context.createEnvironment(identity(), { ...scope(), name: 'production', kind: 'production' });
    if (!environment) throw new Error('Environment fixture was not created');
    const service = await backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'web', kind: 'web' });
    if (!service) throw new Error('Service fixture was not created');
    return { environment, service };
  }
  it('rejects cross-tenant access, lets viewers read, and denies viewers every mutation', async () => {
    const { environment, service } = await base();
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'fixture-repo', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    const viewer = `viewer:${crypto.randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewer]);
    await expect(backend.context.list({ userId: viewer }, scope())).resolves.toMatchObject({ environments: [{ id: environment.id }] });
    const attempts = [
      () => backend.context.createEnvironment({ userId: viewer }, { ...scope(), name: 'staging', kind: 'staging' }),
      () => backend.context.updateEnvironment({ userId: viewer }, { ...scope(), environmentId: environment.id, name: 'stage' }),
      () => backend.context.archiveEnvironment({ userId: viewer }, { ...scope(), environmentId: environment.id, archived: true }),
      () => backend.context.createService({ userId: viewer }, { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' }),
      () => backend.context.updateService({ userId: viewer }, { ...scope(), serviceId: service.id, name: 'renamed' }),
      () => backend.context.createRepositoryLink({ userId: viewer }, { ...scope(), repositoryKey: 'viewer-repo', defaultBranch: 'main' }),
      () => backend.context.revokeRepositoryLink({ userId: viewer }, { ...scope(), repositoryLinkId: link.id }),
      () => backend.context.createDeployment({ userId: viewer }, { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() }),
      () => backend.context.createDependency({ userId: viewer }, { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null }),
      () => backend.context.createOriginCandidate({ userId: viewer }, { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(backend.context.list({ userId: f.b.userId }, scope())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(backend.context.updateEnvironment({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.a.applicationId, environmentId: environment.id, name: 'stolen' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.revokeRepositoryLink({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.a.applicationId, repositoryLinkId: link.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects every mutation after application archive and rejects writes to archived environments', async () => {
    const { environment, service } = await base();
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'fixture-repo', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    const attempts = [
      () => backend.context.createEnvironment(identity(), { ...scope(), name: 'staging', kind: 'staging' }),
      () => backend.context.updateEnvironment(identity(), { ...scope(), environmentId: environment.id, name: 'stage' }),
      () => backend.context.archiveEnvironment(identity(), { ...scope(), environmentId: environment.id, archived: true }),
      () => backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' }),
      () => backend.context.updateService(identity(), { ...scope(), serviceId: service.id, name: 'renamed' }),
      () => backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'another-repo', defaultBranch: 'main' }),
      () => backend.context.revokeRepositoryLink(identity(), { ...scope(), repositoryLinkId: link.id }),
      () => backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() }),
      () => backend.context.createDependency(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null }),
      () => backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    await f.admin.query('UPDATE gotchu.application_environments SET archived=true WHERE organization_id=$1 AND application_id=$2 AND id=$3', [f.a.organizationId, f.a.applicationId, environment.id]);
    await expect(backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.updateService(identity(), { ...scope(), serviceId: service.id, name: 'renamed' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.createDependency(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects client trust assertions at the service and SQL boundaries', async () => {
    const { environment, service } = await base();
    await expect(backend.context.createEnvironment(identity(), { ...scope(), name: 'stage', kind: 'staging', state: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker', source: 'operator' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'repo', defaultBranch: 'main', readAccess: 'granted' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r', deployedAt: new Date().toISOString(), state: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', ownership: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    const db = f.databases.gotchu_api;
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_environment($1,$2,$3,$4,$5,$6,$7,$8)', [f.a.organizationId,f.a.applicationId,f.a.userId,crypto.randomUUID(),'stage','staging','signed_telemetry',null]))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_repository($1,$2,$3,$4,$5,$6,$7,$8)', [f.a.organizationId,f.a.applicationId,f.a.userId,crypto.randomUUID(),'repo','src','main','revoked']))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_deployment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [f.a.organizationId,f.a.applicationId,f.a.userId,environment.id,service.id,crypto.randomUUID(),'r',null,null,null,new Date(),'verified','operator']))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_origin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [f.a.organizationId,f.a.applicationId,f.a.userId,environment.id,crypto.randomUUID(),'https://example.com','customer_inventory','verified',null,'declared','customer_declared',null]))).rejects.toThrow('context_self_assertion');
  });
  it('requires exact Owner confirmation and Writer coverage without MFA, and revokes pending approvals', async () => {
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'gh-owner-writer-repo', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    const repositoryLinkId=link.id;
    const readerInstallationId = crypto.randomUUID().replaceAll(/\D/g, '').slice(0, 20);
    await f.admin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state)
      VALUES($1,$2,'owner-writer-test',$3,'active')`, [f.a.organizationId,readerInstallationId,f.a.userId]);
    await f.admin.query(`UPDATE gotchu.application_repository_links SET state='verified',installation_id=$4
      WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,readerInstallationId]);

    const proofs = new Map<string, VerifiedStepUp>();
    const verifiedWrites: string[] = [];
    let writerCommit = 'a'.repeat(40);
    const repositoryWriteAccessVerifier = async (input: { repositoryKey: string }) => {
      verifiedWrites.push(input.repositoryKey);
      return { installationId:'174788477',baseCommit:writerCommit };
    };
    const sessionBackend = createBackend({ database:f.databases.gotchu_api,repositoryWriteAccessVerifier });
    const writeBackend = createBackend({
      database:f.databases.gotchu_api,
      repositoryWriteAccessVerifier,
      stepUpVerifier:{ verify:async input => {
        const proof=proofs.get(input.proof);
        if (!proof) throw new Error('unissued test step-up');
        return proof;
      } },
    });
    const viewer=`writer-viewer:${crypto.randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [f.a.organizationId,viewer]);
    await expect(writeBackend.context.getRepositoryWriteAccessChallenge({userId:viewer},{...scope(),repositoryLinkId,grant:true}))
      .rejects.toMatchObject({code:'forbidden',status:403});

    const totpChallenge=await writeBackend.context.getRepositoryWriteAccessChallenge(identity(),{...scope(),repositoryLinkId,grant:true});
    const totpProofId=crypto.randomUUID();
    const totpAuthenticatedAt=new Date();
    const totpOpaque=crypto.randomUUID();
    proofs.set(totpOpaque,{proofId:totpProofId,userId:f.a.userId,organizationId:f.a.organizationId,actionHash:totpChallenge.actionHash,
      authenticatedAt:totpAuthenticatedAt,expiresAt:new Date(totpAuthenticatedAt.getTime()+300_000),method:'totp'});
    await expect(writeBackend.context.setRepositoryWriteAccess(identity(),{...scope(),repositoryLinkId,grant:true,
      actionHash:totpChallenge.actionHash,stepUpProof:totpOpaque})).rejects.toMatchObject({code:'step_up_required',status:403});

    const exactInput = {...scope(),repositoryLinkId,grant:true,actionHash:totpChallenge.actionHash};
    for (const userId of [viewer,f.b.userId]) {
      await expect(sessionBackend.context.setRepositoryWriteAccess({userId},exactInput)).rejects.toMatchObject({code:'forbidden'});
    }
    await expect(sessionBackend.context.setRepositoryWriteAccess(identity(),{...exactInput,actionHash:'f'.repeat(64)}))
      .rejects.toMatchObject({code:'stale_state'});
    await expect(sessionBackend.context.setRepositoryWriteAccess(identity(),{...exactInput,stepUpProof:'unverifiable'}))
      .rejects.toMatchObject({code:'step_up_unavailable'});
    writerCommit = 'c'.repeat(40);
    await expect(sessionBackend.context.setRepositoryWriteAccess(identity(),exactInput)).rejects.toMatchObject({code:'stale_state'});
    writerCommit = 'a'.repeat(40);

    async function issue(grant:boolean) {
      const challenge=await writeBackend.context.getRepositoryWriteAccessChallenge(identity(),{...scope(),repositoryLinkId,grant});
      return sessionBackend.context.setRepositoryWriteAccess(identity(),{...scope(),repositoryLinkId,grant,actionHash:challenge.actionHash});
    }
    await expect(issue(true)).resolves.toMatchObject({writeAccess:'granted'});
    expect(verifiedWrites.length).toBeGreaterThanOrEqual(4);
    await expect(sessionBackend.context.setRepositoryWriteAccess(identity(),exactInput)).rejects.toMatchObject({code:'stale_state'});
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
      VALUES($1,$2,$3,$4,$5::jsonb,1,2,'dependency_pull_request','repository.dependency_pr','approved','[]'::jsonb)`, [
      f.a.organizationId,f.a.applicationId,crypto.randomUUID(),'b'.repeat(64),JSON.stringify({target:{repositoryLinkId}}),
    ]);
    const proposal=await f.admin.query<{id:string}>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND body->\'target\'->>\'repositoryLinkId\'=$3',[f.a.organizationId,f.a.applicationId,repositoryLinkId]);
    const proposalId=proposal.rows[0]?.id;
    if (!proposalId) throw new Error('Pending proposal fixture was not stored');
    const state=await f.admin.query<{recovery_epoch:string}>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    const recoveryEpoch=String(state.rows[0]?.recovery_epoch);
    await f.admin.query(`UPDATE gotchu.proposals SET recovery_epoch=$3 WHERE organization_id=$1 AND id=$2`,[f.a.organizationId,proposalId,recoveryEpoch]);
    await f.admin.query(`INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,authorization_method,recovery_epoch,expires_at)
      VALUES($1,$2,$3,$4,$5,'owner_session',$6,clock_timestamp()+interval '5 minutes')`,[f.a.organizationId,crypto.randomUUID(),proposalId,'b'.repeat(64),f.a.userId,recoveryEpoch]);

    const staleRevoke = await sessionBackend.context.getRepositoryWriteAccessChallenge(identity(),{...scope(),repositoryLinkId,grant:false});
    await expect(issue(false)).resolves.toMatchObject({writeAccess:'revoked'});
    await expect(f.admin.query(`SELECT state,invalidation_reason FROM gotchu.proposals WHERE organization_id=$1 AND id=$2`,[f.a.organizationId,proposalId]))
      .resolves.toMatchObject({rows:[{state:'invalidated',invalidation_reason:'repository_write_access_revoked'}]});
    await expect(f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE organization_id=$1 AND proposal_id=$2',[f.a.organizationId,proposalId]))
      .resolves.toMatchObject({rows:[{consumed_at:expect.any(Date)}]});
    const audit=await f.admin.query<{action:string;detail:{method?:string;writerInstallationId?:string}}> (`SELECT action,detail FROM gotchu.audit_records WHERE organization_id=$1 AND subject_id=$2 AND action LIKE 'context.repository_write_access_%' ORDER BY created_at`,[f.a.organizationId,repositoryLinkId]);
    expect(audit.rows.map(row=>row.action)).toEqual(['context.repository_write_access_granted','context.repository_write_access_revoked']);
    expect(audit.rows.map(row=>row.detail.method)).toEqual(['owner_session','owner_session']);
    expect(audit.rows[0]?.detail.writerInstallationId).toBe('174788477');
    const decisions=await writeBackend.decisionRecords.list(identity(),{organizationId:f.a.organizationId,subjectId:repositoryLinkId,limit:20});
    expect(decisions.records.map(row=>row.action)).toEqual(expect.arrayContaining(['context.repository_write_access_granted','context.repository_write_access_revoked']));
    expect(decisions.records.find(row=>row.action==='context.repository_write_access_granted')?.summary).toContain('Owner verificó');
    await issue(true);
    await expect(sessionBackend.context.setRepositoryWriteAccess(identity(),{...scope(),repositoryLinkId,grant:false,actionHash:staleRevoke.actionHash}))
      .rejects.toMatchObject({code:'stale_state'});
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2',[f.a.organizationId,f.a.applicationId]);
    await expect(sessionBackend.context.getRepositoryWriteAccessChallenge(identity(),{...scope(),repositoryLinkId,grant:false}))
      .rejects.toMatchObject({code:'repository_link_unavailable'});
  });
  it('enforces environment, repository and target relationships without deriving ownership from scan authorization', async () => {
    const { environment, service } = await base();
    const otherEnvironment = await backend.context.createEnvironment(identity(), { ...scope(), name: 'staging', kind: 'staging' });
    if (!otherEnvironment) throw new Error('Second environment fixture was not created');
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: otherEnvironment.id, serviceId: service.id, releaseId: 'wrong-env', deployedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    const targetId = crypto.randomUUID();
    await f.admin.query("INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,requested_by,authorized_at,expires_at) VALUES($1,$2,$3,'https://example.com',1,'authorized',$4,now(),now()+interval '1 hour')", [f.a.organizationId,f.a.applicationId,targetId,f.a.userId]);
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', authorizationTargetId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://other.example', discoverySource: 'customer_inventory', authorizationTargetId: targetId })).rejects.toMatchObject({ code: 'invalid_input' });
    const foreignAppId = crypto.randomUUID(); const foreignTargetId = crypto.randomUUID();
    await f.admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Other application')", [f.a.organizationId,foreignAppId]);
    await f.admin.query("INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,requested_by) VALUES($1,$2,$3,'https://example.com',1,'revoked',$4)", [f.a.organizationId,foreignAppId,foreignTargetId,f.a.userId]);
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', authorizationTargetId: foreignTargetId })).rejects.toMatchObject({ code: 'invalid_input' });
    const origin = await backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', ownership: 'claimed', authorizationTargetId: targetId });
    expect(origin?.ownership).toBe('claimed');
    await f.admin.query("UPDATE gotchu.customer_targets SET authorized_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE organization_id=$1 AND application_id=$2 AND id=$3", [f.a.organizationId,f.a.applicationId,targetId]);
    expect((await backend.context.list(identity(), scope())).origins[0]?.ownership).toBe('claimed');
    await f.admin.query("UPDATE gotchu.customer_targets SET status='revoked',expires_at=NULL WHERE organization_id=$1 AND application_id=$2 AND id=$3", [f.a.organizationId,f.a.applicationId,targetId]);
    expect((await backend.context.list(identity(), scope())).origins[0]?.ownership).toBe('claimed');
    expect(await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'catalog-backed', defaultBranch: 'main' })).toMatchObject({ readAccess: 'granted', writeAccess: 'not_granted' });
    await expect(f.admin.query("INSERT INTO gotchu.application_deployments(organization_id,application_id,environment_id,service_id,id,release_id,deployed_at,state,source) VALUES($1,$2,$3,$4,$5,'bad-fk',now(),'declared','customer_declared')", [f.a.organizationId,f.a.applicationId,otherEnvironment.id,service.id,crypto.randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });
});
