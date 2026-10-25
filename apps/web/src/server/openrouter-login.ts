import { createHash, randomBytes } from 'node:crypto';
import type { Backend, Identity } from '@gotchu/backend';
import { z } from 'zod';
import type { DeviceLogin } from './codex-device-login.js';
import { HttpError, readBoundedBody } from './http.js';

type Models = Pick<Backend['investigationModels'], 'authorizeConnection'>;
interface Pending {
  userId: string; organizationId: string; verifier: string; expiresAt: number;
  finish(value: string | null): void;
}

/** PKCE uses the documented provider endpoint; Gotchu never receives the user's password. */
export function createOpenRouterLogins(origin: string, models: Models, fetcher: typeof fetch = fetch) {
  const pending = new Map<string, Pending>();
  return {
    async start(scope: { identity: Identity; organizationId: string }): Promise<DeviceLogin> {
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      let finish: (value: string | null) => void = () => undefined;
      const credential = new Promise<string | null>(resolve => { finish = resolve; });
      pending.set(state, { userId: scope.identity.userId, organizationId: scope.organizationId, verifier, expiresAt: Date.now() + 10 * 60_000, finish });
      const callback = new URL('/api/customer/model-provider/openrouter/callback', origin);
      callback.searchParams.set('state', state);
      const url = new URL('https://openrouter.ai/auth');
      url.search = new URLSearchParams({ callback_url: callback.href, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return { verificationUrl: url.href, credential, async cancel() { pending.delete(state); finish(null); } };
    },
    async complete(identity: Identity, url: URL) {
      const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(url.searchParams.get('state'));
      const code = z.string().min(1).max(1024).safeParse(url.searchParams.get('code'));
      const session = state.success ? pending.get(state.data) : undefined;
      if (!state.success || !code.success || !session || session.userId !== identity.userId || session.expiresAt <= Date.now()) {
        throw new HttpError(400, 'openrouter_login_invalid', 'La autorización caducó o no pertenece a esta sesión. Vuelve a conectar OpenRouter.');
      }
      // Consume once before exchanging. A replay cannot mint another key.
      pending.delete(state.data);
      try {
        await models.authorizeConnection(identity, { organizationId: session.organizationId, providerPresetId: 'openrouter' });
        const response = await fetcher('https://openrouter.ai/api/v1/auth/keys', { method: 'POST',
          headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ code: code.data, code_verifier: session.verifier, code_challenge_method: 'S256' }),
        });
        if (!response.ok) throw new Error('provider_rejected');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(response, 20_000));
        const value: unknown = JSON.parse(text);
        const key = z.object({ key: z.string().min(1).max(16_384) }).parse(value);
        session.finish(key.key);
      } catch {
        session.finish(null);
        throw new HttpError(502, 'openrouter_login_failed', 'OpenRouter no pudo completar la autorización. Vuelve a conectar tu cuenta.');
      }
    },
  };
}
