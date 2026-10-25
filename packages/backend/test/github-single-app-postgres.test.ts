import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../src/core.js';
import { createGitHubConnectionService, loadSingleAppInstallation, loadSingleAppRepository } from '../src/github-connections.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
const appId = '12345';
const discovery = '00000000-0000-0000-0000-000000000000';

// Persistence/authorization sources only: no provider requests or customer execution.
live('single-App GitHub authority on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createGitHubConnectionService>;
  let executor: ReturnType<typeof createGitHubConnectionService>;
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    api = createGitHubConnectionService({ database: f.databases.gotchu_api });
    executor = createGitHubConnectionService({ database: f.databases.gotchu_executor });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  const actor = () => ({ userId: f.a.userId });
  const providerId = () => String(Math.floor(Math.random() * 1_000_000_000) + 1);
  const binding = (installationId: string, tenant = f.a) => ({ organizationId: tenant.organizationId, userId: tenant.userId,
    installationId, accountLogin: 'fixture', githubUserId: '99', githubAccountId: '100', state: 's'.repeat(43), appId });
  async function linked() {
    const installationId = providerId();
    const repositoryId = Number(providerId());
    await executor.bindSingleApp(actor(), binding(installationId));
    const link = await api.createRepositoryLink(actor(), { organizationId: f.a.organizationId, applicationId: f.a.applicationId,
      installationId, repositoryId, fullName: 'fixture/repository', defaultBranch: 'main' });
    return { organizationId: f.a.organizationId, applicationId: f.a.applicationId, repositoryLinkId: link.id, installationId, repositoryId };
  }
  async function capture() {
    const link = await linked();
    const sourceSnapshotId = randomUUID();
    const snapshot = { revision: 'a'.repeat(40), files: [{ path: 'src/index.ts', content: `export const fixture = '${sourceSnapshotId}';\n` }] };
    const digest = sha256(canonicalJson(snapshot));
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [link.organizationId, link.applicationId, sourceSnapshotId, digest, JSON.stringify(snapshot), f.a.userId]);
    return { ...link, sourceSnapshotId, appId, commitSha: snapshot.revision, treeSha: 'b'.repeat(40), digest };
  }

  it('binds authorization state to actor and App, hides its verifier from API, and consumes once', async () => {
    const started = await api.createState(actor(), { organizationId: f.a.organizationId, appId });
    await expect(api.consumeState(actor(), started.state)).rejects.toMatchObject({ code: 'github_state_invalid' });
    await expect(api.consumeState(actor(), started.state, appId)).rejects.toMatchObject({ code: 'github_state_invalid' });
    await expect(api.consumeSingleAppState(f.a.userId, started.state, appId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.databases.gotchu_api.tenant(discovery, tx => tx.query('SELECT * FROM gotchu.github_consume_single_app_state($1,$2,$3)',
      [sha256(started.state), f.a.userId, appId]))).rejects.toThrow(/permission denied/);
    await expect(executor.consumeSingleAppState(f.b.userId, started.state, appId)).rejects.toMatchObject({ code: 'github_state_invalid' });
    await expect(executor.consumeSingleAppState(f.a.userId, started.state, '54321')).rejects.toMatchObject({ code: 'github_state_invalid' });
    const race = await Promise.allSettled(Array.from({ length: 4 }, () => executor.consumeSingleAppState(f.a.userId, started.state, appId)));
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find(result => result.status === 'fulfilled')).toMatchObject({ status: 'fulfilled', value: {
      organizationId: f.a.organizationId, purpose: 'authorize', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    } });
    const choice = await api.createState(actor(), { organizationId: f.a.organizationId, purpose: 'choose', appId });
    await expect(api.consumeState(actor(), choice.state, '54321')).rejects.toMatchObject({ code: 'github_state_invalid' });
    await expect(api.consumeState(actor(), choice.state, appId)).resolves.toMatchObject({ purpose: 'choose', verifier: null });
  });

  it('rejects expired state and membership revoked after state creation', async () => {
    const started = await api.createState(actor(), { organizationId: f.a.organizationId, appId });
    // A workspace keeps at least one owner, so a temporary owner allows revoking this one.
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, f.b.userId]);
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    try { await expect(executor.consumeSingleAppState(f.a.userId, started.state, appId)).rejects.toMatchObject({ code: 'github_state_invalid' }); }
    finally {
      await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
      await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, f.b.userId]);
    }
    await f.admin.query("UPDATE gotchu.github_oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [sha256(started.state)]);
    await expect(executor.consumeSingleAppState(f.a.userId, started.state, appId)).rejects.toMatchObject({ code: 'github_state_invalid' });
  });

  it('keeps installation binding executor-only, exclusive, and Owner-only when moved', async () => {
    const installationId = providerId();
    await expect(api.bindSingleApp(actor(), binding(installationId))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_bind_single_app($1,$2,$3,$4,$5)',
      [f.a.organizationId, f.a.userId, installationId, 'fixture', appId]))).rejects.toThrow(/permission denied/);
    await executor.bindSingleApp(actor(), binding(installationId));
    await expect(executor.bindSingleApp({ userId: f.b.userId }, binding(installationId, f.b))).rejects.toMatchObject({ code: 'github_installation_bound' });
    await expect(executor.bindSingleApp(actor(), { ...binding(installationId), appId: '54321' })).rejects.toMatchObject({ code: 'github_reconnection_required' });
    await api.revoke(actor(), f.a.organizationId, installationId);
    const operator = `operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [f.b.organizationId, operator]);
    await expect(executor.bindSingleApp({ userId: operator }, { ...binding(installationId, f.b), userId: operator }))
      .rejects.toMatchObject({ code: 'github_move_owner_required' });
    await expect(executor.bindSingleApp({ userId: f.b.userId }, binding(installationId, f.b))).resolves.toMatchObject({ state: 'active' });
    const legacy = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result',
      [f.b.organizationId, f.b.userId, installationId, 'fixture']));
    expect(legacy.rows).toEqual([{ result: 'reconnection_required' }]);
    await api.revoke({ userId: f.b.userId }, f.b.organizationId, installationId);
    const reconnected = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result',
      [f.b.organizationId, f.b.userId, installationId, 'fixture']));
    expect(reconnected.rows).toEqual([{ result: 'bound' }]);
    expect((await f.admin.query('SELECT connection_mode,app_id FROM gotchu.github_installations WHERE organization_id=$1 AND installation_id=$2',
      [f.b.organizationId, installationId])).rows).toEqual([{ connection_mode: 'legacy', app_id: null }]);
    await expect(executor.bindSingleApp({ userId: f.b.userId }, binding(installationId, f.b)))
      .rejects.toMatchObject({ code: 'github_reconnection_required' });
  });

  it('authorizes LIST before links exist while enforcing active application, tenant and App identity', async () => {
    const installationId = providerId();
    await executor.bindSingleApp(actor(), binding(installationId));
    const scope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId, installationId };
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppInstallation(tx, scope, appId)))
      .resolves.toEqual({ installationId, appId });
    for (const invalid of [{ ...scope, applicationId: f.b.applicationId }, { ...scope, organizationId: f.b.organizationId }]) {
      await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppInstallation(tx, invalid, appId)))
        .rejects.toMatchObject({ code: 'github_connection_unavailable' });
    }
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppInstallation(tx, scope, '54321')))
      .rejects.toMatchObject({ code: 'github_connection_unavailable' });
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]);
    try {
      await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppInstallation(tx, scope, appId)))
        .rejects.toMatchObject({ code: 'github_connection_unavailable' });
    } finally { await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]); }
    const legacyId = providerId();
    await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4)',
      [f.a.organizationId, f.a.userId, legacyId, 'legacy-fixture']));
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppInstallation(tx, { ...scope, installationId: legacyId }, appId)))
      .rejects.toMatchObject({ code: 'github_connection_unavailable' });
  });

  it('binds canonical captured source once and rejects changed provenance or revoked authorization', async () => {
    const captured = await capture();
    await api.importCapturedSource(actor(), captured);
    await api.importCapturedSource(actor(), captured);
    const stored = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(`SELECT repository_link_id,commit_sha,source_digest,app_id,installation_id,repository_id,tree_sha
      FROM gotchu.customer_source_repository_bindings WHERE organization_id=$1 AND application_id=$2 AND source_id=$3`,
    [captured.organizationId, captured.applicationId, captured.sourceSnapshotId]));
    expect(stored.rows).toEqual([{ repository_link_id: captured.repositoryLinkId, commit_sha: captured.commitSha,
      source_digest: captured.digest, app_id: appId, installation_id: captured.installationId, repository_id: String(captured.repositoryId), tree_sha: captured.treeSha }]);
    expect((await f.admin.query('SELECT state,write_access FROM gotchu.application_repository_links WHERE id=$1', [captured.repositoryLinkId])).rows)
      .toEqual([{ state: 'verified', write_access: 'not_granted' }]);
    await expect(api.importCapturedSource(actor(), { ...captured, treeSha: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'github_source_binding_conflict' });
    await expect(api.importCapturedSource(actor(), { ...captured, repositoryId: captured.repositoryId + 1 })).rejects.toMatchObject({ code: 'github_source_scope_mismatch' });
    await expect(api.importCapturedSource({ userId: f.b.userId }, captured)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(executor.importCapturedSource(actor(), captured)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.admin.query('UPDATE gotchu.customer_source_repository_bindings SET tree_sha=$1 WHERE source_id=$2', ['c'.repeat(40), captured.sourceSnapshotId]))
      .rejects.toThrow(/customer_source_repository_binding_immutable/);
    const hidden = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT source_id FROM gotchu.customer_source_repository_bindings WHERE source_id=$1', [captured.sourceSnapshotId]));
    expect(hidden.rows).toEqual([]);
    await api.revoke(actor(), captured.organizationId, captured.installationId);
    await expect(api.importCapturedSource(actor(), captured)).rejects.toMatchObject({ code: 'github_repository_not_authorized' });
  });

  it('rejects stored body tampering and unavailable sources before creating a binding', async () => {
    const captured = await capture();
    await expect(api.importCapturedSource(actor(), { ...captured, commitSha: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'github_source_digest_mismatch' });
    await expect(api.importCapturedSource(actor(), { ...captured, sourceSnapshotId: randomUUID() })).rejects.toMatchObject({ code: 'github_source_digest_mismatch' });
    await f.admin.query("UPDATE gotchu.customer_sources SET body=jsonb_set(body,'{files,0,content}',to_jsonb('tampered'::text)) WHERE id=$1", [captured.sourceSnapshotId]);
    await expect(api.importCapturedSource(actor(), captured)).rejects.toMatchObject({ code: 'github_source_digest_mismatch' });
    expect((await f.admin.query('SELECT source_id FROM gotchu.customer_source_repository_bindings WHERE source_id=$1', [captured.sourceSnapshotId])).rows).toEqual([]);
    const scope = { organizationId: captured.organizationId, applicationId: captured.applicationId, repositoryLinkId: captured.repositoryLinkId };
    await expect(f.databases.gotchu_executor.tenant(f.b.organizationId, tx => loadSingleAppRepository(tx, scope, appId)))
      .rejects.toMatchObject({ code: 'github_repository_not_authorized' });
    await f.admin.query("UPDATE gotchu.application_repository_links SET read_access='revoked' WHERE id=$1", [captured.repositoryLinkId]);
    await expect(f.databases.gotchu_executor.tenant(f.a.organizationId, tx => loadSingleAppRepository(tx, scope, appId)))
      .rejects.toMatchObject({ code: 'github_repository_not_authorized' });
  });
});
