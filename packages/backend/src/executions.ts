import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, systemClock } from './core.js';
import { authorizationState, checkedStoredAction, hashStoredAction, storedActionSchema, verifyStoredProposal, type ApprovalDependencies, type StoredAction } from './proposals.js';
export interface ExecutionClaim { executionId: string; claimToken: string; actionHash: string; proposal: StoredAction; recoveryEpoch: string }
const uuid = z.uuid().toLowerCase();
const claimSchema = z.object({ organizationId: uuid, approvalId: uuid }).strict();
const executionTokenSchema = z.object({ organizationId: uuid, executionId: uuid, claimToken: uuid }).strict();
const executionStateSchema = z.enum(['claimed', 'succeeded', 'failed', 'uncertain']);
const providerReferenceSchema = z.string().min(1).max(1000).refine(value => value.trim() === value, 'Provider references must not have surrounding whitespace');
const storedExecutionSchema = z.object({
  organizationId: uuid, applicationId: uuid, approvalId: uuid, executionId: uuid, claimToken: uuid,
  actionHash: z.string().regex(/^[0-9a-f]{64}$/), recoveryEpoch: z.string().regex(/^[1-9][0-9]*$/),
  proposal: storedActionSchema, state: executionStateSchema, providerReference: providerReferenceSchema.nullable(),
}).strict();
export type StoredExecution = Omit<z.infer<typeof storedExecutionSchema>, 'providerReference'> & { providerReference?: string };
export function createExecutionService(deps: ApprovalDependencies) {
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
        if (stored.action.version === 2) throw new BackendError('no_adapter', 'No executor adapter is available for version 2 actions', 409);
        const rejected = await verifyStoredProposal(tx, deps, stored.action, approval.proposal_id, 'execution');
        if (rejected) return rejected;
        // Verifier work can take time; expiry must hold at the durable claim, too.
        if (approval.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval expired during independent verification', 409);
        const executionId = randomUUID(); const claimToken = randomUUID();
        const inserted = await tx.query("INSERT INTO gotchu.executions(organization_id,id,approval_id,proposal_id,action_hash,recovery_epoch,claim_token,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'claimed') ON CONFLICT DO NOTHING RETURNING id", [value.organizationId, executionId, value.approvalId, approval.proposal_id, stored.actionHash, state.recoveryEpoch, claimToken]);
        if (!inserted.rowCount) throw new BackendError('already_claimed', 'This proposal already has a durable execution identity; reconcile instead of retrying', 409);
        await tx.query('UPDATE gotchu.approvals SET consumed_at=$1 WHERE organization_id=$2 AND id=$3', [clock.now(), value.organizationId, value.approvalId]);
        await audit(tx, value.organizationId, 'executor', 'execution.claimed', executionId, { approvalId: value.approvalId, actionHash: stored.actionHash });
        await tx.query("UPDATE gotchu.proposals SET state='executing' WHERE organization_id=$1 AND id=$2", [value.organizationId,approval.proposal_id]);
        return { executionId, claimToken, actionHash: stored.actionHash, proposal: stored.action, recoveryEpoch: state.recoveryEpoch };
      });
      if (outcome instanceof BackendError) throw outcome;
      return outcome;
    },
    /** Restricted read for reconciliation, including expired/invalidated proposals and frozen recovery. */
    async findByApproval(input: { organizationId: string; approvalId: string }): Promise<StoredExecution | undefined> {
      requireExecutor();
      const value = parse(claimSchema, input);
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
    /** Call immediately before adapter I/O. This cannot make a remote provider write atomic with Postgres. */
    async assertWritable(input: { organizationId: string; executionId: string; claimToken: string }): Promise<void> {
      requireExecutor();
      const value = parse(executionTokenSchema, input);
      const outcome = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx);
        const result = await tx.query<{ proposal_id: string; recovery_epoch: string; user_id: string; expires_at: Date }>(`SELECT e.proposal_id,e.recovery_epoch,a.user_id,a.expires_at
          FROM gotchu.executions e JOIN gotchu.approvals a ON a.organization_id=e.organization_id AND a.id=e.approval_id
          WHERE e.organization_id=$1 AND e.id=$2 AND e.claim_token=$3 AND e.state='claimed' FOR SHARE OF a,e`, [value.organizationId, value.executionId, value.claimToken]);
        const row = result.rows[0];
        if (!row || String(row.recovery_epoch) !== state.recoveryEpoch) throw new BackendError('stale_execution', 'Execution is no longer authorized for provider I/O', 409);
        await authorize(tx, value.organizationId, { userId: row.user_id }, ['owner']);
        const stored = await checkedStoredAction(tx, value.organizationId, row.proposal_id);
        if (stored.action.version === 2) throw new BackendError('no_adapter', 'No executor adapter is available for version 2 actions', 409);
        const rejected = await verifyStoredProposal(tx, deps, stored.action, row.proposal_id, 'execution');
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
        await tx.query('UPDATE gotchu.proposals SET state=$3 WHERE organization_id=$1 AND id=(SELECT proposal_id FROM gotchu.executions WHERE organization_id=$1 AND id=$2)', [value.organizationId,value.executionId,value.outcome]);
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
        await tx.query('UPDATE gotchu.proposals SET state=$3 WHERE organization_id=$1 AND id=(SELECT proposal_id FROM gotchu.executions WHERE organization_id=$1 AND id=$2)', [value.organizationId,value.executionId,value.outcome]);
        await audit(tx, value.organizationId, 'executor', 'execution.reconciled', value.executionId, { outcome: value.outcome, providerReference: value.providerReference ?? null });
      });
    },
  };
}
