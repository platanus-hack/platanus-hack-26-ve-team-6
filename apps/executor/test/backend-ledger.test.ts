import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BackendError, hashProposal, type Backend } from '@gotchu/backend';
import { proposalFixture } from '../../../packages/backend/test/proposal-fixtures.js';
import { createBackendExecutionLedger } from '../src/index.js';

function fixture() {
  const request = { organizationId: randomUUID(), approvalId: randomUUID() };
  const proposal = proposalFixture({ organizationId: request.organizationId, applicationId: randomUUID() });
  const claim = { executionId: randomUUID(), claimToken: randomUUID(), actionHash: hashProposal(proposal, '1'), proposal, recoveryEpoch: '1' };
  const stored = { ...claim, ...request, applicationId: proposal.applicationId, state: 'uncertain' as const };
  const executions = {
    claim: vi.fn<Backend['executions']['claim']>(async () => claim),
    findByApproval: vi.fn<Backend['executions']['findByApproval']>(async () => stored),
    assertWritable: vi.fn<Backend['executions']['assertWritable']>(async () => {}),
    finish: vi.fn<Backend['executions']['finish']>(async () => {}),
    resolveUncertain: vi.fn<Backend['executions']['resolveUncertain']>(async () => {}),
  } satisfies Backend['executions'];
  return { request, claim, stored, executions, ledger: createBackendExecutionLedger(executions) };
}

describe('backend adapter boundary; injected backend fixtures (no Postgres)', () => {
  it('requires the complete backend proposal, not just the executor subset', async () => {
    const f = fixture();
    f.executions.claim.mockResolvedValueOnce({ ...f.claim, proposal: { ...f.claim.proposal, evidence: [] } });
    await expect(f.ledger.claim(f.request)).rejects.toMatchObject({ code: 'ledger_unavailable' });
    f.executions.findByApproval.mockResolvedValueOnce({ ...f.stored, proposal: { ...f.claim.proposal, changes: [] } });
    await expect(f.ledger.findByApproval(f.request)).rejects.toMatchObject({ code: 'ledger_unavailable' });
  });

  it('requires exact tenant, approval, application, action hash, and a known state on stored results', async () => {
    const f = fixture();
    for (const patch of [
      { organizationId: randomUUID() }, { approvalId: randomUUID() }, { applicationId: randomUUID() },
      { actionHash: '0'.repeat(64) }, { state: 'unknown' }, { state: 'succeeded' },
    ]) {
      // Inject invalid external data without pretending the declared backend contract can guarantee runtime data.
      f.executions.findByApproval.mockResolvedValueOnce(Object.assign({}, f.stored, patch));
      await expect(f.ledger.findByApproval(f.request)).rejects.toMatchObject({ code: 'ledger_unavailable' });
    }
    f.executions.claim.mockResolvedValueOnce({ ...f.claim, actionHash: '0'.repeat(64) });
    await expect(f.ledger.claim(f.request)).rejects.toMatchObject({ code: 'ledger_unavailable' });
    f.executions.claim.mockResolvedValueOnce({ ...f.claim, proposal: { ...f.claim.proposal, organizationId: randomUUID() } });
    await expect(f.ledger.claim(f.request)).rejects.toMatchObject({ code: 'ledger_unavailable' });
  });

  it('rejects unnormalized approval UUIDs before calling the durable backend claim', async () => {
    const f = fixture();
    await expect(f.ledger.claim({ ...f.request, approvalId: f.request.approvalId.toUpperCase() })).rejects.toMatchObject({ code: 'approval_rejected' });
    expect(f.executions.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['approval_used', 'already_claimed'], ['already_claimed', 'already_claimed'],
    ['stale_state', 'stale_proposal'], ['artifact_mismatch', 'stale_proposal'],
    ['proposal_invalidated', 'stale_proposal'], ['proposal_ineligible', 'stale_proposal'], ['stale_verification', 'stale_proposal'],
    ['writes_frozen', 'approval_rejected'], ['approval_expired', 'approval_rejected'], ['stale_epoch', 'approval_rejected'],
    ['forbidden', 'approval_rejected'], ['not_found', 'approval_rejected'],
    ['verification_unavailable', 'ledger_unavailable'], ['execution_corrupt', 'ledger_unavailable'],
  ])('maps %s to %s and retains its cause', async (code, expected) => {
    const f = fixture();
    const cause = new BackendError(code, 'Test fixture rejection');
    f.executions.claim.mockRejectedValueOnce(cause);
    await expect(f.ledger.claim(f.request)).rejects.toMatchObject({ code: expected, cause });
  });
});
