import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customerSourceSnapshotSchema, githubSingleAppOAuthStartSchema, githubBrokerResponseSchema, singleGitHubPublicAppSchema } from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { createSingleAppGitHubBroker } from '../src/server/github-broker-client.js';
import { createGitHubApi } from '../src/server/github-api.js';
import { createWebRuntime } from '../src/server/runtime.js';

const origin = 'http://localhost:3000';
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const applicationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'google:fixture';
const app = singleGitHubPublicAppSchema.parse({ id: '5454279', clientId: 'single-app-client', slug: 'single-app' });
const authorizationState = 'a'.repeat(43);
const challenge = 'c'.repeat(43);
const repository = { id: 101, fullName: 'fixture/service', defaultBranch: 'main', private: true, archived: false };
const snapshot = customerSourceSnapshotSchema.parse({ revision: '1'.repeat(40), files: [{ path: 'package.json', content: '{"name":"fixture"}' }] });
const digest = 'd'.repeat(64);
const connection = { installationId: '174788349', accountLogin: 'fixture-owner', state: 'active' as const, connectedAt: new Date(0).toISOString() };
const source = { organizationId, applicationId, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', digest, revision: snapshot.revision, fileCount: 1, createdAt: new Date(0).toISOString() };
const repositoryLink = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', applicationId, repositoryKey: 'gh-101', fullName: repository.fullName, defaultBranch: repository.defaultBranch, readAccess: 'granted' as const, writeAccess: 'not_granted' as const };

const chooseResult = githubBrokerResponseSchema.parse({
  operation: 'authorize',
  result: { kind: 'choose', organizationId, installations: [{ id: 174788349, account: { id: 101, login: 'fixture-owner', type: 'User' } }] },
});
if (chooseResult.operation !== 'authorize') throw new Error('Invalid authorize fixture');
const capturedResult = githubBrokerResponseSchema.parse({
  operation: 'readRepository',
  result: { kind: 'snapshot', snapshot, digest, repository, installationId: connection.installationId, appId: app.id, treeSha: '2'.repeat(40) },
});
if (capturedResult.operation !== 'readRepository') throw new Error('Invalid snapshot fixture');

let tempDirectory: string | undefined;
afterEach(async () => { if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }); tempDirectory = undefined; });

function fixture(options: { purpose?: 'authorize' | 'install' | 'choose'; brokerAuthorizeResult?: typeof chooseResult; events?: string[] } = {}) {
  const events = options.events ?? [];
  const github = {
    workspaceName: vi.fn(async () => 'Espacio de prueba'),
    createState: vi.fn(async (_identity: Identity, rawInput: unknown) => {
      const input = githubSingleAppOAuthStartSchema.parse(rawInput);
      events.push(`state:${input.purpose}`);
      return { state: authorizationState, codeChallenge: challenge };
    }),
    consumeState: vi.fn(async (_identity: Identity, _state: string, _appId?: string) => ({
      organizationId, installationId: options.purpose === 'authorize' ? null : connection.installationId,
      verifier: 'v'.repeat(43), purpose: options.purpose ?? 'choose',
    })),
    bind: vi.fn(async () => connection),
    list: vi.fn(async () => [connection]),
    revoke: vi.fn(async () => undefined),
    createRepositoryLink: vi.fn(async () => { events.push('link'); return repositoryLink; }),
    importCapturedSource: vi.fn(async () => { events.push('import'); }),
  } satisfies Pick<Backend['github'], 'workspaceName' | 'createState' | 'consumeState' | 'bind' | 'list' | 'revoke' | 'createRepositoryLink' | 'importCapturedSource'>;
  const services = {
    github,
    uploadSource: vi.fn(async () => { events.push('upload'); return source; }),
    queue: vi.fn(async () => { events.push('queue'); return { jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }; }),
  };
  const broker = {
    authorize: vi.fn(async () => options.brokerAuthorizeResult ?? chooseResult),
    installationStatus: vi.fn(async () => ({ operation: 'installationStatus' as const, active: true })),
    listRepositories: vi.fn(async () => ({ operation: 'listRepositories' as const, repositories: [repository] })),
    readRepository: vi.fn(async () => capturedResult),
  };
  return { events, github, services, broker, handler: createGitHubApi({
    origin, appFile: '/must-not-be-read-in-single-app-mode',
    singleApp: { publicApp: app, broker, },
    services,
    fetchImplementation: async () => { throw new Error('Legacy GitHub provider access must not run'); },
  }) };
}

describe('single-app GitHub routing', () => {
  it('starts the existing connect button flow with app-bound PKCE and never reads legacy credentials', async () => {
    const { handler, github, broker } = fixture();
    const response = await handler(new Request(`${origin}/api/customer/github/connect`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ organizationId }),
    }), { userId });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ installUrl: expect.stringContaining('client_id=single-app-client') });
    expect(github.createState).toHaveBeenCalledWith({ userId }, { organizationId, installationId: null, purpose: 'authorize', appId: app.id });
    expect(broker.authorize).not.toHaveBeenCalled();
  });

  it('lets the broker consume OAuth state and creates an app-bound selection state', async () => {
    const { handler, github, broker } = fixture();
    const response = await handler(new Request(`${origin}/api/customer/github/callback?code=fixture-code&state=${authorizationState}`), { userId });
    const page = await response?.text();
    expect(response?.status).toBe(200);
    expect(broker.authorize).toHaveBeenCalledWith({ actorId: userId, state: authorizationState, code: 'fixture-code' });
    expect(github.consumeState).not.toHaveBeenCalled();
    expect(github.createState).toHaveBeenCalledWith({ userId }, { organizationId, installationId: null, purpose: 'choose', appId: app.id });
    expect(page).toContain('archivos compatibles');
    expect(page).toContain('aprobación explícita');
    expect(page).not.toContain('No podrá escribir en ellos');
  });

  it('uses installation callback IDs only as hints and starts a fresh, app-bound authorization', async () => {
    const { handler, github, broker } = fixture({ purpose: 'install' });
    const response = await handler(new Request(`${origin}/api/customer/github/callback?setup_action=install&installation_id=${connection.installationId}&state=${authorizationState}`), { userId });
    expect(response?.status).toBe(303);
    expect(github.consumeState).toHaveBeenCalledWith({ userId }, authorizationState, app.id);
    expect(github.createState).toHaveBeenCalledWith({ userId }, { organizationId, installationId: connection.installationId, purpose: 'authorize', appId: app.id });
    expect(broker.authorize).not.toHaveBeenCalled();
  });

  it('links before capture, imports captured provenance, then queues the existing assessment', async () => {
    const { handler, events, github } = fixture();
    const response = await handler(new Request(`${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/github/installations/${connection.installationId}/repositories/${repository.id}/select`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: repository.fullName, defaultBranch: repository.defaultBranch }),
    }), { userId });
    expect(response?.status).toBe(201);
    expect(events).toEqual(['link', 'upload', 'import', 'queue']);
    expect(github.importCapturedSource).toHaveBeenCalledWith({ userId }, {
      organizationId, applicationId, repositoryLinkId: repositoryLink.id, sourceSnapshotId: source.id,
      appId: app.id, installationId: connection.installationId, repositoryId: repository.id,
      commitSha: snapshot.revision, treeSha: '2'.repeat(40), digest,
    });
  });

  it('fails closed on broker failure without consuming authorization state in the web process', async () => {
    const { handler, github, broker } = fixture();
    broker.authorize.mockRejectedValueOnce(new Error('executor unavailable'));
    const response = await handler(new Request(`${origin}/api/customer/github/callback?code=fixture-code&state=${authorizationState}`), { userId });
    expect(response?.status).toBe(500);
    expect(github.consumeState).not.toHaveBeenCalled();
  });
});

describe('single-app GitHub broker client configuration', () => {
  it('rejects non-loopback HTTP and rejects secret-bearing public app files', async () => {
    expect(() => createSingleAppGitHubBroker({ internalUrl: 'http://executor.example', bearerToken: 'a'.repeat(64) })).toThrow('executor_internal_url_invalid');
    tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-github-public-app-'));
    const publicFile = join(tempDirectory, 'app.json');
    await writeFile(publicFile, JSON.stringify({ ...app, privateKeyPem: 'must-not-be-present' }));
    expect(() => createWebRuntime({
      NODE_ENV: 'production', PUBLIC_APP_URL: 'https://gotchu.example', AUTH_SECRET: 'test-only-secret-at-least-32-characters',
      GOTCHU_GITHUB_CONNECTION_MODE: 'single_app', GOTCHU_GITHUB_PUBLIC_APP_FILE: publicFile,
      GOTCHU_EXECUTOR_INTERNAL_URL: 'https://executor.example', GOTCHU_EXECUTOR_INTERNAL_TOKEN: 'a'.repeat(64),
    })).toThrow('single_app_github_public_configuration_invalid');
  });

  it('keeps GitHub sign-in on a separate Auth.js client', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-github-sign-in-'));
    const publicFile = join(tempDirectory, 'app.json');
    await writeFile(publicFile, JSON.stringify(app));
    expect(() => createWebRuntime({
      NODE_ENV: 'production', PUBLIC_APP_URL: 'https://gotchu.example', AUTH_SECRET: 'test-only-secret-at-least-32-characters',
      AUTH_GITHUB_ID: app.clientId, GOTCHU_GITHUB_CONNECTION_MODE: 'single_app', GOTCHU_GITHUB_PUBLIC_APP_FILE: publicFile,
      GOTCHU_EXECUTOR_INTERNAL_URL: 'https://executor.example', GOTCHU_EXECUTOR_INTERNAL_TOKEN: 'a'.repeat(64),
    })).toThrow('github_sign_in_app_must_be_separate');
  });

  it('allows separate Auth.js GitHub credentials and does not load legacy reader files', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'gotchu-single-app-separate-auth-'));
    const publicFile = join(tempDirectory, 'app.json');
    await writeFile(publicFile, JSON.stringify(app));
    const runtime = createWebRuntime({
      NODE_ENV: 'production', PUBLIC_APP_URL: 'https://gotchu.example', AUTH_SECRET: 'test-only-secret-at-least-32-characters',
      AUTH_GITHUB_ID: 'separate-auth-client', AUTH_GITHUB_SECRET: 'separate-auth-secret',
      GOTCHU_GITHUB_CONNECTION_MODE: 'single_app', GOTCHU_GITHUB_PUBLIC_APP_FILE: publicFile,
      GOTCHU_GITHUB_READER_APP_FILE: '/must-not-be-read', GOTCHU_GITHUB_READER_APP_CREDENTIALS_FILE: '/must-not-be-read',
      GOTCHU_EXECUTOR_INTERNAL_URL: 'https://executor.example', GOTCHU_EXECUTOR_INTERNAL_TOKEN: 'a'.repeat(64),
    });
    await runtime.close();
  });

  it('rejects token-bearing or operation-mismatched executor responses', async () => {
    const broker = createSingleAppGitHubBroker({
      internalUrl: 'https://executor.example', bearerToken: 'a'.repeat(64),
      fetchImplementation: async () => Response.json({ operation: 'installationStatus', active: true, access_token: 'provider-token' }),
    });
    await expect(broker.authorize({ actorId: userId, state: authorizationState, code: 'fixture-code' })).rejects.toMatchObject({ code: 'github_broker_response_invalid' });
  });
});
