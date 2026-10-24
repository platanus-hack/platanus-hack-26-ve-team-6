import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, systemClock } from './core.js';
import { authorizationState, checkedProposal, verifyStoredProposal, type ApprovalDependencies, type Proposal } from './proposals.js';
export interface ExecutionClaim { executionId: string; claimToken: string; actionHash: string; proposal: Proposal; recoveryEpoch: string }
const claimSchema = z.object({ organizationId: z.uuid(), approvalId: z.uuid() }).strict();
const executionTokenSchema = z.object({ organizationId: z.uuid(), executionId: z.uuid(), claimToken: z.uuid() }).strict();
export function createExecutionService(deps: ApprovalDependencies) {
  const clock = deps.clock ?? systemClock;
  return {
    async claim(input: { organizationId: string; approvalId: string }): Promise<ExecutionClaim> {
      const value = parse(claimSchema, input);
      const outcome = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx);
        const result = await tx.query<{ proposal_id: string; user_id: string; action_hash: string; recovery_epoch: string; expires_at: Date; consumed_at: Date | null }>('SELECT proposal_id,user_id,action_hash,recovery_epoch,expires_at,consumed_at FROM gotchu.approvals WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.approvalId]);
        const approval = result.rows[0];
        if (!approval) throw new BackendError('not_found', 'Approval not found', 404);
        if (approval.consumed_at) throw new BackendError('approval_used', 'Approval has already been consumed', 409);
        if (approval.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval has expired', 409);
        if (String(approval.recovery_epoch) !== state.recoveryEpoch) throw new BackendError('stale_epoch', 'Approval predates recovery and cannot authorize a write', 409);
        await authorize(tx, value.organizationId, { userId: approval.user_id }, ['owner']);
        const stored = await checkedProposal(tx, value.organizationId, approval.proposal_id);
        if (stored.actionHash !== approval.action_hash || stored.recoveryEpoch !== state.recoveryEpoch) throw new BackendError('hash_mismatch', 'Approval no longer matches the exact proposal', 409);
        const rejected = await verifyStoredProposal(tx, deps, stored.proposal, approval.proposal_id, 'execution');
        if (rejected) return rejected;
        // Verifier work can take time; expiry must hold at the durable claim, too.
        if (approval.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval expired during independent verification', 409);
        const executionId = randomUUID(); const claimToken = randomUUID();
        const inserted = await tx.query("INSERT INTO gotchu.executions(organization_id,id,approval_id,proposal_id,action_hash,recovery_epoch,claim_token,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'claimed') ON CONFLICT DO NOTHING RETURNING id", [value.organizationId, executionId, value.approvalId, approval.proposal_id, stored.actionHash, state.recoveryEpoch, claimToken]);
        if (!inserted.rowCount) throw new BackendError('already_claimed', 'This proposal already has a durable execution identity; reconcile instead of retrying', 409);
        await tx.query('UPDATE gotchu.approvals SET consumed_at=$1 WHERE organization_id=$2 AND id=$3', [clock.now(), value.organizationId, value.approvalId]);
        await audit(tx, value.organizationId, 'executor', 'execution.claimed', executionId, { approvalId: value.approvalId, actionHash: stored.actionHash });
        return { executionId, claimToken, actionHash: stored.actionHash, proposal: stored.proposal, recoveryEpoch: state.recoveryEpoch };
      });
      if (outcome instanceof BackendError) throw outcome;
      return outcome;
    },
    /** Call immediately before adapter I/O. This cannot make a remote provider write atomic with Postgres. */
    async assertWritable(input: { organizationId: string; executionId: string; claimToken: string }): Promise<void> {
      const value = parse(executionTokenSchema, input);
      const outcome = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx);
        const result = await tx.query<{ proposal_id: string; recovery_epoch: string; user_id: string; expires_at: Date }>(`SELECT e.proposal_id,e.recovery_epoch,a.user_id,a.expires_at
          FROM gotchu.executions e JOIN gotchu.approvals a ON a.organization_id=e.organization_id AND a.id=e.approval_id
          WHERE e.organization_id=$1 AND e.id=$2 AND e.claim_token=$3 AND e.state='claimed' FOR SHARE OF a`, [value.organizationId, value.executionId, value.claimToken]);
        const row = result.rows[0];
        if (!row || String(row.recovery_epoch) !== state.recoveryEpoch) throw new BackendError('stale_execution', 'Execution is no longer authorized for provider I/O', 409);
        await authorize(tx, value.organizationId, { userId: row.user_id }, ['owner']);
        const stored = await checkedProposal(tx, value.organizationId, row.proposal_id);
        const rejected = await verifyStoredProposal(tx, deps, stored.proposal, row.proposal_id, 'execution');
        if (rejected) return rejected;
        if (row.expires_at.getTime() <= clock.now().getTime()) throw new BackendError('approval_expired', 'Approval expired before provider I/O', 409);
        return null;
      });
      if (outcome instanceof BackendError) throw outcome;
    },
    async finish(input: { organizationId: string; executionId: string; claimToken: string; outcome: 'succeeded' | 'failed' | 'uncertain'; providerReference?: string }): Promise<void> {
      const value = parse(executionTokenSchema.extend({ outcome: z.enum(['succeeded', 'failed', 'uncertain']), providerReference: z.string().min(1).max(1000).optional() }), input);
      if (value.outcome === 'succeeded' && !value.providerReference) throw new BackendError('invalid_input', 'Successful execution requires a provider reference');
      await deps.database.tenant(value.organizationId, async tx => {
        // Record outcomes even if recovery froze new writes while the request was in flight.
        const result = await tx.query("UPDATE gotchu.executions SET state=$4,provider_reference=$5,finished_at=$6 WHERE organization_id=$1 AND id=$2 AND claim_token=$3 AND state='claimed'", [value.organizationId, value.executionId, value.claimToken, value.outcome, value.providerReference ?? null, clock.now()]);
        if (result.rowCount !== 1) throw new BackendError('stale_execution', 'Execution is not owned by this claim or has already finished', 409);
        await audit(tx, value.organizationId, 'executor', `execution.${value.outcome}`, value.executionId);
      });
    },
  };
}
