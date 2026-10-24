import { BackendError, hashProposal, parse, proposalSchema, type Backend } from '@gotchu/backend';
import { z } from 'zod';
import { executionClaimSchema, existingExecutionSchema, ExecutionLedgerError, type ExecutionLedgerPort } from './execution.js';

// The executor compares UUID strings. Reject alternate spellings before consuming approval.
const uuid = z.uuid().refine(value => value === value.toLowerCase(), 'Use normalized UUIDs');
const approvalRequestSchema = z.object({ organizationId: uuid, approvalId: uuid }).strict();
const backendClaimSchema = executionClaimSchema.omit({ organizationId: true, applicationId: true, approvalId: true }).extend({
  executionId: uuid, claimToken: uuid, proposal: proposalSchema,
});
const backendStoredSchema = existingExecutionSchema.extend({
  organizationId: uuid, applicationId: uuid, approvalId: uuid, executionId: uuid, claimToken: uuid, proposal: proposalSchema,
});

async function ledgerCall<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof ExecutionLedgerError) throw cause;
    let code: ExecutionLedgerError['code'] = 'ledger_unavailable';
    if (cause instanceof BackendError) {
      if (['approval_used', 'already_claimed'].includes(cause.code)) code = 'already_claimed';
      else if (['stale_state', 'stale_verification', 'artifact_mismatch', 'proposal_ineligible', 'proposal_invalidated'].includes(cause.code)) code = 'stale_proposal';
      else if (['invalid_input', 'not_found', 'forbidden', 'approval_expired', 'stale_epoch', 'hash_mismatch', 'writes_frozen', 'stale_execution'].includes(cause.code)) code = 'approval_rejected';
    }
    const error = new ExecutionLedgerError(code);
    error.cause = cause;
    throw error;
  }
}

/** Server-only adapter. Supply executions from a backend using the isolated gotchu_executor login. */
export function createBackendExecutionLedger(executions: Backend['executions']): ExecutionLedgerPort {
  return {
    claim: input => ledgerCall(async () => {
      const request = parse(approvalRequestSchema, input);
      const claim = backendClaimSchema.parse(await executions.claim(request));
      const proposal = claim.proposal;
      if (proposal.organizationId !== request.organizationId
        || !uuid.safeParse(proposal.applicationId).success
        || hashProposal(proposal, claim.recoveryEpoch) !== claim.actionHash) {
        throw new ExecutionLedgerError('ledger_unavailable');
      }
      return { ...claim, organizationId: proposal.organizationId, applicationId: proposal.applicationId, approvalId: request.approvalId };
    }),
    findByApproval: input => ledgerCall(async () => {
      const request = parse(approvalRequestSchema, input);
      const raw = await executions.findByApproval(request);
      if (raw === undefined) return undefined;
      const stored = backendStoredSchema.parse(raw);
      if (stored.organizationId !== request.organizationId || stored.approvalId !== request.approvalId
        || stored.proposal.organizationId !== stored.organizationId || stored.proposal.applicationId !== stored.applicationId
        || hashProposal(stored.proposal, stored.recoveryEpoch) !== stored.actionHash
        || (stored.state === 'succeeded' && !stored.providerReference)) {
        throw new ExecutionLedgerError('ledger_unavailable');
      }
      return stored;
    }),
    assertWritable: input => ledgerCall(() => executions.assertWritable(input)),
    finish: input => ledgerCall(() => executions.finish(input)),
    resolveUncertain: input => ledgerCall(() => executions.resolveUncertain(input)),
  };
}
