import { Auth, type AuthConfig } from '@auth/core';
import { createHash } from 'node:crypto';
import type { JWT } from '@auth/core/jwt';
import GitHub from '@auth/core/providers/github';
import { z } from 'zod';
import { HttpError, json, readBoundedBody } from './http.js';

interface AuthBase {
  origin: string;
  secret: string;
}
const oidcSettingsSchema = z.object({
  issuer: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'OIDC issuer must use HTTPS without credentials or query parameters'),
  clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(4_096), name: z.string().min(1).max(80),
}).strict();
type OidcSettings = z.infer<typeof oidcSettingsSchema>;
export type AuthSettings = AuthBase & (
  { githubClientId: string; githubClientSecret: string; oidc?: OidcSettings }
  | { oidc: OidcSettings; githubClientId?: never; githubClientSecret?: never }
);

export interface SessionIdentity { userId: string; cookies: string[] }
export interface AuthService {
  enabled: boolean;
  handle(request: Request): Promise<Response>;
  identity(request: Request): Promise<SessionIdentity | null>;
}

export function authSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings | null {
  const oidc = env.AUTH_OIDC_ISSUER || env.AUTH_OIDC_CLIENT_ID || env.AUTH_OIDC_CLIENT_SECRET
    ? oidcSettingsSchema.parse({ issuer: env.AUTH_OIDC_ISSUER, clientId: env.AUTH_OIDC_CLIENT_ID, clientSecret: env.AUTH_OIDC_CLIENT_SECRET, name: env.AUTH_OIDC_NAME ?? 'Workspace sign-in' }) : undefined;
  const github = env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET ? { githubClientId: env.AUTH_GITHUB_ID, githubClientSecret: env.AUTH_GITHUB_SECRET } : undefined;
  if (!env.AUTH_SECRET || !github && !oidc) return null;
  const secret = z.string().min(32).parse(env.AUTH_SECRET);
  const url = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_APP_URL must be an origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PUBLIC_APP_URL must use HTTPS outside local development');
  }
  const base = { origin: url.origin, secret };
  if (github) return { ...base, ...github, ...(oidc ? { oidc } : {}) };
  if (oidc) return { ...base, oidc };
  return null;
}

export function createAuthConfig(settings: AuthSettings): AuthConfig {
  const providers: AuthConfig['providers'] = [];
  const providerIds: string[] = [];
  if (settings.githubClientId && settings.githubClientSecret) {
    providers.push(GitHub({ clientId: settings.githubClientId, clientSecret: settings.githubClientSecret, authorization: { params: { scope: 'read:user user:email' } } }));
    providerIds.push('github');
  }
  if (settings.oidc) {
    const oidc = oidcSettingsSchema.parse(settings.oidc);
    // Replacing an issuer/client must not map another identity into old memberships.
    const id = `oidc-${createHash('sha256').update(JSON.stringify([oidc.issuer, oidc.clientId])).digest('hex').slice(0, 24)}`;
    providers.push({ id, name: oidc.name, type: 'oidc', issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: oidc.clientSecret,
      authorization: { params: { scope: 'openid profile email' } }, checks: ['pkce', 'state', 'nonce'] });
    providerIds.push(id);
  }
  return {
    basePath: '/api/auth',
    secret: settings.secret,
    // Requests are checked against a configured origin before this trust is granted.
    trustHost: true,
    useSecureCookies: settings.origin.startsWith('https:'),
    session: { strategy: 'jwt', maxAge: 900 },
    providers,
    callbacks: {
      jwt: async ({ token, account }) => {
        if (account) {
          // OIDC subjects can be 255 characters. Keep the internal principal bounded
          // without truncating or widening every persisted membership key.
          const subject = account.provider.startsWith('oidc-')
            ? createHash('sha256').update(account.providerAccountId).digest('hex') : account.providerAccountId;
          token.sub = `${account.provider}:${subject}`;
        }
        if (!providerIds.some((id) => token.sub?.startsWith(`${id}:`))) return {};
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
