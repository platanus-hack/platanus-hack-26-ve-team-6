import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('executor suite verification privileges on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const linkId = randomUUID();
  const suiteId = randomUUID();
  beforeAll(async () => {
    f = await fixture();
    await f.admin.query(`INSERT INTO gotchu.application_repository_links
      (organization_id,application_id,id,repository_key,default_branch,read_access)
      VALUES($1,$2,$3,'suite-read-fixture','main','granted')`, [f.a.organizationId,f.a.applicationId,linkId]);
    await f.admin.query(`INSERT INTO gotchu.validation_suite_definitions
      (organization_id,application_id,repository_link_id,id,version,profile,script_name,suite_name,required_count,created_by)
      VALUES($1,$2,$3,$4,1,'node24-npm-test','test','Fixture suite',1,$5)`, [f.a.organizationId,f.a.applicationId,linkId,suiteId,f.a.userId]);
  });
  afterAll(async () => { await f?.close(); });
  it('reads the selected tenant definition while preserving tenant isolation and write denial', async () => {
    const read = (tenant: string) => f.databases.gotchu_executor.tenant(tenant, tx => tx.query(
      'SELECT id FROM gotchu.validation_suite_definitions WHERE organization_id=$1 AND id=$2', [f.a.organizationId,suiteId]));
    expect((await read(f.a.organizationId)).rows).toEqual([{ id: suiteId }]);
    expect((await read(f.b.organizationId)).rows).toEqual([]);
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => tx.query(
      'UPDATE gotchu.validation_suite_definitions SET suite_name=$3 WHERE organization_id=$1 AND id=$2', [f.a.organizationId,suiteId,'Forbidden change'])))
      .rejects.toMatchObject({ code: '42501' });
  });
});
