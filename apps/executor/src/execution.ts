import { z } from 'zod';

const uuid = z.uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const executionRequestSchema = z.object({
  organizationId: uuid,
  applicationId: uuid,
  approvalId: uuid,
  expectedActionHash: sha256,
  expectedResourceVersion: commit,
}).strict();
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;

/**
 * The backend parses the complete proposal before returning a claim. The executor additionally
 * checks the fields that bind this write to the requested tenant, repository, and tested head.
 */
export const executionProposalSchema = z.object({
  version: z.literal(1),
  organizationId: uuid,
  applicationId: uuid,
  adapter: z.literal('github.pull_request'),
  target: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
    branch: z.string().min(1).max(200),
  }).strict(),
  baseCommit: commit,
  candidateCommit: commit,
  artifact: z.object({
    id: uuid,
    patchSha256: sha256,
    lockfileSha256: sha256,
  }).strict(),
  verificationPlan: z.object({
    expectedCandidateCommit: commit,
    checkPatchDigest: z.literal(true),
    checkPullRequestHead: z.literal(true),
  }).strict(),
}).passthrough().refine(
  (proposal) => proposal.baseCommit !== proposal.candidateCommit
    && proposal.verificationPlan.expectedCandidateCommit === proposal.candidateCommit,
  'Candidate must be distinct and match the verification plan',
);
export type ExecutionProposal = z.infer<typeof executionProposalSchema>;

export const executionClaimSchema = z.object({
  organizationId: uuid,
  applicationId: uuid,
  approvalId: uuid,
  executionId: uuid,
  claimToken: uuid,
  actionHash: sha256,
  proposal: executionProposalSchema,
  recoveryEpoch: z.string().regex(/^[1-9][0-9]*$/),
}).strict();
export type ExecutionClaim = z.infer<typeof executionClaimSchema>;

export const existingExecutionSchema = executionClaimSchema.extend({
  state: z.enum(['claimed', 'succeeded', 'failed', 'uncertain']),
  providerReference: z.string().min(1).max(1_000).optional(),
}).strict();
export type ExistingExecution = z.infer<typeof existingExecutionSchema>;
type ExecutionIdentity = Pick<ExecutionClaim,
  'organizationId' | 'applicationId' | 'approvalId' | 'executionId' | 'claimToken' | 'actionHash' | 'proposal'>;

export class ExecutionLedgerError extends Error {
  constructor(readonly code: 'already_claimed' | 'approval_rejected' | 'stale_proposal' | 'ledger_unavailable') {
    super(code);
    this.name = 'ExecutionLedgerError';
  }
}

export interface ExecutionLedgerPort {
  /** Maps to backend.executions.claim; the backend checks the exact approval and policy. */
  claim(request: { organizationId: string; approvalId: string }): Promise<unknown>;
  /** Internal executor lookup needed after `claim` reports an existing durable execution. */
  findByApproval(request: { organizationId: string; approvalId: string }): Promise<unknown | undefined>;
  /** Maps to backend.executions.assertWritable immediately before each provider write. */
  assertWritable(request: { organizationId: string; executionId: string; claimToken: string }): Promise<void>;
  finish(request: {
    organizationId: string;
    executionId: string;
    claimToken: string;
    outcome: 'succeeded' | 'failed' | 'uncertain';
    providerReference?: string;
  }): Promise<void>;
  /** Resolve a terminal uncertain result without making another provider write. */
  resolveUncertain(request: {
    organizationId: string;
    executionId: string;
    claimToken: string;
    outcome: 'succeeded' | 'failed';
    providerReference?: string;
  }): Promise<void>;
}

export const providerReconciliationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('found'), providerReference: z.string().min(1).max(1_000) }).strict(),
  z.object({ status: z.literal('definitely_not_applied') }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]);

export const providerVerificationSchema = z.object({
  status: z.enum(['verified', 'mismatch', 'unknown']),
  providerReference: z.string().min(1).max(1_000),
  actionHash: sha256,
  baseCommit: commit,
  candidateCommit: commit,
}).strict();

export interface ProviderAdapter {
  /** Use executionId as the provider idempotency/reconciliation identity. */
  publish(input: { executionId: string; actionHash: string; proposal: ExecutionProposal }): Promise<unknown>;
  reconcile(input: { executionId: string; actionHash: string; proposal: ExecutionProposal }): Promise<unknown>;
  /** Must independently inspect provider state and exact artifact, not trust publish's response. */
  verify(input: { executionId: string; providerReference: string; actionHash: string; proposal: ExecutionProposal }): Promise<unknown>;
}

export interface ExecutorResult {
  readonly status: 'disabled' | 'verified' | 'failed' | 'uncertain' | 'already_claimed' | 'rejected';
  readonly executionId?: string;
  readonly providerReference?: string;
  readonly reasonCode:
    | 'provider_adapter_disabled'
    | 'approval_rejected'
    | 'action_hash_mismatch'
    | 'resource_version_stale'
    | 'unsupported_adapter'
    | 'already_claimed'
    | 'provider_outcome_unknown'
    | 'provider_not_applied'
    | 'provider_verification_mismatch'
    | 'provider_verification_unavailable'
    | 'provider_verified'
    | 'ledger_unavailable';
}

/** This stays false until disposable VM-class isolation is independently demonstrated. */
export const customerCodeExecutionEnabled = false;

interface ExecutorOptions {
  readonly ledger: ExecutionLedgerPort;
  /** No production GitHub writer exists yet; omitting this port keeps provider writes disabled. */
  readonly provider?: ProviderAdapter;
}

function result(
  status: ExecutorResult['status'],
  reasonCode: ExecutorResult['reasonCode'],
  executionId?: string,
  providerReference?: string,
): ExecutorResult {
  return {
    status,
    reasonCode,
    ...(executionId ? { executionId } : {}),
    ...(providerReference ? { providerReference } : {}),
  };
}

function claimMatchesRequest(claim: ExecutionClaim, request: ExecutionRequest): boolean {
  return claim.organizationId === request.organizationId
    && claim.applicationId === request.applicationId
    && claim.approvalId === request.approvalId
    && claim.actionHash === request.expectedActionHash
    && claim.proposal.organizationId === request.organizationId
    && claim.proposal.applicationId === request.applicationId
    && claim.proposal.baseCommit === request.expectedResourceVersion;
}

function existingMatchesRequest(record: ExistingExecution, request: ExecutionRequest): boolean {
  return record.organizationId === request.organizationId
    && record.applicationId === request.applicationId
    && record.approvalId === request.approvalId
    && record.actionHash === request.expectedActionHash
    && record.proposal.organizationId === request.organizationId
    && record.proposal.applicationId === request.applicationId
    && record.proposal.baseCommit === request.expectedResourceVersion;
}

function classifyIndependentVerification(
  raw: unknown,
  expected: { actionHash: string; proposal: ExecutionProposal; providerReference: string },
): 'verified' | 'mismatch' | 'unknown' {
  const verification = providerVerificationSchema.safeParse(raw);
  if (!verification.success || verification.data.status === 'unknown') return 'unknown';
  if (
    verification.data.status !== 'verified'
    || verification.data.providerReference !== expected.providerReference
    || verification.data.actionHash !== expected.actionHash
    || verification.data.baseCommit !== expected.proposal.baseCommit
    || verification.data.candidateCommit !== expected.proposal.candidateCommit
  ) return 'mismatch';
  return 'verified';
}

export function createExecutor({ ledger, provider }: ExecutorOptions) {
  async function finish(
    claim: Pick<ExecutionIdentity, 'organizationId' | 'executionId' | 'claimToken'>,
    outcome: 'succeeded' | 'failed' | 'uncertain',
    providerReference?: string,
  ): Promise<boolean> {
    try {
      await ledger.finish({
        organizationId: claim.organizationId,
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        outcome,
        ...(providerReference ? { providerReference } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function resolveUncertain(
    claim: Pick<ExecutionIdentity, 'organizationId' | 'executionId' | 'claimToken'>,
    outcome: 'succeeded' | 'failed',
    providerReference?: string,
  ): Promise<boolean> {
    try {
      await ledger.resolveUncertain({
        organizationId: claim.organizationId,
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        outcome,
        ...(providerReference ? { providerReference } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function verifyAndRecord(
    claim: ExecutionIdentity,
    providerReference: string,
    recordState: 'claimed' | 'uncertain' | 'succeeded',
  ): Promise<ExecutorResult> {
    if (!provider) return result('disabled', 'provider_adapter_disabled', claim.executionId);
    let rawVerification: unknown;
    try {
      rawVerification = await provider.verify({
        executionId: claim.executionId,
        providerReference,
        actionHash: claim.actionHash,
        proposal: claim.proposal,
      });
    } catch {
      if (recordState === 'claimed' && !(await finish(claim, 'uncertain'))) {
        return result('uncertain', 'ledger_unavailable', claim.executionId, providerReference);
      }
      return result('uncertain', 'provider_verification_unavailable', claim.executionId, providerReference);
    }

    const verification = classifyIndependentVerification(rawVerification, {
      actionHash: claim.actionHash,
      proposal: claim.proposal,
      providerReference,
    });
    if (verification === 'unknown') {
      if (recordState === 'claimed' && !(await finish(claim, 'uncertain'))) {
        return result('uncertain', 'ledger_unavailable', claim.executionId, providerReference);
      }
      return result('uncertain', 'provider_verification_unavailable', claim.executionId, providerReference);
    }
    const verified = verification === 'verified';
    const finalOutcome = verified ? 'succeeded' : 'failed';
    if (recordState === 'claimed' && !(await finish(claim, finalOutcome, verified ? providerReference : undefined))) {
      return result('uncertain', 'ledger_unavailable', claim.executionId, providerReference);
    }
    if (recordState === 'uncertain' && !(await resolveUncertain(claim, finalOutcome, verified ? providerReference : undefined))) {
      return result('uncertain', 'ledger_unavailable', claim.executionId, providerReference);
    }
    if (!verified) return result('failed', 'provider_verification_mismatch', claim.executionId, providerReference);
    return result('verified', 'provider_verified', claim.executionId, providerReference);
  }

  async function reconcileExisting(record: ExistingExecution, request: ExecutionRequest): Promise<ExecutorResult> {
    if (!provider) return result('disabled', 'provider_adapter_disabled', record.executionId);
    if (!existingMatchesRequest(record, request)) {
      return result('rejected', record.actionHash === request.expectedActionHash ? 'resource_version_stale' : 'action_hash_mismatch', record.executionId);
    }
    if (record.state === 'failed') return result('failed', 'already_claimed', record.executionId);

    let reconciliation: z.infer<typeof providerReconciliationSchema>;
    try {
      reconciliation = providerReconciliationSchema.parse(await provider.reconcile({
        executionId: record.executionId,
        actionHash: record.actionHash,
        proposal: record.proposal,
      }));
    } catch {
      return result('uncertain', 'provider_outcome_unknown', record.executionId);
    }
    if (reconciliation.status === 'found') {
      return verifyAndRecord(record, reconciliation.providerReference, record.state);
    }
    if (reconciliation.status === 'definitely_not_applied' && record.state === 'claimed') {
      // A duplicate delivery is not the owner of a new write, even if the first attempt is absent.
      return result('already_claimed', 'already_claimed', record.executionId);
    }
    return result('uncertain', reconciliation.status === 'definitely_not_applied' ? 'provider_not_applied' : 'provider_outcome_unknown', record.executionId);
  }

  async function reconcileAfterAmbiguousPublish(claim: ExecutionClaim): Promise<ExecutorResult> {
    if (!provider) return result('disabled', 'provider_adapter_disabled', claim.executionId);
    let reconciliation: z.infer<typeof providerReconciliationSchema>;
    try {
      reconciliation = providerReconciliationSchema.parse(await provider.reconcile({
        executionId: claim.executionId,
        actionHash: claim.actionHash,
        proposal: claim.proposal,
      }));
    } catch {
      if (!(await finish(claim, 'uncertain'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
      return result('uncertain', 'provider_outcome_unknown', claim.executionId);
    }
    if (reconciliation.status === 'found') {
      return verifyAndRecord(claim, reconciliation.providerReference, 'claimed');
    }
    if (reconciliation.status === 'unknown') {
      if (!(await finish(claim, 'uncertain'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
      return result('uncertain', 'provider_outcome_unknown', claim.executionId);
    }

    // Retry the same execution ID once only after reconciliation proves the first call had no effect.
    try {
      await ledger.assertWritable({
        organizationId: claim.organizationId,
        executionId: claim.executionId,
        claimToken: claim.claimToken,
      });
    } catch {
      if (!(await finish(claim, 'failed'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
      return result('failed', 'provider_not_applied', claim.executionId);
    }

    let retryResponse: unknown;
    try {
      retryResponse = await provider.publish({
        executionId: claim.executionId,
        actionHash: claim.actionHash,
        proposal: claim.proposal,
      });
    } catch {
      return reconcileAfterRetry(claim);
    }
    const reference = z.object({ providerReference: z.string().min(1).max(1_000) }).strict().safeParse(retryResponse);
    if (!reference.success) return reconcileAfterRetry(claim);
    return verifyAndRecord(claim, reference.data.providerReference, 'claimed');
  }

  async function reconcileAfterRetry(claim: ExecutionClaim): Promise<ExecutorResult> {
    if (!provider) return result('disabled', 'provider_adapter_disabled', claim.executionId);
    let reconciliation: z.infer<typeof providerReconciliationSchema>;
    try {
      reconciliation = providerReconciliationSchema.parse(await provider.reconcile({
        executionId: claim.executionId,
        actionHash: claim.actionHash,
        proposal: claim.proposal,
      }));
    } catch {
      if (!(await finish(claim, 'uncertain'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
      return result('uncertain', 'provider_outcome_unknown', claim.executionId);
    }
    if (reconciliation.status === 'found') {
      return verifyAndRecord(claim, reconciliation.providerReference, 'claimed');
    }
    if (reconciliation.status === 'unknown') {
      if (!(await finish(claim, 'uncertain'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
      return result('uncertain', 'provider_outcome_unknown', claim.executionId);
    }
    if (!(await finish(claim, 'failed'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
    return result('failed', 'provider_not_applied', claim.executionId);
  }

  return {
    async execute(rawRequest: unknown): Promise<ExecutorResult> {
      const parsedRequest = executionRequestSchema.safeParse(rawRequest);
      if (!parsedRequest.success) return result('rejected', 'approval_rejected');
      const request = parsedRequest.data;
      if (!provider) return result('disabled', 'provider_adapter_disabled');

      let claim: ExecutionClaim;
      try {
        claim = executionClaimSchema.parse(await ledger.claim({
          organizationId: request.organizationId,
          approvalId: request.approvalId,
        }));
      } catch (error) {
        if (error instanceof ExecutionLedgerError && error.code === 'already_claimed') {
          try {
            const existingRaw = await ledger.findByApproval({ organizationId: request.organizationId, approvalId: request.approvalId });
            if (existingRaw === undefined) return result('uncertain', 'already_claimed');
            const existing = existingExecutionSchema.safeParse(existingRaw);
            return existing.success
              ? reconcileExisting(existing.data, request)
              : result('uncertain', 'ledger_unavailable');
          } catch {
            return result('uncertain', 'ledger_unavailable');
          }
        }
        if (error instanceof ExecutionLedgerError && error.code === 'approval_rejected') return result('rejected', 'approval_rejected');
        if (error instanceof ExecutionLedgerError && error.code === 'stale_proposal') return result('rejected', 'resource_version_stale');
        return result('uncertain', 'ledger_unavailable');
      }

      if (!claimMatchesRequest(claim, request)) {
        if (!(await finish(claim, 'failed'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
        return result(
          'rejected',
          claim.actionHash !== request.expectedActionHash ? 'action_hash_mismatch' : 'resource_version_stale',
          claim.executionId,
        );
      }
      if (claim.proposal.adapter !== 'github.pull_request') {
        if (!(await finish(claim, 'failed'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
        return result('rejected', 'unsupported_adapter', claim.executionId);
      }

      try {
        await ledger.assertWritable({
          organizationId: claim.organizationId,
          executionId: claim.executionId,
          claimToken: claim.claimToken,
        });
      } catch {
        if (!(await finish(claim, 'failed'))) return result('uncertain', 'ledger_unavailable', claim.executionId);
        return result('rejected', 'approval_rejected', claim.executionId);
      }

      let providerResponse: unknown;
      try {
        providerResponse = await provider.publish({
          executionId: claim.executionId,
          actionHash: claim.actionHash,
          proposal: claim.proposal,
        });
      } catch {
        return reconcileAfterAmbiguousPublish(claim);
      }
      const reference = z.object({ providerReference: z.string().min(1).max(1_000) }).strict().safeParse(providerResponse);
      if (!reference.success) return reconcileAfterAmbiguousPublish(claim);
      return verifyAndRecord(claim, reference.data.providerReference, 'claimed');
    },

    async reconcile(rawRequest: unknown): Promise<ExecutorResult> {
      const parsedRequest = executionRequestSchema.safeParse(rawRequest);
      if (!parsedRequest.success) return result('rejected', 'approval_rejected');
      if (!provider) return result('disabled', 'provider_adapter_disabled');
      try {
        const existingRaw = await ledger.findByApproval({
          organizationId: parsedRequest.data.organizationId,
          approvalId: parsedRequest.data.approvalId,
        });
        if (existingRaw === undefined) return result('failed', 'approval_rejected');
        const existing = existingExecutionSchema.safeParse(existingRaw);
        return existing.success
          ? reconcileExisting(existing.data, parsedRequest.data)
          : result('uncertain', 'ledger_unavailable');
      } catch {
        return result('uncertain', 'ledger_unavailable');
      }
    },
  };
}
