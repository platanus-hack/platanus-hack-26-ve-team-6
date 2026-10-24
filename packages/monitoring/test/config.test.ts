import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMonitoringRepositoryCatalog,
  loadMonitoringRepositoryCatalog,
  MAX_MONITORING_CONFIG_BYTES,
  parseMonitoringProviderConfig,
} from '../src/config.js';

const directories: string[] = [];
async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-monitor-config-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('trusted monitoring repository registry', () => {
  it('returns only repositories explicitly scoped to the requested application', async () => {
    const root = await tempDirectory();
    const first = { organizationId: randomUUID(), applicationId: randomUUID() };
    const other = { organizationId: randomUUID(), applicationId: randomUUID() };
    const config = parseMonitoringProviderConfig({
      repositoryRoot: root,
      repositories: [
        { ...first, repositoryKey: 'source-main', displayName: 'Main', provider: 'local_git', path: 'main.git', ref: 'refs/heads/main' },
        { ...other, repositoryKey: 'source-main', displayName: 'Other tenant', provider: 'github', owner: 'acme', repository: 'product' },
      ],
    });
    const catalog = createMonitoringRepositoryCatalog(config);
    expect(catalog.listAllowedRepositoryOptions(first)).toEqual([
      { repositoryKey: 'source-main', displayName: 'Main', provider: 'local_git' },
    ]);
    expect(catalog.listAllowedRepositoryOptions(other)).toEqual([
      { repositoryKey: 'source-main', displayName: 'Other tenant', provider: 'github' },
    ]);
    expect(() => catalog.resolve(other, 'missing')).toThrow('repository_not_configured');
    const entry = catalog.resolve(first, 'source-main');
    if (entry.provider !== 'local_git') throw new Error('fixture_provider_mismatch');
    expect(catalog.repositoryPath(entry)).toBe(join(root, 'main.git'));
  });

  it('rejects unsafe paths, duplicate scoped keys, and non-GitHub token paths', async () => {
    const root = await tempDirectory();
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    expect(() => parseMonitoringProviderConfig({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'bad-path', displayName: 'Bad', provider: 'local_git', path: '../outside.git' }],
    })).toThrow();
    expect(() => parseMonitoringProviderConfig({
      repositoryRoot: root,
      repositories: [
        { ...scope, repositoryKey: 'same', displayName: 'First', provider: 'github', owner: 'acme', repository: 'one' },
        { ...scope, repositoryKey: 'same', displayName: 'Second', provider: 'github', owner: 'acme', repository: 'two' },
      ],
    })).toThrow();
    expect(() => parseMonitoringProviderConfig({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'private', displayName: 'Private', provider: 'github', owner: 'acme', repository: 'private', tokenFile: 'relative-token' }],
    })).toThrow();
  });

  it('reloads bounded operator JSON and refuses symlinked or oversized config files', async () => {
    const root = await tempDirectory();
    const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    const configFile = join(root, 'monitoring.json');
    await writeFile(configFile, JSON.stringify({
      repositoryRoot: root,
      repositories: [{ ...scope, repositoryKey: 'source', displayName: 'Source', provider: 'github', owner: 'acme', repository: 'service' }],
    }));
    const catalog = await loadMonitoringRepositoryCatalog(configFile);
    expect(catalog.listAllowedRepositoryOptions(scope)).toEqual([
      { repositoryKey: 'source', displayName: 'Source', provider: 'github' },
    ]);

    const linkedConfig = join(root, 'linked-monitoring.json');
    await symlink(configFile, linkedConfig);
    await expect(loadMonitoringRepositoryCatalog(linkedConfig)).rejects.toThrow('monitoring_config_file_unsafe');

    const oversizedConfig = join(root, 'oversized-monitoring.json');
    await writeFile(oversizedConfig, 'x'.repeat(MAX_MONITORING_CONFIG_BYTES + 1));
    await expect(loadMonitoringRepositoryCatalog(oversizedConfig)).rejects.toThrow('monitoring_config_file_limit');
  });
});
