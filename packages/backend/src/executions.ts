import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, systemClock } from './core.js';
import { authorizationState, checkedStoredAction, hashStoredAction, storedActionSchema, verifyStoredProposal, type ApprovalDependencies, type StoredAction } from './proposals.js';
import type { ActionVerifier } from './actions.js';
export interface ExecutionClaim { organizationId: string; applicationId: string; approvalId: string; executionId: string; claimToken: string; actionHash: string; proposal: StoredAction; recoveryEpoch: string }
const uuid = z.uuid().toLowerCase();
const claimSchema = z.object({ organizationId: uuid, approvalId: uuid }).strict();
const executionTokenSchema = z.object({ organizationId: uuid, executionId: uuid, claimToken: uuid }).strict();
const executionStateSchema = z.enum(['claimed', 'succeeded', 'failed', 'uncertain']);
const providerReferenceSchema = z.string().min(1).max(1000).refine(value => value.trim() === value, 'Provider references must not have surrounding whitespace');
const attemptStateSchema = z.enum(['claimed','branch_published','pr_opened','verified','failed','uncertain','reconciliation_required']);
const attemptStepSchema = z.enum(['claim','publish_branch','open_pr','verify']);
const attemptDetailSchema = z.object({ reasonCode: z.string().max(100).optional(), branch: z.string().max(300).optional(), pullRequestNumber: z.number().int().positive().optional() }).strict();
const attemptTransition: Record<z.infer<typeof attemptStateSchema>, readonly z.infer<typeof attemptStateSchema>[]> = {
  claimed: ['claimed','branch_published','pr_opened','failed','uncertain','reconciliation_required'],
  branch_published: ['branch_published','pr_opened','failed','uncertain','reconciliation_required'],
  pr_opened: ['pr_opened','verified','failed','uncertain','reconciliation_required'],
  verified: ['verified'], failed: ['failed'], uncertain: ['uncertain','reconciliation_required','branch_published','pr_opened','verified','failed'],
  reconciliation_required: ['reconciliation_required','branch_published','pr_opened','verified','failed','uncertain'],
};
const storedExecutionSchema = z.object({
  organizationId: uuid, applicationId: uuid, approvalId: uuid, executionId: uuid, claimToken: uuid,
  actionHash: z.string().regex(/^[0-9a-f]{64}$/), recoveryEpoch: z.string().regex(/^[1-9][0-9]*$/),
  proposal: storedActionSchema, state: executionStateSchema, providerReference: providerReferenceSchema.nullable(),
}).strict();
export type StoredExecution = Omit<z.infer<typeof storedExecutionSchema>, 'providerReference'> & { providerReference?: string };
type ExecutionDependencies = ApprovalDependencies & { actionVerifier?: ActionVerifier };
async function verifyStoredExecutionAction(tx: import('@gotchu/database').Transaction, deps: ExecutionDependencies, action: StoredAction, proposalId: string): Promise<BackendError | null> {
  if (action.version === 1) return verifyStoredProposal(tx, deps, action, proposalId, 'execution');
  if (!deps.actionVerifier) throw new BackendError('verification_unavailable', 'No independent action verifier is configured', 503);
  const verification = await deps.actionVerifier.verify(action, { phase: 'execution' });
  if (verification.baseChanged || verification.policyCurrent === false) {
    const reason = verification.baseChanged ? 'base_changed' : 'policy_changed';
    await tx.query("UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason=$3 WHERE organization_id=$1 AND id=$2", [action.organizationId,proposalId,reason]);
    await audit(tx, action.organizationId, 'independent-verifier', 'proposal.invalidated', proposalId, { reason });
    return new BackendError(verification.baseChanged ? 'stale_state' : 'stale_policy', 'Proposal became stale and requires fresh validation and approval', 409);
  }
  if (!verification.eligible || verification.blockingReasons.length > 0) return new BackendError('proposal_ineligible', 'The exact action no longer passes independent validation', 409);
  return null;
}

export function createExecutionService(deps: ExecutionDependencies) {
  const clock = deps.clock ?? systemClock;
  function requireExecutor() {
    // createDatabase binds this trusted capability to a checked, isolated runtime login.
    // In particular, the API role must never receive claim tokens through this service.
    if (deps.database.role !== 'gotchu_executor') throw new BackendError('forbidden', 'Execution ledger operations require the executor database role', 403);
  }
  return {
    async claim(input: { organizationId: string; approvalId: string }): Promise<ExecutionClaim> {
      requireExecutor();
      const value = parse(claimSchema, input);
      const outcome = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx, false);
        const result = await tx.query<{ proposal_id: string; user_id: string; action_hash: string; recovery_epoch: string; expires_at: Date; consumed_at: Date | null }>('SELECT proposal_id,user_id,action_hash,recovery_epoch,expires_at,consumed_at FROM gotchu.approvals WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.approvalId]);
        const approval = result.rows[0];
        if (!approval) throw new BackendError('not_found', 'Approval not found', 404);
        if (approval.consumed_at) throw new BackendError('approval_used', 'Approval has already been consumed', 409);
        if (state.writesFrozen) throw new BackendError('writes_frozen', 'Provider writes are frozen pending operator reconciliation', 409);
        if (approval.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval has expired', 409);
        if (String(approval.recovery_epoch) !== state.recoveryEpoch) throw new BackendError('stale_epoch', 'Approval predates recovery and cannot authorize a write', 409);
        await authorize(tx, value.organizationId, { userId: approval.user_id }, ['owner']);
        const stored = await checkedStoredAction(tx, value.organizationId, approval.proposal_id);
        if (stored.actionHash !== approval.action_hash || stored.recoveryEpoch !== state.recoveryEpoch) throw new BackendError('hash_mismatch', 'Approval no longer matches the exact proposal', 409);
        const rejected = await verifyStoredExecutionAction(tx, deps, stored.action, approval.proposal_id);
        if (rejected) return rejected;
        // Verifier work can take time; expiry must hold at the durable claim, too.
        if (approval.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval expired during independent verification', 409);
        const executionId = randomUUID(); const claimToken = randomUUID();
        const inserted = await tx.query("INSERT INTO gotchu.executions(organization_id,id,approval_id,proposal_id,action_hash,recovery_epoch,claim_token,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'claimed') ON CONFLICT DO NOTHING RETURNING id", [value.organizationId, executionId, value.approvalId, approval.proposal_id, stored.actionHash, state.recoveryEpoch, claimToken]);
        if (!inserted.rowCount) throw new BackendError('already_claimed', 'This proposal already has a durable execution identity; reconcile instead of retrying', 409);
        if (stored.action.version === 2 && (stored.action.kind === 'source_patch_pull_request' || stored.action.kind === 'dependency_pull_request')) {
          const locked = await tx.query('INSERT INTO gotchu.executor_repository_locks(repository_key,organization_id,application_id,repository_link_id,execution_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING repository_key', [stored.action.target.repositoryKey,value.organizationId,stored.action.applicationId,stored.action.target.repositoryLinkId,executionId]);
          if (!locked.rowCount) throw new BackendError('repository_busy', 'Another approved execution holds this repository lock', 409);
        }
        await tx.query('UPDATE gotchu.approvals SET consumed_at=$1 WHERE organization_id=$2 AND id=$3', [clock.now(), value.organizationId, value.approvalId]);
        await audit(tx, value.organizationId, 'executor', 'execution.claimed', executionId, { approvalId: value.approvalId, actionHash: stored.actionHash });
        await tx.query("UPDATE gotchu.proposals SET state='executing' WHERE organization_id=$1 AND id=$2", [value.organizationId,approval.proposal_id]);
        return { organizationId:value.organizationId,applicationId:stored.action.applicationId,approvalId:value.approvalId,executionId,claimToken,actionHash:stored.actionHash,proposal:stored.action,recoveryEpoch:state.recoveryEpoch };
      });
      if (outcome instanceof BackendError) throw outcome;
      return outcome;
    },
    /** Durable per-attempt lifecycle. Details intentionally exclude patches and provider credentials. */
    async recordAttempt(input: { organizationId: string; executionId: string; attempt: number; step: string; state: string; providerReference?: string; detail?: unknown }): Promise<void> {
      requireExecutor();
      const value = parse(z.object({ organizationId: z.uuid(), executionId: z.uuid(), attempt: z.number().int().positive(), step: attemptStepSchema, state: attemptStateSchema, providerReference: providerReferenceSchema.optional(), detail: attemptDetailSchema.default({}) }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const current = await tx.query<{ state: string; step: string }>('SELECT state,step FROM gotchu.executor_attempts WHERE organization_id=$1 AND execution_id=$2 AND attempt=$3 FOR UPDATE', [value.organizationId,value.executionId,value.attempt]);
        const previous = current.rows[0];
        if (previous) {
          const previousState = attemptStateSchema.parse(previous.state);
          if (!attemptTransition[previousState].includes(value.state)) throw new BackendError('invalid_attempt_transition', 'Executor attempt transition is not allowed', 409);
          const rank: Record<z.infer<typeof attemptStepSchema>, number> = { claim:0,publish_branch:1,open_pr:2,verify:3 };
          if (rank[value.step] < rank[attemptStepSchema.parse(previous.step)]) throw new BackendError('invalid_attempt_transition', 'Executor attempt step cannot move backwards', 409);
          await tx.query('UPDATE gotchu.executor_attempts SET state=$4,step=$5,provider_reference=$6,detail=$7::jsonb,updated_at=clock_timestamp() WHERE organization_id=$1 AND execution_id=$2 AND attempt=$3', [value.organizationId,value.executionId,value.attempt,value.state,value.step,value.providerReference ?? null,JSON.stringify(value.detail)]);
        } else {
          if (value.state !== 'claimed' || value.step !== 'claim') throw new BackendError('invalid_attempt_transition', 'An attempt must begin at the claimed state', 409);
          await tx.query('INSERT INTO gotchu.executor_attempts(organization_id,execution_id,attempt,state,step,provider_reference,detail) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [value.organizationId,value.executionId,value.attempt,value.state,value.step,value.providerReference ?? null,JSON.stringify(value.detail)]);
        }
        await tx.query(`INSERT INTO gotchu.executor_attempt_events(organization_id,execution_id,attempt,step,state,provider_reference,detail)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`, [value.organizationId,value.executionId,value.attempt,value.step,value.state,value.providerReference ?? null,JSON.stringify(value.detail)]);
      });
    },
    async listAttempts(input: { organizationId: string; executionId: string }) {
      requireExecutor();
      const value = parse(z.object({ organizationId: z.uuid(), executionId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ attempt: number; state: string; step: string; provider_reference: string | null; detail: unknown; started_at: Date; updated_at: Date }>('SELECT attempt,state,step,provider_reference,detail,started_at,updated_at FROM gotchu.executor_attempts WHERE organization_id=$1 AND execution_id=$2 ORDER BY attempt', [value.organizationId,value.executionId]);
        return result.rows.map(row => ({ attempt:row.attempt,state:attemptStateSchema.parse(row.state),step:attemptStepSchema.parse(row.step),providerReference:row.provider_reference,detail:attemptDetailSchema.parse(row.detail),startedAt:row.started_at,updatedAt:row.updated_at }));
      });
    },
    /** Restricted read for reconciliation, including expired/invalidated proposals and frozen recovery. */
    async findByApproval(input: { organizationId: string; approvalId: string }): Promise<StoredExecution | undefined> {
      requireExecutor();
      const value = parse(z.object({ organizationId: uuid, approvalId: uuid }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query(`SELECT e.organization_id AS "organizationId", p.application_id AS "applicationId",
          e.approval_id AS "approvalId", e.id AS "executionId", e.claim_token AS "claimToken", e.action_hash AS "actionHash",
          e.recovery_epoch::text AS "recoveryEpoch", e.state, e.provider_reference AS "providerReference", p.body AS proposal
          FROM gotchu.executions e JOIN gotchu.proposals p ON p.organization_id=e.organization_id AND p.id=e.proposal_id
          WHERE e.organization_id=$1 AND e.approval_id=$2`, [value.organizationId, value.approvalId]);
        const row = result.rows[0];
        if (!row) return undefined;
        const parsed = storedExecutionSchema.safeParse(row);
        if (!parsed.success) throw new BackendError('execution_corrupt', 'Stored execution does not match its contract', 409);
        const stored = parsed.data;
        if (stored.organizationId !== value.organizationId || stored.approvalId !== value.approvalId
          || stored.proposal.organizationId.toLowerCase() !== stored.organizationId
          || stored.proposal.applicationId.toLowerCase() !== stored.applicationId
          || hashStoredAction(stored.proposal, stored.recoveryEpoch) !== stored.actionHash
          || (stored.state === 'succeeded' && stored.providerReference === null)) {
          throw new BackendError('execution_corrupt', 'Stored execution does not bind the exact proposal and scope', 409);
        }
        const { providerReference, ...execution } = stored;
        return { ...execution, ...(providerReference === null ? {} : { providerReference }) };
      });
    },
    /** Rechecks the exact approval immediately before each write, including after read-only recovery from uncertainty. */
    async assertWritable(input: { organizationId: string; executionId: string; claimToken: string }): Promise<void> {
      requireExecutor();
      const value = parse(executionTokenSchema, input);
      const outcome = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx);
        const result = await tx.query<{ proposal_id: string; recovery_epoch: string; user_id: string; expires_at: Date }>(`SELECT e.proposal_id,e.recovery_epoch,a.user_id,a.expires_at
          FROM gotchu.executions e JOIN gotchu.approvals a ON a.organization_id=e.organization_id AND a.id=e.approval_id
          WHERE e.organization_id=$1 AND e.id=$2 AND e.claim_token=$3 AND e.state IN ('claimed','uncertain') FOR SHARE OF a,e`, [value.organizationId, value.executionId, value.claimToken]);
        const row = result.rows[0];
        if (!row || String(row.recovery_epoch) !== state.recoveryEpoch) throw new BackendError('stale_execution', 'Execution is no longer authorized for provider I/O', 409);
        await authorize(tx, value.organizationId, { userId: row.user_id }, ['owner']);
        const stored = await checkedStoredAction(tx, value.organizationId, row.proposal_id);
        const rejected = await verifyStoredExecutionAction(tx, deps, stored.action, row.proposal_id);
        if (rejected) return rejected;
        if (row.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval expired before provider I/O', 409);
        return null;
      });
      if (outcome instanceof BackendError) throw outcome;
    },
    async finish(input: { organizationId: string; executionId: string; claimToken: string; outcome: 'succeeded' | 'failed' | 'uncertain'; providerReference?: string }): Promise<void> {
      requireExecutor();
      const value = parse(executionTokenSchema.extend({ outcome: z.enum(['succeeded', 'failed', 'uncertain']), providerReference: providerReferenceSchema.optional() }), input);
      if (value.outcome === 'succeeded' && !value.providerReference) throw new BackendError('invalid_input', 'Successful execution requires a provider reference');
      await deps.database.tenant(value.organizationId, async tx => {
        // Record outcomes even if recovery froze new writes while the request was in flight.
        const result = await tx.query("UPDATE gotchu.executions SET state=$4,provider_reference=$5,finished_at=$6 WHERE organization_id=$1 AND id=$2 AND claim_token=$3 AND state='claimed'", [value.organizationId, value.executionId, value.claimToken, value.outcome, value.providerReference ?? null, clock.now()]);
        if (result.rowCount !== 1) throw new BackendError('stale_execution', 'Execution is not owned by this claim or has already finished', 409);
        await tx.query("UPDATE gotchu.proposals SET state=CASE WHEN state='invalidated' THEN state ELSE $3 END WHERE organization_id=$1 AND id=(SELECT proposal_id FROM gotchu.executions WHERE organization_id=$1 AND id=$2)", [value.organizationId,value.executionId,value.outcome]);
        if (value.outcome !== 'uncertain') await tx.query('DELETE FROM gotchu.executor_repository_locks WHERE organization_id=$1 AND execution_id=$2', [value.organizationId,value.executionId]);
        await audit(tx, value.organizationId, 'executor', `execution.${value.outcome}`, value.executionId);
      });
    },
    /** Record independent read-only reconciliation; this never grants permission for provider I/O. */
    async resolveUncertain(input: { organizationId: string; executionId: string; claimToken: string; outcome: 'succeeded' | 'failed'; providerReference?: string }): Promise<void> {
      requireExecutor();
      const value = parse(executionTokenSchema.extend({ outcome: z.enum(['succeeded', 'failed']), providerReference: providerReferenceSchema.optional() }), input);
      if (value.outcome === 'succeeded' && !value.providerReference) throw new BackendError('invalid_input', 'Successful reconciliation requires an independently verified provider reference');
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query(`SELECT state,provider_reference FROM gotchu.executions
          WHERE organization_id=$1 AND id=$2 AND claim_token=$3 FOR UPDATE`, [value.organizationId, value.executionId, value.claimToken]);
        const row = result.rows[0];
        if (!row) throw new BackendError('stale_execution', 'Execution is not owned by this claim', 409);
        const stored = parse(z.object({ state: executionStateSchema, provider_reference: providerReferenceSchema.nullable() }).strict(), row);
        // An identical terminal observation is a no-op; conflicting observations cannot rewrite history.
        if (stored.state === value.outcome && stored.provider_reference === (value.providerReference ?? null)) return;
        if (stored.state !== 'uncertain') throw new BackendError('stale_execution', 'Only an uncertain execution can be settled', 409);
        const updated = await tx.query(`UPDATE gotchu.executions SET state=$4,provider_reference=$5,finished_at=$6
          WHERE organization_id=$1 AND id=$2 AND claim_token=$3 AND state='uncertain'`,
        [value.organizationId, value.executionId, value.claimToken, value.outcome, value.providerReference ?? null, clock.now()]);
        if (updated.rowCount !== 1) throw new BackendError('stale_execution', 'Execution is no longer uncertain', 409);
        await tx.query("UPDATE gotchu.proposals SET state=CASE WHEN state='invalidated' THEN state ELSE $3 END WHERE organization_id=$1 AND id=(SELECT proposal_id FROM gotchu.executions WHERE organization_id=$1 AND id=$2)", [value.organizationId,value.executionId,value.outcome]);
        await tx.query('DELETE FROM gotchu.executor_repository_locks WHERE organization_id=$1 AND execution_id=$2', [value.organizationId,value.executionId]);
        await audit(tx, value.organizationId, 'executor', 'execution.reconciled', value.executionId, { outcome: value.outcome, providerReference: value.providerReference ?? null });
      });
    },
    async markStale(input: { organizationId: string; executionId: string; claimToken: string; reason: 'base_changed' | 'policy_changed'; providerReference?: string }): Promise<void> {
      requireExecutor();
      const value = parse(executionTokenSchema.extend({ reason: z.enum(['base_changed','policy_changed']), providerReference: providerReferenceSchema.optional() }), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const row = await tx.query<{ state: string; proposal_id: string }>('SELECT state,proposal_id FROM gotchu.executions WHERE organization_id=$1 AND id=$2 AND claim_token=$3 FOR UPDATE', [value.organizationId,value.executionId,value.claimToken]);
        if (!row.rows[0] || !['claimed','uncertain'].includes(row.rows[0].state)) throw new BackendError('stale_execution', 'Only an active execution can be marked stale', 409);
        await tx.query("UPDATE gotchu.executions SET state='failed',provider_reference=$4,finished_at=$5 WHERE organization_id=$1 AND id=$2 AND claim_token=$3", [value.organizationId,value.executionId,value.claimToken,value.providerReference ?? null,clock.now()]);
        await tx.query("UPDATE gotchu.proposals SET state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason=$3,blocking_reasons=$4::jsonb WHERE organization_id=$1 AND id=$2", [value.organizationId,row.rows[0].proposal_id,value.reason,JSON.stringify([value.reason === 'base_changed' ? 'La base del repositorio cambió; prepara y valida una propuesta nueva.' : 'La política de esta acción cambió; prepara y valida una propuesta nueva.'])]);
        await tx.query('DELETE FROM gotchu.executor_repository_locks WHERE organization_id=$1 AND execution_id=$2', [value.organizationId,value.executionId]);
        await audit(tx,value.organizationId,'executor','execution.stale',value.executionId,{ reason:value.reason,providerReference:value.providerReference ?? null });
      });
    },
  };
}
