import { describe, expect, it } from 'vitest';
import {
  createExecutor,
  customerCodeExecutionEnabled,
  ExecutionLedgerError,
  type ExecutionClaim,
  type ExecutionLedgerPort,
  type ExistingExecution,
  type ProviderAdapter,
} from '../src/execution.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const executionId = '44444444-4444-4444-8444-444444444444';
const claimToken = '55555555-5555-4555-8555-555555555555';
const actionHash = 'a'.repeat(64);
const baseCommit = 'b'.repeat(40);
const candidateCommit = 'c'.repeat(40);

const proposal: ExecutionClaim['proposal'] = {
  version: 1,
  organizationId,
  applicationId,
  adapter: 'github.pull_request',
  target: { repository: 'acme/widget', branch: 'main' },
  baseCommit,
  candidateCommit,
  changes: [{ name: 'lodash', from: '1.0.0', to: '1.0.1' }],
  artifact: {
    id: '66666666-6666-4666-8666-666666666666',
    patchSha256: 'd'.repeat(64),
    lockfileSha256: 'e'.repeat(64),
  },
  verificationPlan: {
    expectedCandidateCommit: candidateCommit,
    checkPatchDigest: true,
    checkPullRequestHead: true,
  },
};

const claim: ExecutionClaim = {
  organizationId,
  applicationId,
  approvalId,
  executionId,
  claimToken,
  actionHash,
  proposal,
  recoveryEpoch: '1',
};

function request(overrides: Partial<{
  organizationId: string;
  applicationId: string;
  approvalId: string;
  expectedActionHash: string;
  expectedResourceVersion: string;
}> = {}) {
  return {
    organizationId,
    applicationId,
    approvalId,
    expectedActionHash: actionHash,
    expectedResourceVersion: baseCommit,
    ...overrides,
  };
}

function fakeLedger(options: { alreadyClaimed?: boolean; initialState?: ExistingExecution['state'] } = {}) {
  let firstClaim = options.alreadyClaimed ? false : true;
  let state: ExistingExecution['state'] = options.initialState ?? 'claimed';
  let providerReference: string | undefined;
  const claimCalls: Array<{ organizationId: string; approvalId: string }> = [];
  const writeChecks: unknown[] = [];
  const finishes: Array<{ outcome: string; providerReference?: string }> = [];
  const resolveCalls: Array<{ outcome: string; providerReference?: string }> = [];
  const ledger: ExecutionLedgerPort = {
    async claim(input) {
      claimCalls.push(input);
      if (!firstClaim) throw new ExecutionLedgerError('already_claimed');
      firstClaim = false;
      state = 'claimed';
      return claim;
    },
    async findByApproval() {
      return { ...claim, state, ...(providerReference ? { providerReference } : {}) };
    },
    async assertWritable(input) {
      writeChecks.push(input);
      if (state !== 'claimed') throw new Error('not_claimed');
    },
    async finish(input) {
      finishes.push({ outcome: input.outcome, ...(input.providerReference ? { providerReference: input.providerReference } : {}) });
      state = input.outcome;
      providerReference = input.providerReference;
    },
    async resolveUncertain(input) {
      resolveCalls.push({ outcome: input.outcome, ...(input.providerReference ? { providerReference: input.providerReference } : {}) });
      state = input.outcome;
      providerReference = input.providerReference;
    },
  };
  return { ledger, claimCalls, writeChecks, finishes, resolveCalls, state: () => state };
}

function fakeProvider(overrides: Partial<ProviderAdapter> = {}) {
  const publishCalls: unknown[] = [];
  const reconcileCalls: unknown[] = [];
  const verifyCalls: unknown[] = [];
  const provider: ProviderAdapter = {
    async publish(input) {
      publishCalls.push(input);
      return { providerReference: 'https://github.com/acme/widget/pull/42' };
    },
    async reconcile(input) {
      reconcileCalls.push(input);
      return { status: 'found', providerReference: 'https://github.com/acme/widget/pull/42' };
    },
    async verify(input) {
      verifyCalls.push(input);
      return {
        status: 'verified',
        providerReference: input.providerReference,
        actionHash: input.actionHash,
        baseCommit: input.proposal.baseCommit,
        candidateCommit: input.proposal.candidateCommit,
      };
    },
    ...overrides,
  };
  return { provider, publishCalls, reconcileCalls, verifyCalls };
}

describe('independent executor orchestration', () => {
  it('keeps provider writes disabled by default and customer code execution off', async () => {
    const fixture = fakeLedger();
    const executor = createExecutor({ ledger: fixture.ledger });

    await expect(executor.execute(request())).resolves.toMatchObject({ status: 'disabled', reasonCode: 'provider_adapter_disabled' });
    expect(fixture.claimCalls).toHaveLength(0);
    expect(customerCodeExecutionEnabled).toBe(false);
  });

  it('requires the exact action hash and current resource version returned by the trusted claim', async () => {
    const wrongHash = fakeLedger();
    const wrongHashExecutor = createExecutor({ ledger: {
      ...wrongHash.ledger,
      async claim() { return { ...claim, actionHash: 'f'.repeat(64) }; },
    }, provider: fakeProvider().provider });
    await expect(wrongHashExecutor.execute(request())).resolves.toMatchObject({ status: 'rejected', reasonCode: 'action_hash_mismatch' });
    expect(wrongHash.finishes).toEqual([{ outcome: 'failed' }]);

    const stale = fakeLedger();
    const staleExecutor = createExecutor({ ledger: stale.ledger, provider: fakeProvider().provider });
    await expect(staleExecutor.execute(request({ expectedResourceVersion: 'f'.repeat(40) })))
      .resolves.toMatchObject({ status: 'rejected', reasonCode: 'resource_version_stale' });
    expect(stale.writeChecks).toHaveLength(0);
  });

  it('requires the trusted ledger claim to pass owner, step-up, expiry, policy, and head checks', async () => {
    const fixture = fakeLedger();
    const provider = fakeProvider();
    const ledger: ExecutionLedgerPort = {
      ...fixture.ledger,
      async claim() { throw new ExecutionLedgerError('approval_rejected'); },
    };
    const executor = createExecutor({ ledger, provider: provider.provider });

    await expect(executor.execute(request())).resolves.toMatchObject({ status: 'rejected', reasonCode: 'approval_rejected' });
    expect(provider.publishCalls).toHaveLength(0);
    expect(fixture.writeChecks).toHaveLength(0);

    const staleLedger: ExecutionLedgerPort = {
      ...fixture.ledger,
      async claim() { throw new ExecutionLedgerError('stale_proposal'); },
    };
    const staleExecutor = createExecutor({ ledger: staleLedger, provider: provider.provider });
    await expect(staleExecutor.execute(request())).resolves.toMatchObject({ status: 'rejected', reasonCode: 'resource_version_stale' });
  });

  it('claims once and does not publish concurrently when a duplicate sees no reconciled result yet', async () => {
    const fixture = fakeLedger();
    let signalPublishStarted: (() => void) | undefined;
    let completePublish: ((value: unknown) => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => { signalPublishStarted = resolve; });
    const publishResult = new Promise<unknown>((resolve) => { completePublish = resolve; });
    const provider = fakeProvider({
      async publish(input) {
        providerPublishCalls.push(input.executionId);
        signalPublishStarted?.();
        return publishResult;
      },
      async reconcile(input) {
        providerCalls.push(input.executionId);
        return { status: 'definitely_not_applied' };
      },
    });
    const providerCalls: string[] = [];
    const providerPublishCalls: string[] = [];
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    const firstExecution = executor.execute(request());
    await publishStarted;
    const duplicate = await executor.execute(request());
    expect(duplicate).toMatchObject({ status: 'already_claimed', reasonCode: 'already_claimed' });
    const release = completePublish;
    if (!release) throw new Error('provider publish did not start');
    release({ providerReference: 'https://github.com/acme/widget/pull/42' });
    const first = await firstExecution;

    expect(first.status).toBe('verified');
    expect(providerPublishCalls).toHaveLength(1);
    expect(providerCalls).toEqual([executionId]);
    expect(fixture.claimCalls).toHaveLength(2);
    expect(fixture.writeChecks).toHaveLength(1);
  });

  it('reconciles a timeout before one same-ID retry and independently verifies the provider result', async () => {
    const fixture = fakeLedger();
    let publishes = 0;
    let reconciliations = 0;
    const provider = fakeProvider({
      async publish(input) {
        publishes += 1;
        if (publishes === 1) throw new Error('provider timeout');
        expect(input.executionId).toBe(executionId);
        return { providerReference: 'https://github.com/acme/widget/pull/42' };
      },
      async reconcile() {
        reconciliations += 1;
        return reconciliations === 1 ? { status: 'definitely_not_applied' } : { status: 'found', providerReference: 'https://github.com/acme/widget/pull/42' };
      },
    });
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    const result = await executor.execute(request());

    expect(result).toMatchObject({ status: 'verified', executionId, reasonCode: 'provider_verified' });
    expect(publishes).toBe(2);
    expect(reconciliations).toBe(1);
    expect(fixture.writeChecks).toHaveLength(2);
    expect(fixture.finishes).toEqual([{ outcome: 'succeeded', providerReference: 'https://github.com/acme/widget/pull/42' }]);
    expect(provider.verifyCalls).toHaveLength(1);
  });

  it('records unknown provider outcomes as uncertain and never retries them on duplicate delivery', async () => {
    const fixture = fakeLedger();
    let publishes = 0;
    const provider = fakeProvider({
      async publish() {
        publishes += 1;
        throw new Error('provider timeout');
      },
      async reconcile() { return { status: 'unknown' }; },
    });
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    const initial = await executor.execute(request());
    const duplicate = await executor.execute(request());

    expect(initial).toMatchObject({ status: 'uncertain', reasonCode: 'provider_outcome_unknown' });
    expect(duplicate).toMatchObject({ status: 'uncertain', reasonCode: 'provider_outcome_unknown' });
    expect(publishes).toBe(1);
    expect(fixture.state()).toBe('uncertain');
  });

  it('resolves an uncertain provider record after read-only reconciliation and exact verification', async () => {
    const fixture = fakeLedger({ alreadyClaimed: true, initialState: 'uncertain' });
    const provider = fakeProvider();
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    const result = await executor.reconcile(request());

    expect(result).toMatchObject({ status: 'verified', executionId, providerReference: 'https://github.com/acme/widget/pull/42' });
    expect(provider.publishCalls).toHaveLength(0);
    expect(fixture.resolveCalls).toEqual([{ outcome: 'succeeded', providerReference: 'https://github.com/acme/widget/pull/42' }]);
  });

  it('rejects a mismatched provider result instead of reporting a verified execution', async () => {
    const fixture = fakeLedger();
    const provider = fakeProvider({
      async verify(input) {
        return {
          status: 'verified',
          providerReference: input.providerReference,
          actionHash: 'f'.repeat(64),
          baseCommit: input.proposal.baseCommit,
          candidateCommit: input.proposal.candidateCommit,
        };
      },
    });
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    await expect(executor.execute(request())).resolves.toMatchObject({ status: 'failed', reasonCode: 'provider_verification_mismatch' });
    expect(fixture.finishes).toEqual([{ outcome: 'failed' }]);
  });

  it('keeps provider verification uncertainty distinct from a mismatch', async () => {
    const fixture = fakeLedger();
    const provider = fakeProvider({
      async verify(input) {
        return {
          status: 'unknown',
          providerReference: input.providerReference,
          actionHash: input.actionHash,
          baseCommit: input.proposal.baseCommit,
          candidateCommit: input.proposal.candidateCommit,
        };
      },
    });
    const executor = createExecutor({ ledger: fixture.ledger, provider: provider.provider });

    await expect(executor.execute(request())).resolves.toMatchObject({ status: 'uncertain', reasonCode: 'provider_verification_unavailable' });
    expect(fixture.finishes).toEqual([{ outcome: 'uncertain' }]);
  });
});
