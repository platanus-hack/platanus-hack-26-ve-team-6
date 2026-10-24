import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMER_MAX_SOURCE_BYTES, CUSTOMER_MAX_SOURCE_FILES, CUSTOMER_MAX_SOURCE_FILE_BYTES } from '../../contracts/src/customer-assessment.js';
import { fixture, liveUrl, present } from './support.js';

const live = liveUrl ? describe : describe.skip;
const zero = '00000000-0000-0000-0000-000000000000';
live('customer schema privilege and RLS boundaries on real Postgres', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });
  it('keeps forced RLS on all customer tables and isolates sources/targets', async () => {
    const sourceId = randomUUID(); const targetId = randomUUID();
    await f.admin.query("INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [f.a.organizationId, f.a.applicationId, sourceId, 'a'.repeat(64), JSON.stringify({ revision: 'r', files: [{ path: 'a.ts', content: '' }] }), f.a.userId]);
    await f.admin.query("INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,challenge_hash,challenge_expires_at) VALUES ($1,$2,$3,'https://acme.com',1,'pending',$4,$5,now()+interval '30 minutes')", [f.a.organizationId, f.a.applicationId, targetId, f.a.userId, 'b'.repeat(64)]);
    for (const role of ['gotchu_api', 'gotchu_coordinator'] as const) {
      for (const table of ['customer_sources', 'customer_targets', 'customer_requests', 'customer_reports'] as const) {
        const rows = await f.databases[role].tenant(f.b.organizationId, tx => tx.query(`SELECT * FROM gotchu.${table} WHERE organization_id=$1`, [f.a.organizationId]));
        expect(rows.rows).toEqual([]);
      }
    }
    const policies = await f.admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='gotchu'::regnamespace AND relname IN ('customer_sources','customer_targets','customer_requests','customer_reports')");
    expect(policies.rows).toHaveLength(4); expect(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    await expect(f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query("INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [f.b.organizationId, f.a.applicationId, randomUUID(), 'a'.repeat(64), JSON.stringify({ revision: 'r', files: [{ path: 'a.ts', content: '' }] }), f.b.userId]))).rejects.toMatchObject({ code: '23503' });
  });
  it('permits discovery/bootstrap only through narrow API functions and never leaks a discovery setting into general reads', async () => {
    const identity = `credentials:${randomUUID()}`;
    const workspace = await f.databases.gotchu_api.tenant(zero, async tx => {
      const result = await tx.query<{ workspace: { id: string } }>("SELECT gotchu.customer_create_workspace($1,'Customer workspace') AS workspace", [identity]);
      const id = present(result.rows[0]).workspace.id;
      expect((await tx.query('SELECT * FROM gotchu.organizations WHERE id=$1', [id])).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM gotchu.memberships WHERE organization_id=$1', [id])).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM gotchu.customer_workspaces($1)', [identity])).rows).toHaveLength(1);
      await tx.query("SELECT set_config('gotchu.discovery_user',$1,true)", [identity]);
      // A runtime role cannot gain the definer-only SELECT policy by forging settings.
      expect((await tx.query('SELECT * FROM gotchu.memberships WHERE organization_id=$1', [id])).rows).toEqual([]);
      expect((await tx.query('SELECT * FROM gotchu.organizations WHERE id=$1', [id])).rows).toEqual([]);
      return id;
    });
    expect((await f.admin.query('SELECT role FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [workspace, identity])).rows).toEqual([{ role: 'owner' }]);
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.customer_workspaces($1)', [identity]))).rejects.toThrow('invalid_customer_identity');
    for (const role of ['gotchu_coordinator', 'gotchu_ingest', 'gotchu_executor'] as const) {
      await expect(f.databases[role].tenant(zero, tx => tx.query('SELECT * FROM gotchu.customer_workspaces($1)', [identity]))).rejects.toMatchObject({ code: '42501' });
      await expect(f.databases[role].tenant(zero, tx => tx.query("SELECT gotchu.customer_create_workspace($1,'Forbidden')", [identity]))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(f.databases.gotchu_api.tenant(zero, tx => tx.query("SELECT gotchu.customer_create_workspace('demo:controlled-assessment','Forbidden')"))).rejects.toThrow('invalid_customer_identity');
  });
  it('enforces the exported customer source storage bounds in SQL', async () => {
    async function insert(files: { path: string; content: string }[]) {
      return f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [f.a.organizationId, f.a.applicationId, randomUUID(), randomUUID().replaceAll('-', '').repeat(2), JSON.stringify({ revision: 'limits', files }), f.a.userId]));
    }
    await expect(insert([{ path: 'lock.json', content: 'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES) }])).resolves.toHaveProperty('rowCount', 1);
    await expect(insert([{ path: 'lock.json', content: 'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES + 1) }])).rejects.toMatchObject({ code: '23514' });
    await expect(insert(Array.from({ length: CUSTOMER_MAX_SOURCE_FILES + 1 }, (_, i) => ({ path: `${i}.ts`, content: '' })))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(Array.from({ length: CUSTOMER_MAX_SOURCE_BYTES / CUSTOMER_MAX_SOURCE_FILE_BYTES }, (_, i) => ({ path: `${i}.ts`, content: 'x'.repeat(CUSTOMER_MAX_SOURCE_FILE_BYTES) })))).rejects.toMatchObject({ code: '23514' });
  });

  it('retains immutable source/request/report writes and separate API/coordinator privileges', async () => {
    for (const table of ['customer_sources', 'customer_requests', 'customer_reports'] as const) {
      for (const role of ['gotchu_api', 'gotchu_coordinator'] as const) {
        await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query(`DELETE FROM gotchu.${table} WHERE organization_id=$1`, [f.a.organizationId]))).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('INSERT INTO gotchu.customer_reports DEFAULT VALUES'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query('INSERT INTO gotchu.customer_sources DEFAULT VALUES'))).rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query("UPDATE gotchu.customer_targets SET status='verified' WHERE organization_id=$1", [f.a.organizationId]))).rejects.toMatchObject({ code: '42501' });
    expect((await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.lock_customer_organization($1) AS locked', [f.b.organizationId]))).rows).toEqual([{ locked: false }]);
  });
});

live('application context RLS', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });
  it('forces tenant RLS across every context inventory table', async () => {
    const tables = ['application_environments', 'application_services', 'application_repository_links', 'application_deployments', 'application_dependencies', 'application_origin_candidates'] as const;
    for (const table of tables) {
      const rows = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query(`SELECT * FROM gotchu.${table} WHERE organization_id=$1`, [f.a.organizationId]));
      expect(rows.rows).toEqual([]);
    }
    const policies = await f.admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='gotchu'::regnamespace AND relname=ANY($1::text[])", [tables]);
    expect(policies.rows).toHaveLength(tables.length);
    expect(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
