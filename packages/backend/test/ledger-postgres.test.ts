import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setRecoveryState } from '@gotchu/database';
import type { ActionV2 } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { actionPolicyVersion, canonicalJson, createBackend, hashActionV2, hashStoredAction, proposalSchema, sha256, type ActionEligibility, type ProposalEligibility } from '../src/index.js';
import { createExecutionArtifactService } from '../src/execution-artifacts.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';
const live = liveUrl ? describe : describe.skip;
type PullRequestAction = Extract<ActionV2, { kind:'source_patch_pull_request'|'dependency_pull_request' }>;
live('real Postgres approval/execution ledger; injected test-only eligibility verifier', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let now = new Date();
  let factsOverride: Partial<ProposalEligibility> = {};
  let actionFacts: ActionEligibility = { eligible: true, blockingReasons: [], policyCurrent:true };
  const executorInstanceId = randomUUID();
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    const deps = { clock: { now: () => now }, proposalVerifier: { verify: async (p: Parameters<typeof eligibilityFixture>[0]) => ({ ...eligibilityFixture(p, now), ...factsOverride }) }, actionVerifier: { verify: async () => actionFacts } };
    api = createBackend({ ...deps, database: f.databases.gotchu_api });
    executor = createBackend({ ...deps, database: f.databases.gotchu_executor });
    await f.admin.query("INSERT INTO gotchu.action_executor_instances(instance_id,capability_id) VALUES($1,'repository.source_patch_pr'),($1,'repository.dependency_pr')", [executorInstanceId]);
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: no provider writes are performed' });
  }, 30_000);
  beforeEach(async () => { now = new Date(); factsOverride = {}; actionFacts = { eligible: true, blockingReasons: [], policyCurrent:true }; await f.admin.query('UPDATE gotchu.action_executor_instances SET heartbeat_at=clock_timestamp() WHERE instance_id=$1', [executorInstanceId]); });
  afterAll(async () => { if (f) { await f.admin.query('DELETE FROM gotchu.action_executor_instances WHERE instance_id=$1', [executorInstanceId]); await f.close(); } });
  const identity = () => ({ userId: f.a.userId });
  async function create() { return api.proposals.create({ organizationId: f.a.organizationId, proposal: proposalFixture(f.a) }); }
  const actionFixture = (): Extract<PullRequestAction,{kind:'source_patch_pull_request'}> => ({ version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: f.a.organizationId, applicationId: f.a.applicationId, policyVersion: actionPolicyVersion('repository.source_patch_pr') ?? 'unregistered', target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: `catalog:${randomUUID()}`, branch: 'main' }, baseCommit: '1'.repeat(40), expectedTreeSha:'2'.repeat(40), recipeId: 'tls-certificate-verification', recipeVersion: '1', snapshotSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64), findingIdentities: ['finding-1'], validationAttestationIds: [randomUUID()], evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), kind: 'private_correction_candidate' }] });
  const dependencyActionFixture = (): Extract<PullRequestAction,{kind:'dependency_pull_request'}> => ({version:2,kind:'dependency_pull_request',capabilityId:'repository.dependency_pr',organizationId:f.a.organizationId,applicationId:f.a.applicationId,policyVersion:actionPolicyVersion('repository.dependency_pr') ?? 'unregistered',target:{kind:'repository',repositoryLinkId:randomUUID(),repositoryKey:`catalog:${randomUUID()}`,branch:'main'},baseCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40),changes:[{name:'safe-package',from:'1.0.0',to:'1.0.1'}],advisoryIds:['GHSA-xxxx-yyyy-zzzz'],lockfileSha256:'c'.repeat(64),patchSha256:'d'.repeat(64),rescanAttestationId:randomUUID(),suiteAttestationId:randomUUID(),evidence:[{id:randomUUID(),sha256:'e'.repeat(64),kind:'candidate'}]});
  async function createV2(action:PullRequestAction = actionFixture()) {
    await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true,write_access=CASE WHEN write_access=\'granted\' THEN \'revoked\' ELSE write_access END,writer_installation_id=NULL,writer_verified_at=NULL,writer_verified_commit=NULL WHERE organization_id=$1 AND application_id=$2 AND NOT revoked', [action.organizationId,action.applicationId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,$5,'granted','granted','verified','operator','174788477',clock_timestamp(),$6)`, [action.organizationId,action.applicationId,action.target.repositoryLinkId,action.target.repositoryKey,action.target.branch,action.baseCommit]);
    const state = await f.admin.query<{ recovery_epoch: string }>('SELECT recovery_epoch FROM gotchu.platform_state');
    const recoveryEpoch = String(state.rows[0]?.recovery_epoch);
    const actionHash = hashActionV2(action, recoveryEpoch);
    const proposalId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,2,$7,$8,'eligible','[]'::jsonb)`, [f.a.organizationId,f.a.applicationId,proposalId,actionHash,JSON.stringify(action),recoveryEpoch,action.kind,action.capabilityId]);
    return { proposalId, actionHash, action, recoveryEpoch };
  }
  async function approved() {
    const p = await create();
    const a = await api.proposals.approve(identity(), { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash });
    return { ...p, ...a };
  }
  function sessionApi() {
    // Test-only eligibility facts exercise the ledger, not scanner or provider readiness.
    return createBackend({ database:f.databases.gotchu_api,clock:{now:()=>now},actionVerifier:{verify:async()=>actionFacts} });
  }
  it('records exact Owner session approval once for both PR kinds, with audit and outbox but no step-up row', async () => {
    await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='source_patch_pull_request'");
    const withoutMfa = sessionApi();
    const proofCount = await f.admin.query('SELECT id FROM gotchu.step_up_proofs WHERE organization_id=$1',[f.a.organizationId]);
    for (const action of [actionFixture(),dependencyActionFixture()]) {
      const proposal = await createV2(action);
      const input = {organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash};
      await expect(withoutMfa.actions.getEligibility(identity(),{organizationId:input.organizationId,applicationId:input.applicationId,proposalId:input.proposalId}))
        .resolves.toMatchObject({status:'eligible'});
      const attempts = await Promise.allSettled([withoutMfa.actions.approve(identity(),input),withoutMfa.actions.approve(identity(),input)]);
      expect(attempts.filter(attempt=>attempt.status==='fulfilled')).toHaveLength(1);
      const successful = attempts.find(attempt=>attempt.status==='fulfilled');
      if (!successful || successful.status !== 'fulfilled') throw new Error('Missing session approval');
      const approval = successful.value;
      expect(approval.expiresAt.getTime()-now.getTime()).toBe(300_000);
      expect((await f.admin.query('SELECT authorization_method,proof_id,user_id,action_hash FROM gotchu.approvals WHERE id=$1',[approval.approvalId])).rows)
        .toEqual([{authorization_method:'owner_session',proof_id:null,user_id:f.a.userId,action_hash:proposal.actionHash}]);
      expect((await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE subject_id=$1 AND action='action.approved'",[approval.approvalId])).rows)
        .toEqual([{detail:{proposalId:proposal.proposalId,actionHash:proposal.actionHash,authorizationMethod:'owner_session'}}]);
      expect((await f.admin.query("SELECT o.id FROM gotchu.outbox o JOIN gotchu.jobs j ON j.organization_id=o.organization_id AND j.id=o.job_id WHERE j.payload->>'approvalId'=$1",[approval.approvalId])).rowCount).toBe(1);
      await expect(withoutMfa.actions.approve(identity(),input)).rejects.toMatchObject({code:'proposal_ineligible'});
      const request = {organizationId:f.a.organizationId,approvalId:approval.approvalId};
      await executor.executions.claim(request);
      await expect(executor.executions.claim(request)).rejects.toMatchObject({code:'approval_used'});
    }
    expect((await f.admin.query('SELECT id FROM gotchu.step_up_proofs WHERE organization_id=$1',[f.a.organizationId])).rowCount).toBe(proofCount.rowCount);
  });
  it('requires the current Owner, tenant, application and exact hash, and rejects removed proof fields', async () => {
    const proposal = await createV2(dependencyActionFixture());
    const input = {organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash};
    const operator = `pr-operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')",[f.a.organizationId,operator]);
    for (const userId of [operator,f.b.userId]) {
      await expect(sessionApi().actions.approve({userId},input)).rejects.toMatchObject({code:'forbidden'});
    }
    await expect(sessionApi().actions.approve(identity(),{...input,applicationId:f.b.applicationId})).rejects.toMatchObject({code:'not_found'});
    await expect(sessionApi().actions.approve(identity(),{...input,actionHash:'f'.repeat(64)})).rejects.toMatchObject({code:'hash_mismatch'});
    await expect(api.actions.approve(identity(),Object.assign({},input,{stepUpProof:'unissued'}))).rejects.toMatchObject({code:'invalid_input'});
    await expect(sessionApi().actions.approve(identity(),Object.assign({},input,{stepUpProof:'unverifiable'}))).rejects.toMatchObject({code:'invalid_input'});
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2',[f.a.organizationId,f.a.applicationId]);
    try { await expect(sessionApi().actions.approve(identity(),input)).rejects.toMatchObject({code:'not_found'}); }
    finally { await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2',[f.a.organizationId,f.a.applicationId]); }
    expect((await f.admin.query('SELECT id FROM gotchu.approvals WHERE proposal_id=$1',[proposal.proposalId])).rowCount).toBe(0);
  });
  it('keeps session approval subject to cancellation, independent validation and base freshness', async () => {
    const proposal = await createV2(dependencyActionFixture());
    const input = {organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash};
    actionFacts = {eligible:false,blockingReasons:['validation_tampered']};
    await expect(sessionApi().actions.approve(identity(),input)).rejects.toMatchObject({code:'proposal_ineligible'});
    actionFacts = {eligible:false,blockingReasons:['base changed'],baseChanged:true};
    await expect(sessionApi().actions.approve(identity(),input)).rejects.toMatchObject({code:'stale_state'});
    actionFacts = {eligible:true,blockingReasons:[]};
    await expect(sessionApi().actions.approve(identity(),input)).rejects.toMatchObject({code:'not_found'});
    const cancelled = await createV2(dependencyActionFixture());
    await sessionApi().actions.cancel(identity(),{organizationId:input.organizationId,applicationId:input.applicationId,proposalId:cancelled.proposalId,reason:'cancelled'});
    await expect(sessionApi().actions.approve(identity(),{...input,proposalId:cancelled.proposalId,actionHash:cancelled.actionHash})).rejects.toMatchObject({code:'not_found'});
  });
  it('rechecks session approval expiry and current Owner at the executor boundary', async () => {
    const owner = `session-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",[f.a.organizationId,owner]);
    for (const reason of ['expired','demoted'] as const) {
      const proposal = await createV2(dependencyActionFixture());
      const approval = await sessionApi().actions.approve({userId:owner},{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash});
      if (reason === 'expired') now = new Date(now.getTime()+300_000);
      else await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2",[f.a.organizationId,owner]);
      await expect(executor.executions.claim({organizationId:f.a.organizationId,approvalId:approval.approvalId}))
        .rejects.toMatchObject({code:reason === 'expired' ? 'approval_expired' : 'forbidden'});
      now = new Date();
    }
  });
  it('restricts Owner session approval rows to supported PR schemas', async () => {
    const epoch=await f.admin.query<{recovery_epoch:string}>('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    for(const action of [
      {version:1,kind:'dependency_pull_request',capability:'repository.dependency_pr',body:{version:1,adapter:'github.merge'}},
      {version:2,kind:'merge_pull_request',capability:'repository.merge',body:{version:2}},
      {version:2,kind:'deploy_release',capability:'environment.deploy',body:{version:2}},
    ]) {
      const proposalId=randomUUID(); const actionHash=sha256(randomUUID());
      await expect(f.databases.gotchu_api.tenant(f.a.organizationId,async tx=>{
        await tx.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,[f.a.organizationId,f.a.applicationId,proposalId,actionHash,JSON.stringify(action.body),epoch.rows[0]?.recovery_epoch,action.version,action.kind,action.capability]);
        return tx.query(`INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,proof_id,recovery_epoch,expires_at,authorization_method)
          VALUES($1,$2,$3,$4,$5,NULL,$6,clock_timestamp()+interval '5 minutes','owner_session')`,[f.a.organizationId,randomUUID(),proposalId,actionHash,f.a.userId,epoch.rows[0]?.recovery_epoch]);
      }))
        .rejects.toThrow('owner_session_approval_requires_pr');
    }
  });
  it('keeps exact proposals immutable and idempotent', async () => {
    const proposal = proposalFixture(f.a);
    const first = await api.proposals.create({ organizationId: f.a.organizationId, proposal });
    expect(await api.proposals.create({ organizationId: f.a.organizationId, proposal })).toEqual(first);
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query("UPDATE gotchu.proposals SET body='{}' WHERE id=$1", [first.proposalId]))).rejects.toMatchObject({ code: '42501' });
    await expect(api.proposals.create({ organizationId: f.b.organizationId, proposal })).rejects.toMatchObject({ code: 'tenant_mismatch' });
  });
  it('keeps stored v1 proposal hashes byte-for-byte on the original v1 formula', async () => {
    const stored = await create();
    const row = (await f.admin.query<{ body: unknown; recovery_epoch: string; action_hash: string; version: number }>('SELECT body,recovery_epoch,action_hash,version FROM gotchu.proposals WHERE organization_id=$1 AND id=$2', [f.a.organizationId,stored.proposalId])).rows[0];
    if (!row) throw new Error('missing stored v1 proposal');
    const proposal = proposalSchema.parse(row.body);
    const legacyHash = sha256('gotchu-proposal-v1\n' + canonicalJson({ proposal, recoveryEpoch: String(row.recovery_epoch) }));
    expect(row.version).toBe(1);
    expect(legacyHash).toBe(stored.actionHash);
    expect(row.action_hash).toBe(legacyHash);
  });
  it('refuses v2 PR capabilities without an executor adapter', async () => {
    const secondaryOwner = `action-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, secondaryOwner]);
    await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=false WHERE kind='dependency_pull_request'");
    try {
      const proposal = await createV2(dependencyActionFixture());
      await expect(api.actions.approve(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId, actionHash: proposal.actionHash })).rejects.toMatchObject({ code: 'proposal_ineligible' });
      expect((await f.admin.query('SELECT id FROM gotchu.approvals WHERE proposal_id=$1', [proposal.proposalId])).rowCount).toBe(0);
      expect((await f.admin.query("SELECT id FROM gotchu.jobs WHERE kind='execution' AND payload->>'expectedActionHash'=$1", [proposal.actionHash])).rowCount).toBe(0);
    } finally {
      await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='dependency_pull_request'");
      await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, secondaryOwner]);
    }
  });
  it('invalidates pending approvals when the active server-owned action policy version changes', async () => {
    const proposal = await createV2();
    const currentVersion = actionPolicyVersion('repository.source_patch_pr');
    if (!currentVersion) throw new Error('Source patch policy is not registered in code');
    await f.admin.query("UPDATE gotchu.action_policy_registry SET active_version=$1 WHERE capability_id='repository.source_patch_pr'", [`${currentVersion}-next`]);
    try {
      expect((await f.admin.query('SELECT state,invalidation_reason FROM gotchu.proposals WHERE id=$1',[proposal.proposalId])).rows[0]).toEqual({state:'invalidated',invalidation_reason:'policy_changed'});
      await expect(api.actions.approve(identity(),{organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash})).rejects.toMatchObject({code:'not_found'});
    } finally {
      await f.admin.query("UPDATE gotchu.action_policy_registry SET active_version=$1 WHERE capability_id='repository.source_patch_pr'", [currentVersion]);
    }
  });
  it('invalidates v2 proposals when the recovery epoch changes', async () => {
    const proposal = await createV2();
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'freeze' });
    try {
      await expect(api.actions.getEligibility(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId })).resolves.toMatchObject({ status: 'ineligible', blockingReasons: ['propuesta invalidada tras una recuperación'] });
      expect((await f.admin.query('SELECT state,invalidated_at FROM gotchu.proposals WHERE id=$1', [proposal.proposalId])).rows[0]).toMatchObject({ state: 'invalidated' });
    }
    finally { await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: recovery invalidation check' }); }
  });
  it('invalidates a v2 proposal when the independent verifier observes a changed base', async () => {
    await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='source_patch_pull_request'");
    const proposal = await createV2();
    actionFacts = { eligible: false, blockingReasons: ['base changed'], baseChanged: true };
    try {
      await expect(api.actions.getEligibility(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId })).resolves.toMatchObject({ status: 'ineligible', blockingReasons: expect.arrayContaining(['base cambió desde la propuesta']) });
      expect((await f.admin.query('SELECT state,invalidated_at FROM gotchu.proposals WHERE id=$1', [proposal.proposalId])).rows[0]).toMatchObject({ state: 'invalidated' });
    } finally { await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='source_patch_pull_request'"); }
  });
  it('reports explicit blockers without a trusted v2 verifier or write adapter and keeps tenant reads isolated', async () => {
    const proposal = await createV2();
    const disabled = createBackend({ database: f.databases.gotchu_api });
    await expect(disabled.actions.getEligibility(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId })).resolves.toMatchObject({ status: 'ineligible', blockingReasons: expect.arrayContaining(['validación en VM no disponible']) });
    await expect(api.actions.get({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.b.applicationId, proposalId: proposal.proposalId })).rejects.toMatchObject({ status: 404 });
  });
  it('keeps PR approval unavailable when no executor heartbeat is live', async () => {
    const proposal = await createV2();
    await f.admin.query('UPDATE gotchu.action_executor_instances SET heartbeat_at=clock_timestamp()-interval \'2 minutes\' WHERE instance_id=$1', [executorInstanceId]);
    try {
      await expect(api.actions.getEligibility(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId }))
        .resolves.toMatchObject({ status:'ineligible',blockingReasons:expect.arrayContaining(['executor no disponible']) });
      await expect(api.actions.approve(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash }))
        .rejects.toMatchObject({ code:'proposal_ineligible' });
      expect((await f.admin.query('SELECT id FROM gotchu.approvals WHERE proposal_id=$1',[proposal.proposalId])).rowCount).toBe(0);
    } finally {
      await f.admin.query('UPDATE gotchu.action_executor_instances SET heartbeat_at=clock_timestamp() WHERE instance_id=$1', [executorInstanceId]);
    }
  });
  it('builds a source patch action only from stored candidate and context records and projects no private source content', async () => {
    const candidateId = randomUUID(); const repositoryLinkId = randomUUID();
    const privateMarker = 'PRIVATE_SOURCE_MUST_NOT_LEAK';
    const revision = 'a'.repeat(40);
    const baseSourceId = randomUUID();
    const baseBody = { revision, files: [{ path: 'src/config.ts', content: 'const secure = false;\n' }] };
    const body = { revision, files: [{ path: 'src/config.ts', content: privateMarker }] };
    const sourceDigest = sha256(canonicalJson(baseBody)); const candidateDigest = sha256(canonicalJson(body)); const patchHash = 'e'.repeat(64);
    await f.admin.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES($1,$2,$3,$4,$5::jsonb,$6),($1,$2,$7,$8,$9::jsonb,$6)', [f.a.organizationId,f.a.applicationId,baseSourceId,sourceDigest,JSON.stringify(baseBody),f.a.userId,candidateId,candidateDigest,JSON.stringify(body)]);
    await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true,write_access=CASE WHEN write_access=\'granted\' THEN \'revoked\' ELSE write_access END,writer_installation_id=NULL,writer_verified_at=NULL,writer_verified_commit=NULL WHERE organization_id=$1 AND application_id=$2 AND NOT revoked', [f.a.organizationId,f.a.applicationId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,'main','granted','granted','verified','operator','174788477',clock_timestamp(),$5)`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,'catalog:service',revision]);
    await f.admin.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [f.a.organizationId,randomUUID(),f.a.userId,'correction.prepared',candidateId,JSON.stringify({ recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', findingId: 'finding-identity', patchHash, candidateSourceDigest: candidateDigest, path: 'src/config.ts', originalSourceId:baseSourceId, sourceDigest })]);
    const proposed = await api.actions.propose(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId } });
    const card = await api.actions.get(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposed.proposalId });
    expect(card).toMatchObject({ state: 'ineligible', target: { kind: 'repository', repositoryLinkId, repositoryKey: 'catalog:service', branch: 'main' }, diff: { path: 'src/config.ts' }, blockingReasons: expect.arrayContaining(['repository_tree_unavailable']) });
    expect(JSON.stringify(card)).not.toContain(privateMarker);
  });
  it('stores exact source patch bytes atomically from the candidate snapshot', async () => {
    const baseId = randomUUID(); const candidateId = randomUUID(); const repositoryLinkId = randomUUID();
    const revision = 'a'.repeat(40);
    const nonce = randomUUID();
    const baseBody = { revision, files: [{ path: 'src/config.ts', content: `const secure = false;\n// ${nonce}\n` }] };
    const candidateBody = { revision, files: [{ path: 'src/config.ts', content: `const secure = true;\n// ${nonce}\n` }] };
    const sourceDigest = sha256(canonicalJson(baseBody)); const candidateDigest = sha256(canonicalJson(candidateBody)); const patchHash = 'e'.repeat(64);
    await f.admin.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES($1,$2,$3,$4,$5::jsonb,$6),($1,$2,$7,$8,$9::jsonb,$6)', [f.a.organizationId,f.a.applicationId,baseId,sourceDigest,JSON.stringify(baseBody),f.a.userId,candidateId,candidateDigest,JSON.stringify(candidateBody)]);
    await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true WHERE organization_id=$1 AND application_id=$2 AND NOT revoked', [f.a.organizationId,f.a.applicationId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,state,source,writer_installation_id,writer_verified_at,writer_verified_commit)
      VALUES($1,$2,$3,$4,'main','granted','granted','verified','operator','174788477',clock_timestamp(),$5)`, [f.a.organizationId,f.a.applicationId,repositoryLinkId,`catalog:${randomUUID()}`,'a'.repeat(40)]);
    await f.admin.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [f.a.organizationId,randomUUID(),f.a.userId,'correction.prepared',candidateId,JSON.stringify({ recipeId:'tls-certificate-verification',recipeVersion:'1.0.0',findingId:'finding-identity',patchHash,candidateSourceDigest:candidateDigest,path:'src/config.ts',originalSourceId:baseId,sourceDigest })]);

    const makeApi = (treeSha: string) => createBackend({ database:f.databases.gotchu_api, actionVerifier: {
      verify: async () => ({ eligible:false,blockingReasons:['validation_missing'] }),
      prepareArtifact: async input => {
        expect(input.files).toEqual([{ path:'src/config.ts',content:candidateBody.files[0]!.content,mode:'100644' }]);
        return { treeSha,unsupportedReason:null };
      },
    } });
    const sourceRef = { type:'correction_candidate' as const,candidateId };
    await expect(makeApi('not-a-tree-sha').actions.propose(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,kind:'source_patch_pull_request',sourceRef }))
      .rejects.toThrow();
    const absent = await f.admin.query('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND body->\'evidence\'->0->>\'id\'=$2', [f.a.organizationId,candidateId]);
    expect(absent.rowCount).toBe(0);

    const forgedRef = { ...sourceRef, files:[{ path:'src/config.ts',content:'caller controlled' }] };
    await expect(api.actions.propose(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,kind:'source_patch_pull_request',sourceRef:forgedRef }))
      .rejects.toMatchObject({ code:'invalid_input' });
    const proposed = await makeApi('d'.repeat(40)).actions.propose(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,kind:'source_patch_pull_request',sourceRef });
    const artifact = await createExecutionArtifactService(f.databases.gotchu_executor).readForExecutor({ organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposed.proposalId });
    expect(artifact).toMatchObject({ baseCommit:revision,treeSha:'d'.repeat(40),treeComplete:true,unsupportedReason:null,snapshotSha256:candidateDigest,patchSha256:patchHash,artifactSha256:candidateDigest });
    expect(Buffer.from(artifact.files[0]!.contentBase64,'base64').toString('utf8')).toBe(candidateBody.files[0]!.content);
  });
  it('rejects removed proof fields, forged timestamps, hash mismatch and missing independent verification', async () => {
    const p = await create();
    const input = { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash };
    await expect(api.proposals.approve(identity(), Object.assign({}, input, { stepUpProof:'obsolete' }))).rejects.toMatchObject({ code:'invalid_input' });
    await expect(api.proposals.approve(identity(), Object.assign({}, input, { stepUpAt:now.toISOString() }))).rejects.toMatchObject({ code:'invalid_input' });
    await expect(api.proposals.approve(identity(), { ...input, actionHash:'0'.repeat(64) })).rejects.toMatchObject({ code:'hash_mismatch' });
    await expect(api.proposals.approve({userId:f.b.userId}, input)).rejects.toMatchObject({ code:'forbidden' });
    const disabled = createBackend({ database:f.databases.gotchu_api });
    await expect(disabled.proposals.approve(identity(), input)).rejects.toMatchObject({ code:'verification_unavailable' });
  });
  it('records legacy Owner approval once, claims it once, and rechecks it when recovering uncertainty', async () => {
    const p = await create();
    const input = { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash };
    const confirmations=await Promise.allSettled([api.proposals.approve(identity(),input),api.proposals.approve(identity(),input)]);
    expect(confirmations.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const confirmed=confirmations.find(result=>result.status==='fulfilled');
    if(!confirmed || confirmed.status!=='fulfilled') throw new Error('Missing legacy Owner approval');
    const approval=confirmed.value;
    expect(approval.expiresAt.getTime()-now.getTime()).toBe(300_000);
    expect((await f.admin.query('SELECT authorization_method,proof_id FROM gotchu.approvals WHERE id=$1',[approval.approvalId])).rows)
      .toEqual([{authorization_method:'owner_session',proof_id:null}]);
    expect((await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE subject_id=$1 AND action='proposal.approved'",[approval.approvalId])).rows)
      .toEqual([{detail:{proposalId:p.proposalId,actionHash:p.actionHash,authorizationMethod:'owner_session'}}]);
    await expect(api.proposals.approve(identity(), input)).rejects.toMatchObject({ code: 'approval_used' });
    const attempts = await Promise.allSettled([executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId }), executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId })]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    const claim = present(attempts.find(a => a.status === 'fulfilled'));
    if (claim.status !== 'fulfilled') throw new Error('missing claim');
    const token = { organizationId: f.a.organizationId, executionId: claim.value.executionId, claimToken: claim.value.claimToken };
    await executor.executions.assertWritable(token);
    await executor.executions.finish({ ...token, outcome: 'uncertain' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId })).rejects.toMatchObject({ code: 'approval_used' });
    await expect(executor.executions.assertWritable(token)).resolves.toBeUndefined();
    expect((await f.admin.query('SELECT state FROM gotchu.executions WHERE id=$1', [claim.value.executionId])).rows[0].state).toBe('uncertain');
  });
  it('persists monotonic executor attempt transitions across a backend restart', async () => {
    const approval=await approved();
    const claim=await executor.executions.claim({organizationId:f.a.organizationId,approvalId:approval.approvalId});
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'claim',state:'claimed'});
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'publish_branch',state:'branch_published',detail:{branch:'gotchu/test-action'}});
    await expect(executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'claim',state:'claimed'})).rejects.toMatchObject({code:'invalid_attempt_transition'});
    const restarted=createBackend({database:f.databases.gotchu_executor});
    await expect(restarted.executions.listAttempts({organizationId:f.a.organizationId,executionId:claim.executionId})).resolves.toMatchObject([{attempt:1,state:'branch_published',step:'publish_branch',detail:{branch:'gotchu/test-action'}}]);
  });
  it('projects the verified PR URL and complete attempt events to authorized workspace members', async () => {
    const proposal = await createV2();
    const approval = await api.actions.approve(identity(), { organizationId:f.a.organizationId,applicationId:f.a.applicationId,proposalId:proposal.proposalId,actionHash:proposal.actionHash });
    const claim = await executor.executions.claim({ organizationId:f.a.organizationId,approvalId:approval.approvalId });
    const pullRequestUrl = 'https://github.com/example/project/pull/42';
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'claim',state:'claimed'});
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'publish_branch',state:'branch_published',detail:{branch:'gotchu/approved-action'}});
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'open_pr',state:'pr_opened',providerReference:pullRequestUrl,detail:{branch:'gotchu/approved-action',pullRequestNumber:42}});
    await executor.executions.recordAttempt({organizationId:f.a.organizationId,executionId:claim.executionId,attempt:1,step:'verify',state:'verified',providerReference:pullRequestUrl,detail:{pullRequestNumber:42}});
    await executor.executions.finish({organizationId:f.a.organizationId,executionId:claim.executionId,claimToken:claim.claimToken,outcome:'succeeded',providerReference:pullRequestUrl});
    const rows = await api.actions.list(identity(),{organizationId:f.a.organizationId,applicationId:f.a.applicationId});
    expect(rows.find(row => row.id === proposal.proposalId)).toMatchObject({
      state:'succeeded',execution:{status:'succeeded',pullRequestUrl,attempts:[
        {attempt:1,step:'claim',state:'claimed'},
        {attempt:1,step:'publish_branch',state:'branch_published',branch:'gotchu/approved-action'},
        {attempt:1,step:'open_pr',state:'pr_opened',pullRequestNumber:42},
        {attempt:1,step:'verify',state:'verified',pullRequestNumber:42},
      ]},
    });
  });
  it('rejects stale target head and commits invalidation even if the head is later restored', async () => {
    const a = await approved();
    factsOverride = { currentBaseCommit: '3'.repeat(40) };
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'stale_state' });
    factsOverride = {};
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'proposal_invalidated' });
    expect((await f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE id=$1', [a.approvalId])).rows[0].consumed_at).toBeNull();
  });
  it('rejects expired approval and revoked owner authority', async () => {
    const expired = await approved();
    now = new Date(now.getTime() + 301_000);
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: expired.approvalId })).rejects.toMatchObject({ code: 'approval_expired' });
    now = new Date();
    const revoked = await approved();
    const secondaryOwner = `ledger-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, secondaryOwner]);
    try {
      await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
      await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: revoked.approvalId })).rejects.toMatchObject({ code: 'forbidden' });
      await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    } finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, secondaryOwner]); }
  });
  it('serializes membership revocation against the authorization row lock', async () => {
    let locked: () => void = () => { throw new Error('Lock promise not initialized'); };
    let release: () => void = () => { throw new Error('Release promise not initialized'); };
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = f.databases.gotchu_api.tenant(f.a.organizationId, async tx => { await tx.query('SELECT gotchu.lock_membership($1,$2)', [f.a.organizationId, f.a.userId]); locked(); await gate; });
    await ready;
    await f.admin.query('BEGIN');
    await f.admin.query("SET LOCAL lock_timeout='100ms'");
    try { await expect(f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId])).rejects.toMatchObject({ code: '55P03' }); }
    finally { await f.admin.query('ROLLBACK'); release(); await holding; }
  });
  it('restricts lookup and ledger mutations to the executor role and exact tenant/approval', async () => {
    const a = await approved();
    const request = { organizationId: f.a.organizationId, approvalId: a.approvalId };
    const claim = await executor.executions.claim(request);
    const token = { organizationId: f.a.organizationId, executionId: claim.executionId, claimToken: claim.claimToken };
    expect(await executor.executions.findByApproval(request)).toMatchObject({ ...claim, ...request, applicationId: f.a.applicationId, state: 'claimed' });
    expect(await executor.executions.findByApproval({ organizationId: f.b.organizationId, approvalId: a.approvalId })).toBeUndefined();
    expect(await executor.executions.findByApproval({ ...request, approvalId: randomUUID() })).toBeUndefined();
    for (const role of ['gotchu_api', 'gotchu_ingest', 'gotchu_coordinator'] as const) {
      const service = createBackend({ database: f.databases[role] }).executions;
      await expect(service.findByApproval(request)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(service.claim(request)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(service.assertWritable(token)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(service.finish({ ...token, outcome: 'failed' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(service.resolveUncertain({ ...token, outcome: 'failed' })).rejects.toMatchObject({ code: 'forbidden' });
    }
    for (const patch of [{ organizationId: f.b.organizationId }, { claimToken: randomUUID() }, { executionId: randomUUID() }]) {
      await expect(executor.executions.assertWritable({ ...token, ...patch })).rejects.toMatchObject({ code: 'stale_execution' });
      await expect(executor.executions.finish({ ...token, ...patch, outcome: 'failed' })).rejects.toMatchObject({ code: 'stale_execution' });
      await expect(executor.executions.resolveUncertain({ ...token, ...patch, outcome: 'failed' })).rejects.toMatchObject({ code: 'stale_execution' });
    }
    await executor.executions.assertWritable(token);
  });
  it('validates stored proposals and binding even when looking up an existing execution', async () => {
    const a = await approved();
    const request = { organizationId: f.a.organizationId, approvalId: a.approvalId };
    await executor.executions.claim(request);
    const stored = present(await executor.executions.findByApproval(request));
    const damaged = [
      {},
      { ...stored.proposal, applicationId: f.b.applicationId },
      { ...stored.proposal, policyVersion: 'tampered-policy' },
    ];
    for (const body of damaged) {
      await f.admin.query('UPDATE gotchu.proposals SET body=$2::jsonb WHERE id=$1', [a.proposalId, JSON.stringify(body)]);
      await expect(executor.executions.findByApproval(request)).rejects.toMatchObject({ code: 'execution_corrupt' });
    }
    await f.admin.query('UPDATE gotchu.proposals SET body=$2::jsonb,invalidated_at=now() WHERE id=$1', [a.proposalId, JSON.stringify(stored.proposal)]);
    expect(await executor.executions.findByApproval(request)).toEqual(stored);
  });
  it('normalizes UUID spelling and atomically settles uncertainty without reviving a write', async () => {
    const a = await approved();
    const request = { organizationId: f.a.organizationId.toUpperCase(), approvalId: a.approvalId.toUpperCase() };
    const claim = await executor.executions.claim(request);
    const token = { organizationId: request.organizationId, executionId: claim.executionId.toUpperCase(), claimToken: claim.claimToken.toUpperCase() };
    await executor.executions.assertWritable(token);
    await expect(executor.executions.resolveUncertain({ ...token, outcome: 'failed' })).rejects.toMatchObject({ code: 'stale_execution' });
    await executor.executions.finish({ ...token, outcome: 'uncertain' });
    const settlement = { ...token, outcome: 'succeeded' as const, providerReference: 'test-only:independently-observed-pr/42' };
    await Promise.all([executor.executions.resolveUncertain(settlement), executor.executions.resolveUncertain(settlement)]);
    const storedRow = await f.admin.query<{ organizationId:string; applicationId:string; actionHash:string; recoveryEpoch:string; state:string; providerReference:string|null; proposal:unknown }>(`SELECT e.organization_id AS "organizationId",p.application_id AS "applicationId",e.action_hash AS "actionHash",
      e.recovery_epoch::text AS "recoveryEpoch",e.state,e.provider_reference AS "providerReference",p.body AS proposal
      FROM gotchu.executions e JOIN gotchu.proposals p ON p.organization_id=e.organization_id AND p.id=e.proposal_id WHERE e.organization_id=$1 AND e.approval_id=$2`,[f.a.organizationId,a.approvalId]);
    const persisted=present(storedRow.rows[0]);
    const persistedProposal=proposalSchema.parse(persisted.proposal);
    expect(persistedProposal.organizationId.toLowerCase()).toBe(persisted.organizationId);
    expect(persistedProposal.applicationId.toLowerCase()).toBe(persisted.applicationId);
    expect(hashStoredAction(persistedProposal,persisted.recoveryEpoch)).toBe(persisted.actionHash);
    expect(persisted).toMatchObject({state:'succeeded',providerReference:settlement.providerReference});
    const settled = present(await executor.executions.findByApproval(request));
    expect(settled).toMatchObject({ organizationId: f.a.organizationId, approvalId: a.approvalId, state: 'succeeded', providerReference: settlement.providerReference });
    const before = await f.admin.query('SELECT finished_at FROM gotchu.executions WHERE id=$1', [claim.executionId]);
    await executor.executions.resolveUncertain(settlement);
    expect((await f.admin.query('SELECT finished_at FROM gotchu.executions WHERE id=$1', [claim.executionId])).rows).toEqual(before.rows);
    expect((await f.admin.query("SELECT id FROM gotchu.audit_records WHERE subject_id=$1 AND action='execution.reconciled'", [claim.executionId])).rowCount).toBe(1);
    await expect(executor.executions.resolveUncertain({ ...settlement, outcome: 'failed' })).rejects.toMatchObject({ code: 'stale_execution' });
    await expect(executor.executions.resolveUncertain({ ...settlement, providerReference: 'test-only:different-pr' })).rejects.toMatchObject({ code: 'stale_execution' });
    await expect(executor.executions.assertWritable(token)).rejects.toMatchObject({ code: 'stale_execution' });
    await expect(executor.executions.finish({ ...token, outcome: 'uncertain' })).rejects.toMatchObject({ code: 'stale_execution' });
  });
  it('rejects unknown settlement states, missing success references, and forged identities', async () => {
    const a = await approved();
    const claim = await executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId });
    const token = { organizationId: f.a.organizationId, executionId: claim.executionId, claimToken: claim.claimToken };
    await executor.executions.finish({ ...token, outcome: 'uncertain' });
    for (const outcome of ['claimed', 'uncertain', 'unknown']) {
      await expect(executor.executions.resolveUncertain(Object.assign({ ...token, outcome: 'failed' as const }, { outcome }))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const providerReference of [undefined, '', '   ']) {
      await expect(executor.executions.resolveUncertain({ ...token, outcome: 'succeeded', ...(providerReference === undefined ? {} : { providerReference }) })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const patch of [{ organizationId: f.b.organizationId }, { claimToken: randomUUID() }, { executionId: randomUUID() }]) {
      await expect(executor.executions.resolveUncertain({ ...token, ...patch, outcome: 'failed' })).rejects.toMatchObject({ code: 'stale_execution' });
    }
    await expect(f.admin.query("UPDATE gotchu.executions SET state='unknown' WHERE id=$1", [claim.executionId])).rejects.toMatchObject({ code: '23514' });
    await executor.executions.resolveUncertain({ ...token, outcome: 'failed' });
    await executor.executions.resolveUncertain({ ...token, outcome: 'failed' });
    await expect(executor.executions.assertWritable(token)).rejects.toMatchObject({ code: 'stale_execution' });
  });
  it('records reconciliation during frozen recovery without changing recovery or approval authority', async () => {
    const a = await approved();
    const request = { organizationId: f.a.organizationId, approvalId: a.approvalId };
    const claim = await executor.executions.claim(request);
    const token = { organizationId: f.a.organizationId, executionId: claim.executionId, claimToken: claim.claimToken };
    await executor.executions.finish({ ...token, outcome: 'uncertain' });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'freeze' });
    try {
      const frozen = await f.admin.query('SELECT * FROM gotchu.platform_state');
      await executor.executions.resolveUncertain({ ...token, outcome: 'succeeded', providerReference: 'test-only:verified-during-recovery' });
      expect(await executor.executions.findByApproval(request)).toMatchObject({ state: 'succeeded' });
      await expect(executor.executions.assertWritable(token)).rejects.toMatchObject({ code: 'writes_frozen' });
      await expect(executor.executions.claim(request)).rejects.toMatchObject({ code: 'approval_used' });
      expect((await f.admin.query('SELECT * FROM gotchu.platform_state')).rows).toEqual(frozen.rows);
      expect((await f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE id=$1', [a.approvalId])).rows[0].consumed_at).not.toBeNull();
    } finally {
      await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY cleanup; fake provider observations' });
    }
    await expect(executor.executions.assertWritable(token)).rejects.toMatchObject({ code: 'stale_execution' });
  });
  it('freezes provider writes and prevents old approvals from reviving after recovery', async () => {
    const a = await approved();
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'freeze' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'writes_frozen' });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'test reconciliation' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(api.proposals.approve(identity(), { organizationId: f.a.organizationId, proposalId: a.proposalId, actionHash: a.actionHash })).rejects.toMatchObject({ code: 'stale_epoch' });
  });
});
