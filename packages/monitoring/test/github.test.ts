import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';
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

  it('rejects an oversized selected source tree before requesting any blobs', async () => {
    const root = await tempDirectory();
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const catalog = createMonitoringRepositoryCatalog({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'public-source', displayName: 'Public', provider: 'github', owner: 'acme', repository: 'product', ref: 'main' }],
    });
    const headSha = 'a'.repeat(40);
    const treeSha = 'b'.repeat(40);
    const entries = Array.from({ length: 5 }, (_, index) => ({
      path: 'src/file-' + index + '.ts',
      mode: '100644',
      type: 'blob',
      sha: String(index + 1).padStart(40, '0'),
      size: CUSTOMER_MAX_SOURCE_FILE_BYTES,
    }));
    let blobRequests = 0;
    const fetchFixture: typeof fetch = async input => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.pathname === '/repos/acme/product/commits/main') {
        return jsonResponse({ sha: headSha, commit: { tree: { sha: treeSha } } });
      }
      if (requestUrl.pathname === '/repos/acme/product/git/trees/' + treeSha) {
        return jsonResponse({ sha: treeSha, truncated: false, tree: entries });
      }
      if (requestUrl.pathname.includes('/git/blobs/')) blobRequests += 1;
      throw new Error('unexpected_github_route');
    };
    const reader = createGitHubRepositoryReader(catalog, { fetchImplementation: fetchFixture });

    await expect(reader.read({ ...scope, repositoryKey: 'public-source' })).rejects.toThrow('repository_source_bytes_limit');
    expect(blobRequests).toBe(0);
  });

  it('caps actual blob bytes when tree sizes are understated and aborts and observes a stalled worker', async () => {
    const root = await tempDirectory();
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const catalog = createMonitoringRepositoryCatalog({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'public-source', displayName: 'Public', provider: 'github', owner: 'acme', repository: 'product', ref: 'main' }],
    });
    const headSha = 'a'.repeat(40);
    const treeSha = 'b'.repeat(40);
    const entries = Array.from({ length: 20 }, (_, index) => ({
      path: 'src/file-' + index + '.ts',
      mode: '100644',
      type: 'blob',
      sha: String(index + 1).padStart(40, '0'),
      size: 1,
    }));
    const encodedSource = Buffer.alloc(CUSTOMER_MAX_SOURCE_FILE_BYTES, 0x61).toString('base64');
    let blobRequests = 0;
    let stalledWorkerAborted = false;
    const fetchFixture: typeof fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.pathname === '/repos/acme/product/commits/main') {
        return jsonResponse({ sha: headSha, commit: { tree: { sha: treeSha } } });
      }
      if (requestUrl.pathname === '/repos/acme/product/git/trees/' + treeSha) {
        return jsonResponse({ sha: treeSha, truncated: false, tree: entries });
      }
      const blobIndex = entries.findIndex(entry => requestUrl.pathname.endsWith('/git/blobs/' + entry.sha));
      if (blobIndex === -1) throw new Error('unexpected_github_route');
      blobRequests += 1;
      if (blobIndex === 3) {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              stalledWorkerAborted = true;
              controller.error(signal.reason);
            }, { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return jsonResponse({
        sha: entries[blobIndex]?.sha,
        size: CUSTOMER_MAX_SOURCE_FILE_BYTES,
        encoding: 'base64',
        content: encodedSource,
      });
    };
    const reader = createGitHubRepositoryReader(catalog, { fetchImplementation: fetchFixture });

    await expect(reader.read({ ...scope, repositoryKey: 'public-source' })).rejects.toThrow('repository_source_bytes_limit');
    expect(blobRequests).toBeGreaterThan(4);
    expect(blobRequests).toBeLessThan(entries.length);
    expect(stalledWorkerAborted).toBe(true);
  });
});
