import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setRecoveryState } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { BackendError, createBackend, type ProposalEligibility, type StepUpVerifier, type VerifiedStepUp } from '../src/index.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';
const live = liveUrl ? describe : describe.skip;
live('real Postgres approval/execution ledger; injected test-only MFA and eligibility verifier', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let now = new Date();
  let factsOverride: Partial<ProposalEligibility> = {};
  const proofs = new Map<string, VerifiedStepUp>();
  const stepUpVerifier: StepUpVerifier = { verify: async input => {
    const proof = proofs.get(input.proof);
    if (!proof) throw new BackendError('step_up_required', 'Test verifier rejects unissued proof', 403);
    return proof;
  } };
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    const deps = { clock: { now: () => now }, stepUpVerifier, proposalVerifier: { verify: async (p: Parameters<typeof eligibilityFixture>[0]) => ({ ...eligibilityFixture(p, now), ...factsOverride }) } };
    api = createBackend({ ...deps, database: f.databases.gotchu_api });
    executor = createBackend({ ...deps, database: f.databases.gotchu_executor });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: no provider writes are performed' });
  }, 30_000);
  beforeEach(() => { now = new Date(); factsOverride = {}; });
  afterAll(async () => { await f?.close(); });
  const identity = () => ({ userId: f.a.userId });
  async function create() { return api.proposals.create({ organizationId: f.a.organizationId, proposal: proposalFixture(f.a) }); }
  function issue(actionHash: string, patch: Partial<VerifiedStepUp> = {}) {
    const token = randomUUID();
    proofs.set(token, { proofId: token, userId: f.a.userId, organizationId: f.a.organizationId, actionHash, authenticatedAt: now, expiresAt: new Date(now.getTime() + 300_000), method: 'webauthn', ...patch });
    return token;
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
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    try { await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: revoked.approvalId })).rejects.toMatchObject({ code: 'forbidden' }); }
    finally { await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]); }
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
  it('freezes provider writes and prevents old approvals from reviving after recovery', async () => {
    const a = await approved();
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'freeze' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'writes_frozen' });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'test reconciliation' });
    await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: a.approvalId })).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(api.proposals.approve(identity(), { organizationId: f.a.organizationId, proposalId: a.proposalId, actionHash: a.actionHash, stepUpProof: issue(a.actionHash) })).rejects.toMatchObject({ code: 'stale_epoch' });
  });
});
