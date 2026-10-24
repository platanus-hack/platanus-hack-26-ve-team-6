import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, BackendError, canonicalJson, parse, type BaseDependencies } from './core.js';
const scopeSchema = z.object({ organizationId: z.uuid(), runId: z.uuid() }).strict();
const micros = z.number().int().min(0).max(1_000_000_000_000);

/** Trusted gateway/coordinator only. Do not give an investigator this object or a DB connection. */
export function createRunService(deps: BaseDependencies) {
  return {
    async start(input: { organizationId: string; applicationId: string; jobId: string; leaseToken: string }): Promise<{ runId: string; deadline: Date }> {
      const value = parse(z.object({ organizationId: z.uuid(), applicationId: z.uuid(), jobId: z.uuid(), leaseToken: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const job = await tx.query("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND state='running' AND kind='investigation' FOR UPDATE", [value.organizationId, value.applicationId, value.jobId, value.leaseToken]);
        if (!job.rowCount) throw new BackendError('stale_lease', 'Investigation requires a current durable job claim', 409);
        const result = await tx.query<{ id: string; deadline: Date }>("INSERT INTO gotchu.agent_runs(organization_id,application_id,id,job_id,state,deadline) VALUES ($1,$2,$3,$4,'running',clock_timestamp()+interval '5 minutes') ON CONFLICT (organization_id,job_id) DO NOTHING RETURNING id,deadline", [value.organizationId, value.applicationId, randomUUID(), value.jobId]);
        const row = result.rows[0] ?? (await tx.query<{ id: string; deadline: Date }>('SELECT id,deadline FROM gotchu.agent_runs WHERE organization_id=$1 AND job_id=$2', [value.organizationId, value.jobId])).rows[0];
        if (!row) throw new BackendError('run_conflict', 'Run disappeared during creation', 409);
        return { runId: row.id, deadline: row.deadline };
      });
    },
    async load(input: { organizationId: string; runId: string }) {
      const value = parse(scopeSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        const row = (await tx.query<{ id: string; state: string; checkpoint: unknown; checkpointVersion: number; modelCalls: number; toolCalls: number; deadline: Date }>('SELECT id,state,checkpoint,checkpoint_version AS "checkpointVersion",model_calls AS "modelCalls",tool_calls AS "toolCalls",deadline FROM gotchu.agent_runs WHERE organization_id=$1 AND id=$2', [value.organizationId, value.runId])).rows[0];
        if (!row) throw new BackendError('not_found', 'Run not found', 404);
        return row;
      });
    },
    async checkpoint(input: { organizationId: string; runId: string; expectedVersion: number; checkpoint: unknown }): Promise<{ version: number }> {
      const value = parse(scopeSchema.extend({ expectedVersion: z.number().int().min(0), checkpoint: z.unknown() }), input);
      const encoded = canonicalJson(value.checkpoint);
      if (Buffer.byteLength(encoded) > 32_768) throw new BackendError('checkpoint_limit', 'Checkpoint exceeds 32 KiB');
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ checkpoint_version: number }>("UPDATE gotchu.agent_runs SET checkpoint=$4::jsonb,checkpoint_version=checkpoint_version+1 WHERE organization_id=$1 AND id=$2 AND checkpoint_version=$3 AND state='running' AND deadline>clock_timestamp() RETURNING checkpoint_version", [value.organizationId, value.runId, value.expectedVersion, encoded]);
        if (!result.rows[0]) throw new BackendError('stale_checkpoint', 'Run checkpoint is stale, expired, or no longer active', 409);
        return { version: result.rows[0].checkpoint_version };
      });
    },
    async consumeTool(input: { organizationId: string; runId: string }): Promise<void> {
      const value = parse(scopeSchema, input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query("UPDATE gotchu.agent_runs SET tool_calls=tool_calls+1 WHERE organization_id=$1 AND id=$2 AND state='running' AND deadline>clock_timestamp() AND tool_calls<8", [value.organizationId, value.runId]);
        if (!result.rowCount) throw new BackendError('tool_budget_exhausted', 'Run is expired or its tool-call limit has been reached', 429);
      });
    },
    async reserveModel(input: { organizationId: string; runId: string; reservationId: string; maxCostMicros: number }): Promise<{ reservationId: string }> {
      const value = parse(scopeSchema.extend({ reservationId: z.uuid(), maxCostMicros: micros.min(1) }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const org = await tx.query<{ model_opt_in: boolean }>('SELECT model_opt_in FROM gotchu.organizations WHERE id=$1 FOR UPDATE', [value.organizationId]);
        if (!org.rows[0]?.model_opt_in) throw new BackendError('model_opt_in_required', 'Organization has not opted in to external model processing', 403);
        const prior = await tx.query<{ run_id: string; amount_micros: string }>('SELECT run_id,amount_micros FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2', [value.organizationId, value.reservationId]);
        if (prior.rows[0]) {
          if (prior.rows[0].run_id !== value.runId || BigInt(prior.rows[0].amount_micros) !== BigInt(value.maxCostMicros)) throw new BackendError('reservation_conflict', 'Reservation ID was reused for a different request', 409);
          // A reservation is permission for one provider call, not permission to repeat it.
          throw new BackendError('reservation_exists', 'Reconcile the existing model call; never repeat it using a consumed reservation ID', 409);
        }
        const run = await tx.query("UPDATE gotchu.agent_runs SET model_calls=model_calls+1,reserved_micros=reserved_micros+$3 WHERE organization_id=$1 AND id=$2 AND state='running' AND deadline>clock_timestamp() AND model_calls<4 RETURNING id", [value.organizationId, value.runId, value.maxCostMicros]);
        if (!run.rowCount) throw new BackendError('model_call_limit', 'Run is expired or its model-call limit has been reached', 429);
        const reserved = await tx.query('UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros+$2 WHERE id=$1 AND model_spent_micros+model_reserved_micros+$2<=model_budget_micros', [value.organizationId, value.maxCostMicros]);
        if (!reserved.rowCount) throw new BackendError('model_budget_exhausted', 'Hard organization model-spend ceiling reached', 429);
        await tx.query('INSERT INTO gotchu.model_reservations(organization_id,id,run_id,amount_micros) VALUES ($1,$2,$3,$4)', [value.organizationId, value.reservationId, value.runId, value.maxCostMicros]);
        return { reservationId: value.reservationId };
      });
    },
    async settleModel(input: { organizationId: string; reservationId: string; actualCostMicros: number }): Promise<void> {
      const value = parse(z.object({ organizationId: z.uuid(), reservationId: z.uuid(), actualCostMicros: micros }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await tx.query('SELECT id FROM gotchu.organizations WHERE id=$1 FOR UPDATE', [value.organizationId]);
        const result = await tx.query<{ run_id: string; amount_micros: string; charged_micros: string | null }>('SELECT run_id,amount_micros,charged_micros FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.reservationId]);
        const row = result.rows[0];
        if (!row) throw new BackendError('not_found', 'Model reservation not found', 404);
        if (row.charged_micros !== null) {
          if (BigInt(row.charged_micros) !== BigInt(value.actualCostMicros)) throw new BackendError('settlement_conflict', 'Reservation already settled at a different amount', 409);
          return;
        }
        if (BigInt(value.actualCostMicros) > BigInt(row.amount_micros)) throw new BackendError('reservation_overrun', 'Provider charge exceeds its reserved maximum; operator reconciliation is required', 409);
        await tx.query('UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros-$2,model_spent_micros=model_spent_micros+$3 WHERE id=$1', [value.organizationId, row.amount_micros, value.actualCostMicros]);
        await tx.query('UPDATE gotchu.agent_runs SET reserved_micros=reserved_micros-$3,spent_micros=spent_micros+$4 WHERE organization_id=$1 AND id=$2', [value.organizationId, row.run_id, row.amount_micros, value.actualCostMicros]);
        await tx.query('UPDATE gotchu.model_reservations SET charged_micros=$3,settled_at=clock_timestamp() WHERE organization_id=$1 AND id=$2', [value.organizationId, value.reservationId, value.actualCostMicros]);
        await audit(tx, value.organizationId, 'model-gateway', 'model.settled', value.reservationId, { chargedMicros: value.actualCostMicros });
      });
    },
    async finish(input: { organizationId: string; runId: string; outcome: 'succeeded' | 'unavailable' | 'failed' }): Promise<void> {
      const value = parse(scopeSchema.extend({ outcome: z.enum(['succeeded', 'unavailable', 'failed']) }), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query("UPDATE gotchu.agent_runs SET state=$3 WHERE organization_id=$1 AND id=$2 AND state='running' AND reserved_micros=0", [value.organizationId, value.runId, value.outcome]);
        if (!result.rowCount) throw new BackendError('run_unsettled', 'Run is already terminal or has unsettled provider reservations', 409);
      });
    },
  };
}
