import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, enqueue } from '../src/index.js';
const live = liveUrl ? describe : describe.skip;
live('real Postgres durable model budgets and bounded private checkpoints', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture({ max: 4 }); backend = createBackend({ database: f.databases.gotchu_coordinator }); }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function start(tenant = f.a) {
    const jobId = randomUUID();
    await f.databases.gotchu_coordinator.tenant(tenant.organizationId, tx => enqueue(tx, { organizationId: tenant.organizationId, applicationId: tenant.applicationId, id: jobId, kind: 'investigation', idempotencyKey: jobId }));
    const job = await backend.jobs.claim({ organizationId: tenant.organizationId, jobId });
    const input = { organizationId: tenant.organizationId, applicationId: tenant.applicationId, jobId, leaseToken: present(job).leaseToken };
    const run = await backend.runs.start(input);
    expect(await backend.runs.start(input)).toEqual(run);
    return { ...run, organizationId: tenant.organizationId };
  }
  it('serializes hard spend reservations, rejects replay, and retains uncertainty across restart', async () => {
    const run = await start();
    const ids = [randomUUID(), randomUUID()];
    const attempted = await Promise.allSettled(ids.map(reservationId => backend.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId, maxCostMicros: 600 })));
    expect(attempted.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const used = present(ids[attempted.findIndex(r => r.status === 'fulfilled')]);
    const totals = await f.admin.query('SELECT model_reserved_micros,model_spent_micros FROM gotchu.organizations WHERE id=$1', [run.organizationId]);
    expect(totals.rows[0]).toEqual({ model_reserved_micros: '600', model_spent_micros: '0' });
    expect(await backend.runs.load({ organizationId: run.organizationId, runId: run.runId })).toMatchObject({ modelCalls: 1 });
    const restarted = createBackend({ database: f.databases.gotchu_coordinator });
    await expect(restarted.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId: used, maxCostMicros: 600 })).rejects.toMatchObject({ code: 'reservation_exists' });
    await expect(restarted.runs.finish({ organizationId: run.organizationId, runId: run.runId, outcome: 'succeeded' })).rejects.toMatchObject({ code: 'run_unsettled' });
    await expect(restarted.runs.settleModel({ organizationId: run.organizationId, reservationId: used, actualCostMicros: 601 })).rejects.toMatchObject({ code: 'reservation_overrun' });
    await restarted.runs.settleModel({ organizationId: run.organizationId, reservationId: used, actualCostMicros: 500 });
    await restarted.runs.settleModel({ organizationId: run.organizationId, reservationId: used, actualCostMicros: 500 });
    await expect(restarted.runs.settleModel({ organizationId: run.organizationId, reservationId: used, actualCostMicros: 499 })).rejects.toMatchObject({ code: 'settlement_conflict' });
    await expect(backend.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId: randomUUID(), maxCostMicros: 501 })).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    expect((await f.admin.query('SELECT model_reserved_micros,model_spent_micros FROM gotchu.organizations WHERE id=$1', [run.organizationId])).rows[0]).toEqual({ model_reserved_micros: '0', model_spent_micros: '500' });
  });
  it('enforces four model calls, eight tool calls, and five minutes across durable retries', async () => {
    const run = await start(f.b);
    for (let i = 0; i < 4; i++) {
      const reservationId = randomUUID();
      await backend.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId, maxCostMicros: 100 });
      await backend.runs.settleModel({ organizationId: run.organizationId, reservationId, actualCostMicros: 100 });
    }
    await expect(backend.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId: randomUUID(), maxCostMicros: 1 })).rejects.toMatchObject({ code: 'model_call_limit' });
    for (let i = 0; i < 8; i++) await backend.runs.consumeTool({ organizationId: run.organizationId, runId: run.runId });
    await expect(backend.runs.consumeTool({ organizationId: run.organizationId, runId: run.runId })).rejects.toMatchObject({ code: 'tool_budget_exhausted' });
    const fresh = await start(f.b);
    await f.admin.query("UPDATE gotchu.agent_runs SET deadline=now()-interval '1 second' WHERE id=$1", [fresh.runId]);
    await expect(backend.runs.consumeTool({ organizationId: fresh.organizationId, runId: fresh.runId })).rejects.toMatchObject({ code: 'tool_budget_exhausted' });
    await expect(backend.runs.reserveModel({ organizationId: fresh.organizationId, runId: fresh.runId, reservationId: randomUUID(), maxCostMicros: 1 })).rejects.toMatchObject({ code: 'model_call_limit' });
  });
  it('requires explicit external processing opt-in and isolates/version-fences checkpoints', async () => {
    const run = await start();
    const input = { organizationId: run.organizationId, runId: run.runId, expectedVersion: 0, checkpoint: { node: 'triage', reads: 1 } };
    expect(await backend.runs.checkpoint(input)).toEqual({ version: 1 });
    await expect(backend.runs.checkpoint(input)).rejects.toMatchObject({ code: 'stale_checkpoint' });
    await expect(backend.runs.load({ organizationId: f.b.organizationId, runId: run.runId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.runs.checkpoint({ ...input, expectedVersion: 1, checkpoint: { huge: 'x'.repeat(32_769) } })).rejects.toMatchObject({ code: 'checkpoint_limit' });
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=false WHERE id=$1', [run.organizationId]);
    await expect(backend.runs.reserveModel({ organizationId: run.organizationId, runId: run.runId, reservationId: randomUUID(), maxCostMicros: 1 })).rejects.toMatchObject({ code: 'model_opt_in_required' });
  });
});
