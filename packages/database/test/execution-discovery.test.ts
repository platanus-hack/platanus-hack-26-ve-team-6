import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
const systemTenant = '00000000-0000-0000-0000-000000000000';

live('pending execution discovery on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function discover() {
    return f.databases.gotchu_coordinator.tenant(systemTenant, tx =>
      tx.query<{ organization_id: string }>('SELECT * FROM gotchu.customer_pending_organizations(500)'));
  }

  it('keeps an execution-only organization discoverable until its pending work finishes', async () => {
    const jobId = randomUUID();
    // Discovery reads the envelope kind; approval authorization remains the executor's responsibility.
    await f.admin.query(`INSERT INTO gotchu.jobs
      (organization_id, application_id, id, kind, idempotency_key, payload, state)
      VALUES ($1,$2,$3,'audit',$3::text,'{"version":2}','succeeded'),
             ($1,$2,$4,'execution',$4::text,'{}','queued')`,
    [f.a.organizationId, f.a.applicationId, randomUUID(), jobId]);

    for (const state of ['queued', 'running']) {
      await f.admin.query('UPDATE gotchu.jobs SET state=$3 WHERE organization_id=$1 AND id=$2',
        [f.a.organizationId, jobId, state]);
      expect((await discover()).rows).toContainEqual({ organization_id: f.a.organizationId });
    }
    for (const state of ['succeeded', 'failed']) {
      await f.admin.query('UPDATE gotchu.jobs SET state=$3 WHERE organization_id=$1 AND id=$2',
        [f.a.organizationId, jobId, state]);
      expect((await discover()).rows).not.toContainEqual({ organization_id: f.a.organizationId });
    }
  });

  it('preserves the system-tenant guard, bounded limits, and coordinator-only access', async () => {
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx =>
      tx.query('SELECT * FROM gotchu.customer_pending_organizations(100)')))
      .rejects.toThrow('invalid_customer_discovery');
    for (const limit of [null, 0, -1, 501]) {
      await expect(f.databases.gotchu_coordinator.tenant(systemTenant, tx =>
        tx.query('SELECT * FROM gotchu.customer_pending_organizations($1)', [limit])))
        .rejects.toThrow('invalid_customer_discovery');
    }
    for (const role of ['gotchu_api', 'gotchu_ingest', 'gotchu_executor', 'gotchu_validator'] as const) {
      await expect(f.databases[role].tenant(systemTenant, tx =>
        tx.query('SELECT * FROM gotchu.customer_pending_organizations(100)')))
        .rejects.toMatchObject({ code: '42501' });
    }
  });

  it('retains forced RLS and does not expose customer jobs through discovery settings', async () => {
    const jobId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.jobs
      (organization_id, application_id, id, kind, idempotency_key)
      VALUES ($1,$2,$3,'execution',$3::text)`, [f.b.organizationId, f.b.applicationId, jobId]);
    await f.databases.gotchu_coordinator.tenant(systemTenant, async tx => {
      expect((await tx.query('SELECT * FROM gotchu.customer_pending_organizations(500)')).rows)
        .toContainEqual({ organization_id: f.b.organizationId });
      expect((await tx.query(`SELECT current_setting('gotchu.pending_discovery',true) AS pending,
        current_setting('gotchu.operation_discovery',true) AS operation`)).rows)
        .toEqual([{ pending: '', operation: '' }]);
      await tx.query("SELECT set_config('gotchu.pending_discovery','enabled',true)");
      expect((await tx.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1', [f.b.organizationId])).rows)
        .toEqual([]);
      expect((await tx.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1 RETURNING id",
        [f.b.organizationId])).rows).toEqual([]);
    });
    expect((await f.admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid='gotchu.jobs'::regclass`)).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect((await f.admin.query(`SELECT cmd, roles FROM pg_policies
      WHERE schemaname='gotchu' AND tablename='jobs' AND policyname='customer_pending_discovery'`)).rows)
      .toEqual([{ cmd: 'SELECT', roles: ['gotchu_owner'] }]);
  });
});
