import { randomUUID } from 'node:crypto';
import {
  configureInvestigationModelSchema,
  investigationDataScopeSchema,
  investigationModelSettingsSchema,
  modelProviderSchema,
} from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, type Identity } from './core.js';

export interface ModelSecretStore {
  get(reference: string): Promise<Uint8Array>;
  put(reference: string, secret: Uint8Array): Promise<void>;
  delete(reference: string): Promise<void>;
}

const configureSchema = configureInvestigationModelSchema.extend({
  organizationId: z.uuid(),
  clearApiKey: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.apiKey !== undefined && value.clearApiKey) {
    context.addIssue({ code: 'custom', path: ['clearApiKey'], message: 'A new key and key removal cannot be requested together' });
  }
});
const dataScopesSchema = investigationDataScopeSchema.array().max(7);

interface SettingsRow {
  provider: string | null;
  endpoint: string | null;
  model_id: string | null;
  secret_ref: string | null;
  consent_to_external_processing: boolean;
  data_scopes: unknown;
  input_price_micro_usd_per_million_tokens: string | number;
  output_price_micro_usd_per_million_tokens: string | number;
  budget_micros: string | number;
  tokens_budget: string | number;
  spent_micros: string | number;
  reserved_micros: string | number;
  tokens_spent: string | number;
  tokens_reserved: string | number;
}

async function load(tx: Transaction, organizationId: string): Promise<SettingsRow> {
  const result = await tx.query<SettingsRow>(`SELECT s.provider,s.endpoint,s.model_id,s.secret_ref,
    COALESCE(s.consent_to_external_processing,false) AS consent_to_external_processing,COALESCE(s.data_scopes,'[]'::jsonb) AS data_scopes,
    COALESCE(s.input_price_micro_usd_per_million_tokens,0) AS input_price_micro_usd_per_million_tokens,
    COALESCE(s.output_price_micro_usd_per_million_tokens,0) AS output_price_micro_usd_per_million_tokens,
    o.model_budget_micros AS budget_micros,o.model_token_budget AS tokens_budget,
    o.model_spent_micros AS spent_micros,o.model_reserved_micros AS reserved_micros,
    o.model_tokens_spent AS tokens_spent,o.model_tokens_reserved AS tokens_reserved
    FROM gotchu.organizations o LEFT JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id WHERE o.id=$1`, [organizationId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Workspace not found', 404);
  return row;
}

function project(row: SettingsRow, secretStoreAvailable: boolean) {
  const provider = row.provider === null ? null : modelProviderSchema.parse(row.provider);
  const dataScopes = dataScopesSchema.parse(row.data_scopes);
  const consent = row.consent_to_external_processing;
  const keyConfigured = row.secret_ref !== null;
  const budgetCents = Number(row.budget_micros) / 10_000;
  let disabledReason: z.infer<typeof investigationModelSettingsSchema.shape.disabledReason> = null;
  if (!provider || !row.endpoint || !row.model_id) disabledReason = 'not_configured';
  else if (!consent) disabledReason = 'consent_required';
  else if (dataScopes.length === 0) disabledReason = 'data_scope_required';
  else if (budgetCents <= 0 || Number(row.tokens_budget) <= 0) disabledReason = 'budget_unconfigured';
  else if (provider === 'anthropic_messages' && !keyConfigured || keyConfigured && !secretStoreAvailable) disabledReason = 'secret_unavailable';
  return investigationModelSettingsSchema.parse({
    status: disabledReason === null ? 'ready' : 'disabled', disabledReason,
    provider, endpoint: row.endpoint, modelId: row.model_id,
    apiKeyConfigured: keyConfigured, consentToExternalProcessing: consent, dataScopes,
    inputPriceMicroUsdPerMillionTokens: Number(row.input_price_micro_usd_per_million_tokens),
    outputPriceMicroUsdPerMillionTokens: Number(row.output_price_micro_usd_per_million_tokens),
    organizationBudgetCents: budgetCents, organizationTokenBudget: Number(row.tokens_budget),
    spentMicroUsd: Number(row.spent_micros), reservedMicroUsd: Number(row.reserved_micros),
    tokensSpent: Number(row.tokens_spent), tokensReserved: Number(row.tokens_reserved),
  });
}

export function createInvestigationModelService(options: { database: Database; secrets?: ModelSecretStore }) {
  const { database, secrets } = options;
  return {
    async get(identity: Identity, input: { organizationId: string }) {
      const organizationId = parse(z.uuid(), input.organizationId);
      return database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity);
        return project(await load(tx, organizationId), Boolean(secrets));
      });
    },
    async configure(identity: Identity, raw: unknown) {
      const value = parse(configureSchema, raw);
      if ((value.apiKey !== undefined || value.clearApiKey) && !secrets) {
        throw new BackendError('model_secret_store_unavailable', 'Model credential storage is not configured', 503);
      }
      const newSecretRef = value.apiKey ? `local-model:${randomUUID()}` : null;
      if (newSecretRef && secrets) {
        const apiKey = value.apiKey;
        if (apiKey === undefined) throw new BackendError('model_secret_required', 'Model credential is required', 400);
        try { await secrets.put(newSecretRef, Buffer.from(apiKey, 'utf8')); }
        catch (cause) { throw new BackendError('model_secret_store_unavailable', 'Model credential could not be stored', 503, { cause }); }
      }
      let oldSecretRef: string | null = null;
      try {
        await database.tenant(value.organizationId, async tx => {
          await authorize(tx, value.organizationId, identity, ['owner']);
          const current = await tx.query<{ secret_ref: string | null }>('SELECT secret_ref FROM gotchu.investigation_model_settings WHERE organization_id=$1 FOR UPDATE', [value.organizationId]);
          oldSecretRef = current.rows[0]?.secret_ref ?? null;
          const secretRef = newSecretRef ?? (value.clearApiKey ? null : oldSecretRef);
          const budgetMicros = BigInt(value.organizationBudgetCents) * 10_000n;
          const budgetUpdate = await tx.query(`UPDATE gotchu.organizations SET model_opt_in=$2,model_budget_micros=$3,model_token_budget=$4
            WHERE id=$1 AND model_spent_micros+model_reserved_micros<=$3 AND model_tokens_spent+model_tokens_reserved<=$4`,
          [value.organizationId, value.consentToExternalProcessing, budgetMicros.toString(), value.organizationTokenBudget]);
          if (!budgetUpdate.rowCount) throw new BackendError('model_budget_below_usage', 'A budget cannot be lower than spend or reservations already recorded', 409);
          await tx.query(`INSERT INTO gotchu.investigation_model_settings(organization_id,provider,endpoint,model_id,secret_ref,
            consent_to_external_processing,data_scopes,input_price_micro_usd_per_million_tokens,output_price_micro_usd_per_million_tokens,updated_by,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,clock_timestamp())
            ON CONFLICT(organization_id) DO UPDATE SET provider=EXCLUDED.provider,endpoint=EXCLUDED.endpoint,model_id=EXCLUDED.model_id,
              secret_ref=EXCLUDED.secret_ref,consent_to_external_processing=EXCLUDED.consent_to_external_processing,data_scopes=EXCLUDED.data_scopes,
              input_price_micro_usd_per_million_tokens=EXCLUDED.input_price_micro_usd_per_million_tokens,
              output_price_micro_usd_per_million_tokens=EXCLUDED.output_price_micro_usd_per_million_tokens,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
          [value.organizationId, value.provider, value.endpoint, value.modelId, secretRef, value.consentToExternalProcessing,
            JSON.stringify(value.dataScopes), value.inputPriceMicroUsdPerMillionTokens, value.outputPriceMicroUsdPerMillionTokens, identity.userId]);
          await audit(tx, value.organizationId, identity.userId, 'investigation.model_configured', null, {
            provider: value.provider, modelId: value.modelId, consentToExternalProcessing: value.consentToExternalProcessing,
            dataScopes: value.dataScopes, organizationBudgetCents: value.organizationBudgetCents,
            organizationTokenBudget: value.organizationTokenBudget, apiKeyChanged: newSecretRef !== null || value.clearApiKey,
          });
        });
      } catch (cause) {
        if (newSecretRef && secrets) await secrets.delete(newSecretRef).catch(() => undefined);
        throw cause;
      }
      if (oldSecretRef && (newSecretRef || value.clearApiKey) && oldSecretRef !== newSecretRef) await secrets?.delete(oldSecretRef);
      return this.get(identity, { organizationId: value.organizationId });
    },
    async disable(identity: Identity, input: { organizationId: string }) {
      const organizationId = parse(z.uuid(), input.organizationId);
      let secretRef: string | null = null;
      await database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity, ['owner']);
        const row = await tx.query<{ secret_ref: string | null }>('DELETE FROM gotchu.investigation_model_settings WHERE organization_id=$1 RETURNING secret_ref', [organizationId]);
        secretRef = row.rows[0]?.secret_ref ?? null;
        await tx.query('UPDATE gotchu.organizations SET model_opt_in=false WHERE id=$1', [organizationId]);
        await audit(tx, organizationId, identity.userId, 'investigation.model_disabled', null, {});
      });
      if (secretRef) await secrets?.delete(secretRef);
      return this.get(identity, { organizationId });
    },
  };
}
