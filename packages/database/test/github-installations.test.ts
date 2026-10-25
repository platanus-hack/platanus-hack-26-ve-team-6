import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('GitHub installation authorization on real Postgres', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('stores only hashed OAuth state, binds it to one session and expiry, and consumes it once', async () => {
    const hash = 'a'.repeat(64);
    const verifier = 'v'.repeat(43);
    const create = (userId: string) => f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_create_state($1,$2,$3,$4,$5,$6)', [f.a.organizationId, userId, hash, verifier, '174788349', 'authorize']));
    await create(f.a.userId);
    const foreign = await f.databases.gotchu_api.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.github_consume_state($1,$2)', [hash, f.b.userId]));
    expect(foreign.rows).toEqual([]);
    const consumed = await f.databases.gotchu_api.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.github_consume_state($1,$2)', [hash, f.a.userId]));
    expect(consumed.rows).toEqual([{ organization_id: f.a.organizationId, user_id: f.a.userId, pkce_verifier: verifier, installation_id: '174788349', purpose: 'authorize' }]);
    const replay = await f.databases.gotchu_api.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.github_consume_state($1,$2)', [hash, f.a.userId]));
    expect(replay.rows).toEqual([]);
    const expiredHash = 'b'.repeat(64);
    await createState(expiredHash);
    await f.admin.query("UPDATE gotchu.github_oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [expiredHash]);
    const expired = await f.databases.gotchu_api.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.github_consume_state($1,$2)', [expiredHash, f.a.userId]));
    expect(expired.rows).toEqual([]);
    async function createState(value: string) { await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_create_state($1,$2,$3)', [f.a.organizationId, f.a.userId, value])); }
  });

  it('rejects viewer connects and cross-workspace installation claims, applies RLS, and revokes linked repositories', async () => {
    const viewerId = `github-viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewerId]);
    const viewer = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_create_state($1,$2,$3) AS created', [f.a.organizationId, viewerId, 'c'.repeat(64)]));
    expect(viewer.rows).toEqual([{ created: false }]);

    const installationId = '174788349';
    const bound = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [f.a.organizationId, f.a.userId, installationId, 'acme']));
    expect(bound.rows).toEqual([{ result: 'bound' }]);
    const conflict = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [f.b.organizationId, f.b.userId, installationId, 'acme']));
    expect(conflict.rows).toEqual([{ result: 'already_bound' }]);
    const isolated = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT * FROM gotchu.github_installations WHERE organization_id=$1', [f.a.organizationId]));
    expect(isolated.rows).toEqual([]);

    const linked = await f.databases.gotchu_api.tenant(f.a.organizationId, async tx => {
      const result = await tx.query('SELECT gotchu.github_create_repository_link($1,$2,$3,$4,$5,$6,$7) AS link_id', [f.a.organizationId, f.a.applicationId, f.a.userId, installationId, randomUUID(), 'gh-991', 'main']);
      expect(result.rows[0]?.link_id).toMatch(/^[0-9a-f-]{36}$/);
      return tx.query('SELECT installation_id,revoked FROM gotchu.application_repository_links WHERE organization_id=$1 AND repository_key=$2', [f.a.organizationId, 'gh-991']);
    });
    expect(linked.rows).toEqual([{ installation_id: installationId, revoked: false }]);
    await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.github_revoke_installation($1,$2,$3)', [f.a.organizationId, f.a.userId, installationId]));
    const revoked = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT revoked,read_access,state FROM gotchu.application_repository_links WHERE organization_id=$1 AND repository_key=$2', [f.a.organizationId, 'gh-991']));
    expect(revoked.rows).toEqual([{ revoked: true, read_access: 'revoked', state: 'unknown' }]);
    await f.databases.gotchu_api.tenant(f.a.organizationId, async tx => {
      await tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4)', [f.a.organizationId, f.a.userId, installationId, 'acme']);
      const relinked = await tx.query('SELECT gotchu.github_create_repository_link($1,$2,$3,$4,$5,$6,$7) AS id', [f.a.organizationId, f.a.applicationId, f.a.userId, installationId, randomUUID(), 'gh-991', 'main']);
      expect(relinked.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      const restored = await tx.query('SELECT installation_id,revoked,read_access,write_access FROM gotchu.application_repository_links WHERE organization_id=$1 AND repository_key=$2', [f.a.organizationId, 'gh-991']);
      expect(restored.rows).toEqual([{ installation_id: installationId, revoked: false, read_access: 'granted', write_access: 'not_granted' }]);
      await tx.query('SELECT gotchu.github_revoke_installation($1,$2,$3)', [f.a.organizationId, f.a.userId, installationId]);
    });
    const operatorId = `github-operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [f.b.organizationId, operatorId]);
    const operatorMove = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [f.b.organizationId, operatorId, installationId, 'acme']));
    expect(operatorMove.rows).toEqual([{ result: 'owner_required_to_move' }]);
    const movedAfterOwnerDisconnect = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [f.b.organizationId, f.b.userId, installationId, 'acme']));
    expect(movedAfterOwnerDisconnect.rows).toEqual([{ result: 'bound' }]);
  });
});
