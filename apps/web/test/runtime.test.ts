import { describe, expect, it } from 'vitest';
import { createWebRuntime, resolveWebAuthnConfiguration } from '../src/server/runtime.js';

describe('web runtime origin and WebAuthn configuration', () => {
  it('keeps the localhost development default enabled', () => {
    expect(resolveWebAuthnConfiguration(new URL('http://localhost:3000'), undefined)).toEqual({
      rpID: 'localhost', origin: 'http://localhost:3000', rpName: 'Gotchu',
    });
  });

  it.each(['http://127.0.0.1:3000', 'http://[::1]:3000'])('allows loopback runtime origin %s without enabling unsupported WebAuthn', async appUrl => {
    const runtime = createWebRuntime({ PUBLIC_APP_URL: appUrl });
    try {
      expect(resolveWebAuthnConfiguration(new URL(appUrl), undefined)).toBeUndefined();
    } finally {
      await runtime.close();
    }
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
