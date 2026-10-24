import { randomUUID } from 'node:crypto';
import { encode } from '@auth/core/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalAccounts } from '../../apps/web/src/server/local-accounts.js';
import { authSettings, createAuthService } from '../../apps/web/src/server/auth.js';
import { fixture, liveUrl } from '../../packages/database/test/support.js';

const live = liveUrl ? describe : describe.skip;
const password = 'fixture-only long passphrase 2026';
live('persisted local accounts and actual Auth.js sessions', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let accounts: ReturnType<typeof createLocalAccounts>;
  beforeAll(async () => { f = await fixture(); accounts = createLocalAccounts(f.databases.gotchu_api); });
  afterAll(async () => { await f?.close(); });
  const email = () => `local-${randomUUID()}@example.com`;
  it('persists a salted scrypt hash while denying raw table access to every runtime role', async () => {
    const address = email();
    const account = await accounts.register({ email: address.toUpperCase(), password });
    const stored = await f.admin.query<{ password_hash: string }>('SELECT password_hash FROM gotchu.local_accounts WHERE id=$1', [account.id]);
    expect(stored.rows[0]?.password_hash).toMatch(/^scrypt-v1\$32768\$8\$3\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(password);
    for (const database of Object.values(f.databases)) {
      await expect(database.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.local_accounts'))).rejects.toThrow();
    }
    for (const role of ['gotchu_ingest', 'gotchu_coordinator', 'gotchu_executor'] as const) {
      await expect(f.databases[role].tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.auth_lookup($1)', [address]))).rejects.toThrow();
    }
    expect(await accounts.authenticate({ email: address, password })).toMatchObject({ id: account.id, credentialEpoch: 1 });
    expect(await accounts.authenticate({ email: address, password: 'incorrect' })).toBeNull();
    expect(await accounts.authenticate({ email: email(), password })).toBeNull();
  });
  it('keeps admission state across service recreation and rejects concurrent email duplicates', async () => {
    const address = email();
    const results = await Promise.allSettled([accounts.register({ email: address, password }), accounts.register({ email: address.toUpperCase(), password })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (let attempt = 0; attempt < 5; attempt++) expect(await accounts.authenticate({ email: address, password: 'wrong' })).toBeNull();
    await expect(createLocalAccounts(f.databases.gotchu_api).authenticate({ email: address, password })).rejects.toMatchObject({ status: 429 });
  });
  it('runs an actual CSRF-protected credentials callback and invalidates encrypted sessions on epoch change', async () => {
    const address = email();
    const account = await accounts.register({ email: address, password });
    const origin = 'http://localhost:3000';
    const secret = 'local-account-fixture-secret-not-production'.repeat(2);
    const settings = authSettings({ AUTH_SECRET: secret, PUBLIC_APP_URL: origin }, accounts);
    const auth = createAuthService(settings);
    const csrf = await auth.handle(new Request(`${origin}/api/auth/csrf`));
    const csrfBody: unknown = await csrf.json();
    if (!csrfBody || typeof csrfBody !== 'object' || !('csrfToken' in csrfBody) || typeof csrfBody.csrfToken !== 'string') throw new Error('Missing CSRF token');
    const cookies = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const signedIn = await auth.handle(new Request(`${origin}/api/auth/callback/credentials`, {
      method: 'POST', headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
      body: new URLSearchParams({ csrfToken: csrfBody.csrfToken, email: address, password, callbackUrl: `${origin}/dashboard` }),
    }));
    expect(signedIn.status).toBe(200);
    const sessionCookies = signedIn.headers.getSetCookie().filter(value => value.includes('authjs.session-token=')).map(value => value.split(';')[0]).join('; ');
    expect(sessionCookies).not.toBe('');
    const request = new Request(`${origin}/api/customer/session`, { headers: { cookie: sessionCookies } });
    expect((await auth.identity(request))?.userId).toBe(`credentials:${account.id}`);
    await f.admin.query('UPDATE gotchu.local_accounts SET epoch=epoch+1 WHERE id=$1', [account.id]);
    expect(await auth.identity(request)).toBeNull();
    const oldToken = await encode({ secret, salt: 'authjs.session-token', token: { sub: `credentials:${account.id}`, credentialEpoch: 2 } });
    await f.admin.query('UPDATE gotchu.local_accounts SET disabled=true WHERE id=$1', [account.id]);
    expect(await auth.identity(new Request(`${origin}/api/customer/session`, { headers: { cookie: `authjs.session-token=${oldToken}` } }))).toBeNull();
  });
  it('rejects weak or malformed credentials without creating accounts', async () => {
    await expect(accounts.register({ email: email(), password: 'short' })).rejects.toThrow();
    expect(await accounts.authenticate({ email: email(), password: 'a'.repeat(129) })).toBeNull();
  });
});
