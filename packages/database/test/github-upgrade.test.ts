import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { grantGitHubWriteFixture } from './github-fixtures.js';
import { liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('populated GitHub authorization upgrade', () => {
  it('invalidates both tenants under the real migration owner and forced RLS', async () => {
    if (!liveUrl) throw new Error('Live database required');
    const name = `gotchu_test_upgrade_${randomUUID().replaceAll('-', '')}`;
    const operator = new pg.Client({ connectionString: liveUrl });
    const url = new URL(liveUrl); url.pathname = `/${name}`;
    const admin = new pg.Client({ connectionString: url.toString() });
    await operator.connect();
    try {
      await operator.query(`CREATE DATABASE ${name}`);
      // Bootstrap the same roles as production, then reconstruct the actual pre-050 schema.
      await migrate({ connectionString: url.toString() });
      await admin.connect();
      await admin.query('DROP SCHEMA gotchu CASCADE');
      await admin.query('CREATE SCHEMA gotchu AUTHORIZATION gotchu_owner');
      const directory = new URL('../migrations/', import.meta.url);
      const files = (await readdir(directory)).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
      async function apply(filesToApply: string[]) {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE gotchu_owner');
          expect((await admin.query('SELECT current_user')).rows).toEqual([{ current_user: 'gotchu_owner' }]);
          for (const file of filesToApply) await admin.query(await readFile(new URL(file, directory), 'utf8'));
          await admin.query('COMMIT');
        } catch (error) { await admin.query('ROLLBACK'); throw error; }
      }
      await apply(files.filter(file => file < '050_'));
      const tenants = [];
      for (const installationId of ['111', '222']) {
        const tenant = { organizationId: randomUUID(), applicationId: randomUUID(), userId: `github:${randomUUID()}` };
        const linkId = randomUUID();
        await admin.query("INSERT INTO gotchu.organizations(id,name) VALUES($1,'Upgrade')", [tenant.organizationId]);
        await admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [tenant.organizationId, tenant.userId]);
        await admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Upgrade')", [tenant.organizationId, tenant.applicationId]);
        await admin.query("INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state) VALUES($1,$2,'fixture',$3,'active')", [tenant.organizationId, installationId, tenant.userId]);
        await admin.query("INSERT INTO gotchu.github_oauth_states(organization_id,state_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [tenant.organizationId, installationId.padStart(64, 'a'), tenant.userId]);
        await admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,source,installation_id,read_access)
          VALUES($1,$2,$3,$4,'main','github_app',$5,'granted')`, [tenant.organizationId, tenant.applicationId, linkId, `gh-${installationId}`, installationId]);
        const proposalId = await grantGitHubWriteFixture(admin, tenant, linkId);
        tenants.push({ ...tenant, installationId, linkId, proposalId });
      }
      expect((await admin.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='gotchu.application_repository_links'::regclass")).rows).toEqual([{ relforcerowsecurity: true }]);
      await apply(['050_github_owner_authorization.sql']);
      expect((await admin.query('SELECT count(*)::int AS count FROM gotchu.github_oauth_states')).rows).toEqual([{ count: 0 }]);
      for (const tenant of tenants) {
        expect((await admin.query('SELECT state FROM gotchu.github_installations WHERE installation_id=$1', [tenant.installationId])).rows).toEqual([{ state: 'revoked' }]);
        expect((await admin.query('SELECT revoked,installation_id,write_access,writer_installation_id,writer_verified_at,writer_verified_commit FROM gotchu.application_repository_links WHERE id=$1', [tenant.linkId])).rows)
          .toEqual([{ revoked: true, installation_id: null, write_access: 'not_granted', writer_installation_id: null, writer_verified_at: null, writer_verified_commit: null }]);
        expect((await admin.query('SELECT state,invalidation_reason FROM gotchu.proposals WHERE id=$1', [tenant.proposalId])).rows)
          .toEqual([{ state: 'invalidated', invalidation_reason: 'github_reauthorization_required' }]);
        expect((await admin.query('SELECT consumed_at IS NOT NULL AS consumed FROM gotchu.approvals WHERE proposal_id=$1', [tenant.proposalId])).rows).toEqual([{ consumed: true }]);
        expect((await admin.query("SELECT count(*)::int AS count FROM gotchu.audit_records WHERE organization_id=$1 AND action='github.reauthorization_required'", [tenant.organizationId])).rows).toEqual([{ count: 1 }]);
      }
    } finally {
      await admin.end();
      await operator.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await operator.end();
    }
  }, 30_000);
});
