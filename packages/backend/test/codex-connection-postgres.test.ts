import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('dedicated Codex connection import on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const stored = new Map<string, Uint8Array>();
  let models: ReturnType<typeof createBackend>['investigationModels'];
  const credential = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } });
  beforeAll(async () => {
    f = await fixture();
    models = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async reference => stored.get(reference) ?? new Uint8Array(),
      put: async (reference, secret) => { stored.set(reference, secret); },
      replace: async (reference, secret) => { stored.set(reference, secret); },
      delete: async reference => { stored.delete(reference); },
    } }).investigationModels;
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  const configuration = (organizationId: string) => ({ organizationId, providerPresetId: 'codex', modelId: 'gpt-6-luna',
    consentToExternalProcessing: false, dataScopes: [], inputPriceMicroUsdPerMillionTokens: 0,
    outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 100_000 });

  it('connects without expanding consent, budgets or data scopes, and never projects credentials', async () => {
    const identity = { userId: f.a.userId }; const organizationId = f.a.organizationId;
    await models.configure(identity, configuration(organizationId));
    const version = await models.authorizeConnection(identity, { organizationId, providerPresetId: 'codex' });
    await models.connectCredential(identity, { organizationId, providerPresetId: 'codex', version, credential });
    const settings = await models.get(identity, { organizationId });
    expect(settings).toMatchObject({ apiKeyConfigured: true, consentToExternalProcessing: false, dataScopes: [], organizationTokenBudget: 100_000, status: 'disabled' });
    expect(JSON.stringify(settings)).not.toContain('synthetic-'); expect(stored.size).toBe(1);
    const audit = await f.admin.query('SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action=$2', [organizationId, 'investigation.provider_connected']);
    expect(audit.rows).toEqual([{ detail: { providerPresetId: 'codex' } }]);
  });

  it('rejects cross-tenant access and non-owners before touching secret storage', async () => {
    const organizationId = f.a.organizationId;
    const viewer = `viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [organizationId, viewer]);
    const version = await models.authorizeConnection({ userId: f.a.userId }, { organizationId, providerPresetId: 'codex' });
    const before = stored.size;
    for (const userId of [viewer, f.b.userId]) {
      await expect(models.authorizeConnection({ userId }, { organizationId, providerPresetId: 'codex' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(models.connectCredential({ userId }, { organizationId, providerPresetId: 'codex', version, credential })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(stored.size).toBe(before);
  });

  it('rejects a stale ceremony after a settings change and discards its new credential', async () => {
    const identity = { userId: f.a.userId }; const organizationId = f.a.organizationId;
    const version = await models.authorizeConnection(identity, { organizationId, providerPresetId: 'codex' });
    await models.configure(identity, { ...configuration(organizationId), modelId: 'gpt-6-sol' });
    const before = stored.size;
    await expect(models.connectCredential(identity, { organizationId, providerPresetId: 'codex', version, credential })).rejects.toMatchObject({ code: 'codex_configuration_changed' });
    expect(stored.size).toBe(before);
    await models.disable(identity, { organizationId });
    await expect(models.connectCredential(identity, { organizationId, providerPresetId: 'codex', version, credential })).rejects.toMatchObject({ code: 'codex_configuration_changed' });
    expect(stored.size).toBe(0);
  });

  it.each(['claude_code', 'openrouter'] as const)('imports %s without reusing another provider session', async providerPresetId => {
    const identity = { userId: f.b.userId }; const organizationId = f.b.organizationId;
    await models.configure(identity, { ...configuration(organizationId), providerPresetId, modelId: 'synthetic-model' });
    await expect(models.authorizeConnection(identity, { organizationId, providerPresetId: 'codex' })).rejects.toMatchObject({ status: 409 });
    const version = await models.authorizeConnection(identity, { organizationId, providerPresetId });
    const value = providerPresetId === 'claude_code' ? 'sk-ant-oat01-syntheticSubscriptionToken1234567890' : 'synthetic-openrouter-key';
    await models.connectCredential(identity, { organizationId, providerPresetId, version, credential: value });
    expect(await models.get(identity, { organizationId })).toMatchObject({ providerPresetId, apiKeyConfigured: true, consentToExternalProcessing: false });
    await models.disable(identity, { organizationId });
    expect(stored.size).toBe(0);
  });
});
