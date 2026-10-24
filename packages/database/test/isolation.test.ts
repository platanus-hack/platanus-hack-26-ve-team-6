import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/index.js';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('real Postgres tenant and role isolation (GOTCHU_TEST_DATABASE_URL)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });
  it('uses non-owner roles and FORCE RLS on all tenant tables', async () => {
    const tables = await f.admin.query("SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'gotchu'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'");
    expect(tables.rows.length).toBeGreaterThan(15);
    for (const row of tables.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: 'gotchu_owner' });
    const roles = await f.admin.query("SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('gotchu_api','gotchu_ingest','gotchu_coordinator','gotchu_executor')");
    for (const row of roles.rows) expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });
  it('rejects privileged runtime connections even if SET ROLE could hide privilege', async () => {
    const unsafe = createDatabase({ connectionString: liveUrl!, role: 'gotchu_api' });
    await expect(unsafe.tenant(f.a.organizationId, async tx => tx.query('SELECT 1'))).rejects.toThrow('non-owner');
    await unsafe.close();
  });
  it('isolates reads, writes, and tenant-aware foreign keys', async () => {
    const db = f.databases.gotchu_api;
    const rows = await db.tenant(f.a.organizationId, tx => tx.query('SELECT id FROM gotchu.applications'));
    expect(rows.rows).toEqual([{ id: f.a.applicationId }]);
    await expect(db.tenant(f.a.organizationId, tx => tx.query("INSERT INTO gotchu.jobs(organization_id, application_id, id, kind, idempotency_key) VALUES ($1,$2,$3,'audit','wrong-tenant')", [f.b.organizationId, f.b.applicationId, randomUUID()]))).rejects.toMatchObject({ code: '42501' });
    await expect(db.tenant(f.a.organizationId, tx => tx.query("INSERT INTO gotchu.jobs(organization_id, application_id, id, kind, idempotency_key) VALUES ($1,$2,$3,'audit','wrong-fk')", [f.a.organizationId, f.b.applicationId, randomUUID()]))).rejects.toMatchObject({ code: '23503' });
  });
  it('clears tenant context on the same pooled connection after commit and rollback', async () => {
    const db = f.databases.gotchu_api;
    const first = await db.tenant(f.a.organizationId, tx => tx.query('SELECT pg_backend_pid() AS pid'));
    await expect(db.tenant(f.a.organizationId, async tx => { await tx.query("SELECT set_config('gotchu.integration_id', $1, false)", [f.a.integrationId]); throw new Error('rollback'); })).rejects.toThrow('rollback');
    const second = await db.tenant(f.b.organizationId, tx => tx.query("SELECT pg_backend_pid() AS pid, gotchu.tenant_id() AS tenant, gotchu.integration_id() AS integration, (SELECT count(*)::int FROM gotchu.applications) AS count"));
    expect(second.rows[0]).toEqual({ pid: first.rows[0]?.pid, tenant: f.b.organizationId, integration: null, count: 1 });
    await db.tenant(f.b.organizationId, async tx => {
      await tx.query("SELECT set_config('gotchu.organization_id', '', true)");
      expect((await tx.query('SELECT * FROM gotchu.applications')).rows).toEqual([]);
    });
  });
  it('keeps credentials, approvals, and private checkpoints out of worker/customer permissions', async () => {
    for (const role of ['gotchu_api', 'gotchu_coordinator', 'gotchu_executor'] as const) {
      await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.integration_credentials'))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.agent_runs'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.approvals'))).rejects.toMatchObject({ code: '42501' });
  });
  it('allows intake lookup only for its transaction-scoped integration', async () => {
    const rows = await f.databases.gotchu_ingest.integration(f.a.integrationId, tx => tx.query('SELECT id FROM gotchu.integrations'));
    expect(rows.rows).toEqual([{ id: f.a.integrationId }]);
    const credentials = await f.databases.gotchu_ingest.integration(f.b.integrationId, tx => tx.query('SELECT integration_id FROM gotchu.integration_credentials'));
    expect(credentials.rows).toEqual([{ integration_id: f.b.integrationId }]);
  });
});
