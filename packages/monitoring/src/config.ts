import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

export const MAX_MONITORING_CONFIG_BYTES = 512 * 1024;

const uuid = z.uuid().transform(value => value.toLowerCase());
const repositoryKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const gitRefSchema = z.string().min(1).max(200).refine(value => {
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('@{') || /[~^:?*[\\\s\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}, 'A configured Git ref must be a safe branch or tag name');

const relativeBarePathSchema = z.string().min(1).max(512).refine(value => {
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value)) return false;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized.split('/').every(part => part && part !== '.' && part !== '..');
}, 'Local repository path must be normalized and relative to repositoryRoot');

const repositoryConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    organizationId: uuid,
    applicationId: uuid,
    repositoryKey: repositoryKeySchema,
    displayName: z.string().trim().min(1).max(120),
    provider: z.literal('local_git'),
    path: relativeBarePathSchema,
    ref: gitRefSchema.default('HEAD'),
  }).strict(),
  z.object({
    organizationId: uuid,
    applicationId: uuid,
    repositoryKey: repositoryKeySchema,
    displayName: z.string().trim().min(1).max(120),
    provider: z.literal('github'),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => value !== '.' && value !== '..'),
    ref: gitRefSchema.optional(),
    tokenFile: z.string().min(1).max(1024).refine(value => isAbsolute(value) && !value.includes('\0')).optional(),
  }).strict(),
]);

export const monitoringProviderConfigSchema = z.object({
  repositoryRoot: z.string().min(1).max(1024).refine(value => isAbsolute(value) && !value.includes('\0')),
  repositories: z.array(repositoryConfigSchema).max(500),
}).strict().superRefine((config, context) => {
  const seen = new Set<string>();
  for (const [index, repository] of config.repositories.entries()) {
    const scopeKey = [repository.organizationId, repository.applicationId, repository.repositoryKey].join('\0');
    if (seen.has(scopeKey)) {
      context.addIssue({ code: 'custom', path: ['repositories', index, 'repositoryKey'], message: 'Repository keys must be unique within an application' });
    }
    seen.add(scopeKey);
  }
});

export type MonitoringRepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type MonitoringProviderConfig = z.infer<typeof monitoringProviderConfigSchema>;
export interface RepositoryScope {
  organizationId: string;
  applicationId: string;
}
export interface AllowedRepositoryOption {
  repositoryKey: string;
  displayName: string;
  provider: 'local_git' | 'github';
}

export function parseMonitoringProviderConfig(input: unknown): MonitoringProviderConfig {
  return monitoringProviderConfigSchema.parse(input);
}

/**
 * Load trusted operator configuration on demand. Callers choose when to reload;
 * this package never reads process arguments or environment variables.
 */
export async function loadMonitoringRepositoryCatalog(configFile: string): Promise<MonitoringRepositoryCatalog> {
  if (!configFile || configFile.includes('\0')) throw new Error('monitoring_config_path_invalid');
  const beforeOpen = await lstat(configFile);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) throw new Error('monitoring_config_file_unsafe');
  if (beforeOpen.size > MAX_MONITORING_CONFIG_BYTES) throw new Error('monitoring_config_file_limit');

  const handle = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino) throw new Error('monitoring_config_file_unsafe');
    if (opened.size > MAX_MONITORING_CONFIG_BYTES) throw new Error('monitoring_config_file_limit');
    const bytes = Buffer.alloc(MAX_MONITORING_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_MONITORING_CONFIG_BYTES) throw new Error('monitoring_config_file_limit');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error('monitoring_config_file_encoding');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('monitoring_config_file_invalid_json');
    }
    return createMonitoringRepositoryCatalog(parsed);
  } finally {
    await handle.close();
  }
}

export interface MonitoringRepositoryCatalog {
  listAllowedRepositoryOptions(scope: RepositoryScope): AllowedRepositoryOption[];
  resolve(scope: RepositoryScope, repositoryKey: string): MonitoringRepositoryConfig;
  repositoryPath(entry: Extract<MonitoringRepositoryConfig, { provider: 'local_git' }>): string;
  repositoryRoot(): string;
}

export function createMonitoringRepositoryCatalog(input: unknown): MonitoringRepositoryCatalog {
  const config = parseMonitoringProviderConfig(input);
  const root = resolve(config.repositoryRoot);
  const scopedIndex = new Map<string, MonitoringRepositoryConfig>();
  for (const entry of config.repositories) {
    scopedIndex.set(scopeKey(entry, entry.repositoryKey), entry);
  }
  return {
    listAllowedRepositoryOptions(scope) {
      const normalized = normalizeScope(scope);
      return config.repositories
        .filter(entry => entry.organizationId === normalized.organizationId && entry.applicationId === normalized.applicationId)
        .map(({ repositoryKey, displayName, provider }) => ({ repositoryKey, displayName, provider }));
    },
    resolve(scope, repositoryKey) {
      const normalized = normalizeScope(scope);
      const parsedKey = repositoryKeySchema.parse(repositoryKey);
      const entry = scopedIndex.get(scopeKey(normalized, parsedKey));
      if (!entry) throw new Error('repository_not_configured');
      return entry;
    },
    repositoryPath(entry) {
      if (entry.provider !== 'local_git') throw new Error('repository_provider_mismatch');
      const repositoryPath = resolve(root, ...entry.path.split('/'));
      const fromRoot = relative(root, repositoryPath);
      if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) throw new Error('repository_path_escape');
      return repositoryPath;
    },
    repositoryRoot() {
      return root;
    },
  };
}

function normalizeScope(scope: RepositoryScope): RepositoryScope {
  return { organizationId: uuid.parse(scope.organizationId), applicationId: uuid.parse(scope.applicationId) };
}

function scopeKey(scope: RepositoryScope, repositoryKey: string): string {
  return [scope.organizationId.toLowerCase(), scope.applicationId.toLowerCase(), repositoryKey].join('\0');
}
