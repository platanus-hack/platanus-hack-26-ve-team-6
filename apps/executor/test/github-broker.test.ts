import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { Database, Transaction } from '@gotchu/database';
import type { QueryResult, QueryResultRow } from 'pg';

const backend = vi.hoisted(() => ({
  consumeSingleAppState: vi.fn(),
  bindSingleApp: vi.fn(),
  loadSingleAppRepository: vi.fn(),
  loadSingleAppInstallation: vi.fn(),
}));

vi.mock('@gotchu/backend', () => ({
  createBackend: () => ({ github: {
    consumeSingleAppState: backend.consumeSingleAppState,
    bindSingleApp: backend.bindSingleApp,
  } }),
  loadSingleAppRepository: backend.loadSingleAppRepository,
  loadSingleAppInstallation: backend.loadSingleAppInstallation,
}));

import { createGitHubBroker } from '../src/github-broker.js';
import { createSingleAppGitHubResolver } from '../src/single-app-resolver.js';

const actorId = 'user-1';
const organizationId = '11111111-1111-4111-8111-111111111111';
const applicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const repositoryLinkId = '22222222-2222-4222-8222-222222222222';
const app = {
  id: '12345', clientId: 'Iv1.example', clientSecret: 'private-client-secret',
  slug: 'gotchu', privateKeyPem: 'private-key-never-used-by-this-test',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function fakeDatabase(repositoryLinkId?: string, queryValues?: unknown[][]): Database {
  const tx: Transaction = {
    query: async <R extends QueryResultRow = Record<string, unknown>>(_query: string, values?: unknown[]): Promise<QueryResult<R>> => {
      queryValues?.push(values ?? []);
      if (repositoryLinkId) return {
        rows: [{ id: repositoryLinkId } as unknown as R], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      };
      throw new Error('unexpected_query');
    },
  };
  return {
    role: 'gotchu_executor',
    async tenant<T>(_organizationId: string, work: (tx: Transaction) => Promise<T>) { return work(tx); },
    async integration<T>(_integrationId: string, work: (tx: Transaction) => Promise<T>) { return work(tx); },
    async system<T>(work: (tx: Transaction) => Promise<T>) { return work(tx); },
    async checkHealth() {},
    async close() {},
  };
}

function appWithTestKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { ...app, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

const repositoryBinding = {
  repositoryLinkId, repositoryId: 42, repositoryKey: 'gh-42', defaultBranch: 'main', installationId: '77', appId: app.id,
};

function repositoryFetch(read: (url: URL) => Response | undefined): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input);
    if (url.pathname === '/app/installations/77/access_tokens') return response({
      token: 'installation-token', expires_at: new Date(Date.now() + 60_000).toISOString(),
      permissions: { metadata: 'read', contents: 'read' }, repository_selection: 'selected', repositories: [{ id: 42 }],
    });
    if (url.pathname === '/repositories/42') return response({
      id: 42, full_name: 'acme/widget', default_branch: 'main', private: true, archived: false,
    });
    if (url.pathname === '/installation/token' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    const result = read(url);
    if (result) return result;
    throw new Error(`unexpected_github_request:${url.pathname}`);
  };
}

describe('single-app GitHub broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.consumeSingleAppState.mockResolvedValue({
      organizationId, installationId: null, purpose: 'authorize', verifier: 'v'.repeat(43),
    });
    backend.loadSingleAppRepository.mockRejectedValue(new Error('single_app_scope_denied'));
  });

  it('keeps the OAuth token inside the executor and returns only installation metadata', async () => {
    const oauthToken = 'gho-user-secret-must-not-leave-executor';
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input);
      requests.push({ url, init });
      if (url.hostname === 'github.com') return response({ access_token: oauthToken, token_type: 'bearer' });
      if (url.pathname === '/user/installations') return response({ installations: [{
        id: 77, node_id: 'I_kwDOBogus', html_url: 'https://github.com/organizations/acme/settings/installations/77',
        account: { id: 88, login: 'acme', type: 'Organization', name: 'Acme, Inc.', avatar_url: 'https://avatars.example/acme.png', node_id: 'MDEyOk9yZ2FuaXphdGlvbjg4' },
      }] });
      if (url.pathname === '/applications/Iv1.example/token') return new Response(null, { status: 204 });
      throw new Error('unexpected_github_request');
    };
    const broker = createGitHubBroker({ database: fakeDatabase(), app, publicAppUrl: 'https://gotchu.example', fetchImplementation });

    const result = await broker.dispatch({ operation: 'authorize', actorId, state: 'state-'.padEnd(40, 'x'), code: 'oauth-code' });

    expect(result).toEqual({ operation: 'authorize', result: {
      kind: 'choose', organizationId, installations: [{ id: 77, account: { id: 88, login: 'acme', type: 'Organization' } }],
    } });
    expect(JSON.stringify(result)).not.toContain(oauthToken);
    expect(backend.consumeSingleAppState).toHaveBeenCalledWith(actorId, 'state-'.padEnd(40, 'x'), app.id);
    const oauthRequest = requests.find(request => request.url.hostname === 'github.com');
    expect(JSON.parse(String(oauthRequest?.init?.body))).toMatchObject({
      redirect_uri: 'https://gotchu.example/api/customer/github/callback',
      client_id: app.clientId,
    });
    expect(requests.find(request => request.url.pathname === '/applications/Iv1.example/token')?.init?.method).toBe('DELETE');
    expect(requests.some(request => request.url.pathname === '/applications/Iv1.example/grant')).toBe(false);
  });

  it('denies a repository link before contacting GitHub when the persisted binding is unavailable', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const broker = createGitHubBroker({ database: fakeDatabase(), app, publicAppUrl: 'https://gotchu.example', fetchImplementation });

    await expect(broker.dispatch({ operation: 'readRepository', organizationId, applicationId: organizationId,
      repositoryLinkId: '22222222-2222-4222-8222-222222222222', read: 'head' })).rejects.toThrow('single_app_scope_denied');

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('projects readRepository requests into the persisted binding scope', async () => {
    backend.loadSingleAppRepository.mockResolvedValue(repositoryBinding);
    const sha = 'a'.repeat(40);
    const broker = createGitHubBroker({ database: fakeDatabase(), app: appWithTestKey(), publicAppUrl: 'https://gotchu.example',
      fetchImplementation: repositoryFetch(url => url.pathname.endsWith('/git/ref/heads/main') ? response({ object: { sha } }) : undefined) });

    const result = await broker.dispatch({ operation: 'readRepository', organizationId, applicationId,
      repositoryLinkId, read: 'head' });

    expect(result).toEqual({ operation: 'readRepository', result: { kind: 'head', sha } });
    expect(backend.loadSingleAppRepository).toHaveBeenCalledWith(expect.anything(),
      { organizationId, applicationId, repositoryLinkId }, app.id);
  });

  it('resolves a repository key before projecting a readHead scope', async () => {
    backend.loadSingleAppRepository.mockResolvedValue(repositoryBinding);
    const sha = 'b'.repeat(40);
    const queryValues: unknown[][] = [];
    const resolver = createSingleAppGitHubResolver({ database: fakeDatabase(repositoryLinkId, queryValues), app: appWithTestKey(),
      fetchImplementation: repositoryFetch(url => url.pathname.endsWith('/git/ref/heads/main') ? response({ object: { sha } }) : undefined) });

    await expect(resolver.readHead({ organizationId, applicationId, repositoryKey: 'gh-42' }, '')).resolves.toBe(sha);

    expect(backend.loadSingleAppRepository).toHaveBeenCalledWith(expect.anything(),
      { organizationId, applicationId, repositoryLinkId }, app.id);
    expect(queryValues).toEqual([[organizationId, applicationId, 'gh-42']]);
  });

  it('reads workflow blobs whose GitHub base64 content contains line breaks', async () => {
    backend.loadSingleAppRepository.mockResolvedValue(repositoryBinding);
    const commitSha = 'c'.repeat(40);
    const treeSha = 'd'.repeat(40);
    const blobSha = 'e'.repeat(40);
    const workflow = 'name: Check\non:\n  pull_request_target:\n    types: [opened]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n';
    const encoded = Buffer.from(workflow).toString('base64').match(/.{1,60}/g)?.join('\n');
    if (!encoded) throw new Error('test_workflow_encoding_empty');
    const broker = createGitHubBroker({ database: fakeDatabase(), app: appWithTestKey(), publicAppUrl: 'https://gotchu.example',
      fetchImplementation: repositoryFetch(url => {
        if (url.pathname.endsWith(`/git/commits/${commitSha}`)) return response({ sha: commitSha, tree: { sha: treeSha } });
        if (url.pathname.endsWith(`/git/trees/${treeSha}`)) return response({ sha: treeSha, truncated: false, tree: [
          { path: '.github/workflows/check.yml', mode: '100644', type: 'blob', sha: blobSha },
        ] });
        if (url.pathname.endsWith(`/git/blobs/${blobSha}`)) return response({ encoding: 'base64', content: encoded });
        return undefined;
      }) });

    const result = await broker.dispatch({ operation: 'readRepository', organizationId, applicationId,
      repositoryLinkId, read: 'automation', commitSha });

    expect(result).toEqual({ operation: 'readRepository', result: { kind: 'automation', violations: [expect.objectContaining({
      path: '.github/workflows/check.yml', rule: 'pull_request_target',
    })] } });
  });

  it('reports a suspended installation as inactive', async () => {
    backend.loadSingleAppInstallation.mockResolvedValue({ installationId: '77', appId: app.id });
    const broker = createGitHubBroker({ database: fakeDatabase(), app: appWithTestKey(), publicAppUrl: 'https://gotchu.example',
      fetchImplementation: async input => {
        const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input);
        if (url.pathname === '/app/installations/77') return response({ id: 77, suspended_at: '2026-10-20T12:00:00Z' });
        throw new Error(`unexpected_github_request:${url.pathname}`);
      } });

    await expect(broker.dispatch({ operation: 'installationStatus', organizationId, installationId: '77' }))
      .resolves.toEqual({ operation: 'installationStatus', active: false });
  });
});
