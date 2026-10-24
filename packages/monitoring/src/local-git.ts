import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { CUSTOMER_MAX_SOURCE_BYTES, CUSTOMER_MAX_SOURCE_FILES, CUSTOMER_MAX_SOURCE_FILE_BYTES } from '@gotchu/contracts';
import type { MonitoringRepositoryCatalog, RepositoryScope } from './config.js';
import type { RepositorySnapshotObservation } from './types.js';
import {
  MAX_REPOSITORY_DIFF_FILES,
  MAX_REPOSITORY_TREE_BYTES,
  MAX_REPOSITORY_TREE_ENTRIES,
  buildCustomerSnapshot,
  compareTrees,
  makeRepositoryChangeCandidate,
  makeRepositorySnapshotEvidence,
  repositoryReference,
  isSupportedSourcePath,
  assertSafeRepositoryPath,
  type SourceTreeEntry,
} from './source.js';

const commitShaSchema = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const SAFE_CONFIG_KEYS = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'extensions.objectformat',
]);

export interface LocalGitRepositoryReaderOptions {
  now?: () => Date;
  commandTimeoutMs?: number;
  maxDiffFiles?: number;
}

export interface RepositoryReadRequest extends RepositoryScope {
  repositoryKey: string;
  previousRevision?: string | null;
  signal?: AbortSignal;
}

export function createLocalGitRepositoryReader(catalog: MonitoringRepositoryCatalog, options: LocalGitRepositoryReaderOptions = {}) {
  return {
    async read(input: RepositoryReadRequest): Promise<RepositorySnapshotObservation> {
      const entry = catalog.resolve(input, input.repositoryKey);
      if (entry.provider !== 'local_git') throw new Error('repository_provider_mismatch');
      const repositoryPath = await assertManagedBareRepository(catalog.repositoryRoot(), entry.path, catalog.repositoryPath(entry));
      const workspace = await mkdtemp(resolve(tmpdir(), 'gotchu-monitor-git-'));
      const now = options.now ?? (() => new Date());
      const commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
      try {
        const emptyConfig = resolve(workspace, 'empty-config');
        const hooksDirectory = resolve(workspace, 'hooks');
        const attributesFile = resolve(workspace, 'attributes');
        const excludeFile = resolve(workspace, 'exclude');
        await Promise.all([writeFile(emptyConfig, ''), mkdir(hooksDirectory), writeFile(attributesFile, ''), writeFile(excludeFile, '')]);
        const run = (args: string[], maxOutput: number, stdin?: Buffer): Promise<Buffer> =>
          runGit(workspace, repositoryPath, args, {
            maxOutput,
            timeoutMs: commandTimeoutMs,
            globalConfig: emptyConfig,
            hooksDirectory,
            attributesFile,
            excludeFile,
            ...(stdin === undefined ? {} : { stdin }),
            ...(input.signal ? { signal: input.signal } : {}),
          });
        const resolved = (await run(['rev-parse', '--verify', '--end-of-options', entry.ref + '^{commit}'], 256)).toString('ascii').trim();
        if (!commitShaSchema.test(resolved)) throw new Error('repository_commit_invalid');
        const commit = await readCommitMetadata(run, resolved);
        const tree = await readTree(run, commit.treeSha);
        let previousRevision: string | null = null;
        let previousTree: SourceTreeEntry[] | null = null;
        if (input.previousRevision !== undefined && input.previousRevision !== null) {
          if (!commitShaSchema.test(input.previousRevision)) throw new Error('previous_revision_invalid');
          previousRevision = (await run(['rev-parse', '--verify', '--end-of-options', input.previousRevision + '^{commit}'], 256)).toString('ascii').trim();
          if (!commitShaSchema.test(previousRevision)) throw new Error('previous_commit_invalid');
          const previousCommit = await readCommitMetadata(run, previousRevision);
          previousTree = await readTree(run, previousCommit.treeSha);
        }
        const capturedAt = now().toISOString();
        const contents = await readBlobContents(run, tree, CUSTOMER_MAX_SOURCE_FILES, input.signal);
        const built = buildCustomerSnapshot(commit.sha, tree, contents);
        const treeDiff = previousTree && previousRevision !== commit.sha ? compareTrees(previousTree, tree) : [];
        const maxDiffFiles = options.maxDiffFiles ?? MAX_REPOSITORY_DIFF_FILES;
        const filesTruncated = treeDiff.length > maxDiffFiles;
        const state = previousRevision === null ? 'baseline' : previousRevision === commit.sha ? 'unchanged' : 'changed';
        const change = {
          state,
          previousRevision,
          revision: commit.sha,
          files: treeDiff.slice(0, maxDiffFiles),
          filesTruncated,
          historyTruncated: false,
        } as const;
        const candidate = state === 'changed' && previousRevision
          ? makeRepositoryChangeCandidate({
            repositoryKey: input.repositoryKey,
            reference: repositoryReference('local_git', input.repositoryKey, commit.sha),
            previousRevision,
            revision: commit.sha,
            files: treeDiff,
            filesTruncated,
            observedAt: capturedAt,
          })
          : null;
        const repositoryEvidence = makeRepositorySnapshotEvidence({
          provider: 'local_git',
          repositoryKey: input.repositoryKey,
          repositoryReference: repositoryReference('local_git', input.repositoryKey, commit.sha),
          digest: built.digest,
          collectedAt: capturedAt,
        });
        return {
          repositoryKey: input.repositoryKey,
          provider: 'local_git',
          commit,
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
          limitations: limitations(built.excludedUnsupportedFiles, built.excludedSymlinks, built.excludedSubmodules, filesTruncated),
        };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  };
}

async function assertManagedBareRepository(rootPath: string, relativeRepositoryPath: string, repositoryPath: string): Promise<string> {
  const canonicalRoot = await realpath(rootPath).catch(() => {
    throw new Error('repository_root_unavailable');
  });
  if (canonicalRoot !== resolve(rootPath)) throw new Error('repository_root_unsafe');
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('repository_root_unsafe');
  let current = canonicalRoot;
  for (const part of relativeRepositoryPath.split('/')) {
    current = resolve(current, part);
    const segment = await lstat(current).catch(() => null);
    if (!segment || segment.isSymbolicLink()) throw new Error('repository_path_unsafe');
  }
  const rootFromEntry = resolve(repositoryPath);
  if (!isAbsolute(rootFromEntry)) throw new Error('repository_path_invalid');
  let stat;
  try {
    stat = await lstat(rootFromEntry);
  } catch {
    throw new Error('repository_not_available');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('repository_path_unsafe');
  const resolvedPath = await realpath(rootFromEntry);
  const withinRoot = relative(canonicalRoot, resolvedPath);
  if (withinRoot === '..' || withinRoot.startsWith('..' + sep) || isAbsolute(withinRoot)) throw new Error('repository_path_escape');
  const configStat = await lstat(resolve(resolvedPath, 'config')).catch(() => null);
  if (!configStat?.isFile() || configStat.isSymbolicLink()) throw new Error('repository_config_unsafe');
  const configBytes = await readFile(resolve(resolvedPath, 'config'));
  if (configBytes.byteLength > 64 * 1024) throw new Error('repository_config_limit');
  assertMinimalGitConfig(configBytes.toString('utf8'));

  for (const relativePath of ['HEAD', 'objects', 'refs']) {
    const file = resolve(resolvedPath, relativePath);
    const item = await lstat(file).catch(() => null);
    if (!item || item.isSymbolicLink() || (relativePath === 'objects' || relativePath === 'refs' ? !item.isDirectory() : !item.isFile())) {
      throw new Error('repository_layout_unsafe');
    }
  }
  for (const relativePath of ['objects/info', 'objects/pack']) {
    const directory = resolve(resolvedPath, relativePath);
    const item = await lstat(directory).catch(() => null);
    if (item?.isSymbolicLink()) throw new Error('repository_path_unsafe');
    if (item && !item.isDirectory()) throw new Error('repository_layout_unsafe');
  }
  for (const relativePath of ['objects/info/alternates', 'commondir']) {
    const file = resolve(resolvedPath, relativePath);
    const item = await lstat(file).catch(() => null);
    if (item?.isSymbolicLink()) throw new Error('repository_external_objects_refused');
    if (relativePath === 'commondir' && item) throw new Error('repository_worktree_refused');
    if (relativePath.endsWith('/alternates') && item) {
      if (!item.isFile() || item.size > 0) throw new Error('repository_external_objects_refused');
    }
  }
  return resolvedPath;
}

function assertMinimalGitConfig(config: string): void {
  let section = '';
  const seen = new Set<string>();
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z0-9]+)\]$/.exec(line);
    if (header) {
      section = header[1]?.toLowerCase() ?? '';
      if (!['core', 'extensions'].includes(section)) throw new Error('repository_config_unsafe');
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!pair || !section) throw new Error('repository_config_unsafe');
    const key = section + '.' + pair[1]?.toLowerCase();
    const value = pair[2]?.replace(/^"(.*)"$/, '$1') ?? '';
    if (!SAFE_CONFIG_KEYS.has(key) || seen.has(key) || value.includes('\\') || value.includes('"')) throw new Error('repository_config_unsafe');
    seen.add(key);
    if (key === 'core.bare' && value !== 'true') throw new Error('repository_not_bare');
    if (key === 'extensions.objectformat' && value !== 'sha1' && value !== 'sha256') throw new Error('repository_object_format_unsupported');
    if (key === 'core.repositoryformatversion' && !/^(?:0|1)$/.test(value)) throw new Error('repository_config_unsafe');
  }
  if (!seen.has('core.bare') || !seen.has('core.repositoryformatversion')) throw new Error('repository_not_bare');
}

async function readCommitMetadata(run: GitRunner, revision: string): Promise<{ sha: string; committedAt: string | null; treeSha: string }> {
  const output = (await run(['show', '-s', '--format=%H%x00%T%x00%cI', '--no-patch', revision], 512)).toString('utf8').trim();
  const [sha, treeSha, timestamp] = output.split('\0');
  if (!sha || !treeSha || !commitShaSchema.test(sha) || !commitShaSchema.test(treeSha)) throw new Error('repository_commit_invalid');
  const parsedDate = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
  return { sha, treeSha, committedAt: parsedDate };
}

async function readTree(run: GitRunner, revision: string): Promise<SourceTreeEntry[]> {
  const output = await run(['ls-tree', '-r', '-z', '-l', '--full-tree', revision], MAX_REPOSITORY_TREE_BYTES);
  const records = output.toString('binary').split('\0');
  if (records.at(-1) === '') records.pop();
  if (records.length > MAX_REPOSITORY_TREE_ENTRIES) throw new Error('repository_tree_entry_limit');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: SourceTreeEntry[] = [];
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('repository_tree_invalid');
    const header = record.slice(0, tab).trim().split(/\s+/);
    const pathBytes = Buffer.from(record.slice(tab + 1), 'binary');
    let path: string;
    try {
      path = decoder.decode(pathBytes);
    } catch {
      throw new Error('repository_path_invalid_encoding');
    }
    assertSafeRepositoryPath(path);
    const mode = header[0] ?? '';
    const type = header[1] ?? '';
    const sha = header[2] ?? '';
    if (!/^(?:100644|100755|120000|160000)$/.test(mode) || !['blob', 'commit'].includes(type) || !commitShaSchema.test(sha)) throw new Error('repository_tree_invalid');
    if ((mode === '160000') !== (type === 'commit')) throw new Error('repository_tree_invalid');
    let size: number | undefined;
    if (mode === '160000') {
      if (header[3] !== '-') throw new Error('repository_tree_invalid');
    } else {
      if (header[3] === undefined || header[3] === '-') throw new Error('repository_tree_invalid');
      size = Number(header[3]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('repository_tree_invalid');
    }
    entries.push({ path, mode, type: type as SourceTreeEntry['type'], sha, ...(size === undefined ? {} : { size }) });
  }
  return entries;
}

async function readBlobContents(run: GitRunner, tree: readonly SourceTreeEntry[], maxFiles: number, signal?: AbortSignal): Promise<Map<string, string>> {
  const blobs = tree.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && isSupportedSourcePath(entry.path));
  if (blobs.length > maxFiles) throw new Error('repository_source_file_limit');
  let totalKnownBytes = 0;
  for (const blob of blobs) {
    if (blob.size === undefined || blob.size > CUSTOMER_MAX_SOURCE_FILE_BYTES) throw new Error('repository_source_file_limit');
    totalKnownBytes += blob.size;
    if (totalKnownBytes > CUSTOMER_MAX_SOURCE_BYTES) throw new Error('repository_source_bytes_limit');
  }
  const contents = new Map<string, string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < blobs.length) {
    signal?.throwIfAborted();
    const batch: SourceTreeEntry[] = [];
    let batchSize = 0;
    for (const blob of blobs.slice(offset)) {
      if (batch.length >= 100 || batchSize + (blob.size ?? 0) > CUSTOMER_MAX_SOURCE_BYTES) break;
      batch.push(blob);
      batchSize += blob.size ?? 0;
    }
    if (batch.length === 0) throw new Error('repository_source_bytes_limit');
    offset += batch.length;
    const input = Buffer.from(batch.map(item => item.sha).join('\n') + '\n');
    const output = await run(['cat-file', '--batch'], CUSTOMER_MAX_SOURCE_BYTES + 64 * batch.length, input);
    let cursor = 0;
    for (const entry of batch) {
      const headerEnd = output.indexOf(10, cursor);
      if (headerEnd < 0) throw new Error('repository_blob_invalid');
      const header = output.subarray(cursor, headerEnd).toString('ascii').split(' ');
      cursor = headerEnd + 1;
      const sha = header[0] ?? '';
      const type = header[1] ?? '';
      const size = Number(header[2]);
      if (sha !== entry.sha || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > CUSTOMER_MAX_SOURCE_FILE_BYTES
          || entry.size !== undefined && size !== entry.size || cursor + size >= output.length || output[cursor + size] !== 10) {
        throw new Error('repository_blob_limit_or_invalid');
      }
      if (contents.has(entry.path)) throw new Error('repository_duplicate_path');
      let content: string;
      try {
        content = decoder.decode(output.subarray(cursor, cursor + size));
      } catch {
        throw new Error('repository_source_not_utf8');
      }
      contents.set(entry.path, content);
      cursor += size + 1;
      if (contents.size > maxFiles) throw new Error('repository_blob_limit');
    }
    if (cursor !== output.length) throw new Error('repository_blob_invalid');
  }
  return contents;
}

type GitRunner = (args: string[], maxOutput: number, stdin?: Buffer) => Promise<Buffer>;

interface GitCommandOptions {
  maxOutput: number;
  stdin?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  globalConfig: string;
  hooksDirectory: string;
  attributesFile: string;
  excludeFile: string;
}

function runGit(workspace: string, repositoryPath: string, args: string[], options: GitCommandOptions): Promise<Buffer> {
  const ownTimeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, ownTimeout]) : ownTimeout;
  signal.throwIfAborted();
  const gitArgs = [
    '--no-pager',
    '--git-dir=' + repositoryPath,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + options.hooksDirectory,
    '-c', 'core.attributesFile=' + options.attributesFile,
    '-c', 'core.excludesFile=' + options.excludeFile,
    '-c', 'diff.external=',
    '-c', 'protocol.file.allow=never',
    ...args,
  ];
  return new Promise((resolveOutput, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workspace,
        XDG_CONFIG_HOME: workspace,
        GIT_CONFIG_GLOBAL: options.globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let settled = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolveOutput(value ?? Buffer.alloc(0));
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(new Error(options.signal?.aborted ? 'repository_read_cancelled' : 'repository_command_timeout'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutput) {
        child.kill('SIGKILL');
        finish(new Error('repository_command_output_limit'));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 8192) {
        child.kill('SIGKILL');
        finish(new Error('repository_command_stderr_limit'));
      }
    });
    child.on('error', () => finish(new Error('repository_git_unavailable')));
    child.on('close', code => {
      if (code !== 0) finish(new Error('repository_git_command_failed'));
      else finish(null, Buffer.concat(output, size));
    });
    child.stdin.on('error', () => finish(new Error('repository_git_command_failed')));
    child.stdin.end(options.stdin);
  });
}

function limitations(unsupported: number, symlinks: number, submodules: number, diffTruncated: boolean): string[] {
  const notes = ['Source snapshot contains only the supported JS/TS, JSON, YAML and TOML paths; customer code is never executed.'];
  if (unsupported > 0) notes.push(unsupported + ' repository files were outside the source snapshot path allowlist.');
  if (symlinks > 0) notes.push(symlinks + ' symlinks were excluded without following their targets.');
  if (submodules > 0) notes.push(submodules + ' Git submodules were excluded; their repository contents were not read.');
  if (diffTruncated) notes.push('The changed-path list was capped; the commit and snapshot remain exact.');
  return notes;
}
