import { encode } from '@auth/core/jwt';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { authSettings, createAuthConfig, createAuthService, type AuthSettings } from '../src/server/auth.js';

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

  it('bounds anonymous auth POST bodies before Auth.js reads them', async () => {
    await expect(service.handle(new Request(`${settings.origin}/api/auth/signout`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(16_385),
    }))).rejects.toMatchObject({ status: 413, code: 'body_too_large' });
  });

  it('stays explicitly unavailable without provider setup and rejects insecure public origins', async () => {
    expect(authSettings({})).toBeNull();
    expect((await createAuthService(null).handle(new Request(`${settings.origin}/api/auth/session`))).status).toBe(503);
    expect(() => authSettings({ AUTH_SECRET: settings.secret, AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret', PUBLIC_APP_URL: 'http://public.example' })).toThrow('HTTPS');
  });

  it('supports generic OIDC without a GitHub account and exposes no client secret', async () => {
    const configured = authSettings({ PUBLIC_APP_URL: settings.origin, AUTH_SECRET: settings.secret, AUTH_OIDC_ISSUER: 'https://identity.example.test/realm', AUTH_OIDC_CLIENT_ID: 'fixture-client', AUTH_OIDC_CLIENT_SECRET: 'fixture-secret', AUTH_OIDC_NAME: '' });
    expect(configured).not.toBeNull();
    const response = await createAuthService(configured).handle(new Request(`${settings.origin}/api/auth/providers`));
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(JSON.stringify(payload)).toContain('oidc-');
    expect(JSON.stringify(payload)).not.toContain('github');
    expect(JSON.stringify(payload)).not.toContain('fixture-secret');
    expect(() => authSettings({ AUTH_SECRET: settings.secret, AUTH_OIDC_ISSUER: 'http://identity.example.test', AUTH_OIDC_CLIENT_ID: 'id', AUTH_OIDC_CLIENT_SECRET: 'secret' })).toThrow('HTTPS');
  });

  it('maps maximum-length OIDC subjects into distinct bounded session principals', async () => {
    const configured: AuthSettings = { origin: settings.origin, secret: settings.secret, oidc: { issuer: 'https://identity.example.test', clientId: 'fixture', clientSecret: 'fixture-secret', name: 'Fixture' } };
    const config = createAuthConfig(configured);
    const jwt = config.callbacks?.jwt;
    if (!jwt) throw new Error('JWT callback missing');
    const providers = z.record(z.string(), z.object({ id: z.string() }).passthrough()).parse(await (await createAuthService(configured).handle(new Request(`${settings.origin}/api/auth/providers`))).json());
    const provider = Object.values(providers)[0];
    if (!provider) throw new Error('OIDC fixture provider missing');
    const mint = (subject: string) => jwt({ token: {}, user: { id: subject }, account: { provider: provider.id, providerAccountId: subject, type: 'oidc' }, trigger: 'signIn' });
    const first = await mint('a'.repeat(255));
    const second = await mint('a'.repeat(254) + 'b');
    expect(first?.sub?.length).toBe(94);
    expect(first?.sub).not.toBe(second?.sub);
    const token = await encode({ secret: settings.secret, salt: cookieName, token: first ?? {} });
    const identity = await createAuthService(configured).identity(new Request(`${settings.origin}/api/v1/applications`, { headers: { cookie: `${cookieName}=${token}` } }));
    expect(identity?.userId).toBe(first?.sub);
  });

  it('does not preserve sessions from an identity provider that was removed', async () => {
    const configured = authSettings({ PUBLIC_APP_URL: settings.origin, AUTH_SECRET: settings.secret, AUTH_OIDC_ISSUER: 'https://identity.example.test', AUTH_OIDC_CLIENT_ID: 'fixture-client', AUTH_OIDC_CLIENT_SECRET: 'fixture-secret' });
    const identity = await createAuthService(configured).identity(new Request(`${settings.origin}/api/v1/applications`, { headers: { cookie: await sessionCookie() } }));
    expect(identity).toBeNull();
  });

  it('requires a new identity namespace when the OIDC issuer changes', async () => {
    const environment = { PUBLIC_APP_URL: settings.origin, AUTH_SECRET: settings.secret, AUTH_OIDC_CLIENT_ID: 'fixture-client', AUTH_OIDC_CLIENT_SECRET: 'fixture-secret' };
    const old = createAuthService(authSettings({ ...environment, AUTH_OIDC_ISSUER: 'https://first.example.test' }));
    const replacement = createAuthService(authSettings({ ...environment, AUTH_OIDC_ISSUER: 'https://replacement.example.test' }));
    const providers = z.record(z.string(), z.object({ id: z.string() }).passthrough()).parse(await (await old.handle(new Request(`${settings.origin}/api/auth/providers`))).json());
    const provider = Object.values(providers)[0];
    if (!provider) throw new Error('OIDC fixture provider missing');
    const token = await encode({ secret: settings.secret, salt: cookieName, token: { sub: `${provider.id}:same-subject` } });
    const request = new Request(`${settings.origin}/api/v1/applications`, { headers: { cookie: `${cookieName}=${token}` } });
    expect((await old.identity(request))?.userId).toBe(`${provider.id}:same-subject`);
    expect(await replacement.identity(request)).toBeNull();
  });
});
