import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setRecoveryState } from '@gotchu/database';
import type { ActionV2 } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { BackendError, canonicalJson, createBackend, hashActionV2, proposalSchema, sha256, type ActionEligibility, type ProposalEligibility, type StepUpVerifier, type VerifiedStepUp } from '../src/index.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';
const live = liveUrl ? describe : describe.skip;
live('real Postgres approval/execution ledger; injected test-only MFA and eligibility verifier', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let now = new Date();
  let factsOverride: Partial<ProposalEligibility> = {};
  let actionFacts: ActionEligibility = { eligible: true, blockingReasons: [] };
  const proofs = new Map<string, VerifiedStepUp>();
  const stepUpVerifier: StepUpVerifier = { verify: async input => {
    const proof = proofs.get(input.proof);
    if (!proof) throw new BackendError('step_up_required', 'Test verifier rejects unissued proof', 403);
    return proof;
  } };
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    const deps = { clock: { now: () => now }, stepUpVerifier, proposalVerifier: { verify: async (p: Parameters<typeof eligibilityFixture>[0]) => ({ ...eligibilityFixture(p, now), ...factsOverride }) }, actionVerifier: { verify: async () => actionFacts } };
    api = createBackend({ ...deps, database: f.databases.gotchu_api });
    executor = createBackend({ ...deps, database: f.databases.gotchu_executor });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: no provider writes are performed' });
  }, 30_000);
  beforeEach(() => { now = new Date(); factsOverride = {}; actionFacts = { eligible: true, blockingReasons: [] }; });
  afterAll(async () => { await f?.close(); });
  const identity = () => ({ userId: f.a.userId });
  async function create() { return api.proposals.create({ organizationId: f.a.organizationId, proposal: proposalFixture(f.a) }); }
  function issue(actionHash: string, patch: Partial<VerifiedStepUp> = {}) {
    const token = randomUUID();
    proofs.set(token, { proofId: token, userId: f.a.userId, organizationId: f.a.organizationId, actionHash, authenticatedAt: now, expiresAt: new Date(now.getTime() + 300_000), method: 'webauthn', ...patch });
    return token;
  }
  const actionFixture = (): ActionV2 => ({ version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: f.a.organizationId, applicationId: f.a.applicationId, policyVersion: 'policy-v2', target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: 'catalog:key', branch: 'main' }, recipeId: 'tls-certificate-verification', recipeVersion: '1', snapshotSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64), findingIdentities: ['finding-1'], validationAttestationIds: [randomUUID()], evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), kind: 'candidate' }] });
  async function createV2(action = actionFixture()) {
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
    const a = await api.proposals.approve(identity(), { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash, stepUpProof: issue(p.actionHash) });
    return { ...p, ...a };
  }
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
  it('approves v2 only for Owners, binds MFA to the exact hash, serializes duplicate approval, and refuses executor claims without an adapter', async () => {
    const secondaryOwner = `action-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, secondaryOwner]);
    await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=true WHERE kind='source_patch_pull_request'");
    try {
      const proposal = await createV2();
      const wrongHash = 'f'.repeat(64);
      await expect(api.actions.approve(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId, actionHash: proposal.actionHash, stepUpProof: issue(wrongHash) })).rejects.toMatchObject({ code: 'step_up_required' });
      for (const role of ['viewer','operator'] as const) {
        await f.admin.query('UPDATE gotchu.memberships SET role=$3 WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId,f.a.userId,role]);
        try { await expect(api.actions.approve(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId, actionHash: proposal.actionHash, stepUpProof: issue(proposal.actionHash) })).rejects.toMatchObject({ code: 'forbidden' }); }
        finally { await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId,f.a.userId]); }
      }
      const approvals = await Promise.allSettled([1,2].map(() => api.actions.approve(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId, actionHash: proposal.actionHash, stepUpProof: issue(proposal.actionHash) })));
      expect(approvals.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect((await f.admin.query('SELECT id FROM gotchu.approvals WHERE proposal_id=$1', [proposal.proposalId])).rowCount).toBe(1);
      const approval = present(approvals.find(result => result.status === 'fulfilled'));
      if (approval.status !== 'fulfilled') throw new Error('missing action approval');
      await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.value.approvalId })).rejects.toMatchObject({ code: 'no_adapter' });
      expect((await f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE id=$1', [approval.value.approvalId])).rows[0]?.consumed_at).toBeNull();
    } finally {
      await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=false WHERE kind='source_patch_pull_request'");
      await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, secondaryOwner]);
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
    } finally { await f.admin.query("UPDATE gotchu.action_capabilities SET adapter_available=false WHERE kind='source_patch_pull_request'"); }
  });
  it('reports explicit blockers without a trusted v2 verifier or write adapter and keeps tenant reads isolated', async () => {
    const proposal = await createV2();
    const disabled = createBackend({ database: f.databases.gotchu_api });
    await expect(disabled.actions.getEligibility(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposal.proposalId })).resolves.toMatchObject({ status: 'ineligible', blockingReasons: expect.arrayContaining(['validación en VM no disponible','sin adaptador de escritura']) });
    await expect(api.actions.get({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.b.applicationId, proposalId: proposal.proposalId })).rejects.toMatchObject({ status: 404 });
  });
  it('builds a source patch action only from stored candidate and context records and projects no private source content', async () => {
    const candidateId = randomUUID(); const repositoryLinkId = randomUUID();
    const privateMarker = 'PRIVATE_SOURCE_MUST_NOT_LEAK';
    const body = { revision: 'candidate', files: [{ path: 'src/config.ts', content: privateMarker }] };
    const candidateDigest = 'd'.repeat(64); const patchHash = 'e'.repeat(64);
    await f.admin.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [f.a.organizationId,f.a.applicationId,candidateId,candidateDigest,JSON.stringify(body),f.a.userId]);
    await f.admin.query('INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,state) VALUES($1,$2,$3,$4,$5,$6,$7)', [f.a.organizationId,f.a.applicationId,repositoryLinkId,'catalog:service','main','granted','declared']);
    await f.admin.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [f.a.organizationId,randomUUID(),f.a.userId,'correction.prepared',candidateId,JSON.stringify({ recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', findingId: 'finding-identity', patchHash, candidateSourceDigest: candidateDigest, path: 'src/config.ts' })]);
    const proposed = await api.actions.propose(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId } });
    const card = await api.actions.get(identity(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId, proposalId: proposed.proposalId });
    expect(card).toMatchObject({ state: 'ineligible', target: { kind: 'repository', repositoryLinkId, repositoryKey: 'catalog:service', branch: 'main' }, diff: { path: 'src/config.ts' }, blockingReasons: expect.arrayContaining(['No hay un adaptador de escritura disponible. No se modificará ningún repositorio.']) });
    expect(JSON.stringify(card)).not.toContain(privateMarker);
  });
  it('rejects forged caller timestamps, unissued proof, hash mismatch, and no trusted verifier', async () => {
    const p = await create();
    const input = { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash, stepUpProof: 'not-issued' };
    await expect(api.proposals.approve(identity(), input)).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(api.proposals.approve(identity(), Object.assign({}, input, { stepUpAt: now.toISOString() }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(api.proposals.approve(identity(), { ...input, actionHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'hash_mismatch' });
    const disabled = createBackend({ database: f.databases.gotchu_api });
    await expect(disabled.proposals.approve(identity(), input)).rejects.toMatchObject({ code: 'step_up_unavailable' });
    await expect(api.proposals.approve(identity(), { ...input, stepUpProof: issue(p.actionHash, { authenticatedAt: new Date(now.getTime() - 301_000) }) })).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(api.proposals.approve(identity(), { ...input, stepUpProof: issue(p.actionHash, { userId: f.b.userId }) })).rejects.toMatchObject({ code: 'step_up_required' });
  });
  it('consumes step-up once and durably claims approval once under concurrent execution', async () => {
    const p = await create();
    const input = { organizationId: f.a.organizationId, proposalId: p.proposalId, actionHash: p.actionHash, stepUpProof: issue(p.actionHash) };
    const approval = await api.proposals.approve(identity(), input);
    await expect(api.proposals.approve(identity(), input)).rejects.toMatchObject({ code: 'proof_replayed' });
    const attempts = await Promise.allSettled([executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId }), executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId })]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    const claim = present(attempts.find(a => a.status === 'fulfilled'));
    if (claim.status !== 'fulfilled') throw new Error('missing claim');
    const token = { organizationId: f.a.organizationId, executionId: claim.value.executionId, claimToken: claim.value.claimToken };
    await executor.executions.assertWritable(token);
    await executor.executions.finish({ ...token, outcome: 'uncertain' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId })).rejects.toMatchObject({ code: 'approval_used' });
    await expect(executor.executions.assertWritable(token)).rejects.toMatchObject({ code: 'stale_execution' });
    expect((await f.admin.query('SELECT state FROM gotchu.executions WHERE id=$1', [claim.value.executionId])).rows[0].state).toBe('uncertain');
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
    await expect(api.proposals.approve(identity(), { organizationId: f.a.organizationId, proposalId: a.proposalId, actionHash: a.actionHash, stepUpProof: issue(a.actionHash) })).rejects.toMatchObject({ code: 'stale_epoch' });
  });
});
