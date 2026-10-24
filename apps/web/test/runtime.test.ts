import { describe, expect, it } from 'vitest';
import { createWebRuntime, resolveWebAuthnConfiguration } from '../src/server/runtime.js';

describe('web runtime origin and WebAuthn configuration', () => {
  it.each([
    { NODE_ENV: 'production', GOTCHU_AUTH_MODE: 'public', expected: true },
    { NODE_ENV: 'production', GOTCHU_AUTH_MODE: 'self_host', GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true', expected: false },
    { NODE_ENV: 'production', GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true', expected: false },
    { NODE_ENV: 'development', GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true', expected: true },
  ])('exposes registration only through an explicit allowed mode: $NODE_ENV / $GOTCHU_AUTH_MODE', async ({ expected, ...env }) => {
    const origin = 'https://gotchu.example';
    const runtime = createWebRuntime({
      ...env, PUBLIC_APP_URL: origin, AUTH_SECRET: 'test-only-public-signup-secret-at-least-32-bytes',
      // Session metadata for an anonymous request must not need a database connection.
      GOTCHU_API_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:9/unused',
    });
    try {
      const response = await runtime.handleCustomer(new Request(`${origin}/api/customer/session`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: null, localAuthEnabled: true, registrationEnabled: expected });
      if (env.GOTCHU_AUTH_MODE === 'public') {
        const setup = await runtime.handleCustomer(new Request(`${origin}/api/customer/setup`, { method: 'POST', headers: { origin } }));
        expect(setup.status).toBe(404);
      }
    } finally { await runtime.close(); }
  });

  it('accepts HTTPS origins with a matching host or parent RP ID', () => {
    const appOrigin = new URL('https://console.example.com');
    expect(resolveWebAuthnConfiguration(appOrigin, undefined)).toMatchObject({ rpID: 'console.example.com', origin: appOrigin.origin });
    expect(resolveWebAuthnConfiguration(appOrigin, 'example.com')).toMatchObject({ rpID: 'example.com', origin: appOrigin.origin });
  });

  it('rejects explicit RP IDs that are invalid or do not match the configured origin', () => {
    const appOrigin = new URL('https://console.example.com');
    expect(() => resolveWebAuthnConfiguration(appOrigin, 'other.example.net')).toThrow(/must match/);
    expect(() => resolveWebAuthnConfiguration(appOrigin, '127.0.0.1')).toThrow(/must match/);
    expect(() => resolveWebAuthnConfiguration(appOrigin, 'not a host')).toThrow();
  });
});
