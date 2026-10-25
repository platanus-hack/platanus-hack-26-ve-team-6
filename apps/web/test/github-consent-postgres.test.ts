import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBackend } from '@gotchu/backend';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';
import { createCustomerApi, type CustomerServices } from '../src/server/customer-api.js';
import type { AuthService } from '../src/server/auth.js';

const live = liveUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
live('GitHub consent through customer routing and real backend state (mocked provider)', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  let handle: ReturnType<typeof createCustomerApi>;
  let directory: string;
  beforeAll(async () => {
    db = await fixture({ max: 5 });
    backend = createBackend({ database: db.databases.gotchu_api });
    directory = await mkdtemp(join(tmpdir(), 'gotchu-consent-'));
    const appFile = join(directory, 'app.json');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(appFile, JSON.stringify({ id: '5454279', slug: 'fixture-app', clientId: 'fixture-client', clientSecret: 'fixture-secret', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), webhookSecret: 'fixture-webhook' }));
    const unused = async (): Promise<never> => { throw new Error('Unexpected customer service call'); };
    const services: CustomerServices = { github: backend.github, listWorkspaces: unused, createWorkspace: unused, updateWorkspace: unused, listApplications: unused, createApplication: unused, updateApplication: unused, listTargets: unused, enrollTarget: unused, verifyTarget: unused, revokeTarget: unused, listSources: unused, uploadSource: unused, deleteSource: unused, listContainerImages: unused, uploadContainerImage: unused, deleteContainerImage: unused, listReports: unused, getReport: unused, recordReportDownload: unused, queue: unused, job: unused };
    const auth: AuthService = { enabled: true, handle: unused, identity: async request => ({ userId: request.headers.get('x-fixture-user') ?? db.a.userId, cookies: [] }), accountEmail: async () => null };
    handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [], githubAppFile: appFile });
    const provider: typeof fetch = async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'fixture-token' });
      if (url === 'https://api.github.com/user') return Response.json({ id: 101 });
      if (url.startsWith('https://api.github.com/user/installations')) return Response.json({ installations: ['111', '222'].map(id => ({ id: Number(id), account: { id: 101, login: 'fixture-owner', type: 'User' } })) });
      throw new Error('Unexpected provider request');
    };
    vi.stubGlobal('fetch', provider);
  }, 30_000);
  afterAll(async () => { vi.unstubAllGlobals(); await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function choose(state: string, installationId: string, userId = db.a.userId) {
    return handle(new Request(`${origin}/api/customer/github/choose`, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', 'x-fixture-user': userId }, body: new URLSearchParams({ state, installationId }) }));
  }
  async function consent() { return backend.github.createState({ userId: db.a.userId }, { organizationId: db.a.organizationId, purpose: 'choose' }); }
  function location(response: Response) {
    expect(response.status).toBe(303);
    const value = response.headers.get('location');
    if (!value) throw new Error('Missing redirect');
    return new URL(value, origin);
  }
  async function authorize(url: URL) {
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // A spoofed callback installation ID must never replace the server-pinned target.
    return handle(new Request(`${origin}/api/customer/github/callback?code=fixture-code&installation_id=999&state=${url.searchParams.get('state')}`));
  }

  it('connects an existing installation, rejects replay, and pins the selected installation', async () => {
    const state = await consent();
    const authorization = location(await choose(state.state, '111'));
    expect((await choose(state.state, '111')).status).toBe(400);
    expect(location(await authorize(authorization)).search).toBe('?github=connected');
    expect((await authorize(authorization)).status).toBe(400);
    expect(await backend.github.list({ userId: db.a.userId }, { organizationId: db.a.organizationId })).toMatchObject([{ installationId: '111', state: 'active' }]);
  });

  it('requires fresh PKCE after a new installation callback before binding', async () => {
    const install = location(await choose((await consent()).state, 'new'));
    expect(install.pathname).toBe('/apps/fixture-app/installations/new');
    const callback = new Request(`${origin}/api/customer/github/callback?installation_id=222&setup_action=install&code=untrusted-install-code&state=${install.searchParams.get('state')}`);
    const authorization = location(await handle(callback));
    expect((await backend.github.list({ userId: db.a.userId }, { organizationId: db.a.organizationId })).some(item => item.installationId === '222')).toBe(false);
    expect(location(await authorize(authorization)).search).toBe('?github=connected');
    expect((await backend.github.list({ userId: db.a.userId }, { organizationId: db.a.organizationId })).some(item => item.installationId === '222' && item.state === 'active')).toBe(true);
    expect((await handle(callback)).status).toBe(400);
  });

  it('rejects another user without consuming consent and allows exactly one concurrent submission', async () => {
    const state = await consent();
    expect((await choose(state.state, '111', db.b.userId)).status).toBe(400);
    const responses = await Promise.all(Array.from({ length: 5 }, () => choose(state.state, '111')));
    expect(responses.filter(response => response.status === 303)).toHaveLength(1);
    expect(responses.filter(response => response.status === 400)).toHaveLength(4);
  });
});
