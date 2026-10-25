import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunScope } from '@gotchu/agent';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { migrateGateway } from '../src/migrate.js';
import { recordObservedModelUsage } from '../src/model-usage.js';

// Unrun PostgreSQL regression source. Reservations are seeded; no provider calls or billing are simulated.
const live = liveUrl ? describe : describe.skip;
live('observed model usage', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
    await migrateGateway({ connectionString: present(liveUrl) });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function seed(state: 'reserved' | 'in_flight' | 'unknown' = 'in_flight') {
    const scope: RunScope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, runId: randomUUID() };
    const jobId = randomUUID();
    const reservationId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,payload)
      VALUES ($1,$2,$3,'investigation',$4,'{}'::jsonb)`, [scope.organizationId, scope.applicationId, jobId, jobId]);
    await f.admin.query(`INSERT INTO gotchu.agent_runs
      (organization_id,application_id,id,job_id,state,deadline,model_calls,tokens_reserved,reserved_micros)
      VALUES ($1,$2,$3,$4,'running',clock_timestamp()+interval '5 minutes',1,20000,20)`,
    [scope.organizationId, scope.applicationId, scope.runId, jobId]);
    await f.admin.query(`INSERT INTO gotchu.model_reservations
      (organization_id,id,run_id,amount_micros,reserved_tokens,state) VALUES ($1,$2,$3,20,20000,$4)`,
    [scope.organizationId, reservationId, scope.runId, state]);
    return { scope, reservationId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const overrun = { inputTokens: 25_000, outputTokens: 1_000 };
  const record = (s: Seed, usage = overrun) => f.databases.gotchu_coordinator.tenant(s.scope.organizationId,
    tx => recordObservedModelUsage(tx, s.scope, s.reservationId, usage));
  const observation = async (s: Seed) => present((await f.admin.query(`SELECT observed_input_tokens,
    observed_output_tokens,observed_at FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2`,
  [s.scope.organizationId, s.reservationId])).rows[0]);
  const ledger = async (s: Seed) => (await f.admin.query(`SELECT m.amount_micros,m.reserved_tokens,
    m.charged_micros,m.charged_tokens,m.input_tokens,m.output_tokens,m.settled_at,
    r.tokens_reserved,r.tokens_spent,r.reserved_micros,r.spent_micros,
    o.model_budget_micros,o.model_token_budget,o.model_reserved_micros,o.model_spent_micros,
    o.model_tokens_reserved,o.model_tokens_spent
    FROM gotchu.model_reservations m JOIN gotchu.agent_runs r ON r.organization_id=m.organization_id AND r.id=m.run_id
    JOIN gotchu.organizations o ON o.id=m.organization_id WHERE m.organization_id=$1 AND m.id=$2`,
  [s.scope.organizationId, s.reservationId])).rows;

  it.each(['reserved', 'in_flight', 'unknown'] as const)('retains an overrun in %s without altering the ledger', async state => {
    const s = await seed(state);
    const before = await ledger(s);
    await record(s);
    const saved = await observation(s);
    expect(saved).toMatchObject({ observed_input_tokens: '25000', observed_output_tokens: '1000' });
    expect(saved.observed_at).toBeInstanceOf(Date);
    await f.admin.query("UPDATE gotchu.model_reservations SET state='unknown' WHERE organization_id=$1 AND id=$2",
      [s.scope.organizationId, s.reservationId]);
    await record(s);
    expect(await observation(s)).toEqual(saved);
    expect(await ledger(s)).toEqual(before);
  });

  it('serializes competing observations and rejects overwrites', async () => {
    const s = await seed();
    const outcomes = await Promise.allSettled([record(s), record(s, { inputTokens: 26_000, outputTokens: 1_000 })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const saved = await observation(s);
    await expect(record(s, { inputTokens: 0, outputTokens: 0 })).rejects.toMatchObject({ code: 'model_usage_reservation_conflict' });
    await expect(f.admin.query(`UPDATE gotchu.model_reservations SET observed_input_tokens=0,
      observed_output_tokens=0 WHERE organization_id=$1 AND id=$2`, [s.scope.organizationId, s.reservationId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(f.admin.query(`UPDATE gotchu.model_reservations SET observed_input_tokens=NULL,
      observed_output_tokens=NULL,observed_at=NULL WHERE organization_id=$1 AND id=$2`, [s.scope.organizationId, s.reservationId]))
      .rejects.toMatchObject({ code: '23514' });
    expect(await observation(s)).toEqual(saved);
  });

  it('requires the exact reservation, run, application, organization, and tenant', async () => {
    const s = await seed();
    const other = await seed();
    for (const wrong of [
      { ...s, reservationId: other.reservationId },
      { ...s, scope: { ...s.scope, runId: other.scope.runId } },
      { ...s, scope: { ...s.scope, applicationId: f.b.applicationId } },
      { ...s, scope: { ...s.scope, organizationId: f.b.organizationId } },
    ]) await expect(record(wrong)).rejects.toMatchObject({ code: 'model_usage_reservation_conflict' });
    await expect(f.databases.gotchu_coordinator.tenant(f.b.organizationId,
      tx => recordObservedModelUsage(tx, s.scope, s.reservationId, overrun)))
      .rejects.toMatchObject({ code: 'model_usage_reservation_conflict' });
    await expect(f.databases.gotchu_api.tenant(s.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.model_reservations SET observed_input_tokens=0,observed_output_tokens=0,observed_at=clock_timestamp() WHERE id=$1',
      [s.reservationId]))).rejects.toMatchObject({ code: '42501' });
    expect((await observation(s)).observed_at).toBeNull();
  });

  it('only accepts matching existing observations after settlement', async () => {
    const usage = { inputTokens: 900, outputTokens: 100 };
    for (const observed of [true, false]) {
      const s = await seed();
      if (observed) await record(s, usage);
      await f.admin.query(`UPDATE gotchu.model_reservations SET state='settled',charged_tokens=1000,
        charged_micros=1,input_tokens=900,output_tokens=100,settled_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2`, [s.scope.organizationId, s.reservationId]);
      const saved = await observation(s);
      if (observed) await record(s, usage);
      else await expect(record(s, usage)).rejects.toMatchObject({ code: 'model_usage_reservation_conflict' });
      await expect(record(s)).rejects.toMatchObject({ code: 'model_usage_reservation_conflict' });
      expect(await observation(s)).toEqual(saved);
    }
  });

  it('rejects invalid counts and incomplete database observations, and accepts boundary counts', async () => {
    const s = await seed();
    for (const tokens of [-1, 0.5, NaN, Infinity, -Infinity, 1_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(record(s, { inputTokens: tokens, outputTokens: 0 })).rejects.toMatchObject({ code: 'invalid_model_usage' });
      await expect(record(s, { inputTokens: 0, outputTokens: tokens })).rejects.toMatchObject({ code: 'invalid_model_usage' });
    }
    await expect(f.admin.query('UPDATE gotchu.model_reservations SET observed_input_tokens=1 WHERE id=$1', [s.reservationId]))
      .rejects.toMatchObject({ code: '23514' });
    for (const tokens of [-1, 1_000_000_001]) await expect(f.admin.query(`UPDATE gotchu.model_reservations
      SET observed_input_tokens=$2,observed_output_tokens=$2,observed_at=clock_timestamp() WHERE id=$1`, [s.reservationId, tokens]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await observation(s)).observed_at).toBeNull();
    await record(s, { inputTokens: 0, outputTokens: 1_000_000_000 });
    expect(await observation(s)).toMatchObject({ observed_input_tokens: '0', observed_output_tokens: '1000000000' });
  });
});
