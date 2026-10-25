import { Auth, type AuthConfig } from '@auth/core';
import { createHash } from 'node:crypto';
import type { JWT } from '@auth/core/jwt';
import GitHub from '@auth/core/providers/github';
import Google from '@auth/core/providers/google';
import Credentials from '@auth/core/providers/credentials';
import type { LocalAccounts } from './local-accounts.js';
import { z } from 'zod';
import { HttpError, json, readBoundedBody } from './http.js';

interface AuthBase {
  origin: string;
  secret: string;
  selfHostSetup?: boolean;
  invalidateStepUpSession?: (userId: string) => Promise<void>;
}
const oidcSettingsSchema = z.object({
  issuer: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'OIDC issuer must use HTTPS without credentials or query parameters'),
  clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(4_096), name: z.string().min(1).max(80),
}).strict();
type OidcSettings = z.infer<typeof oidcSettingsSchema>;
type AuthProviderOptions = {
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  oidc?: OidcSettings;
  localAccounts?: LocalAccounts;
};
export type AuthSettings = AuthBase & AuthProviderOptions & (
  | { googleClientId: string; googleClientSecret: string }
  | { githubClientId: string; githubClientSecret: string }
  | { oidc: OidcSettings }
  | { localAccounts: LocalAccounts }
);

const googleProfileSchema = z.object({
  sub: z.string().min(1).max(255),
  name: z.string().max(200).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  email_verified: z.boolean().optional(),
  picture: z.url().max(2_048).nullable().optional(),
});

export interface SessionIdentity { userId: string; cookies: string[]; displayName?: string }
export interface AuthService {
  enabled: boolean;
  handle(request: Request): Promise<Response>;
  identity(request: Request): Promise<SessionIdentity | null>;
  accountEmail(userId: string): Promise<string | null>;
}

export function authSettings(env: NodeJS.ProcessEnv = process.env, localAccounts?: LocalAccounts, invalidateStepUpSession?: (userId: string) => Promise<void>): AuthSettings | null {
  const oidc = env.AUTH_OIDC_ISSUER || env.AUTH_OIDC_CLIENT_ID || env.AUTH_OIDC_CLIENT_SECRET
    ? oidcSettingsSchema.parse({ issuer: env.AUTH_OIDC_ISSUER, clientId: env.AUTH_OIDC_CLIENT_ID, clientSecret: env.AUTH_OIDC_CLIENT_SECRET, name: env.AUTH_OIDC_NAME?.trim() || 'Workspace sign-in' }) : undefined;
  const github = env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET ? { githubClientId: env.AUTH_GITHUB_ID, githubClientSecret: env.AUTH_GITHUB_SECRET } : undefined;
  const google = env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET ? { googleClientId: env.AUTH_GOOGLE_ID, googleClientSecret: env.AUTH_GOOGLE_SECRET } : undefined;
  if (!env.AUTH_SECRET || !github && !google && !oidc && !localAccounts) return null;
  const secret = z.string().min(32).parse(env.AUTH_SECRET);
  const url = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_APP_URL must be an origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PUBLIC_APP_URL must use HTTPS outside local development');
  }
  const base = {
    origin: url.origin,
    secret,
    ...(env.GOTCHU_AUTH_MODE === 'self_host' ? { selfHostSetup: true } : {}),
    ...(invalidateStepUpSession ? { invalidateStepUpSession } : {}),
  };
  const providerOptions = {
    ...(google ?? {}),
    ...(github ?? {}),
    ...(oidc ? { oidc } : {}),
    ...(localAccounts ? { localAccounts } : {}),
  };
  if (google) return { ...base, ...providerOptions, googleClientId: google.googleClientId, googleClientSecret: google.googleClientSecret };
  if (github) return { ...base, ...providerOptions, githubClientId: github.githubClientId, githubClientSecret: github.githubClientSecret };
  if (oidc) return { ...base, ...providerOptions, oidc };
  if (localAccounts) return { ...base, ...providerOptions, localAccounts };
  return null;
}

export function createAuthConfig(settings: AuthSettings): AuthConfig {
  const providers: AuthConfig['providers'] = [];
  const providerIds: string[] = [];
  if (settings.githubClientId && settings.githubClientSecret) {
    providers.push(GitHub({ clientId: settings.githubClientId, clientSecret: settings.githubClientSecret, authorization: { params: { scope: 'read:user user:email' } } }));
    providerIds.push('github');
  }
  if (settings.googleClientId && settings.googleClientSecret) {
    providers.push(Google({
      clientId: settings.googleClientId,
      clientSecret: settings.googleClientSecret,
      authorization: { params: { scope: 'openid email profile' } },
      profile: profile => {
        const parsed = googleProfileSchema.parse(profile);
        return { id: parsed.sub, name: parsed.name ?? null, email: parsed.email ?? null, image: parsed.picture ?? null };
      },
    }));
    providerIds.push('google');
  }
  if (settings.oidc) {
    const oidc = oidcSettingsSchema.parse(settings.oidc);
    // Replacing an issuer/client must not map another identity into old memberships.
    const id = `oidc-${createHash('sha256').update(JSON.stringify([oidc.issuer, oidc.clientId])).digest('hex').slice(0, 24)}`;
    providers.push({ id, name: oidc.name, type: 'oidc', issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: oidc.clientSecret,
      authorization: { params: { scope: 'openid profile email' } }, checks: ['pkce', 'state', 'nonce'] });
    providerIds.push(id);
  }
  if (settings.localAccounts) {
    const accounts = settings.localAccounts;
    providers.push(Credentials({ id: 'credentials', name: 'Email y contraseña', credentials: { email: { type: 'email' }, password: { type: 'password' } },
      authorize: async credentials => accounts.authenticate({ email: credentials.email, password: credentials.password }),
    }));
    providerIds.push('credentials');
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
      signIn: async ({ account, profile }) => {
        if (settings.selfHostSetup && (!settings.localAccounts || !await settings.localAccounts.bootstrapComplete())) {
          return new URL('/dashboard?authError=BootstrapRequired', settings.origin).href;
        }
        if (account?.provider !== 'google') return true;
        const parsedProfile = googleProfileSchema.safeParse(profile);
        if (!parsedProfile.success || parsedProfile.data.email_verified !== true || !parsedProfile.data.email) {
          return new URL('/dashboard?authError=GoogleEmailUnverified', settings.origin).href;
        }
        // Local emails are unverified identifiers. They cannot veto a verified
        // provider identity, which keeps its own namespace and memberships.
        return true;
      },
      jwt: async ({ token, account, user }) => {
        if (account) {
          // OIDC subjects can be 255 characters. Keep the internal principal bounded
          // without truncating or widening every persisted membership key.
          const subject = account.provider.startsWith('oidc-')
            ? createHash('sha256').update(account.providerAccountId).digest('hex') : account.providerAccountId;
          token.sub = `${account.provider}:${subject}`;
          if (account.provider === 'credentials' && user && 'credentialEpoch' in user) token.credentialEpoch = user.credentialEpoch;
        }
        if (!providerIds.some((id) => token.sub?.startsWith(`${id}:`))) return {};
        if (token.sub?.startsWith('credentials:')) {
          const epoch = await settings.localAccounts?.epoch(token.sub.slice('credentials:'.length));
          if (epoch === null || epoch === undefined || epoch !== token.credentialEpoch) return {};
        }
        // OAuth access and refresh tokens are never copied into the session JWT.
        const claims: JWT = {};
        if (token.sub !== undefined) claims.sub = token.sub;
        if (token.name !== undefined) claims.name = token.name;
        if (token.email !== undefined) claims.email = token.email;
        if (token.picture !== undefined) claims.picture = token.picture;
        if (typeof token.credentialEpoch === 'number') claims.credentialEpoch = token.credentialEpoch;
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
    events: {
      signOut: async event => {
        if ('token' in event && event.token?.sub) await settings.invalidateStepUpSession?.(event.token.sub);
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
    accountEmail: async () => null,
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
        : new Request(request.url, { method: request.method, headers, signal: request.signal });
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
      const session = z.object({ user: z.object({
        id: z.string().min(1).max(256),
        name: z.string().max(200).nullable().optional(),
        email: z.string().max(254).nullable().optional(),
      }).passthrough() }).passthrough().safeParse(await response.json());
      if (!session.success) return null;
      const displayName = session.data.user.name?.trim() || session.data.user.email?.trim().split('@', 1)[0];
      return { userId: session.data.user.id, cookies: response.headers.getSetCookie(), ...(displayName ? { displayName } : {}) };
    },
    accountEmail: async userId => settings.localAccounts ? settings.localAccounts.accountEmail(userId) : null,
  };
}

export function publicAuthProviders(settings: AuthSettings | null) {
  return settings ? createAuthConfig(settings).providers.map(provider => {
    const configured = typeof provider === 'function' ? provider() : provider;
    return { id: configured.id, name: configured.name, type: configured.type };
  }) : [];
}
