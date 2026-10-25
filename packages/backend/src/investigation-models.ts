import { randomUUID } from 'node:crypto';
import {
  configureInvestigationModelSchema,
  investigationDataScopeSchema,
  investigationModelEndpointSchema,
  investigationModelSettingsSchema,
  investigationModelProviderForPreset,
  investigationModelProbeResultSchema,
  investigationProviderCatalog,
  investigationProviderPresetIdSchema,
  modelProviderSchema,
  parseSubscriptionCredential,
} from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, parse, type Identity } from './core.js';
import type { ModelEndpointValidator } from './investigation-model-endpoint.js';

export interface ModelSecretStore {
  get(reference: string): Promise<Uint8Array>;
  put(reference: string, secret: Uint8Array): Promise<void>;
  /** Overwrites an existing reference atomically, e.g. when a CLI login refreshes its own tokens. */
  replace(reference: string, secret: Uint8Array): Promise<void>;
  delete(reference: string): Promise<void>;
}

export interface ModelProbeClient {
  probe(input: { organizationId: string; requestId: string }): Promise<unknown>;
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
  provider_preset_id: string | null;
  endpoint: string | null;
  model_id: string | null;
  secret_ref: string | null;
  consent_to_external_processing: boolean;
  automatic_source_investigations: boolean;
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
  const result = await tx.query<SettingsRow>(`SELECT s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,
    COALESCE(s.consent_to_external_processing,false) AS consent_to_external_processing,COALESCE(s.automatic_source_investigations,false) AS automatic_source_investigations,COALESCE(s.data_scopes,'[]'::jsonb) AS data_scopes,
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
  const providerPresetId = row.provider_preset_id === null ? null : investigationProviderPresetIdSchema.parse(row.provider_preset_id);
  const preset = providerPresetId ? investigationProviderCatalog.find(item => item.id === providerPresetId) : undefined;
  const endpoint = preset?.id === 'custom_openai_compatible'
    ? row.endpoint
    : preset?.baseUrl ?? null;
  const endpointMatchesPreset = preset?.id === 'custom_openai_compatible' || preset?.baseUrl === row.endpoint;
  const checkedEndpoint = endpoint === null ? null : investigationModelEndpointSchema.safeParse(endpoint);
  const dataScopes = dataScopesSchema.parse(row.data_scopes);
  const consent = row.consent_to_external_processing;
  const keyConfigured = row.secret_ref !== null;
  const budgetCents = Number(row.budget_micros) / 10_000;
  let disabledReason: z.infer<typeof investigationModelSettingsSchema.shape.disabledReason> = null;
  if (!provider || !providerPresetId || !preset || !checkedEndpoint?.success || !endpointMatchesPreset || provider !== investigationModelProviderForPreset(preset) || !row.model_id) disabledReason = 'not_configured';
  else if (!consent) disabledReason = 'consent_required';
  else if (dataScopes.length === 0) disabledReason = 'data_scope_required';
  else if (budgetCents <= 0 || Number(row.tokens_budget) <= 0) disabledReason = 'budget_unconfigured';
  else if (!keyConfigured || !secretStoreAvailable) disabledReason = 'secret_unavailable';
  return investigationModelSettingsSchema.parse({
    status: disabledReason === null ? 'ready' : 'disabled', disabledReason,
    provider, providerPresetId, endpoint: checkedEndpoint?.success ? checkedEndpoint.data : null, modelId: row.model_id,
    apiKeyConfigured: keyConfigured, consentToExternalProcessing: consent, automaticSourceInvestigations: row.automatic_source_investigations, dataScopes,
    inputPriceMicroUsdPerMillionTokens: Number(row.input_price_micro_usd_per_million_tokens),
    outputPriceMicroUsdPerMillionTokens: Number(row.output_price_micro_usd_per_million_tokens),
    organizationBudgetCents: budgetCents, organizationTokenBudget: Number(row.tokens_budget),
    spentMicroUsd: Number(row.spent_micros), reservedMicroUsd: Number(row.reserved_micros),
    tokensSpent: Number(row.tokens_spent), tokensReserved: Number(row.tokens_reserved),
  });
}

export function createInvestigationModelService(options: {
  database: Database;
  secrets?: ModelSecretStore;
  endpointValidator?: ModelEndpointValidator;
  probeClient?: ModelProbeClient;
}) {
  const { database, secrets, endpointValidator, probeClient } = options;
  return {
    async authorizeConnection(identity: Identity, input: { organizationId: string; providerPresetId: 'codex' | 'claude_code' | 'openrouter' }) {
      const organizationId = parse(z.uuid(), input.organizationId);
      const presetId = parse(z.enum(['codex', 'claude_code', 'openrouter']), input.providerPresetId);
      return database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity, ['owner']);
        if (!secrets) throw new BackendError('model_secret_store_unavailable', 'Model credential storage is not configured', 503);
        const row = await tx.query<{ version: string }>(`SELECT updated_at::text AS version FROM gotchu.investigation_model_settings
          WHERE organization_id=$1 AND provider_preset_id=$2`, [organizationId, presetId]);
        if (!row.rows[0]) throw new BackendError('codex_configuration_changed', 'Select and save the provider before connecting', 409);
        return row.rows[0].version;
      });
    },
    async connectCredential(identity: Identity, input: { organizationId: string; providerPresetId: 'codex' | 'claude_code' | 'openrouter'; version: string; credential: string }) {
      await this.authorizeConnection(identity, input);
      const credential = input.providerPresetId === 'openrouter'
        ? parse(z.string().trim().min(1).max(16_384), input.credential)
        : parseSubscriptionCredential(input.providerPresetId, input.credential);
      if (!credential) throw new BackendError('model_credential_invalid', 'Provider did not return a valid login', 400);
      if (!secrets) throw new BackendError('model_secret_store_unavailable', 'Model credential storage is not configured', 503);
      const reference = `local-model:${randomUUID()}`;
      await secrets.put(reference, Buffer.from(credential, 'utf8'));
      let oldReference: string | null = null;
      try {
        await database.tenant(input.organizationId, async tx => {
          await authorize(tx, input.organizationId, identity, ['owner']);
          const row = await tx.query<{ secret_ref: string | null }>(`SELECT secret_ref FROM gotchu.investigation_model_settings
            WHERE organization_id=$1 AND provider_preset_id=$3 AND updated_at::text=$2 FOR UPDATE`, [input.organizationId, input.version, input.providerPresetId]);
          if (!row.rows[0]) throw new BackendError('codex_configuration_changed', 'Configuration changed; reconnect the provider', 409);
          oldReference = row.rows[0].secret_ref;
          await tx.query('UPDATE gotchu.investigation_model_settings SET secret_ref=$2,updated_at=clock_timestamp() WHERE organization_id=$1', [input.organizationId, reference]);
          await audit(tx, input.organizationId, identity.userId, 'investigation.provider_connected', null, { providerPresetId: input.providerPresetId });
        });
      } catch (error) { await secrets.delete(reference); throw error; }
      if (oldReference) await secrets.delete(oldReference);
    },
    async get(identity: Identity, input: { organizationId: string }) {
      const organizationId = parse(z.uuid(), input.organizationId);
      return database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity);
        return project(await load(tx, organizationId), Boolean(secrets));
      });
    },
    async configure(identity: Identity, raw: unknown) {
      const value = parse(configureSchema, raw);
      await database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner']);
      });
      if ((value.apiKey !== undefined || value.clearApiKey) && !secrets) {
        throw new BackendError('model_secret_store_unavailable', 'Model credential storage is not configured', 503);
      }
      const preset = investigationProviderCatalog.find(item => item.id === value.providerPresetId);
      if (!preset) throw new BackendError('provider_preset_invalid', 'Provider preset is not supported', 400);
      const endpoint = preset.baseUrl ?? value.customEndpoint;
      if (!endpoint) throw new BackendError('model_endpoint_required', 'Custom provider endpoint is required', 400);
      if (preset.id === 'custom_openai_compatible') {
        if (!endpointValidator) throw new BackendError('model_endpoint_validator_unavailable', 'Custom provider endpoint validation is unavailable', 503);
        try { await endpointValidator.validate(endpoint); }
        catch (cause) {
          const code = cause instanceof Error ? cause.message : '';
          if (code === 'model_endpoint_nonpublic' || code === 'model_endpoint_https_required' || code === 'model_endpoint_invalid') {
            throw new BackendError(code, 'Custom provider endpoints must use HTTPS and resolve only to public addresses', 400, { cause });
          }
          throw new BackendError('model_endpoint_dns_unavailable', 'Custom provider DNS could not be validated safely', 503, { cause });
        }
      }
      let apiKey = value.apiKey;
      if (apiKey !== undefined && preset.billing === 'subscription') {
        const credential = parseSubscriptionCredential(preset.id, apiKey);
        if (credential === null) {
          throw new BackendError('model_credential_invalid', preset.id === 'codex'
            ? 'Paste the full auth.json written by `codex login` with a ChatGPT account'
            : 'Paste the token printed by `claude setup-token`', 400);
        }
        apiKey = credential;
      }
      const newSecretRef = apiKey ? `local-model:${randomUUID()}` : null;
      if (newSecretRef && secrets) {
        if (apiKey === undefined) throw new BackendError('model_secret_required', 'Model credential is required', 400);
        try { await secrets.put(newSecretRef, Buffer.from(apiKey, 'utf8')); }
        catch (cause) { throw new BackendError('model_secret_store_unavailable', 'Model credential could not be stored', 503, { cause }); }
      }
      let oldSecretRef: string | null = null;
      let providerChanged = false;
      try {
        await database.tenant(value.organizationId, async tx => {
          await authorize(tx, value.organizationId, identity, ['owner']);
          const current = await tx.query<{ secret_ref: string | null; provider_preset_id: string | null }>('SELECT secret_ref,provider_preset_id FROM gotchu.investigation_model_settings WHERE organization_id=$1 FOR UPDATE', [value.organizationId]);
          const currentSettings = current.rows[0];
          oldSecretRef = currentSettings?.secret_ref ?? null;
          providerChanged = currentSettings !== undefined && currentSettings.provider_preset_id !== value.providerPresetId;
          const secretRef = newSecretRef ?? (value.clearApiKey || providerChanged ? null : oldSecretRef);
          const budgetMicros = BigInt(value.organizationBudgetCents) * 10_000n;
          const budgetUpdate = await tx.query(`UPDATE gotchu.organizations SET model_opt_in=$2,model_budget_micros=$3,model_token_budget=$4
            WHERE id=$1 AND model_spent_micros+model_reserved_micros<=$3 AND model_tokens_spent+model_tokens_reserved<=$4`,
          [value.organizationId, value.consentToExternalProcessing, budgetMicros.toString(), value.organizationTokenBudget]);
          if (!budgetUpdate.rowCount) throw new BackendError('model_budget_below_usage', 'A budget cannot be lower than spend or reservations already recorded', 409);
          await tx.query(`INSERT INTO gotchu.investigation_model_settings(organization_id,provider,provider_preset_id,endpoint,model_id,secret_ref,
            consent_to_external_processing,data_scopes,input_price_micro_usd_per_million_tokens,output_price_micro_usd_per_million_tokens,updated_by,updated_at,automatic_source_investigations)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,clock_timestamp(),$12)
            ON CONFLICT(organization_id) DO UPDATE SET provider=EXCLUDED.provider,provider_preset_id=EXCLUDED.provider_preset_id,
              endpoint=EXCLUDED.endpoint,model_id=EXCLUDED.model_id,
              automatic_source_investigations=EXCLUDED.automatic_source_investigations,secret_ref=EXCLUDED.secret_ref,consent_to_external_processing=EXCLUDED.consent_to_external_processing,data_scopes=EXCLUDED.data_scopes,
              input_price_micro_usd_per_million_tokens=EXCLUDED.input_price_micro_usd_per_million_tokens,
              output_price_micro_usd_per_million_tokens=EXCLUDED.output_price_micro_usd_per_million_tokens,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
          [value.organizationId, investigationModelProviderForPreset(preset), preset.id, endpoint, value.modelId, secretRef, value.consentToExternalProcessing,
            JSON.stringify(value.dataScopes), value.inputPriceMicroUsdPerMillionTokens, value.outputPriceMicroUsdPerMillionTokens, identity.userId, value.automaticSourceInvestigations]);
          await audit(tx, value.organizationId, identity.userId, 'investigation.model_configured', null, {
            providerPresetId: preset.id, modelId: value.modelId, consentToExternalProcessing: value.consentToExternalProcessing, automaticSourceInvestigations: value.automaticSourceInvestigations,
            dataScopes: value.dataScopes, organizationBudgetCents: value.organizationBudgetCents,
            organizationTokenBudget: value.organizationTokenBudget, apiKeyChanged: newSecretRef !== null || value.clearApiKey,
          });
        });
      } catch (cause) {
        if (newSecretRef && secrets) await secrets.delete(newSecretRef).catch(() => undefined);
        throw cause;
      }
      if (oldSecretRef && (newSecretRef || value.clearApiKey || providerChanged) && oldSecretRef !== newSecretRef) await secrets?.delete(oldSecretRef);
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
    async testConnection(identity: Identity, input: { organizationId: string }) {
      const organizationId = parse(z.uuid(), input.organizationId);
      const state = await database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity, ['owner']);
        return project(await load(tx, organizationId), Boolean(secrets));
      });
      if (!probeClient) return investigationModelProbeResultSchema.parse({ status: 'failed', reason: 'probe_unavailable', inputTokens: null, outputTokens: null });
      if (state.status !== 'ready') {
        return investigationModelProbeResultSchema.parse({ status: 'failed',
          reason: state.disabledReason === 'budget_unconfigured' ? 'budget_exhausted' : 'probe_unavailable', inputTokens: null, outputTokens: null });
      }
      const requestId = randomUUID();
      let result: z.infer<typeof investigationModelProbeResultSchema>;
      try {
        result = investigationModelProbeResultSchema.parse(await probeClient.probe({ organizationId, requestId }));
      } catch {
        result = investigationModelProbeResultSchema.parse({ status: 'failed', reason: 'probe_unavailable', inputTokens: null, outputTokens: null });
      }
      await database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity, ['owner']);
        await audit(tx, organizationId, identity.userId, 'investigation.model_connection_tested', null, {
          requestId, status: result.status, reason: result.reason,
        });
      });
      return result;
    },
  };
}
