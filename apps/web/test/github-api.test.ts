import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '@gotchu/backend';
import { createGitHubApi } from '../src/server/github-api.js';
import { HttpError } from '../src/server/http.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'google:fixture';
const state = 's'.repeat(43);
const verifier = 'v'.repeat(43);
const fixtureToken = 'ghu-fixture-user-token-never-return-this';
let directory: string | undefined;

type FixtureOptions = {
  visible?: boolean; userId?: number; accountType?: 'User' | 'Organization';
  role?: 'admin' | 'member'; memberState?: 'active' | 'pending'; membershipAccountId?: number;
  target?: string | null; purpose?: 'authorize' | 'install' | 'choose'; verifier?: string | null;
};

async function callbackFixture(options: FixtureOptions = {}) {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-github-fixture-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appFile = join(directory, 'app.json');
  await writeFile(appFile, JSON.stringify({ id: '5454279', slug: 'fixture-app', clientId: 'fixture-client', clientSecret: 'fixture-secret', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), webhookSecret: 'fixture-webhook' }));
  const github = {
    workspaceName: vi.fn(async () => 'Workspace <private>'),
    createState: vi.fn(async () => ({ state: 'n'.repeat(43), codeChallenge: 'c'.repeat(43) })),
    consumeState: vi.fn(async (_identity: { userId: string }, received: string) => {
      if (received !== state) throw new HttpError(400, 'github_state_invalid', 'Invalid state');
      return { organizationId, installationId: options.target === undefined ? '174788349' : options.target, verifier: options.verifier === undefined ? verifier : options.verifier, purpose: options.purpose ?? 'authorize' };
    }),
    bind: vi.fn(async () => ({ installationId: '174788349', accountLogin: 'fixture-owner', state: 'active' as const, connectedAt: new Date().toISOString() })),
    list: vi.fn(async () => []), revoke: vi.fn(async () => undefined), listRepositoryLinks: vi.fn(async () => []),
    createRepositoryLink: vi.fn(async () => { throw new Error('No source read is expected'); }),
  } satisfies Backend['github'];
  const calls: string[] = [];
  const exchanges: unknown[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      if (typeof init?.body !== 'string') throw new Error('Expected token exchange JSON');
      const body: unknown = JSON.parse(init.body); exchanges.push(body);
      return Response.json({ access_token: fixtureToken, token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ id: options.userId ?? 101 });
    if (url.startsWith('https://api.github.com/user/installations')) return Response.json({ installations: options.visible === false ? [] : [{ id: 174788349, account: { id: 101, login: 'fixture-owner', type: options.accountType ?? 'User' } }] });
    if (url.startsWith('https://api.github.com/user/memberships/orgs/')) return Response.json({ role: options.role ?? 'admin', state: options.memberState ?? 'active', organization: { id: options.membershipAccountId ?? 101 }, user: { id: options.userId ?? 101 } });
    throw new Error('Unexpected fixture request');
  };
  const handler = createGitHubApi({ origin: 'http://localhost:3000', appFile, appSlug: 'fixture-app', services: { github, enableDefaultMonitoring: async () => { throw new Error('No monitor expected'); }, uploadSource: async () => { throw new Error('No source upload expected'); }, queue: async () => { throw new Error('No scan expected'); } }, fetchImplementation });
  const request = new Request(`http://localhost:3000/api/customer/github/callback?code=fixture-code&installation_id=174788349&setup_action=install&state=${state}`);
  const response = await handler(request, { userId });
  if (!response) throw new Error('Callback route did not match');
  return { response, github, calls, exchanges, handler };
}

afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('GitHub owner delegation HTTP boundary (mocked GitHub)', () => {
  it('rejects an installation the authorizing GitHub account cannot access', async () => {
    const { response, github } = await callbackFixture({ visible: false });
    expect(response.status).toBe(403);
    expect(github.bind).not.toHaveBeenCalled();
  });

  it('rejects a collaborator even when the installation is visible', async () => {
    const { response, github } = await callbackFixture({ userId: 202 });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('github_owner_required');
    expect(github.bind).not.toHaveBeenCalled();
  });

  it('requires an active organization owner and matching authoritative IDs', async () => {
    for (const options of [{ role: 'member' as const }, { memberState: 'pending' as const }, { membershipAccountId: 999 }]) {
      const fixture = await callbackFixture({ accountType: 'Organization', ...options });
      expect(fixture.response.status).toBe(403);
      expect(fixture.github.bind).not.toHaveBeenCalled();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds a personal owner only after PKCE and records the delegator', async () => {
    const { response, github, exchanges } = await callbackFixture();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/dashboard?github=connected');
    expect(exchanges).toEqual([{ client_id: 'fixture-client', client_secret: 'fixture-secret', code: 'fixture-code', code_verifier: verifier, redirect_uri: 'http://localhost:3000/api/customer/github/callback' }]);
    expect(github.bind).toHaveBeenCalledWith({ userId }, { organizationId, userId, state, installationId: '174788349', accountLogin: 'fixture-owner', githubUserId: '101', githubAccountId: '101' });
    expect(await response.text()).not.toContain(fixtureToken);
    expect(response.headers.get('set-cookie') ?? '').not.toContain(fixtureToken);
  });

  it('allows a verified organization owner', async () => {
    const { response, github } = await callbackFixture({ accountType: 'Organization', userId: 202 });
    expect(response.status).toBe(303);
    expect(github.bind).toHaveBeenCalledOnce();
  });

  it('requires explicit installation consent even when only one installation is visible', async () => {
    const { response, github } = await callbackFixture({ target: null });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('Workspace &lt;private&gt;');
    expect(page).toContain('value="174788349"');
    expect(page).not.toContain(fixtureToken);
    expect(page).not.toContain(verifier);
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://github.com;");
    expect(github.bind).not.toHaveBeenCalled();
    expect(github.createState).toHaveBeenCalledWith({ userId }, { organizationId, purpose: 'choose' });
  });

  it('never binds from installation callback hints or accepts missing PKCE', async () => {
    const installed = await callbackFixture({ purpose: 'install', verifier: null });
    expect(installed.response.status).toBe(303);
    const location = new URL(installed.response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(installed.calls).toEqual([]);
    expect(installed.github.bind).not.toHaveBeenCalled();
    if (directory) await rm(directory, { recursive: true, force: true });
    const missing = await callbackFixture({ verifier: null });
    expect(missing.response.status).toBe(400);
    expect(missing.calls).toEqual([]);
    expect(missing.github.bind).not.toHaveBeenCalled();
  });

  it('starts OAuth before installation so existing installs can reconnect', async () => {
    const { handler, github } = await callbackFixture();
    github.createState.mockClear();
    const response = await handler(new Request('http://localhost:3000/api/customer/github/connect', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ organizationId }) }), { userId });
    const payload: unknown = await response?.json();
    expect(payload).toEqual({ installUrl: expect.stringContaining('https://github.com/login/oauth/authorize?') });
  });

  it('rejects cross-origin selection before consuming its user-bound state', async () => {
    const { handler, github } = await callbackFixture({ purpose: 'choose' });
    github.consumeState.mockClear();
    const response = await handler(new Request('http://localhost:3000/api/customer/github/choose', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, installationId: '174788349' }) }), { userId });
    expect(response?.status).toBe(403);
    expect(github.consumeState).not.toHaveBeenCalled();
  });
});
