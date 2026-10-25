import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const actorId = 'user-1';
const organizationId = '11111111-1111-4111-8111-111111111111';
const app = {
  id: '12345', clientId: 'Iv1.example', clientSecret: 'private-client-secret',
  slug: 'gotchu', privateKeyPem: 'private-key-never-used-by-this-test',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function fakeDatabase(): Database {
  const tx: Transaction = {
    query: async <R extends QueryResultRow = Record<string, unknown>>(_query: string, _values?: unknown[]): Promise<QueryResult<R>> => {
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
        id: 77, account: { id: 88, login: 'acme', type: 'Organization' },
      }] });
      if (url.pathname === '/applications/Iv1.example/grant') return new Response(null, { status: 204 });
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
    expect(requests.find(request => request.url.pathname === '/applications/Iv1.example/grant')?.init?.method).toBe('DELETE');
  });

  it('denies a repository link before contacting GitHub when the persisted binding is unavailable', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const broker = createGitHubBroker({ database: fakeDatabase(), app, publicAppUrl: 'https://gotchu.example', fetchImplementation });

    await expect(broker.dispatch({ operation: 'readRepository', organizationId, applicationId: organizationId,
      repositoryLinkId: '22222222-2222-4222-8222-222222222222', read: 'head' })).rejects.toThrow('single_app_scope_denied');

    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
