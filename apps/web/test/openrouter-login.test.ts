import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterLogins } from '../src/server/openrouter-login.js';

const identity = { userId: 'owner' }; const organizationId = randomUUID();
const origin = 'http://localhost:4801';
function fixture() {
  const authorizeConnection = vi.fn(async () => 'settings-version');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ key: 'synthetic-openrouter-key' })));
  return { logins: createOpenRouterLogins(origin, { authorizeConnection }, fetcher), authorizeConnection, fetcher };
}
describe('OpenRouter PKCE authorization (injected provider exchange)', () => {
  it('binds a one-time code exchange to the signed-in user and an S256 challenge', async () => {
    const f = fixture(); const login = await f.logins.start({ identity, organizationId });
    const provider = new URL(login.verificationUrl);
    expect(provider.origin).toBe('https://openrouter.ai'); expect(provider.pathname).toBe('/auth');
    const callback = new URL(provider.searchParams.get('callback_url') ?? '');
    expect(callback.origin).toBe(origin); callback.searchParams.set('code', 'synthetic-code');
    await expect(f.logins.complete({ userId: 'another-user' }, callback)).rejects.toMatchObject({ code: 'openrouter_login_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.logins.complete(identity, callback);
    expect(await login.credential).toBe('synthetic-openrouter-key');
    const request = f.fetcher.mock.calls[0]?.[1];
    if (typeof request?.body !== 'string') throw new Error('Expected JSON exchange');
    const payload: { code: string; code_verifier: string; code_challenge_method: string } = JSON.parse(request.body);
    expect(payload.code).toBe('synthetic-code'); expect(payload.code_challenge_method).toBe('S256');
    expect(createHash('sha256').update(payload.code_verifier).digest('base64url')).toBe(provider.searchParams.get('code_challenge'));
    expect(request.redirect).toBe('error');
    await expect(f.logins.complete(identity, callback)).rejects.toMatchObject({ code: 'openrouter_login_invalid' });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('cancels a pending authorization and rejects late callbacks', async () => {
    const f = fixture(); const login = await f.logins.start({ identity, organizationId });
    const callback = new URL(new URL(login.verificationUrl).searchParams.get('callback_url') ?? ''); callback.searchParams.set('code', 'synthetic-code');
    await login.cancel(); expect(await login.credential).toBeNull();
    await expect(f.logins.complete(identity, callback)).rejects.toMatchObject({ code: 'openrouter_login_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rechecks owner access before exchanging a provider code', async () => {
    const f = fixture(); const login = await f.logins.start({ identity, organizationId });
    const callback = new URL(new URL(login.verificationUrl).searchParams.get('callback_url') ?? ''); callback.searchParams.set('code', 'synthetic-code');
    f.authorizeConnection.mockRejectedValueOnce(new Error('owner_revoked'));
    await expect(f.logins.complete(identity, callback)).rejects.toMatchObject({ code: 'openrouter_login_failed' });
    expect(await login.credential).toBeNull(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized provider responses without projecting their content', async () => {
    const f = fixture(); const login = await f.logins.start({ identity, organizationId });
    const callback = new URL(new URL(login.verificationUrl).searchParams.get('callback_url') ?? ''); callback.searchParams.set('code', 'synthetic-code');
    f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(20_001)));
    await expect(f.logins.complete(identity, callback)).rejects.toMatchObject({ code: 'openrouter_login_failed' });
    expect(await login.credential).toBeNull();
  });
});
