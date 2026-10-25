import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { investigationDataScopeSchema, investigationProviderCatalog, investigationProviderPresetIdSchema, modelProviderSchema } from '@gotchu/contracts';
import { audit, BackendError, canonicalJson, parse, type BaseDependencies } from './core.js';
import { modelConfigurationFingerprint } from './model-configuration.js';
const scopeSchema = z.object({ organizationId: z.uuid(), runId: z.uuid() }).strict();
const micros = z.number().int().min(0).max(1_000_000_000_000);
const RUN_MODEL_COST_LIMIT_MICROS = 250_000;
const RUN_MODEL_TOKEN_LIMIT = 20_000;
// Usage sanity bound, independent of a model invocation's token budget.
const observedTokens = z.number().int().min(0).max(1_000_000_000);

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
    async reserveModel(input: {
      organizationId: string; runId: string; reservationId: string; maxCostMicros: number; reserveTokens: number;
      requestSha256: string; configSha256: string; provider: z.infer<typeof modelProviderSchema>; modelId: string;
    }): Promise<{ reservationId: string }> {
      const value = parse(scopeSchema.extend({
        reservationId: z.uuid(), maxCostMicros: micros, reserveTokens: z.number().int().min(0).max(RUN_MODEL_TOKEN_LIMIT),
        requestSha256: z.string().regex(/^[a-f0-9]{64}$/), configSha256: z.string().regex(/^[a-f0-9]{64}$/), provider: modelProviderSchema,
        modelId: z.string().min(1).max(200),
      }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const org = await tx.query<{ model_opt_in: boolean; model_budget_micros: string; model_spent_micros: string; model_reserved_micros: string; model_token_budget: string; model_tokens_spent: string; model_tokens_reserved: string }>('SELECT model_opt_in,model_budget_micros,model_spent_micros,model_reserved_micros,model_token_budget,model_tokens_spent,model_tokens_reserved FROM gotchu.organizations WHERE id=$1 FOR UPDATE', [value.organizationId]);
        const organization = org.rows[0];
        if (!organization?.model_opt_in) throw new BackendError('model_opt_in_required', 'Workspace consent is not active', 403);
        const settings = await tx.query<{ consent_to_external_processing: boolean; provider: string; provider_preset_id: string; endpoint: string; model_id: string; secret_ref: string | null; data_scopes: unknown; input_price_micro_usd_per_million_tokens: string | number; output_price_micro_usd_per_million_tokens: string | number }>(`SELECT consent_to_external_processing,provider,provider_preset_id,endpoint,model_id,secret_ref,data_scopes,
          input_price_micro_usd_per_million_tokens,output_price_micro_usd_per_million_tokens
          FROM gotchu.investigation_model_settings WHERE organization_id=$1`, [value.organizationId]);
        const setting = settings.rows[0];
        if (!setting?.consent_to_external_processing || setting.provider !== value.provider || setting.model_id !== value.modelId) {
          throw new BackendError('model_configuration_changed', 'Workspace model configuration is disabled or changed', 409);
        }
        const configSha256 = modelConfigurationFingerprint({
          provider: modelProviderSchema.parse(setting.provider), providerPresetId: investigationProviderPresetIdSchema.parse(setting.provider_preset_id),
          endpoint: setting.endpoint, modelId: setting.model_id,
          secretRef: setting.secret_ref, consentToExternalProcessing: setting.consent_to_external_processing,
          dataScopes: z.array(investigationDataScopeSchema).max(7).parse(setting.data_scopes),
          inputPriceMicroUsdPerMillionTokens: Number(setting.input_price_micro_usd_per_million_tokens),
          outputPriceMicroUsdPerMillionTokens: Number(setting.output_price_micro_usd_per_million_tokens),
        });
        if (configSha256 !== value.configSha256) throw new BackendError('model_configuration_changed', 'Workspace model configuration changed before reservation', 409);
        const preset = investigationProviderCatalog.find(item => item.id === setting.provider_preset_id);
        const tokenLimitEnforced = preset?.billing !== 'subscription';
        if (tokenLimitEnforced ? value.reserveTokens === 0 : value.reserveTokens !== 0 || value.maxCostMicros !== 1) {
          throw new BackendError('model_reservation_invalid', 'Token and cost reservations must match the configured billing mode', 400);
        }
        const prior = await tx.query<{ run_id: string; amount_micros: string; reserved_tokens: string; token_limit_enforced: boolean; request_sha256: string | null; model_config_sha256: string | null; provider: string | null; model_id: string | null }>('SELECT run_id,amount_micros,reserved_tokens,token_limit_enforced,request_sha256,model_config_sha256,provider,model_id FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2', [value.organizationId, value.reservationId]);
        if (prior.rows[0]) {
          if (prior.rows[0].run_id !== value.runId || BigInt(prior.rows[0].amount_micros) !== BigInt(value.maxCostMicros)
            || prior.rows[0].token_limit_enforced !== tokenLimitEnforced
            || BigInt(prior.rows[0].reserved_tokens) !== BigInt(value.reserveTokens) || prior.rows[0].request_sha256 !== value.requestSha256
            || prior.rows[0].model_config_sha256 !== value.configSha256 || prior.rows[0].provider !== value.provider || prior.rows[0].model_id !== value.modelId) throw new BackendError('reservation_conflict', 'Reservation ID was reused for a different request', 409);
          // A reservation is permission for one provider call, not permission to repeat it.
          throw new BackendError('reservation_exists', 'Reconcile the existing model call; never repeat it using a consumed reservation ID', 409);
        }
        const runResult = await tx.query<{ model_calls: number; reserved_micros: string; spent_micros: string; tokens_reserved: string; tokens_spent: string }>("SELECT model_calls,reserved_micros,spent_micros,tokens_reserved,tokens_spent FROM gotchu.agent_runs WHERE organization_id=$1 AND id=$2 AND state='running' AND deadline>clock_timestamp() AND cancel_requested_at IS NULL FOR UPDATE", [value.organizationId, value.runId]);
        const run = runResult.rows[0];
        if (!run || run.model_calls >= 4) throw new BackendError('model_call_limit', 'Run is expired, cancelled, or its model-call limit has been reached', 429);
        if (BigInt(run.reserved_micros) + BigInt(run.spent_micros) + BigInt(value.maxCostMicros) > BigInt(RUN_MODEL_COST_LIMIT_MICROS)
          || (tokenLimitEnforced && BigInt(run.tokens_reserved) + BigInt(run.tokens_spent) + BigInt(value.reserveTokens) > BigInt(RUN_MODEL_TOKEN_LIMIT))) {
          throw new BackendError('model_budget_exhausted', 'Investigation run budget is exhausted', 429);
        }
        if (BigInt(organization.model_spent_micros) + BigInt(organization.model_reserved_micros) + BigInt(value.maxCostMicros) > BigInt(organization.model_budget_micros)
          || (tokenLimitEnforced && BigInt(organization.model_tokens_spent) + BigInt(organization.model_tokens_reserved) + BigInt(value.reserveTokens) > BigInt(organization.model_token_budget))) {
          throw new BackendError('model_budget_exhausted', 'Workspace model budget is exhausted', 429);
        }
        await tx.query('UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros+$2,model_tokens_reserved=model_tokens_reserved+$3 WHERE id=$1', [value.organizationId, value.maxCostMicros, value.reserveTokens]);
        await tx.query('UPDATE gotchu.agent_runs SET model_calls=model_calls+1,reserved_micros=reserved_micros+$3,tokens_reserved=tokens_reserved+$4 WHERE organization_id=$1 AND id=$2', [value.organizationId, value.runId, value.maxCostMicros, value.reserveTokens]);
        await tx.query(`INSERT INTO gotchu.model_reservations(organization_id,id,run_id,amount_micros,reserved_tokens,request_sha256,model_config_sha256,provider,model_id,token_limit_enforced,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved')`, [value.organizationId, value.reservationId, value.runId, value.maxCostMicros, value.reserveTokens, value.requestSha256, value.configSha256, value.provider, value.modelId, tokenLimitEnforced]);
        return { reservationId: value.reservationId };
      });
    },
    async markModelInFlight(input: { organizationId: string; reservationId: string }): Promise<void> {
      const value = parse(z.object({ organizationId: z.uuid(), reservationId: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query("UPDATE gotchu.model_reservations SET state='in_flight' WHERE organization_id=$1 AND id=$2 AND state='reserved' AND charged_micros IS NULL", [value.organizationId, value.reservationId]);
        if (result.rowCount !== 1) throw new BackendError('reservation_unavailable', 'Model reservation is not available for dispatch', 409);
      });
    },
    async markModelUnknown(input: { organizationId: string; reservationId: string }): Promise<void> {
      const value = parse(z.object({ organizationId: z.uuid(), reservationId: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await tx.query("UPDATE gotchu.model_reservations SET state='unknown' WHERE organization_id=$1 AND id=$2 AND charged_micros IS NULL AND state IN ('reserved','in_flight','unknown')", [value.organizationId, value.reservationId]);
      });
    },
    async settleModel(input: { organizationId: string; reservationId: string; actualCostMicros: number; actualTokens: number; inputTokens: number; outputTokens: number }): Promise<void> {
      const value = parse(z.object({ organizationId: z.uuid(), reservationId: z.uuid(), actualCostMicros: micros,
        actualTokens: observedTokens, inputTokens: observedTokens, outputTokens: observedTokens }).strict().refine(item => item.inputTokens + item.outputTokens === item.actualTokens), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await tx.query('SELECT id FROM gotchu.organizations WHERE id=$1 FOR UPDATE', [value.organizationId]);
        const result = await tx.query<{ run_id: string; amount_micros: string; reserved_tokens: string; token_limit_enforced: boolean; charged_micros: string | null; charged_tokens: string | null; input_tokens: string | null; output_tokens: string | null }>('SELECT run_id,amount_micros,reserved_tokens,token_limit_enforced,charged_micros,charged_tokens,input_tokens,output_tokens FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2 FOR UPDATE', [value.organizationId, value.reservationId]);
        const row = result.rows[0];
        if (!row) throw new BackendError('not_found', 'Model reservation not found', 404);
        if (row.charged_micros !== null) {
          if (BigInt(row.charged_micros) !== BigInt(value.actualCostMicros) || BigInt(row.charged_tokens ?? '0') !== BigInt(value.actualTokens)
            || (row.input_tokens !== null && BigInt(row.input_tokens) !== BigInt(value.inputTokens))
            || (row.output_tokens !== null && BigInt(row.output_tokens) !== BigInt(value.outputTokens))) throw new BackendError('settlement_conflict', 'Reservation already settled at a different amount', 409);
          return;
        }
        // The subscription sentinel holds uncertainty; it is never a per-call charge.
        if ((!row.token_limit_enforced && value.actualCostMicros !== 0)
          || BigInt(value.actualCostMicros) > BigInt(row.amount_micros)
          || (row.token_limit_enforced && BigInt(value.actualTokens) > BigInt(row.reserved_tokens))) {
          throw new BackendError('reservation_overrun', 'Provider usage does not fit its reserved billing limits; reservation remains held for reconciliation', 409);
        }
        await tx.query('UPDATE gotchu.organizations SET model_reserved_micros=model_reserved_micros-$2,model_spent_micros=model_spent_micros+$3,model_tokens_reserved=model_tokens_reserved-$4,model_tokens_spent=model_tokens_spent+$5 WHERE id=$1', [value.organizationId, row.amount_micros, value.actualCostMicros, row.reserved_tokens, value.actualTokens]);
        await tx.query('UPDATE gotchu.agent_runs SET reserved_micros=reserved_micros-$3,spent_micros=spent_micros+$4,tokens_reserved=tokens_reserved-$5,tokens_spent=tokens_spent+$6 WHERE organization_id=$1 AND id=$2', [value.organizationId, row.run_id, row.amount_micros, value.actualCostMicros, row.reserved_tokens, value.actualTokens]);
        await tx.query("UPDATE gotchu.model_reservations SET charged_micros=$3,charged_tokens=$4,input_tokens=$5,output_tokens=$6,state='settled',settled_at=clock_timestamp() WHERE organization_id=$1 AND id=$2", [value.organizationId, value.reservationId, value.actualCostMicros, value.actualTokens, value.inputTokens, value.outputTokens]);
        await audit(tx, value.organizationId, 'model-gateway', 'model.settled', value.reservationId, { chargedMicros: value.actualCostMicros, chargedTokens: value.actualTokens });
      });
    },
    async finish(input: { organizationId: string; runId: string; outcome: 'succeeded' | 'unavailable' | 'failed' }): Promise<void> {
      const value = parse(scopeSchema.extend({ outcome: z.enum(['succeeded', 'unavailable', 'failed']) }), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query("UPDATE gotchu.agent_runs SET state=$3 WHERE organization_id=$1 AND id=$2 AND state='running' AND reserved_micros=0 AND tokens_reserved=0", [value.organizationId, value.runId, value.outcome]);
        if (!result.rowCount) throw new BackendError('run_unsettled', 'Run is already terminal or has unsettled provider reservations', 409);
      });
    },
  };
}
