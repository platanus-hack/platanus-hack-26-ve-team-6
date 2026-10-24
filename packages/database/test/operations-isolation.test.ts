import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';
const live = liveUrl ? describe : describe.skip;
live('operations SQL privileges and RLS on real PostgreSQL', () => {
 let f: Awaited<ReturnType<typeof fixture>>;
 beforeAll(async () => { f = await fixture(); }); afterAll(async () => { await f?.close(); });
 it('forces tenant isolation and limits discovery/materialization to the coordinator', async () => {
  await f.admin.query("INSERT INTO gotchu.operation_monitors(organization_id,application_id,enabled,interval_seconds,providers,author_id) VALUES($1,$2,true,21600,'[\"cloudflare\"]',$3)", [f.a.organizationId,f.a.applicationId,f.a.userId]);
  for (const role of ['gotchu_api','gotchu_coordinator'] as const) {
   expect((await f.databases[role].tenant(f.b.organizationId, tx => tx.query('SELECT * FROM gotchu.operation_monitors WHERE organization_id=$1', [f.a.organizationId]))).rows).toEqual([]);
   await f.databases[role].tenant(f.b.organizationId, async tx => {
    await tx.query("SELECT set_config('gotchu.operation_discovery','enabled',true)");
    expect((await tx.query('SELECT * FROM gotchu.operation_monitors WHERE organization_id=$1', [f.a.organizationId])).rows).toEqual([]);
   });
  }
  await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.operation_claim_due(1,1000)'))).rejects.toMatchObject({ code:'42501' });
  await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query("SELECT gotchu.operation_materialize($1,$2,gen_random_uuid(),gen_random_uuid(),NULL,NULL)", [f.a.organizationId,f.a.applicationId]))).rejects.toMatchObject({ code:'42501' });
  await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, tx => tx.query("UPDATE gotchu.operation_monitors SET enabled=false"))).rejects.toMatchObject({ code:'42501' });
  const tables = await f.admin.query("SELECT relname,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])", [['operation_monitors','operation_runs','operation_alerts','operation_observations','operation_plans']]);
  expect(tables.rows).toHaveLength(5); expect(tables.rows.every(row => row.relforcerowsecurity)).toBe(true);
 });
});
