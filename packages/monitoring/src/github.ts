import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CUSTOMER_MAX_SOURCE_BYTES, CUSTOMER_MAX_SOURCE_FILES, CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';
import { gitRefSchema, type MonitoringRepositoryCatalog } from './config.js';
import { parseJsonBody, requestJson, type JsonRequestOptions } from './http.js';
import type { RepositoryReadRequest } from './local-git.js';
import type { RepositorySnapshotObservation } from './types.js';
import {
  MAX_REPOSITORY_DIFF_FILES,
  MAX_REPOSITORY_TREE_BYTES,
  MAX_REPOSITORY_TREE_ENTRIES,
  assertSafeRepositoryPath,
  buildCustomerSnapshot,
  compareTrees,
  isSupportedSourcePath,
  makeRepositoryChangeCandidate,
  makeRepositorySnapshotEvidence,
  repositoryReference,
  type SourceTreeEntry,
} from './source.js';

const gitSha = /^[a-f0-9]{40}$/i;
const apiBase = 'https://api.github.com';
const githubApiVersion = '2026-03-10';
const MAX_GITHUB_BLOB_RESPONSE_BYTES = Math.ceil((CUSTOMER_MAX_SOURCE_FILE_BYTES * 4) / 3) + 8192;
const MAX_GITHUB_BLOB_RESPONSES_BYTES = 8 * 1024 * 1024;
const treeResponseSchema = z.object({
  sha: z.string().regex(gitSha),
  tree: z.array(z.object({
    path: z.string().min(1).max(4096),
    mode: z.string().regex(/^(?:100644|100755|120000|160000|040000)$/),
    type: z.enum(['blob', 'tree', 'commit']),
    sha: z.string().regex(gitSha),
    size: z.number().int().nonnegative().optional(),
  }).passthrough()).max(100_000),
  truncated: z.boolean(),
}).passthrough();
const commitResponseSchema = z.object({
  sha: z.string().regex(gitSha),
  commit: z.object({
    committer: z.object({ date: z.string().optional() }).nullable().optional(),
    tree: z.object({ sha: z.string().regex(gitSha) }).passthrough(),
  }).passthrough(),
}).passthrough();
const repositoryResponseSchema = z.object({ default_branch: z.string().min(1).max(200) }).passthrough();
const commitListSchema = z.array(z.object({ sha: z.string().regex(gitSha) }).passthrough()).max(100);
const blobResponseSchema = z.object({
  sha: z.string().regex(gitSha),
  size: z.number().int().nonnegative(),
  encoding: z.literal('base64'),
  content: z.string().max(Math.ceil((CUSTOMER_MAX_SOURCE_FILE_BYTES * 4) / 3) + 64),
}).passthrough();

export interface GitHubRepositoryReaderOptions {
  fetchImplementation?: typeof fetch;
  installationTokenProvider?: (repository: { organizationId: string; applicationId: string; repositoryKey: string }) => Promise<string>;
  now?: () => Date;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  maxHistoryPages?: number;
  maxDiffFiles?: number;
}

export function createGitHubRepositoryReader(catalog: MonitoringRepositoryCatalog, options: GitHubRepositoryReaderOptions = {}) {
  return {
    async read(input: RepositoryReadRequest): Promise<RepositorySnapshotObservation> {
      const entry = catalog.resolve(input, input.repositoryKey);
      if (entry.provider !== 'github') throw new Error('repository_provider_mismatch');
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(options.deadlineMs ?? 60_000)])
        : AbortSignal.timeout(options.deadlineMs ?? 60_000);
      const token = options.installationTokenProvider
        ? await options.installationTokenProvider({ organizationId: input.organizationId, applicationId: input.applicationId, repositoryKey: input.repositoryKey })
        : entry.tokenFile ? await readGitHubToken(entry.tokenFile) : null;
      const requestOptions = {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': githubApiVersion,
          'user-agent': 'Gotchu-Monitoring/0.1.0',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        signal,
        timeoutMs: options.requestTimeoutMs ?? 10_000,
        maxBytes: MAX_REPOSITORY_TREE_BYTES,
        retries: 1,
          ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      } satisfies Omit<JsonRequestOptions, 'method' | 'body'>;
      const owner = encodeURIComponent(entry.owner);
      const repository = encodeURIComponent(entry.repository);
      const repoUrl = new URL('/repos/' + owner + '/' + repository, apiBase);
      let ref = entry.ref;
      if (!ref) {
        const response = await requestJson(repoUrl, requestOptions);
        const repositoryMetadata = repositoryResponseSchema.parse(parseJsonBody(response.body));
        ref = gitRefSchema.parse(repositoryMetadata.default_branch);
      }
      const currentCommit = await readCommit(repoUrl, ref, requestOptions);
      let previousRevision: string | null = null;
      let previousCommit: CommitRead | null = null;
      let historyTruncated = false;
      if (input.previousRevision !== undefined && input.previousRevision !== null) {
        if (!gitSha.test(input.previousRevision)) throw new Error('previous_revision_invalid');
        previousRevision = input.previousRevision.toLowerCase();
        if (previousRevision !== currentCommit.sha) {
          historyTruncated = await inspectHistory(repoUrl, currentCommit.sha, previousRevision, requestOptions, options.maxHistoryPages ?? 5);
          previousCommit = await readCommit(repoUrl, previousRevision, requestOptions);
        }
      }
      const currentTree = await readTree(repoUrl, currentCommit.treeSha, requestOptions);
      const previousTree = previousCommit ? await readTree(repoUrl, previousCommit.treeSha, requestOptions) : null;
      const sourceEntries = currentTree.filter(entry => entry.type !== 'tree');
      const contents = await readBlobs(repoUrl, sourceEntries, requestOptions, requestOptions.signal);
      const built = buildCustomerSnapshot(currentCommit.sha, sourceEntries, contents);
      const treeDiff = previousTree && previousRevision !== currentCommit.sha ? compareTrees(previousTree, currentTree) : [];
      const maxDiffFiles = options.maxDiffFiles ?? MAX_REPOSITORY_DIFF_FILES;
      const filesTruncated = treeDiff.length > maxDiffFiles;
      const capturedAt = (options.now ?? (() => new Date()))().toISOString();
      const state = previousRevision === null ? 'baseline' : previousRevision === currentCommit.sha ? 'unchanged' : 'changed';
      const change = {
        state,
        previousRevision,
        revision: currentCommit.sha,
        files: treeDiff.slice(0, maxDiffFiles),
        filesTruncated,
        historyTruncated,
      } as const;
      const candidate = state === 'changed' && previousRevision
        ? makeRepositoryChangeCandidate({
          repositoryKey: input.repositoryKey,
          reference: repositoryReference('github', input.repositoryKey, currentCommit.sha, entry.owner, entry.repository),
          previousRevision,
          revision: currentCommit.sha,
          files: treeDiff,
          filesTruncated,
          observedAt: capturedAt,
        })
        : null;
      const repositoryEvidence = makeRepositorySnapshotEvidence({
        provider: 'github',
        repositoryKey: input.repositoryKey,
        repositoryReference: repositoryReference('github', input.repositoryKey, currentCommit.sha, entry.owner, entry.repository),
        digest: built.digest,
        collectedAt: capturedAt,
      });
      const limitations = [
        'Source snapshot contains only the supported JS/TS, JSON, YAML and TOML paths; customer code is never executed.',
        'GitHub response data was pinned to the resolved commit SHA before the tree or blob reads.',
      ];
      if (built.excludedUnsupportedFiles > 0) limitations.push(built.excludedUnsupportedFiles + ' repository files were outside the source snapshot path allowlist.');
      if (built.excludedSymlinks > 0) limitations.push(built.excludedSymlinks + ' symlinks were excluded without following their targets.');
      if (built.excludedSubmodules > 0) limitations.push(built.excludedSubmodules + ' Git submodules were excluded; their repository contents were not read.');
      if (filesTruncated) limitations.push('The changed-path list was capped; the commit and snapshot remain exact.');
      if (historyTruncated) limitations.push('GitHub commit history pagination reached the configured page bound; the exact tree diff is still pinned and complete.');
      return {
        repositoryKey: input.repositoryKey,
        provider: 'github',
        commit: currentCommit,
        change,
        snapshot: built.snapshot,
        digest: built.digest,
        includedFiles: built.snapshot.files.length,
        excludedUnsupportedFiles: built.excludedUnsupportedFiles,
        excludedSymlinks: built.excludedSymlinks,
        excludedSubmodules: built.excludedSubmodules,
        capturedAt,
        evidence: [repositoryEvidence, ...(candidate?.evidence ?? [])],
        candidate,
        limitations,
      };
    },
  };
}

interface CommitRead {
  sha: string;
  treeSha: string;
  committedAt: string | null;
}

async function readCommit(base: URL, ref: string, options: Omit<JsonRequestOptions, 'method' | 'body'>): Promise<CommitRead> {
  const url = new URL(base.pathname + '/commits/' + encodeURIComponent(ref), base.origin);
  const response = await requestJson(url, options);
  const parsed = commitResponseSchema.parse(parseJsonBody(response.body));
  const committedAt = parsed.commit.committer?.date;
  return {
    sha: parsed.sha.toLowerCase(),
    treeSha: parsed.commit.tree.sha.toLowerCase(),
    committedAt: committedAt && Number.isFinite(Date.parse(committedAt)) ? new Date(committedAt).toISOString() : null,
  };
}

async function readTree(base: URL, treeSha: string, options: Omit<JsonRequestOptions, 'method' | 'body'>): Promise<SourceTreeEntry[]> {
  const url = new URL(base.pathname + '/git/trees/' + encodeURIComponent(treeSha) + '?recursive=1', base.origin);
  const response = await requestJson(url, { ...options, maxBytes: MAX_REPOSITORY_TREE_BYTES });
  const parsed = treeResponseSchema.parse(parseJsonBody(response.body));
  if (parsed.truncated) throw new Error('github_tree_truncated');
  if (parsed.tree.length > MAX_REPOSITORY_TREE_ENTRIES) throw new Error('repository_tree_entry_limit');
  const entries: SourceTreeEntry[] = [];
  for (const item of parsed.tree) {
    assertSafeRepositoryPath(item.path);
    entries.push({ path: item.path, mode: item.mode, type: item.type, sha: item.sha.toLowerCase(), ...(item.size === undefined ? {} : { size: item.size }) });
  }
  return entries;
}

async function readBlobs(
  base: URL,
  tree: readonly SourceTreeEntry[],
  options: Omit<JsonRequestOptions, 'method' | 'body'>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const blobs = tree.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && isSupportedSourcePath(entry.path));
  if (blobs.length > CUSTOMER_MAX_SOURCE_FILES) throw new Error('repository_source_file_limit');
  // Tree sizes are a pre-fetch estimate; decoded blob bytes are checked against the aggregate limit below.
  let selectedTreeBytes = 0;
  for (const entry of blobs) {
    if (entry.size === undefined || entry.size > CUSTOMER_MAX_SOURCE_FILE_BYTES) throw new Error('repository_source_file_limit');
    if (entry.size > CUSTOMER_MAX_SOURCE_BYTES - selectedTreeBytes) throw new Error('repository_source_bytes_limit');
    selectedTreeBytes += entry.size;
  }

  const contents = new Map<string, string>();
  const abortController = new AbortController();
  const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let downloadedResponseBytes = 0;
  let downloadedSourceBytes = 0;
  let failed = false;
  let firstFailure: unknown;

  // GitHub's base64 response is larger than the source snapshot. Cap its aggregate
  // serialized size while streaming so many small tree entries cannot retain huge
  // provider response bodies before the snapshot validator runs.
  const budgetedFetch: typeof fetch = async (input, init) => {
    const response = await fetchImplementation(input, init);
    if (!response.ok || !response.body) return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (workerSignal.aborted) throw workerSignal.reason;
        if (chunk.byteLength > MAX_GITHUB_BLOB_RESPONSES_BYTES - downloadedResponseBytes) {
          const error = new Error('repository_source_bytes_limit');
          abortController.abort(error);
          throw error;
        }
        downloadedResponseBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < blobs.length) {
      workerSignal.throwIfAborted();
      const entry = blobs[cursor];
      cursor += 1;
      if (!entry) continue;
      const url = new URL(base.pathname + '/git/blobs/' + encodeURIComponent(entry.sha), base.origin);
      const response = await requestJson(url, {
        ...options,
        signal: workerSignal,
        maxBytes: MAX_GITHUB_BLOB_RESPONSE_BYTES,
        fetchImplementation: budgetedFetch,
      });
      const parsed = blobResponseSchema.parse(parseJsonBody(response.body));
      if (parsed.sha.toLowerCase() !== entry.sha || parsed.size > CUSTOMER_MAX_SOURCE_FILE_BYTES) {
        throw new Error('github_blob_mismatch');
      }
      const encoded = parsed.content.replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('github_blob_invalid');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.byteLength !== parsed.size) throw new Error('github_blob_mismatch');
      if (bytes.byteLength > CUSTOMER_MAX_SOURCE_BYTES - downloadedSourceBytes) throw new Error('repository_source_bytes_limit');
      downloadedSourceBytes += bytes.byteLength;
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('repository_source_not_utf8');
      }
      contents.set(entry.path, content);
    }
  };

  const observeWorker = async () => {
    try {
      await worker();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
        abortController.abort(error);
      }
      throw error;
    }
  };
  const workers = Array.from({ length: Math.min(4, blobs.length) }, () => observeWorker());
  const results = await Promise.allSettled(workers);
  if (failed) throw firstFailure;
  const rejected = results.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  return contents;
}

async function inspectHistory(
  base: URL,
  head: string,
  previous: string,
  options: Omit<JsonRequestOptions, 'method' | 'body'>,
  maxPages: number,
): Promise<boolean> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('invalid_history_page_limit');
  let url = new URL(base.pathname + '/commits?sha=' + encodeURIComponent(head) + '&per_page=100&page=1', base.origin);
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await requestJson(url, { ...options, maxBytes: 1_048_576 });
    const commits = commitListSchema.parse(parseJsonBody(response.body));
    if (commits.some(commit => commit.sha.toLowerCase() === previous)) return false;
    const next = nextPage(response.headers.get('link'), url, base, head);
    if (!next) return false;
    if (page === maxPages) return true;
    url = next;
  }
  return true;
}

function nextPage(linkHeader: string | null, current: URL, base: URL, head: string): URL | null {
  if (!linkHeader) return null;
  const next = [...linkHeader.matchAll(/<([^>]+)>\s*;\s*rel="next"/g)][0]?.[1];
  if (!next) return null;
  const url = new URL(next, base.origin);
  if (url.protocol !== 'https:' || url.origin !== base.origin || url.pathname !== base.pathname + '/commits'
      || url.searchParams.get('sha') !== head || url.searchParams.get('per_page') !== '100') {
    throw new Error('github_pagination_link_invalid');
  }
  const page = Number(url.searchParams.get('page'));
  const currentPage = Number(current.searchParams.get('page'));
  if (!Number.isSafeInteger(page) || page !== currentPage + 1 || [...url.searchParams.keys()].some(key => !['sha', 'per_page', 'page'].includes(key))) {
    throw new Error('github_pagination_link_invalid');
  }
  return url;
}

async function readGitHubToken(tokenFile: string): Promise<string> {
  const filePath = resolve(tokenFile);
  const beforeOpen = await lstat(filePath).catch(() => null);
  if (!beforeOpen?.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > 8192 || (beforeOpen.mode & 0o077) !== 0) throw new Error('github_token_file_unsafe');
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new Error('github_token_file_unsafe');
  let tokenText: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino || opened.size > 8192 || (opened.mode & 0o077) !== 0) {
      throw new Error('github_token_file_unsafe');
    }
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 8192) throw new Error('github_token_file_unsafe');
    tokenText = bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
  const token = tokenText.trim();
  if (!/^[A-Za-z0-9_]{20,4096}$/.test(token)) throw new Error('github_token_invalid');
  return token;
}
