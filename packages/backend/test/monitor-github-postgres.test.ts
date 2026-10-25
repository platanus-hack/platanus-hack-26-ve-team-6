import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('GitHub App repository resolution for scheduled monitors with real PostgreSQL roles', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture();
    api = createBackend({ database: f.databases.gotchu_api });
  });
  afterAll(async () => { await f?.close(); });

  async function connected() {
    const owner = { userId: `monitor-github:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(owner, { name: 'GitHub monitor' });
    const app = await api.customers.createApplication(owner, { organizationId: workspace.id, name: 'Service' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    const installationId = String(Math.floor(Math.random() * 1e12));
    const repositoryKey = `gh-${Math.floor(Math.random() * 1e9)}`;
    // Operator fixture for an OAuth-bound installation; no GitHub request occurs.
    await f.admin.query("INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state) VALUES($1,$2,'octo',$3,'active')", [scope.organizationId, installationId, owner.userId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,write_access,revoked,state,source,installation_id)
      VALUES($1,$2,$3,$4,'main','granted','not_granted',false,'declared','github_app',$5)`, [scope.organizationId, scope.applicationId, randomUUID(), repositoryKey, installationId]);
    await api.operations.configure(owner, { ...scope, enabled: true, intervalSeconds: 3600, sourceSnapshotId: null, targetId: null, repositoryKey, providers: [] });
    return { owner, scope, installationId, repositoryKey };
  }
  function resolve(tenant: string, scope: { organizationId: string; applicationId: string }, repositoryKey: string) {
    return f.databases.gotchu_coordinator.tenant(tenant, async tx => (await tx.query<{ installation_id: string; default_branch: string }>(
      'SELECT installation_id,default_branch FROM gotchu.monitor_github_repository($1,$2,$3)', [scope.organizationId, scope.applicationId, repositoryKey])).rows);
  }

  it('resolves only the enabled monitor repository of the current tenant', async () => {
    const a = await connected(); const b = await connected();
    expect(await resolve(a.scope.organizationId, a.scope, a.repositoryKey)).toEqual([{ installation_id: a.installationId, default_branch: 'main' }]);
    expect(await resolve(b.scope.organizationId, a.scope, a.repositoryKey)).toEqual([]);
    expect(await resolve(a.scope.organizationId, a.scope, b.repositoryKey)).toEqual([]);
    expect(await api.github.listRepositoryLinks(a.owner, a.scope)).toEqual([{ repositoryKey: a.repositoryKey, installationId: a.installationId }]);
    await expect(api.github.listRepositoryLinks(a.owner, b.scope)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.databases.gotchu_coordinator.tenant(a.scope.organizationId, tx => tx.query('SELECT 1 FROM gotchu.github_installations'))).rejects.toThrow(/permission denied/);
  });

  it('stops resolving after the installation is revoked or the monitor is disabled', async () => {
    const revoked = await connected();
    await api.github.revoke(revoked.owner, revoked.scope.organizationId, revoked.installationId);
    expect(await resolve(revoked.scope.organizationId, revoked.scope, revoked.repositoryKey)).toEqual([]);
    expect(await api.github.listRepositoryLinks(revoked.owner, revoked.scope)).toEqual([]);

    const disabled = await connected();
    await api.operations.configure(disabled.owner, { ...disabled.scope, enabled: false, intervalSeconds: 3600, sourceSnapshotId: null, targetId: null, repositoryKey: disabled.repositoryKey, providers: [] });
    expect(await resolve(disabled.scope.organizationId, disabled.scope, disabled.repositoryKey)).toEqual([]);
  });
});
