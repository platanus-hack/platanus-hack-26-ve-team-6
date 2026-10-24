import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitoringRepositoryCatalog } from '../src/config.js';
import { createGitHubRepositoryReader } from '../src/github.js';

const directories: string[] = [];
async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-monitor-github-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

describe('GitHub REST repository reader', () => {
  it('pins snapshots to a resolved commit, follows bounded commit pagination, and sends an optional token only in Authorization', async () => {
    const root = await tempDirectory();
    const tokenFile = join(root, 'github-token');
    const token = 'ghp_' + 'x'.repeat(36);
    await writeFile(tokenFile, token + '\n', { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const catalog = createMonitoringRepositoryCatalog({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'private-source', displayName: 'Private repository', provider: 'github', owner: 'acme', repository: 'product', tokenFile }],
    });
    const previousSha = 'b'.repeat(40);
    const headSha = 'a'.repeat(40);
    const currentTreeSha = 'c'.repeat(40);
    const previousTreeSha = 'd'.repeat(40);
    const contents = Buffer.from('export const current = true;\n');
    const blobSha = createHash('sha1').update('blob ' + contents.length + '\0').update(contents).digest('hex');
    const requested: Array<{ url: string; authorization: string | null; apiVersion: string | null }> = [];
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const requestUrl = new URL(url);
      const headers = new Headers(init?.headers);
      requested.push({ url, authorization: headers.get('authorization'), apiVersion: headers.get('x-github-api-version') });
      if (requestUrl.hostname !== 'api.github.com') throw new Error('unexpected_github_host');

      if (requestUrl.pathname === '/repos/acme/product') return jsonResponse({ default_branch: 'main', private: true });
      if (requestUrl.pathname === '/repos/acme/product/commits/main') {
        return jsonResponse({ sha: headSha, commit: { committer: { date: '2026-10-24T07:00:00Z' }, tree: { sha: currentTreeSha, url: 'https://api.github.com/tree' } } });
      }
      if (requestUrl.pathname === '/repos/acme/product/commits/' + previousSha) {
        return jsonResponse({ sha: previousSha, commit: { committer: { date: '2026-10-23T07:00:00Z' }, tree: { sha: previousTreeSha } } });
      }
      if (requestUrl.pathname === '/repos/acme/product/commits' && requestUrl.searchParams.get('page') === '1') {
        const next = 'https://api.github.com/repos/acme/product/commits?sha=' + headSha + '&per_page=100&page=2';
        return jsonResponse([{ sha: headSha }], { link: '<' + next + '>; rel=\"next\"' });
      }
      if (requestUrl.pathname === '/repos/acme/product/commits' && requestUrl.searchParams.get('page') === '2') {
        return jsonResponse([{ sha: previousSha }]);
      }
      if (requestUrl.pathname === '/repos/acme/product/git/trees/' + currentTreeSha) {
        return jsonResponse({
          sha: currentTreeSha,
          url: 'https://api.github.com/tree',
          truncated: false,
          tree: [{ path: 'src/main.ts', mode: '100644', type: 'blob', sha: blobSha, size: contents.length, url: 'https://api.github.com/blob/' + blobSha }],
        });
      }
      if (requestUrl.pathname === '/repos/acme/product/git/trees/' + previousTreeSha) {
        return jsonResponse({
          sha: previousTreeSha,
          truncated: false,
          tree: [{ path: 'src/main.ts', mode: '100644', type: 'blob', sha: 'e'.repeat(40), size: 1 }],
        });
      }
      if (requestUrl.pathname === '/repos/acme/product/git/blobs/' + blobSha) {
        return jsonResponse({ sha: blobSha, size: contents.length, encoding: 'base64', content: contents.toString('base64') + '\n', url: 'https://api.github.com/blob/' + blobSha });
      }
      throw new Error('unexpected_github_route');
    };
    const reader = createGitHubRepositoryReader(catalog, { fetchImplementation: fetchFixture, now: () => new Date('2026-10-24T08:00:00Z') });

    const observed = await reader.read({ ...scope, repositoryKey: 'private-source', previousRevision: previousSha });
    expect(observed.provider).toBe('github');
    expect(observed.commit.sha).toBe(headSha);
    expect(observed.snapshot.revision).toBe(headSha);
    expect(observed.snapshot.files).toEqual([{ path: 'src/main.ts', content: contents.toString('utf8') }]);
    expect(observed.change.state).toBe('changed');
    expect(observed.change.files).toEqual([{ path: 'src/main.ts', status: 'modified' }]);
    expect(observed.change.historyTruncated).toBe(false);
    expect(requested.some(request => request.url.includes('page=2'))).toBe(true);
    expect(requested.every(request => request.authorization === 'Bearer ' + token)).toBe(true);
    expect(requested.every(request => request.apiVersion === '2026-03-10')).toBe(true);
    expect(requested.every(request => !request.url.includes(token))).toBe(true);
    expect(observed.evidence[0]?.reference).toBe('https://github.com/acme/product/commit/' + headSha);
    expect(observed.candidate?.kind).toBe('repository_change');
  });

  it('refuses redirects without following a provider-selected host', async () => {
    const root = await tempDirectory();
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const catalog = createMonitoringRepositoryCatalog({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'public-source', displayName: 'Public', provider: 'github', owner: 'acme', repository: 'product', ref: 'main' }],
    });
    const fetchFixture: typeof fetch = async () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
    const reader = createGitHubRepositoryReader(catalog, { fetchImplementation: fetchFixture });
    await expect(reader.read({ ...scope, repositoryKey: 'public-source' })).rejects.toThrow('redirect_refused');
  });
});
