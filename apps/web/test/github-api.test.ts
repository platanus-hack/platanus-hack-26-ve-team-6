import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '@gotchu/backend';
import { createGitHubApi } from '../src/server/github-api.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'github-user:fixture';
const fixtureToken = 'gho-fixture-user-token-never-return-this';
let directory: string | undefined;

async function callbackFixture(canAccess: boolean) {
  directory = await mkdtemp(join(tmpdir(), 'gotchu-github-fixture-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appFile = join(directory, 'app.json');
  await writeFile(appFile, JSON.stringify({ id: '5454279', clientId: 'fixture-client', clientSecret: 'fixture-secret', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), webhookSecret: 'fixture-webhook' }));
  const github = {
    consumeState: vi.fn(async (_identity: { userId: string }, state: string) => { if (state !== 'single-use-fixture-state') throw new Error('wrong_state'); return organizationId; }),
    bind: vi.fn(async () => ({ installationId: '174788349', accountLogin: 'fixture-owner', state: 'active' as const, connectedAt: new Date().toISOString() })),
  } as unknown as Backend['github'];
  const calls: string[] = [];
  const fetchImplementation: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: fixtureToken, token_type: 'bearer', scope: 'read:user' });
    if (url.startsWith('https://api.github.com/user/installations')) return Response.json({ installations: canAccess ? [{ id: 174788349, account: { login: 'fixture-owner' } }] : [] });
    throw new Error('unexpected_fixture_request');
  };
  const handler = createGitHubApi({ origin: 'http://localhost:3000', appFile, appSlug: 'fixture-app', services: { github, uploadSource: vi.fn(), queue: vi.fn() }, fetchImplementation });
  const request = new Request('http://localhost:3000/api/customer/github/callback?code=fixture-code&installation_id=174788349&setup_action=install&state=single-use-fixture-state');
  const response = await handler(request, { userId });
  if (!response) throw new Error('callback route did not match');
  return { response, github, calls };
}

afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('GitHub callback HTTP boundary (mocked GitHub fixture)', () => {
  it('rejects an installation the signed-in GitHub account cannot access', async () => {
    const { response, github } = await callbackFixture(false);
    expect(response.status).toBe(403);
    expect(github.bind).not.toHaveBeenCalled();
    const payload = await response.text();
    expect(payload).not.toContain(fixtureToken);
  });

  it('binds only after access is proven and never returns OAuth tokens', async () => {
    const { response, github } = await callbackFixture(true);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/dashboard?github=connected');
    expect(github.bind).toHaveBeenCalledWith({ userId }, { organizationId, userId, state: 'single-use-fixture-state', installationId: '174788349', accountLogin: 'fixture-owner' });
    expect(await response.text()).not.toContain(fixtureToken);
    expect(response.headers.get('set-cookie') ?? '').not.toContain(fixtureToken);
  });
});
