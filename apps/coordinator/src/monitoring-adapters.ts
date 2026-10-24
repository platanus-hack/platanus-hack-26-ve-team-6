import {
  loadMonitoringRepositoryCatalog, createLocalGitRepositoryReader, createGitHubRepositoryReader,
  createOsvDependencyAdapter, createCloudflareStatusAdapter, createRailwayStatusAdapter, createAuthorizedHttpsHealthAdapter,
} from '@gotchu/monitoring';
import type { MonitoringAdapters } from './monitoring.js';

export function createConfiguredMonitoringAdapters(options: { configFile?: string; advisories: boolean }): MonitoringAdapters {
  const cloudflare = createCloudflareStatusAdapter(); const railway = createRailwayStatusAdapter();
  const httpsHealth = createAuthorizedHttpsHealthAdapter();
  const osv = options.advisories ? createOsvDependencyAdapter() : null;
  return {
    async repository(input) {
      if (!options.configFile) throw new Error('repository_registry_not_configured');
      const catalog = await loadMonitoringRepositoryCatalog(options.configFile);
      const entry = catalog.resolve(input, input.repositoryKey);
      return entry.provider === 'local_git' ? createLocalGitRepositoryReader(catalog).read(input) : createGitHubRepositoryReader(catalog).read(input);
    },
    async dependencies(repository, signal) {
      if (!osv) throw new Error('advisory_reader_not_configured');
      const reference = repository.evidence.find(e => e.source === 'repository')?.reference;
      if (!reference) throw new Error('repository_evidence_missing');
      return osv.read({ repositoryKey: repository.repositoryKey, commitSha: repository.commit.sha, repositoryReference: reference, snapshot: repository.snapshot, signal });
    },
    provider: (name, signal) => (name === 'cloudflare' ? cloudflare : railway).read(signal),
    httpsHealth: (target, route, signal) => httpsHealth.read(target, signal, route),
  };
}
