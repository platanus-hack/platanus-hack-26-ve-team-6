import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';
import { createAuthService, type AuthSettings } from '../src/server/auth.js';
import { createCustomerApi } from '../src/server/customer-api.js';
import { createLocalAccounts } from '../src/server/local-accounts.js';

const live = liveUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const password = `Long-passphrase-${randomBytes(16).toString('hex')}`;

live('self-host first Owner bootstrap in Postgres', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let handle: ReturnType<typeof createCustomerApi>;
  let accounts: ReturnType<typeof createLocalAccounts>;

  beforeAll(async () => {
    db = await fixture({ max: 5 });
    accounts = createLocalAccounts(db.databases.gotchu_api);
    const auth = createAuthService({ origin, secret: randomBytes(32).toString('base64url'), localAccounts: accounts } satisfies AuthSettings);
    handle = createCustomerApi({ auth, origin, services: null, localAccounts: accounts, registrationEnabled: false, selfHostSetup: true, providers: [] });
  }, 30_000);

  afterEach(async () => {
    const state = await db.admin.query<{ account_id: string; organization_id: string }>(
      'SELECT account_id,organization_id FROM gotchu.self_host_bootstrap_state WHERE singleton',
    );
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('ALTER TABLE gotchu.memberships DISABLE TRIGGER USER');
      await db.admin.query('DELETE FROM gotchu.self_host_bootstrap_state WHERE singleton');
      for (const row of state.rows) {
        await db.admin.query('DELETE FROM gotchu.audit_records WHERE organization_id=$1', [row.organization_id]);
        await db.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1', [row.organization_id]);
        await db.admin.query('DELETE FROM gotchu.organizations WHERE id=$1', [row.organization_id]);
        await db.admin.query('DELETE FROM gotchu.local_accounts WHERE id=$1', [row.account_id]);
      }
      await db.admin.query('ALTER TABLE gotchu.memberships ENABLE TRIGGER USER');
      await db.admin.query('DELETE FROM gotchu.self_host_setup_tokens');
      await db.admin.query('COMMIT');
    } catch (error) {
      await db.admin.query('ROLLBACK');
      throw error;
    }
  });

  afterAll(async () => { await db?.close(); });

  async function addToken(token: string, expiresAt = new Date(Date.now() + 60_000)) {
    await db.admin.query('INSERT INTO gotchu.self_host_setup_tokens(token_hash,expires_at) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), expiresAt]);
  }
  async function setup(token: string, email: string) {
    return handle(new Request(`${origin}/api/customer/setup`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token, email, password, workspaceName: 'Mi espacio' }),
    }));
  }

  it('creates the first Owner and workspace, consumes the token once, and blocks registration', async () => {
    const token = randomBytes(32).toString('hex'); await addToken(token);
    const response = await setup(token, `owner-${randomUUID()}@example.test`);
    expect(response.status).toBe(201);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('id' in payload) || typeof payload.id !== 'string') throw new Error('Setup response did not contain an account id');
    const membership = await db.admin.query<{ role: string; name: string }>(
      "SELECT m.role,o.name FROM gotchu.memberships m JOIN gotchu.organizations o ON o.id=m.organization_id WHERE m.user_id=$1",
      [`credentials:${payload.id}`],
    );
    expect(membership.rows).toEqual([{ role: 'owner', name: 'Mi espacio' }]);
    expect((await setup(token, `replay-${randomUUID()}@example.test`)).status).toBe(409);
    const setupLink = await db.admin.query<{ issued: boolean }>(
      'SELECT gotchu.self_host_issue_setup_token($1,$2) AS issued',
      [createHash('sha256').update(randomBytes(32)).digest('hex'), new Date(Date.now() + 60_000)],
    );
    expect(setupLink.rows[0]?.issued).toBe(false);
    const register = await handle(new Request(`${origin}/api/customer/register`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `blocked-${randomUUID()}@example.test`, password }),
    }));
    expect(register.status).toBe(403);
  });

  it('rejects expired tokens without creating an account', async () => {
    const token = randomBytes(32).toString('hex'); await addToken(token, new Date(Date.now() - 1000));
    expect((await setup(token, `expired-${randomUUID()}@example.test`)).status).toBe(409);
    expect((await db.admin.query('SELECT token_hash FROM gotchu.self_host_setup_tokens WHERE token_hash=$1 AND consumed_at IS NULL', [createHash('sha256').update(token).digest('hex')])).rowCount).toBe(1);
  });

  it('allows only one concurrent setup request to create the first Owner', async () => {
    const token = randomBytes(32).toString('hex'); await addToken(token);
    const [first, second] = await Promise.all([
      setup(token, `concurrent-a-${randomUUID()}@example.test`),
      setup(token, `concurrent-b-${randomUUID()}@example.test`),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const state = await db.admin.query<{ account_id: string }>('SELECT account_id FROM gotchu.self_host_bootstrap_state WHERE singleton');
    const accountId = state.rows[0]?.account_id;
    if (!accountId) throw new Error('Concurrent setup did not persist bootstrap state');
    const owners = await db.admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM gotchu.memberships WHERE role='owner' AND user_id=$1",
      [`credentials:${accountId}`],
    );
    expect(owners.rows[0]?.count).toBe(1);
  });
});
