import { describe, expect, it } from 'vitest';
import { githubBrokerRequestSchema, githubBrokerResponseSchema, singleGitHubPublicAppSchema } from '../src/index.js';

const organizationId = '2184b86c-c6b2-4902-995d-c8055d883cd5';
const applicationId = 'ca6a34df-783e-47f7-b108-9e0616e12c09';
const repositoryLinkId = '3ec70b06-2b53-4ca8-93b5-6739bd15dd08';
const scope = { organizationId, applicationId, repositoryLinkId };

describe('semantic single-App GitHub broker contracts', () => {
  it('accepts only semantic repository reads with immutable commit selectors', () => {
    const request = { operation: 'readRepository', ...scope, read: 'tree', commitSha: 'a'.repeat(40) };
    expect(githubBrokerRequestSchema.safeParse(request).success).toBe(true);
    for (const change of [{ url: 'https://api.github.com/repos/other/private' }, { method: 'POST' },
      { read: 'accessToken' }, { commitSha: 'main' }, { commitSha: 'a'.repeat(64) }]) {
      expect(githubBrokerRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
    expect(githubBrokerRequestSchema.safeParse({ operation: 'listRepositories', organizationId, applicationId, installationId: '123' }).success).toBe(true);
    expect(githubBrokerRequestSchema.safeParse({ operation: 'listRepositories', organizationId, installationId: '123' }).success).toBe(false);
  });

  it('rejects credentials and mismatched operation results instead of dropping fields', () => {
    const response = { operation: 'authorize', result: { kind: 'connected', organizationId } };
    expect(githubBrokerResponseSchema.safeParse(response).success).toBe(true);
    expect(githubBrokerResponseSchema.safeParse({ ...response, accessToken: 'provider-token' }).success).toBe(false);
    expect(githubBrokerResponseSchema.safeParse({ ...response, result: { ...response.result, access_token: 'provider-token' } }).success).toBe(false);
    expect(githubBrokerResponseSchema.safeParse({ ...response, operation: 'readRepository' }).success).toBe(false);
    expect(githubBrokerResponseSchema.safeParse({ operation: 'readRepository', result: { kind: 'head', sha: 'a'.repeat(40), token: 'provider-token' } }).success).toBe(false);
  });

  it('binds snapshots to App, installation, repository and exact Git objects', () => {
    const result = { kind: 'snapshot', snapshot: { revision: 'a'.repeat(40), files: [{ path: 'src/index.ts', content: 'export {};\n' }] },
      digest: 'b'.repeat(64), repository: { id: 42, fullName: 'example/repo', defaultBranch: 'main', private: true, archived: false },
      installationId: '123', appId: '456', treeSha: 'c'.repeat(40) };
    expect(githubBrokerResponseSchema.safeParse({ operation: 'readRepository', result }).success).toBe(true);
    for (const change of [{ appId: undefined }, { treeSha: 'main' }, { digest: 'b'.repeat(40) }]) {
      expect(githubBrokerResponseSchema.safeParse({ operation: 'readRepository', result: { ...result, ...change } }).success).toBe(false);
    }
  });

  it('keeps public App configuration free of signing and OAuth secrets', () => {
    const app = { id: '456', clientId: 'public-client-id', slug: 'gotchu-fixture' };
    expect(singleGitHubPublicAppSchema.parse(app)).toEqual(app);
    for (const change of [{ privateKey: 'private-key' }, { clientSecret: 'oauth-secret' }, { id: 'not-an-id' }]) {
      expect(singleGitHubPublicAppSchema.safeParse({ ...app, ...change }).success).toBe(false);
    }
  });
});
