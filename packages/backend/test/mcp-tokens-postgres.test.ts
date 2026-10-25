import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('MCP access tokens with real Postgres roles', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture(); api = createBackend({ database: f.databases.gotchu_api }); });
  afterAll(async () => { await f?.close(); });

  async function customer() {
    const identity = { userId: `mcp:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'MCP' });
    return { identity, organizationId: workspace.id };
  }

  it('authenticates only the exact unrevoked secret, and shows it once', async () => {
    const c = await customer();
    const created = await api.mcpTokens.create(c.identity, { organizationId: c.organizationId, label: 'Claude Code', expiresInDays: 7 });
    expect(created.token).toMatchObject({ label: 'Claude Code', userId: c.identity.userId, state: 'active', lastUsedAt: null });
    expect(created.secret.startsWith(`gmcp.${c.organizationId}.${created.token.id}.`)).toBe(true);
    const stored = await f.admin.query<{ secret_hash: string }>('SELECT secret_hash FROM gotchu.mcp_access_tokens WHERE organization_id=$1 AND id=$2', [c.organizationId, created.token.id]);
    expect(stored.rows[0]?.secret_hash).not.toContain(created.secret.split('.')[3]);
    expect(JSON.stringify(await api.mcpTokens.list(c.identity, { organizationId: c.organizationId }))).not.toContain(created.secret.split('.')[3]);

    await expect(api.mcpTokens.authenticate(created.secret)).resolves.toEqual({ identity: c.identity, organizationId: c.organizationId, tokenId: created.token.id });
    const [listed] = await api.mcpTokens.list(c.identity, { organizationId: c.organizationId });
    expect(listed?.lastUsedAt).not.toBeNull();

    const tampered = `${created.secret.slice(0, -1)}${created.secret.endsWith('A') ? 'B' : 'A'}`;
    await expect(api.mcpTokens.authenticate(tampered)).rejects.toMatchObject({ status: 401 });
    await expect(api.mcpTokens.authenticate('Bearer nonsense')).rejects.toMatchObject({ status: 401 });

    // The same secret under another workspace's id never resolves, even if that workspace exists.
    const other = await customer();
    await expect(api.mcpTokens.authenticate(created.secret.replace(c.organizationId, other.organizationId))).rejects.toMatchObject({ status: 401 });

    await expect(api.mcpTokens.revoke(c.identity, { organizationId: c.organizationId, tokenId: created.token.id })).resolves.toMatchObject({ state: 'revoked' });
    await expect(api.mcpTokens.authenticate(created.secret)).rejects.toMatchObject({ status: 401 });
  });

  it('stops working when the member leaves and stays dead if they are invited back', async () => {
    const c = await customer();
    const viewer = { userId: `viewer:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role,joined_at) VALUES($1,$2,'viewer',clock_timestamp()-interval '1 hour')", [c.organizationId, viewer.userId]);
    const created = await api.mcpTokens.create(viewer, { organizationId: c.organizationId, label: 'Codex' });
    await expect(api.mcpTokens.authenticate(created.secret)).resolves.toMatchObject({ identity: viewer });
    await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [c.organizationId, viewer.userId]);
    await expect(api.mcpTokens.authenticate(created.secret)).rejects.toMatchObject({ status: 401 });
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [c.organizationId, viewer.userId]);
    await expect(api.mcpTokens.authenticate(created.secret)).rejects.toMatchObject({ status: 401 });
  });

  it('lets owners see and revoke every token but keeps members to their own', async () => {
    const c = await customer();
    const operator = { userId: `operator:${randomUUID()}` };
    const outsider = await customer();
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [c.organizationId, operator.userId]);
    const ownerToken = await api.mcpTokens.create(c.identity, { organizationId: c.organizationId, label: 'Owner' });
    const operatorToken = await api.mcpTokens.create(operator, { organizationId: c.organizationId, label: 'Operator' });
    expect((await api.mcpTokens.list(c.identity, { organizationId: c.organizationId })).map(token => token.id).sort()).toEqual([ownerToken.token.id, operatorToken.token.id].sort());
    expect((await api.mcpTokens.list(operator, { organizationId: c.organizationId })).map(token => token.id)).toEqual([operatorToken.token.id]);
    await expect(api.mcpTokens.revoke(operator, { organizationId: c.organizationId, tokenId: ownerToken.token.id })).rejects.toMatchObject({ status: 404 });
    await expect(api.mcpTokens.list(outsider.identity, { organizationId: c.organizationId })).rejects.toMatchObject({ status: 403 });
    await expect(api.mcpTokens.revoke(c.identity, { organizationId: c.organizationId, tokenId: operatorToken.token.id })).resolves.toMatchObject({ state: 'revoked' });
    await expect(api.mcpTokens.create(c.identity, { organizationId: c.organizationId, label: 'Too long', expiresInDays: 91 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('returns active owner tokens before more than 200 inactive tokens', async () => {
    const c = await customer();
    const active = await Promise.all(['Claude', 'Codex', 'IDE'].map(label => api.mcpTokens.create(c.identity, { organizationId: c.organizationId, label })));
    await f.admin.query(`INSERT INTO gotchu.mcp_access_tokens(organization_id,id,user_id,label,secret_hash,created_at,expires_at)
      SELECT $1,gen_random_uuid(),$2,'Expired '||n,repeat('a',64),clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day'
      FROM generate_series(1,220) AS n`, [c.organizationId, c.identity.userId]);

    const listed = await api.mcpTokens.list(c.identity, { organizationId: c.organizationId });
    const activeIds = active.map(item => item.token.id);
    expect(listed).toHaveLength(223);
    expect(listed.slice(0, active.length).map(token => token.id).sort()).toEqual(activeIds.sort());
    expect(listed.slice(0, active.length).every(token => token.state === 'active')).toBe(true);
    expect(listed.slice(active.length).every(token => token.state === 'expired')).toBe(true);
  });
});
