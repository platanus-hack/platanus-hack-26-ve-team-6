import { Auth, type AuthConfig } from '@auth/core';
import type { JWT } from '@auth/core/jwt';
import GitHub from '@auth/core/providers/github';
import { z } from 'zod';
import { HttpError, json, readBoundedBody } from './http.js';

export interface AuthSettings {
  origin: string;
  secret: string;
  githubClientId: string;
  githubClientSecret: string;
}

export interface SessionIdentity { userId: string; cookies: string[] }
export interface AuthService {
  enabled: boolean;
  handle(request: Request): Promise<Response>;
  identity(request: Request): Promise<SessionIdentity | null>;
}

export function authSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings | null {
  if (!env.AUTH_SECRET || !env.AUTH_GITHUB_ID || !env.AUTH_GITHUB_SECRET) return null;
  const secret = z.string().min(32).parse(env.AUTH_SECRET);
  const url = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_APP_URL must be an origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PUBLIC_APP_URL must use HTTPS outside local development');
  }
  return { origin: url.origin, secret, githubClientId: env.AUTH_GITHUB_ID, githubClientSecret: env.AUTH_GITHUB_SECRET };
}

export function createAuthConfig(settings: AuthSettings): AuthConfig {
  return {
    basePath: '/api/auth',
    secret: settings.secret,
    // Requests are checked against a configured origin before this trust is granted.
    trustHost: true,
    useSecureCookies: settings.origin.startsWith('https:'),
    session: { strategy: 'jwt', maxAge: 900 },
    providers: [GitHub({
      clientId: settings.githubClientId,
      clientSecret: settings.githubClientSecret,
      authorization: { params: { scope: 'read:user user:email' } },
    })],
    callbacks: {
      jwt: async ({ token, account }) => {
        if (account) token.sub = `${account.provider}:${account.providerAccountId}`;
        // OAuth access and refresh tokens are never copied into the session JWT.
        const claims: JWT = {};
        if (token.sub !== undefined) claims.sub = token.sub;
        if (token.name !== undefined) claims.name = token.name;
        if (token.email !== undefined) claims.email = token.email;
        if (token.picture !== undefined) claims.picture = token.picture;
        return claims;
      },
      session: async ({ session, token }) => {
        if (session.user && token.sub) session.user.id = token.sub;
        return session;
      },
      redirect: async ({ url }) => {
        const target = new URL(url, settings.origin);
        return target.origin === settings.origin ? target.href : settings.origin;
      },
    },
    logger: {
      error: (error) => console.error(JSON.stringify({ event: 'auth_error', type: error.name })),
      warn: (code) => console.warn(JSON.stringify({ event: 'auth_warning', code })),
      debug: () => {},
    },
  };
}

export function createAuthService(settings: AuthSettings | null): AuthService {
  if (!settings) return {
    enabled: false,
    handle: async () => json({ error: { code: 'auth_not_configured', message: 'Sign-in is not configured' } }, 503),
    identity: async () => { throw new HttpError(503, 'auth_not_configured', 'Sign-in is not configured'); },
  };
  const config = createAuthConfig(settings);
  const validateOrigin = (request: Request) => {
    if (new URL(request.url).origin !== settings.origin) throw new HttpError(400, 'untrusted_host', 'Request origin is not configured');
    // Do not let an untrusted forwarded host override the validated Request URL.
    const headers = new Headers(request.headers);
    headers.delete('x-forwarded-host');
    headers.delete('x-forwarded-proto');
    headers.delete('forwarded');
    return headers;
  };
  return {
    enabled: true,
    handle: async (request) => {
      const headers = validateOrigin(request);
      const bounded = request.method === 'POST'
        ? new Request(request.url, { method: 'POST', headers, body: new Uint8Array(await readBoundedBody(request, 16_384)), signal: request.signal })
        : new Request(request, { headers });
      const response = await Auth(bounded, config);
      // Auth.js may return an immutable redirect response.
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    },
    identity: async (request) => {
      const headers = validateOrigin(request);
      const response = await Auth(new Request(`${settings.origin}/api/auth/session`, { headers }), config);
      if (!response.ok) throw new HttpError(503, 'auth_unavailable', 'Session validation is unavailable');
      const session = z.object({ user: z.object({ id: z.string().min(1).max(256) }).passthrough() }).passthrough().safeParse(await response.json());
      if (!session.success) return null;
      return { userId: session.data.user.id, cookies: response.headers.getSetCookie() };
    },
  };
}
