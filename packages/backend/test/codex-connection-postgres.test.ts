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
    const version = await models.authorizeCodexConnection(identity, { organizationId });
    await models.connectCodex(identity, { organizationId, version, credential });
    const settings = await models.get(identity, { organizationId });
    expect(settings).toMatchObject({ apiKeyConfigured: true, consentToExternalProcessing: false, dataScopes: [], organizationTokenBudget: 100_000, status: 'disabled' });
    expect(JSON.stringify(settings)).not.toContain('synthetic-'); expect(stored.size).toBe(1);
    const audit = await f.admin.query('SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action=$2', [organizationId, 'investigation.codex_connected']);
    expect(audit.rows).toEqual([{ detail: {} }]);
  });

  it('rejects cross-tenant access and non-owners before touching secret storage', async () => {
    const organizationId = f.a.organizationId;
    const viewer = `viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [organizationId, viewer]);
    const version = await models.authorizeCodexConnection({ userId: f.a.userId }, { organizationId });
    const before = stored.size;
    for (const userId of [viewer, f.b.userId]) {
      await expect(models.authorizeCodexConnection({ userId }, { organizationId })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(models.connectCodex({ userId }, { organizationId, version, credential })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(stored.size).toBe(before);
  });

  it('rejects a stale ceremony after a settings change and discards its new credential', async () => {
    const identity = { userId: f.a.userId }; const organizationId = f.a.organizationId;
    const version = await models.authorizeCodexConnection(identity, { organizationId });
    await models.configure(identity, { ...configuration(organizationId), modelId: 'gpt-6-sol' });
    const before = stored.size;
    await expect(models.connectCodex(identity, { organizationId, version, credential })).rejects.toMatchObject({ code: 'codex_configuration_changed' });
    expect(stored.size).toBe(before);
    await models.disable(identity, { organizationId });
    await expect(models.connectCodex(identity, { organizationId, version, credential })).rejects.toMatchObject({ code: 'codex_configuration_changed' });
    expect(stored.size).toBe(0);
  });
});
