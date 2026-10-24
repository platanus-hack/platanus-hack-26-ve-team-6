import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;

live('material investigations on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;

  beforeAll(async () => {
    f = await fixture();
    api = createBackend({ database: f.databases.gotchu_api });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('deduplicates a material incident, cancels queued work, and resumes from its scoped evidence', async () => {
    const identity = { userId: f.a.userId };
    const evidenceId = randomUUID();
    const incidentId = randomUUID();
    await api.investigationModels.configure(identity, {
      organizationId: f.a.organizationId, providerPresetId: 'openai', modelId: 'gpt-5.4',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries'], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 10_000,
    });
    await f.admin.query(`INSERT INTO gotchu.incidents(organization_id,application_id,id,rule_id,dedupe_key,summary,severity,evidence)
      VALUES($1,$2,$3,'auth.login_failures.v1.account',$4,'Synthetic material incident','medium',$5::jsonb)`,
    [f.a.organizationId, f.a.applicationId, incidentId, randomUUID(), JSON.stringify([evidenceId])]);

    const input = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, subject: { kind: 'incident' as const, subjectId: incidentId } };
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'accepted' });
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'already_active' });
    const beforeCancel = await f.admin.query<{ id: string; payload: { evidenceIds: string[] } }>(`SELECT id,payload FROM gotchu.jobs
      WHERE organization_id=$1 AND application_id=$2 AND kind='investigation'`, [f.a.organizationId, f.a.applicationId]);
    expect(beforeCancel.rows).toHaveLength(1);
    expect(beforeCancel.rows[0]?.payload.evidenceIds).toEqual([evidenceId]);

    const originalJobId = beforeCancel.rows[0]?.id;
    if (!originalJobId) throw new Error('investigation_job_missing');
    expect(await api.investigations.cancel(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId: originalJobId }))
      .toEqual({ status: 'cancel_requested' });
    expect((await api.investigations.list(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))[0]?.status).toBe('cancelled');

    expect(await api.investigations.resume(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId: originalJobId }))
      .toEqual({ status: 'resumed' });
    const runs = await api.investigations.list(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId });
    expect(runs).toHaveLength(2);
    expect(runs.find(run => run.jobId !== originalJobId)).toMatchObject({ status: 'pending', subject: input.subject });
    expect(await api.investigations.request(identity, input)).toEqual({ status: 'already_exists' });

    await expect(api.investigations.list({ userId: f.b.userId }, { organizationId: f.a.organizationId, applicationId: f.a.applicationId }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps connection testing server-enforced for Owners', async () => {
    const viewer = `viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewer]);
    await expect(api.investigationModels.testConnection({ userId: viewer }, { organizationId: f.a.organizationId }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(api.investigationModels.testConnection({ userId: f.a.userId }, { organizationId: f.a.organizationId }))
      .resolves.toEqual({ status: 'failed', reason: 'probe_unavailable', inputTokens: null, outputTokens: null });
  });

  it('checks Owner access before storing a submitted provider key', async () => {
    const viewer = `viewer:${randomUUID()}`;
    const storedSecrets: Uint8Array[] = [];
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewer]);
    const apiWithSecrets = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async () => new Uint8Array(),
      put: async (_reference, secret) => { storedSecrets.push(secret); },
      replace: async () => undefined,
      delete: async () => {},
    } });
    await expect(apiWithSecrets.investigationModels.configure({ userId: viewer }, {
      organizationId: f.a.organizationId, providerPresetId: 'openai', modelId: 'gpt-5.4', apiKey: 'provider-key',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries'], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 10_000,
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(storedSecrets).toHaveLength(0);
  });

  it('does not reuse a saved key after the Owner switches provider presets', async () => {
    const storedSecrets = new Map<string, Uint8Array>();
    const apiWithSecrets = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async reference => storedSecrets.get(reference) ?? new Uint8Array(),
      put: async (reference, secret) => { storedSecrets.set(reference, secret); },
      replace: async (reference, secret) => { storedSecrets.set(reference, secret); },
      delete: async reference => { storedSecrets.delete(reference); },
    } });
    const identity = { userId: f.a.userId };
    await apiWithSecrets.investigationModels.configure(identity, {
      organizationId: f.a.organizationId, providerPresetId: 'openai', modelId: 'gpt-5.4', apiKey: 'provider-key',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries'], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 10_000,
    });
    expect(storedSecrets.size).toBe(1);
    const switched = await apiWithSecrets.investigationModels.configure(identity, {
      organizationId: f.a.organizationId, providerPresetId: 'anthropic', modelId: 'claude-sonnet-5-5',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries'], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 10_000,
    });
    expect(switched.providerPresetId).toBe('anthropic');
    expect(switched.apiKeyConfigured).toBe(false);
    expect(storedSecrets.size).toBe(0);
  });

  it('stores only a real subscription login and never a per-token price for it', async () => {
    const storedSecrets = new Map<string, Uint8Array>();
    const apiWithSecrets = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async reference => storedSecrets.get(reference) ?? new Uint8Array(),
      put: async (reference, secret) => { storedSecrets.set(reference, secret); },
      replace: async (reference, secret) => { storedSecrets.set(reference, secret); },
      delete: async reference => { storedSecrets.delete(reference); },
    } });
    const identity = { userId: f.a.userId };
    const codex = {
      organizationId: f.a.organizationId, providerPresetId: 'codex' as const, modelId: 'gpt-6-luna',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries' as const], inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 100_000,
    };
    await expect(apiWithSecrets.investigationModels.configure(identity, { ...codex, apiKey: '{"OPENAI_API_KEY":"sk-not-a-login"}' }))
      .rejects.toMatchObject({ code: 'model_credential_invalid', status: 400 });
    await expect(apiWithSecrets.investigationModels.configure(identity, { ...codex, inputPriceMicroUsdPerMillionTokens: 1,
      apiKey: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r' } }) }))
      .rejects.toMatchObject({ status: 400 });
    expect(storedSecrets.size).toBe(0);

    const ready = await apiWithSecrets.investigationModels.configure(identity, { ...codex,
      apiKey: '{\n  "auth_mode": "chatgpt",\n  "tokens": { "id_token": "i", "access_token": "a", "refresh_token": "r" }\n}' });
    expect(ready).toMatchObject({ status: 'ready', provider: 'codex_cli', endpoint: 'https://chatgpt.com/backend-api/codex', apiKeyConfigured: true });
    expect([...storedSecrets.values()].map(secret => Buffer.from(secret).toString('utf8')))
      .toEqual(['{"auth_mode":"chatgpt","tokens":{"id_token":"i","access_token":"a","refresh_token":"r"}}']);

    await expect(apiWithSecrets.investigationModels.configure(identity, { ...codex, providerPresetId: 'claude_code', modelId: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-api03-a-console-api-key-is-not-a-subscription-token' })).rejects.toMatchObject({ code: 'model_credential_invalid' });
    const claude = await apiWithSecrets.investigationModels.configure(identity, { ...codex, providerPresetId: 'claude_code',
      modelId: 'claude-sonnet-5-5', apiKey: `sk-ant-oat01-${'b'.repeat(40)}` });
    expect(claude).toMatchObject({ status: 'ready', provider: 'claude_code_cli', providerPresetId: 'claude_code' });
    expect(storedSecrets.size).toBe(1);
  });
});
