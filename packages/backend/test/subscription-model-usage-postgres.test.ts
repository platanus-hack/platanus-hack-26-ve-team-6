import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { investigationModelProviderForPreset, investigationProviderCatalog } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, enqueue, modelConfigurationFingerprint } from '../src/index.js';
import type { ModelConfigurationSnapshot } from '../src/model-configuration.js';
import { correctionModelFingerprint } from '../src/ai-correction-context.js';

const live = liveUrl ? describe : describe.skip;
live('subscription usage on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  beforeEach(async () => {
    f = await fixture({ max: 4 });
    backend = createBackend({ database: f.databases.gotchu_coordinator });
  }, 30_000);
  afterEach(async () => { await f?.close(); });

  function configuration(providerPresetId: 'codex' | 'claude_code' | 'openai') {
    const preset = present(investigationProviderCatalog.find(item => item.id === providerPresetId));
    return {
      provider: investigationModelProviderForPreset(preset), providerPresetId,
      endpoint: present(preset.baseUrl), modelId: 'fixture-model', secretRef: `local-model:${randomUUID()}`,
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries', 'finding_details', 'source_excerpts'],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0,
    } satisfies ModelConfigurationSnapshot;
  }
  async function settings(config: ReturnType<typeof configuration>) {
    await f.admin.query(`INSERT INTO gotchu.investigation_model_settings(organization_id,provider,provider_preset_id,
      endpoint,model_id,secret_ref,consent_to_external_processing,data_scopes,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,true,$7::jsonb,$8)
      ON CONFLICT(organization_id) DO UPDATE SET provider=EXCLUDED.provider,provider_preset_id=EXCLUDED.provider_preset_id,
        endpoint=EXCLUDED.endpoint,model_id=EXCLUDED.model_id,secret_ref=EXCLUDED.secret_ref`,
    [f.a.organizationId, config.provider, config.providerPresetId, config.endpoint, config.modelId,
      config.secretRef, JSON.stringify(config.dataScopes), f.a.userId]);
  }
  async function start(providerPresetId: 'codex' | 'claude_code' | 'openai' = 'codex') {
    const config = configuration(providerPresetId);
    await settings(config);
    await f.admin.query('UPDATE gotchu.organizations SET model_token_budget=$2 WHERE id=$1',
      [f.a.organizationId, providerPresetId === 'openai' ? 100_000 : 0]);
    const jobId = randomUUID();
    await f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => enqueue(tx, {
      organizationId: f.a.organizationId, applicationId: f.a.applicationId, id: jobId, kind: 'investigation', idempotencyKey: jobId,
    }));
    const job = present(await backend.jobs.claim({ organizationId: f.a.organizationId, jobId }));
    const run = await backend.runs.start({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId, leaseToken: job.leaseToken });
    return { organizationId: f.a.organizationId, runId: run.runId, reservationId: randomUUID(),
      maxCostMicros: 1, reserveTokens: providerPresetId === 'openai' ? 20_000 : 0,
      requestSha256: 'a'.repeat(64), configSha256: modelConfigurationFingerprint(config), provider: config.provider, modelId: config.modelId };
  }
  function settlement(reservation: Awaited<ReturnType<typeof start>>) {
    return { organizationId: reservation.organizationId, reservationId: reservation.reservationId,
      actualCostMicros: 0, actualTokens: 75_000, inputTokens: 70_000, outputTokens: 5_000 };
  }

  it.each(['codex', 'claude_code'] as const)('accounts %s usage past token thresholds exactly once and still bounds invocations', async provider => {
    const reservation = await start(provider);
    await backend.runs.reserveModel(reservation);
    await backend.runs.markModelInFlight({ organizationId: reservation.organizationId, reservationId: reservation.reservationId });
    const usage = settlement(reservation);
    await backend.runs.settleModel(usage);
    await backend.runs.settleModel(usage);
    await expect(backend.runs.settleModel({ ...usage, inputTokens: 69_999, outputTokens: 5_001 }))
      .rejects.toMatchObject({ code: 'settlement_conflict' });
    await expect(backend.runs.settleModel({ ...usage, organizationId: f.b.organizationId }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.runs.reserveModel(reservation)).rejects.toMatchObject({ code: 'reservation_exists' });
    expect((await f.admin.query(`SELECT model_tokens_spent,model_tokens_reserved,model_spent_micros,model_reserved_micros
      FROM gotchu.organizations WHERE id=$1`, [f.a.organizationId])).rows[0])
      .toEqual({ model_tokens_spent: '75000', model_tokens_reserved: '0', model_spent_micros: '0', model_reserved_micros: '0' });
    for (let i = 0; i < 3; i++) await backend.runs.reserveModel({ ...reservation, reservationId: randomUUID() });
    await expect(backend.runs.reserveModel({ ...reservation, reservationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'model_call_limit' });
  });

  it('requires trusted subscription settings, zero tokens, the sentinel hold, and active consent', async () => {
    const reservation = await start();
    await expect(backend.runs.reserveModel({ ...reservation, reserveTokens: 1 }))
      .rejects.toMatchObject({ code: 'model_reservation_invalid' });
    await expect(backend.runs.reserveModel({ ...reservation, maxCostMicros: 0 }))
      .rejects.toMatchObject({ code: 'model_reservation_invalid' });
    await expect(backend.runs.reserveModel({ ...reservation, provider: 'openai_compatible' }))
      .rejects.toMatchObject({ code: 'model_configuration_changed' });
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=false WHERE id=$1', [f.a.organizationId]);
    await expect(backend.runs.reserveModel(reservation)).rejects.toMatchObject({ code: 'model_opt_in_required' });
  });

  it('holds unknown subscription calls and preserves their billing mode after settings change', async () => {
    const reservation = await start();
    await backend.runs.reserveModel(reservation);
    await backend.runs.markModelUnknown({ organizationId: reservation.organizationId, reservationId: reservation.reservationId });
    await expect(backend.runs.finish({ organizationId: reservation.organizationId, runId: reservation.runId, outcome: 'succeeded' }))
      .rejects.toMatchObject({ code: 'run_unsettled' });
    await expect(f.admin.query('UPDATE gotchu.model_reservations SET token_limit_enforced=true WHERE organization_id=$1 AND id=$2',
      [reservation.organizationId, reservation.reservationId])).rejects.toThrow('token enforcement is immutable');
    await expect(backend.runs.settleModel({ ...settlement(reservation), actualCostMicros: 2 }))
      .rejects.toMatchObject({ code: 'reservation_overrun' });
    await expect(backend.runs.settleModel({ ...settlement(reservation), actualCostMicros: 1 }))
      .rejects.toMatchObject({ code: 'reservation_overrun' });
    expect((await f.admin.query('SELECT state,amount_micros,reserved_tokens,token_limit_enforced FROM gotchu.model_reservations WHERE id=$1',
      [reservation.reservationId])).rows[0]).toEqual({ state: 'unknown', amount_micros: '1', reserved_tokens: '0', token_limit_enforced: false });
    await settings(configuration('openai'));
    await backend.runs.settleModel(settlement(reservation));
  });

  it('retains API token and money limits, including legacy holds after switching to a subscription', async () => {
    const reservation = await start('openai');
    await expect(backend.runs.reserveModel({ ...reservation, reserveTokens: 0 })).rejects.toMatchObject({ code: 'model_reservation_invalid' });
    await expect(backend.runs.reserveModel({ ...reservation, maxCostMicros: 1_001 })).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    await f.admin.query('UPDATE gotchu.organizations SET model_token_budget=0 WHERE id=$1', [f.a.organizationId]);
    await expect(backend.runs.reserveModel(reservation)).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    await f.admin.query('UPDATE gotchu.organizations SET model_token_budget=100000 WHERE id=$1', [f.a.organizationId]);
    await backend.runs.reserveModel(reservation);
    await expect(backend.runs.reserveModel({ ...reservation, reservationId: randomUUID(), reserveTokens: 1 }))
      .rejects.toMatchObject({ code: 'model_budget_exhausted' });
    await backend.runs.markModelUnknown({ organizationId: reservation.organizationId, reservationId: reservation.reservationId });
    await settings(configuration('codex'));
    await expect(backend.runs.settleModel(settlement(reservation))).rejects.toMatchObject({ code: 'reservation_overrun' });
    // Omitting the new column models a call admitted by pre-migration code.
    const legacyId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.model_reservations(organization_id,id,run_id,amount_micros,reserved_tokens,state)
      VALUES($1,$2,$3,1,10,'unknown')`, [reservation.organizationId, legacyId, reservation.runId]);
    expect((await f.admin.query('SELECT state,token_limit_enforced FROM gotchu.model_reservations WHERE id=$1', [legacyId])).rows[0])
      .toEqual({ state: 'unknown', token_limit_enforced: true });
    await expect(f.admin.query('UPDATE gotchu.model_reservations SET token_limit_enforced=false WHERE id=$1', [legacyId]))
      .rejects.toThrow('token enforcement is immutable');
    await expect(backend.runs.settleModel({ ...settlement(reservation), reservationId: legacyId }))
      .rejects.toMatchObject({ code: 'reservation_overrun' });
  });

  it('admits subscription investigations and corrections and saves settings after observed usage exceeds the token budget', async () => {
    const reservation = await start();
    await backend.runs.reserveModel(reservation);
    await backend.runs.settleModel(settlement(reservation));
    const api = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async () => { throw new Error('No provider credentials should be read'); },
      put: async () => { throw new Error('No provider credentials should be written'); },
      replace: async () => { throw new Error('No provider credentials should be replaced'); },
      delete: async () => {},
    } });
    const identity = { userId: f.a.userId };
    const input = { organizationId: f.a.organizationId, providerPresetId: 'codex', modelId: 'fixture-model',
      consentToExternalProcessing: true, dataScopes: ['runtime_summaries', 'finding_details', 'source_excerpts'],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0,
      organizationBudgetCents: 1, organizationTokenBudget: 0 };
    expect(await api.investigationModels.configure(identity, input)).toMatchObject({ status: 'ready', tokensSpent: 75_000 });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => correctionModelFingerprint(tx, f.a.organizationId, true)))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
    const incidentId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.incidents(organization_id,application_id,id,rule_id,dedupe_key,summary,severity,evidence)
      VALUES($1,$2,$3,'auth.login_failures.v1.account',$4,'Synthetic material incident','medium',$5::jsonb)`,
    [f.a.organizationId, f.a.applicationId, incidentId, randomUUID(), JSON.stringify([randomUUID()])]);
    const request = { organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      subject: { kind: 'incident' as const, subjectId: incidentId } };
    await expect(api.investigations.request(identity, request)).resolves.toEqual({ status: 'accepted' });
    await expect(api.investigationModels.configure(identity, { ...input, providerPresetId: 'openai' }))
      .rejects.toMatchObject({ code: 'model_budget_below_usage' });
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=false WHERE id=$1', [f.a.organizationId]);
    expect(await api.investigationModels.get(identity, { organizationId: f.a.organizationId }))
      .toMatchObject({ status: 'disabled', disabledReason: 'consent_required' });
    await expect(api.investigations.request(identity, request)).rejects.toMatchObject({ code: 'investigation_disabled' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => correctionModelFingerprint(tx, f.a.organizationId, true)))
      .rejects.toMatchObject({ code: 'model_consent_required' });
  });
});
