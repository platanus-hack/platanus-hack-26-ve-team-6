import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '@gotchu/backend';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';
import { createAuthService, type AuthSettings } from '../src/server/auth.js';
import { createCustomerApi } from '../src/server/customer-api.js';
import { createLocalAccounts } from '../src/server/local-accounts.js';

const live = liveUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const password = `Long-passphrase-${randomBytes(16).toString('hex')}`;
const accountId = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Registration did not return an account id');
  return value.id;
};

live('workspace invitation acceptance over the HTTP handler and Postgres', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let handle: ReturnType<typeof createCustomerApi>;
  let auth: ReturnType<typeof createAuthService>;

  beforeAll(async () => {
    db = await fixture({ max: 6 });
    const accounts = createLocalAccounts(db.databases.gotchu_api);
    auth = createAuthService({ origin, secret: randomBytes(32).toString('base64url'), localAccounts: accounts } satisfies AuthSettings);
    const backend = createBackend({ database: db.databases.gotchu_api });
    handle = createCustomerApi({ auth, origin, services: { ...backend.customers, members: backend.members, job: (identity, value) => backend.web.getJob(identity, value) }, localAccounts: accounts, registrationEnabled: true, providers: [] });
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function register(email: string) {
    const response = await handle(new Request(`${origin}/api/customer/register`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    }));
    expect(response.status).toBe(201);
    return accountId(await response.json());
  }

  async function signIn(email: string) {
    const csrfResponse = await auth.handle(new Request(`${origin}/api/auth/csrf`));
    const csrfPayload: unknown = await csrfResponse.json();
    if (!csrfPayload || typeof csrfPayload !== 'object' || !('csrfToken' in csrfPayload) || typeof csrfPayload.csrfToken !== 'string') throw new Error('Auth.js did not return a CSRF token');
    const csrfCookie = csrfResponse.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    const response = await auth.handle(new Request(`${origin}/api/auth/callback/credentials`, {
      method: 'POST', headers: { cookie: csrfCookie, 'x-auth-return-redirect': '1', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: csrfPayload.csrfToken, email, password, callbackUrl: '/dashboard', json: 'true' }),
    }));
    expect(response.ok).toBe(true);
    const sessionCookie = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).find(cookie => cookie?.startsWith('authjs.session-token='));
    if (!sessionCookie) throw new Error('Auth.js did not issue a session cookie');
    return sessionCookie;
  }

  async function post(path: string, payload: unknown, cookie: string) {
    return handle(new Request(`${origin}${path}`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
  }

  it('accepts an invite only for the registered account email and consumes the token once', async () => {
    const ownerEmail = `owner-${randomUUID()}@example.test`;
    const ownerId = await register(ownerEmail);
    const ownerCookie = await signIn(ownerEmail);
    await db.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [db.a.organizationId, `credentials:${ownerId}`]);

    const invitedEmail = `member-${randomUUID()}@example.test`;
    const invitationResponse = await post(`/api/customer/workspaces/${db.a.organizationId}/invitations`, { email: invitedEmail, role: 'operator' }, ownerCookie);
    expect(invitationResponse.status).toBe(201);
    const invitationPayload: unknown = await invitationResponse.json();
    if (!invitationPayload || typeof invitationPayload !== 'object' || !('token' in invitationPayload) || typeof invitationPayload.token !== 'string') throw new Error('Invitation response did not contain its token');
    const token = invitationPayload.token;

    const wrongEmail = `different-${randomUUID()}@example.test`;
    await register(wrongEmail);
    const wrongCookie = await signIn(wrongEmail);
    expect((await post('/api/customer/invitations/accept', { token }, wrongCookie)).status).toBe(403);

    const memberId = await register(invitedEmail);
    const memberCookie = await signIn(invitedEmail);
    const accepted = await post('/api/customer/invitations/accept', { token }, memberCookie);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ organizationId: db.a.organizationId, role: 'operator' });
    expect((await post('/api/customer/invitations/accept', { token }, memberCookie)).status).toBe(409);
    const member = await db.admin.query('SELECT role,email FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [db.a.organizationId, `credentials:${memberId}`]);
    expect(member.rows[0]).toEqual({ role: 'operator', email: invitedEmail });
  });
});
