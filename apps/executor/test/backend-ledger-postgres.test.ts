import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend, type Proposal, type ProposalEligibility } from '@gotchu/backend';
import { setRecoveryState } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { eligibilityFixture, proposalFixture } from '../../../packages/backend/test/proposal-fixtures.js';
import { createBackendExecutionLedger, createExecutor, customerCodeExecutionEnabled, type ExecutionRequest, type ProviderAdapter } from '../src/index.js';

/** In-memory provider fixture only. Verification reads the separately stored observation. No network I/O. */
function fakeProvider(options: { timeout?: boolean; beforePublish?: () => Promise<void> } = {}) {
  const observations = new Map<string, Parameters<ProviderAdapter['publish']>[0] & { providerReference: string }>();
  let visible = !options.timeout;
  let verification: 'verified' | 'unknown' | 'mismatch' = 'verified';
  const provider = {
    publish: vi.fn<ProviderAdapter['publish']>(async input => {
      await options.beforePublish?.();
      const providerReference = `test-only:pull-request/${input.executionId}`;
      observations.set(input.executionId, { ...structuredClone(input), providerReference });
      if (options.timeout) throw new Error('TEST ONLY ambiguous provider timeout after applying write');
      return { providerReference };
    }),
    reconcile: vi.fn<ProviderAdapter['reconcile']>(async input => {
      if (!visible) return { status: 'unknown' };
      const observation = observations.get(input.executionId);
      return observation ? { status: 'found', providerReference: observation.providerReference } : { status: 'definitely_not_applied' };
    }),
    verify: vi.fn<ProviderAdapter['verify']>(async input => {
      const observation = present(observations.get(input.executionId));
      return {
        status: verification, providerReference: observation.providerReference, actionHash: observation.actionHash,
        baseCommit: observation.proposal.baseCommit, candidateCommit: observation.proposal.candidateCommit,
      };
    }),
  } satisfies ProviderAdapter;
  return { provider, reveal: () => { visible = true; }, verification: (value: typeof verification) => { verification = value; } };
}

const live = liveUrl ? describe : describe.skip;
live('real Postgres → backend ledger adapter → executor; fake provider/eligibility fixtures only', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let backend: ReturnType<typeof createBackend>;
  let now = new Date();
  let facts: Partial<ProposalEligibility> = {};
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    const deps = {
      clock: { now: () => now },
      proposalVerifier: { verify: async (proposal: Proposal) => ({ ...eligibilityFixture(proposal, now), ...facts }) },
    };
    api = createBackend({ ...deps, database: f.databases.gotchu_api });
    backend = createBackend({ ...deps, database: f.databases.gotchu_executor });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: fake provider, no production execution' });
  }, 30_000);
  beforeEach(() => { now = new Date(); facts = {}; });
  afterAll(async () => { await f?.close(); });

  async function approve(proposal = proposalFixture(f.a)) {
    const stored = await api.proposals.create({ organizationId: f.a.organizationId, proposal });
    const approval = await api.proposals.approve({ userId: f.a.userId }, {
      organizationId: f.a.organizationId, proposalId: stored.proposalId, actionHash: stored.actionHash,
    });
    const request: ExecutionRequest = {
      organizationId: f.a.organizationId, applicationId: f.a.applicationId, approvalId: approval.approvalId,
      expectedActionHash: stored.actionHash, expectedResourceVersion: proposal.baseCommit,
    };
    return { request, proposal };
  }
  const ledger = () => createBackendExecutionLedger(backend.executions);
  async function state(request: ExecutionRequest) {
    return backend.executions.findByApproval({ organizationId: request.organizationId, approvalId: request.approvalId });
  }
  async function expectUnconsumed(request: ExecutionRequest) {
    expect((await f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE id=$1', [request.approvalId])).rows[0].consumed_at).toBeNull();
  }

  it('keeps the absent production provider disabled before consuming an approval', async () => {
    const { request } = await approve();
    const executor = createExecutor({ ledger: ledger() });
    expect(await executor.execute(request)).toMatchObject({ status: 'disabled', reasonCode: 'provider_adapter_disabled' });
    await expectUnconsumed(request);
    expect(await state(request)).toBeUndefined();
    expect(customerCodeExecutionEnabled).toBe(false);
  });

  it('publishes the exact approved action once under concurrent and repeated delivery', async () => {
    const { request, proposal } = await approve();
    let signalStarted: () => void = () => { throw new Error('Missing start signal'); };
    let releasePublish: () => void = () => { throw new Error('Missing release signal'); };
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const release = new Promise<void>(resolve => { releasePublish = resolve; });
    const fake = fakeProvider({ beforePublish: async () => { signalStarted(); await release; } });
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    const first = executor.execute(request);
    try {
      await started;
      expect(await executor.execute(request)).toMatchObject({ status: 'already_claimed' });
    } finally { releasePublish(); }
    expect(await first).toMatchObject({ status: 'verified' });
    for (let delivery = 0; delivery < 3; delivery++) expect(await executor.execute(request)).toMatchObject({ status: 'verified' });
    const stored = present(await state(request));
    expect(stored).toMatchObject({ state: 'succeeded', approvalId: request.approvalId, proposal });
    expect(fake.provider.publish).toHaveBeenCalledExactlyOnceWith({ executionId: stored.executionId, actionHash: request.expectedActionHash, proposal });
    expect(fake.provider.verify).toHaveBeenCalled();
    expect((await f.admin.query('SELECT id FROM gotchu.executions WHERE approval_id=$1', [request.approvalId])).rowCount).toBe(1);
  });

  it('settles an ambiguous timeout only after read-only reconciliation and independent verification', async () => {
    const { request } = await approve();
    const fake = fakeProvider({ timeout: true });
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    expect(await executor.execute(request)).toMatchObject({ status: 'uncertain' });
    expect(await executor.execute(request)).toMatchObject({ status: 'uncertain' });
    fake.reveal();
    fake.verification('unknown');
    expect(await executor.reconcile(request)).toMatchObject({ status: 'uncertain', reasonCode: 'provider_verification_unavailable' });
    expect(await state(request)).toMatchObject({ state: 'uncertain' });
    fake.verification('verified');
    expect(await executor.execute(request)).toMatchObject({ status: 'verified' });
    expect(await executor.reconcile(request)).toMatchObject({ status: 'verified' });
    expect(await state(request)).toMatchObject({ state: 'succeeded' });
    expect(fake.provider.publish).toHaveBeenCalledTimes(1);
  });

  it('settles a reconciled verification mismatch as failed and never republishes', async () => {
    const { request } = await approve();
    const fake = fakeProvider({ timeout: true });
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    expect(await executor.execute(request)).toMatchObject({ status: 'uncertain' });
    fake.reveal();
    fake.verification('mismatch');
    expect(await executor.reconcile(request)).toMatchObject({ status: 'failed', reasonCode: 'provider_verification_mismatch' });
    expect(await state(request)).toMatchObject({ state: 'failed' });
    expect(await executor.execute(request)).toMatchObject({ status: 'failed' });
    expect(fake.provider.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects another tenant and non-normalized request identity before consuming approval', async () => {
    const { request } = await approve();
    const fake = fakeProvider();
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    expect(await executor.execute({ ...request, organizationId: f.b.organizationId, applicationId: f.b.applicationId })).toMatchObject({ status: 'rejected' });
    // The executor compares strings, so the adapter rejects alternate spelling instead of burning a valid approval.
    expect(await executor.execute({ ...request, organizationId: request.organizationId.toUpperCase() })).toMatchObject({ status: 'rejected' });
    await expectUnconsumed(request);
    expect(fake.provider.publish).not.toHaveBeenCalled();
    expect(fake.provider.reconcile).not.toHaveBeenCalled();
  });

  it('rejects wrong hash, application, and resource version without any provider I/O', async () => {
    const fake = fakeProvider();
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    for (const patch of [
      { expectedActionHash: '0'.repeat(64) },
      { applicationId: f.b.applicationId },
      { expectedResourceVersion: 'f'.repeat(40) },
    ]) {
      const { request } = await approve();
      expect(await executor.execute({ ...request, ...patch })).toMatchObject({ status: 'rejected' });
      expect(await state(request)).toMatchObject({ state: 'failed' });
    }
    expect(fake.provider.publish).not.toHaveBeenCalled();
    expect(fake.provider.verify).not.toHaveBeenCalled();
  });

  it('maps expired approvals and stale independent policy/head/artifact checks without provider writes', async () => {
    const fake = fakeProvider();
    const executor = createExecutor({ ledger: ledger(), provider: fake.provider });
    const expired = await approve();
    now = new Date(now.getTime() + 301_000);
    expect(await executor.execute(expired.request)).toMatchObject({ status: 'rejected', reasonCode: 'approval_rejected' });
    await expectUnconsumed(expired.request);
    now = new Date();
    for (const override of [{ currentBaseCommit: 'f'.repeat(40) }, { patchSha256: 'f'.repeat(64) }, { policyVersion: 'changed' }, { suitePassed: false }]) {
      facts = {};
      const { request } = await approve();
      facts = override;
      expect(await executor.execute(request)).toMatchObject({ status: 'rejected', reasonCode: 'resource_version_stale' });
      facts = {};
      expect(await executor.execute(request)).toMatchObject({ status: 'rejected', reasonCode: 'resource_version_stale' });
      await expectUnconsumed(request);
    }
    expect(fake.provider.publish).not.toHaveBeenCalled();
  });

  it('maps forged claim tokens to rejection and does not alias a second approval onto an execution', async () => {
    const { request, proposal } = await approve();
    const adapter = ledger();
    const claim = await backend.executions.claim({ organizationId: request.organizationId, approvalId: request.approvalId });
    const forged = { organizationId: request.organizationId, executionId: claim.executionId, claimToken: randomUUID() };
    await expect(adapter.assertWritable(forged)).rejects.toMatchObject({ code: 'approval_rejected' });
    await expect(adapter.finish({ ...forged, outcome: 'failed' })).rejects.toMatchObject({ code: 'approval_rejected' });
    await expect(adapter.resolveUncertain({ ...forged, outcome: 'failed' })).rejects.toMatchObject({ code: 'approval_rejected' });
    expect(await state(request)).toMatchObject({ state: 'claimed' });
    const stored = await api.proposals.create({ organizationId: f.a.organizationId, proposal });
    await expect(api.proposals.approve({ userId: f.a.userId }, { organizationId: f.a.organizationId,
      proposalId: stored.proposalId, actionHash: stored.actionHash })).rejects.toMatchObject({ code: 'approval_used' });
    // A legacy duplicate approval row must still never alias onto the claimed execution.
    const duplicate = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,recovery_epoch,expires_at,proof_id,authorization_method)
      SELECT organization_id,$2,proposal_id,action_hash,user_id,recovery_epoch,expires_at,proof_id,authorization_method
      FROM gotchu.approvals WHERE organization_id=$1 AND id=$3`, [request.organizationId, duplicate, request.approvalId]);
    const second = { request: { ...request, approvalId: duplicate } };
    await expect(adapter.claim({ organizationId: second.request.organizationId, approvalId: second.request.approvalId })).rejects.toMatchObject({ code: 'already_claimed' });
    expect(await adapter.findByApproval({ organizationId: second.request.organizationId, approvalId: second.request.approvalId })).toBeUndefined();
    const fake = fakeProvider();
    expect(await createExecutor({ ledger: adapter, provider: fake.provider }).execute(second.request)).toMatchObject({ status: 'uncertain', reasonCode: 'already_claimed' });
    expect(fake.provider.publish).not.toHaveBeenCalled();
    expect(fake.provider.reconcile).not.toHaveBeenCalled();
    await expectUnconsumed(second.request);
  });

  it('reconciles a frozen execution without unfreezing or granting any new write', async () => {
    const { request } = await approve();
    const pending = await approve();
    const fake = fakeProvider({ timeout: true });
    const adapter = ledger();
    const executor = createExecutor({ ledger: adapter, provider: fake.provider });
    expect(await executor.execute(request)).toMatchObject({ status: 'uncertain' });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'freeze' });
    try {
      fake.reveal();
      const frozen = (await f.admin.query('SELECT * FROM gotchu.platform_state')).rows;
      // Consumed approval maps to the existing record even during frozen recovery.
      expect(await executor.execute(request)).toMatchObject({ status: 'verified' });
      expect(await executor.execute(pending.request)).toMatchObject({ status: 'rejected' });
      const settled = present(await state(request));
      await expect(adapter.assertWritable({ organizationId: settled.organizationId, executionId: settled.executionId, claimToken: settled.claimToken })).rejects.toMatchObject({ code: 'approval_rejected' });
      expect(fake.provider.publish).toHaveBeenCalledTimes(1);
      expect((await f.admin.query('SELECT * FROM gotchu.platform_state')).rows).toEqual(frozen);
      await expectUnconsumed(pending.request);
    } finally {
      await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY cleanup, no production writes' });
    }
    expect(await executor.execute(pending.request)).toMatchObject({ status: 'rejected' });
    expect(fake.provider.publish).toHaveBeenCalledTimes(1);
  });
});
