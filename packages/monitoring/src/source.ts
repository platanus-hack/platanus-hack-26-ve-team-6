import { createHash } from 'node:crypto';
import { CUSTOMER_MAX_SOURCE_FILES, customerSourceFileSchema, customerSourceSnapshotSchema, type CustomerSourceSnapshot } from '@gotchu/contracts';
import type { MonitoringCandidate, MonitoringEvidence, RepositoryChange } from './types.js';

export const MAX_REPOSITORY_TREE_ENTRIES = 25_000;
export const MAX_REPOSITORY_TREE_BYTES = 8 * 1024 * 1024;
export const MAX_REPOSITORY_DIFF_FILES = 300;
export const OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SourceTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface SnapshotBuildResult {
  snapshot: CustomerSourceSnapshot;
  digest: string;
  excludedUnsupportedFiles: number;
  excludedSymlinks: number;
  excludedSubmodules: number;
}

export function isSupportedSourcePath(path: string): boolean {
  const parsed = customerSourceFileSchema.shape.path.safeParse(path);
  if (!parsed.success) assertSafeRepositoryPath(path);
  return parsed.success;
}

export function buildCustomerSnapshot(revision: string, treeEntries: readonly SourceTreeEntry[], contents: ReadonlyMap<string, string>): SnapshotBuildResult {
  if (treeEntries.length > MAX_REPOSITORY_TREE_ENTRIES) throw new Error('repository_tree_entry_limit');
  const files: Array<{ path: string; content: string }> = [];
  let excludedUnsupportedFiles = 0;
  let excludedSymlinks = 0;
  let excludedSubmodules = 0;

  for (const entry of treeEntries) {
    if (entry.type === 'commit' || entry.mode === '160000') {
      excludedSubmodules += 1;
      continue;
    }
    if (entry.mode === '120000') {
      excludedSymlinks += 1;
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) continue;
    if (!isSupportedSourcePath(entry.path)) {
      excludedUnsupportedFiles += 1;
      continue;
    }
    const content = contents.get(entry.path);
    if (content === undefined) throw new Error('repository_blob_missing');
    files.push({ path: entry.path, content });
    if (files.length > CUSTOMER_MAX_SOURCE_FILES) throw new Error('repository_source_file_limit');
  }

  if (files.length === 0) throw new Error('repository_no_supported_files');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const snapshot = customerSourceSnapshotSchema.parse({ revision, files });
  const canonical = canonicalSourceJson(snapshot);
  const digest = sha256(canonical);
  return { snapshot, digest, excludedUnsupportedFiles, excludedSymlinks, excludedSubmodules };
}

export function compareTrees(previous: readonly SourceTreeEntry[], current: readonly SourceTreeEntry[]): RepositoryChange['files'] {
  const before = new Map(previous.filter(item => item.type === 'blob' || item.type === 'commit').map(item => [item.path, item]));
  const after = new Map(current.filter(item => item.type === 'blob' || item.type === 'commit').map(item => [item.path, item]));
  const changed: RepositoryChange['files'] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (!oldEntry) changed.push({ path, status: 'added' });
    else if (!newEntry) changed.push({ path, status: 'deleted' });
    else if (oldEntry.sha !== newEntry.sha || oldEntry.mode !== newEntry.mode || oldEntry.type !== newEntry.type) changed.push({ path, status: 'modified' });
  }
  changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return changed;
}

export function makeRepositoryChangeCandidate(input: {
  repositoryKey: string;
  reference: string;
  previousRevision: string;
  revision: string;
  files: RepositoryChange['files'];
  filesTruncated: boolean;
  observedAt: string;
  ttlMs?: number;
}): MonitoringCandidate {
  const shown = input.files.slice(0, 12);
  const changedFileSummary = shown.map(file => file.status + ' ' + file.path).join(', ');
  const remainder = Math.max(0, input.files.length - shown.length) + (input.filesTruncated ? 1 : 0);
  const summary = [
    'Repository commit changed from ' + input.previousRevision + ' to ' + input.revision + '.',
    input.files.length === 0 ? 'The commit changed without changing tracked tree entries.' : 'Changed paths: ' + changedFileSummary + (remainder > 0 ? ' (+' + remainder + ' more).' : '.'),
    'This records a source change; it does not establish that a vulnerable change is deployed or exploited.',
  ].join(' ').slice(0, 2000);
  const expiresAt = new Date(Date.parse(input.observedAt) + (input.ttlMs ?? OBSERVATION_TTL_MS)).toISOString();
  const checksum = sha256(canonicalJson({
    repositoryKey: input.repositoryKey,
    previousRevision: input.previousRevision,
    revision: input.revision,
    files: input.files,
    filesTruncated: input.filesTruncated,
  }));
  const evidence: MonitoringEvidence = {
    source: 'repository',
    reference: input.reference,
    checksum,
    collectedAt: input.observedAt,
    adapter: 'repository_change',
    adapterVersion: '0.1.0',
  };
  return {
    kind: 'repository_change',
    summary,
    severity: 'info',
    confidence: 'high',
    observedAt: input.observedAt,
    expiresAt,
    evidence: [evidence],
    metrics: null,
    incidentId: null,
    upstreamImpact: 'not_applicable',
  };
}

export function makeRepositorySnapshotEvidence(input: {
  provider: 'local_git' | 'github';
  repositoryKey: string;
  repositoryReference: string;
  digest: string;
  collectedAt: string;
}): MonitoringEvidence {
  return {
    source: 'repository',
    reference: input.repositoryReference,
    checksum: input.digest,
    collectedAt: input.collectedAt,
    adapter: input.provider === 'local_git' ? 'local_git_snapshot' : 'github_snapshot',
    adapterVersion: '0.1.0',
  };
}

export function canonicalSourceJson(snapshot: CustomerSourceSnapshot): string {
  const files = snapshot.files.map(file => ({ content: file.content, path: file.path }));
  return canonicalJson({ files, revision: snapshot.revision });
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(input: unknown): string {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
  if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
  if (Array.isArray(input)) return '[' + input.map(canonicalJson).join(',') + ']';
  if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
    return '{' + Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => JSON.stringify(key) + ':' + canonicalJson(value)).join(',') + '}';
  }
  throw new Error('invalid_canonical_json');
}

export function assertSafeRepositoryPath(path: string): void {
  if (path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('repository_path_escape');
  }
}

export function repositoryReference(provider: 'local_git' | 'github', repositoryKey: string, revision: string, owner?: string, repository?: string): string {
  if (provider === 'github') {
    if (!owner || !repository) throw new Error('github_repository_config_invalid');
    return 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repository) + '/commit/' + revision;
  }
  return 'gotchu://repository/' + encodeURIComponent(repositoryKey) + '/commit/' + revision;
}

export function asIsoTimestamp(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
