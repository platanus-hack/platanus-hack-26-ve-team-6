import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, enqueue, modelConfigurationFingerprint } from '../src/index.js';
const live = liveUrl ? describe : describe.skip;
live('real Postgres durable model budgets and bounded private checkpoints', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture({ max: 4 }); backend = createBackend({ database: f.databases.gotchu_coordinator }); }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function start(tenant = f.a) {
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=true,model_token_budget=100000 WHERE id=$1', [tenant.organizationId]);
    await f.admin.query(`INSERT INTO gotchu.investigation_model_settings(organization_id,provider,provider_preset_id,endpoint,model_id,consent_to_external_processing,data_scopes,input_price_micro_usd_per_million_tokens,output_price_micro_usd_per_million_tokens,updated_by)
      VALUES($1,'openai_compatible','custom_openai_compatible','https://models.example/v1','fixture-model',true,'["runtime_summaries"]'::jsonb,0,0,$2)
      ON CONFLICT(organization_id) DO UPDATE SET provider=EXCLUDED.provider,provider_preset_id=EXCLUDED.provider_preset_id,endpoint=EXCLUDED.endpoint,model_id=EXCLUDED.model_id,secret_ref=NULL,
        consent_to_external_processing=true,data_scopes=EXCLUDED.data_scopes,input_price_micro_usd_per_million_tokens=0,output_price_micro_usd_per_million_tokens=0`, [tenant.organizationId, tenant.userId]);
    const jobId = randomUUID();
    await f.databases.gotchu_coordinator.tenant(tenant.organizationId, tx => enqueue(tx, { organizationId: tenant.organizationId, applicationId: tenant.applicationId, id: jobId, kind: 'investigation', idempotencyKey: jobId }));
    const job = await backend.jobs.claim({ organizationId: tenant.organizationId, jobId });
    const input = { organizationId: tenant.organizationId, applicationId: tenant.applicationId, jobId, leaseToken: present(job).leaseToken };
    const run = await backend.runs.start(input);
    expect(await backend.runs.start(input)).toEqual(run);
    return { ...run, organizationId: tenant.organizationId };
  }
  function reservation(run: Awaited<ReturnType<typeof start>>, reservationId: string, maxCostMicros: number) {
    const configuration = { provider: 'openai_compatible' as const, providerPresetId: 'custom_openai_compatible' as const, endpoint: 'https://models.example/v1', modelId: 'fixture-model',
      secretRef: null, consentToExternalProcessing: true, dataScopes: ['runtime_summaries' as const],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0 };
    return { organizationId: run.organizationId, runId: run.runId, reservationId, maxCostMicros, reserveTokens: 1_000,
      requestSha256: 'a'.repeat(64), configSha256: modelConfigurationFingerprint(configuration), provider: configuration.provider, modelId: configuration.modelId };
  }
  it('serializes hard spend reservations, rejects replay, and retains uncertainty across restart', async () => {
    const run = await start();
    const ids = [randomUUID(), randomUUID()];
    const attempted = await Promise.allSettled(ids.map(reservationId => backend.runs.reserveModel(reservation(run, reservationId, 600))));
    expect(attempted.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const used = present(ids[attempted.findIndex(r => r.status === 'fulfilled')]);
    await backend.runs.markModelInFlight({ organizationId: run.organizationId, reservationId: used });
    await backend.runs.markModelUnknown({ organizationId: run.organizationId, reservationId: used });
    expect((await f.admin.query('SELECT state FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2', [run.organizationId, used])).rows[0]?.state).toBe('unknown');
    const totals = await f.admin.query('SELECT model_reserved_micros,model_spent_micros,model_tokens_reserved,model_tokens_spent FROM gotchu.organizations WHERE id=$1', [run.organizationId]);
    expect(totals.rows[0]).toEqual({ model_reserved_micros: '600', model_spent_micros: '0', model_tokens_reserved: '1000', model_tokens_spent: '0' });
    expect(await backend.runs.load({ organizationId: run.organizationId, runId: run.runId })).toMatchObject({ modelCalls: 1 });
    const restarted = createBackend({ database: f.databases.gotchu_coordinator });
    await expect(restarted.runs.reserveModel(reservation(run, used, 600))).rejects.toMatchObject({ code: 'reservation_exists' });
    await expect(restarted.runs.finish({ organizationId: run.organizationId, runId: run.runId, outcome: 'succeeded' })).rejects.toMatchObject({ code: 'run_unsettled' });
    const settlement = { organizationId: run.organizationId, reservationId: used, actualTokens: 10, inputTokens: 5, outputTokens: 5 };
    await expect(restarted.runs.settleModel({ ...settlement, actualCostMicros: 601 })).rejects.toMatchObject({ code: 'reservation_overrun' });
    await restarted.runs.settleModel({ ...settlement, actualCostMicros: 500 });
    await restarted.runs.settleModel({ ...settlement, actualCostMicros: 500 });
    await expect(restarted.runs.settleModel({ ...settlement, actualCostMicros: 499 })).rejects.toMatchObject({ code: 'settlement_conflict' });
    await expect(backend.runs.reserveModel(reservation(run, randomUUID(), 501))).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    expect((await f.admin.query('SELECT model_reserved_micros,model_spent_micros,model_tokens_reserved,model_tokens_spent FROM gotchu.organizations WHERE id=$1', [run.organizationId])).rows[0]).toEqual({ model_reserved_micros: '0', model_spent_micros: '500', model_tokens_reserved: '0', model_tokens_spent: '10' });
  });
  it('enforces four model calls, eight tool calls, and five minutes across durable retries', async () => {
    const run = await start(f.b);
    for (let i = 0; i < 4; i++) {
      const reservationId = randomUUID();
      await backend.runs.reserveModel(reservation(run, reservationId, 100));
      await backend.runs.settleModel({ organizationId: run.organizationId, reservationId, actualCostMicros: 100, actualTokens: 10, inputTokens: 5, outputTokens: 5 });
    }
    await expect(backend.runs.reserveModel(reservation(run, randomUUID(), 1))).rejects.toMatchObject({ code: 'model_call_limit' });
    for (let i = 0; i < 8; i++) await backend.runs.consumeTool({ organizationId: run.organizationId, runId: run.runId });
    await expect(backend.runs.consumeTool({ organizationId: run.organizationId, runId: run.runId })).rejects.toMatchObject({ code: 'tool_budget_exhausted' });
    const fresh = await start(f.b);
    await f.admin.query("UPDATE gotchu.agent_runs SET deadline=now()-interval '1 second' WHERE id=$1", [fresh.runId]);
    await expect(backend.runs.consumeTool({ organizationId: fresh.organizationId, runId: fresh.runId })).rejects.toMatchObject({ code: 'tool_budget_exhausted' });
    await expect(backend.runs.reserveModel(reservation(fresh, randomUUID(), 1))).rejects.toMatchObject({ code: 'model_call_limit' });
  });
  it('requires explicit external processing opt-in and isolates/version-fences checkpoints', async () => {
    const run = await start();
    const input = { organizationId: run.organizationId, runId: run.runId, expectedVersion: 0, checkpoint: { node: 'triage', reads: 1 } };
    expect(await backend.runs.checkpoint(input)).toEqual({ version: 1 });
    await expect(backend.runs.checkpoint(input)).rejects.toMatchObject({ code: 'stale_checkpoint' });
    await expect(backend.runs.load({ organizationId: f.b.organizationId, runId: run.runId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.runs.checkpoint({ ...input, expectedVersion: 1, checkpoint: { huge: 'x'.repeat(32_769) } })).rejects.toMatchObject({ code: 'checkpoint_limit' });
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=false WHERE id=$1', [run.organizationId]);
    await expect(backend.runs.reserveModel(reservation(run, randomUUID(), 1))).rejects.toMatchObject({ code: 'model_opt_in_required' });
  });
});
