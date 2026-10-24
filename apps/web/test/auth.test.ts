import { encode } from '@auth/core/jwt';
import { describe, expect, it } from 'vitest';
import { authSettings, createAuthService, type AuthSettings } from '../src/server/auth.js';

const settings: AuthSettings = {
  origin: 'http://localhost:3000',
  secret: 'test-only-secret-never-use-in-production-000000',
  githubClientId: 'test-client',
  githubClientSecret: 'test-only-client-secret',
};
const service = createAuthService(settings);
const cookieName = 'authjs.session-token';

async function sessionCookie(secret = settings.secret) {
  const token = await encode({ secret, salt: cookieName, token: { sub: 'github:42', name: 'Test operator' } });
  return `${cookieName}=${token}`;
}

describe('Auth.js Request/Response integration', () => {
  it('reads a real Auth.js encrypted session and propagates refreshed cookies', async () => {
    const identity = await service.identity(new Request(`${settings.origin}/api/v1/applications`, { headers: { cookie: await sessionCookie() } }));
    expect(identity?.userId).toBe('github:42');
    expect(identity?.cookies.some((cookie) => cookie.startsWith(`${cookieName}=`))).toBe(true);
  });

  it('does not accept unsigned identity headers or cookies encrypted with another key', async () => {
    const fake = await service.identity(new Request(`${settings.origin}/api/v1/applications`, { headers: { 'x-user-id': 'github:42', 'x-organization-id': 'another-tenant' } }));
    expect(fake).toBeNull();
    const forged = await service.identity(new Request(`${settings.origin}/api/v1/applications`, { headers: { cookie: await sessionCookie('attacker-controlled-key-000000000000000000') } }));
    expect(forged).toBeNull();
  });

  it('rejects an unconfigured host before trusting Auth.js and strips forwarded-host overrides', async () => {
    await expect(service.handle(new Request('https://attacker.example/api/auth/csrf'))).rejects.toMatchObject({ code: 'untrusted_host' });
    const response = await service.handle(new Request(`${settings.origin}/api/auth/csrf`, { headers: { 'x-forwarded-host': 'attacker.example' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).not.toContain('attacker.example');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('retains Auth.js CSRF protection for sign-out', async () => {
    const response = await service.handle(new Request(`${settings.origin}/api/auth/signout`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: await sessionCookie() }, body: 'callbackUrl=%2F',
    }));
    expect(response.headers.get('location')).toContain('error=MissingCSRF');
  });

  it('stays explicitly unavailable without provider setup and rejects insecure public origins', async () => {
    expect(authSettings({})).toBeNull();
    expect((await createAuthService(null).handle(new Request(`${settings.origin}/api/auth/session`))).status).toBe(503);
    expect(() => authSettings({ AUTH_SECRET: settings.secret, AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret', PUBLIC_APP_URL: 'http://public.example' })).toThrow('HTTPS');
  });
});
