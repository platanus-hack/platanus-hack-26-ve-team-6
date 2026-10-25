import {
  loadMonitoringRepositoryCatalog, createMonitoringRepositoryCatalog, createLocalGitRepositoryReader, createGitHubRepositoryReader, createGitHubAppInstallationClient,
  createOsvDependencyAdapter, createCisaKevAdapter, createCloudflareStatusAdapter, createRailwayStatusAdapter, createAuthorizedHttpsHealthAdapter,
} from '@gotchu/monitoring';
import type { Database } from '@gotchu/database';
import type { MonitoringAdapters } from './monitoring.js';

/** Keys created by the GitHub App connection flow: `gh-<numeric repository id>`. */
const githubAppKey = /^gh-(\d{1,20})$/;

export function createConfiguredMonitoringAdapters(options: { database: Database; configFile?: string; githubAppFile?: string; advisories: boolean }): MonitoringAdapters {
  const cloudflare = createCloudflareStatusAdapter(); const railway = createRailwayStatusAdapter();
  const httpsHealth = createAuthorizedHttpsHealthAdapter();
  const osv = options.advisories ? createOsvDependencyAdapter() : null;
  const kev = options.advisories ? createCisaKevAdapter() : null;
  const github = options.githubAppFile ? createGitHubAppInstallationClient(options.githubAppFile) : null;
  return {
    async repository(input) {
      const appRepository = githubAppKey.exec(input.repositoryKey);
      if (appRepository) {
        if (!github) throw new Error('github_app_not_configured');
        const link = await options.database.tenant(input.organizationId, tx => tx.query<{ installation_id: string; default_branch: string }>(
          'SELECT installation_id,default_branch FROM gotchu.monitor_github_repository($1,$2,$3)', [input.organizationId, input.applicationId, input.repositoryKey]));
        const row = link.rows[0];
        if (!row) throw new Error('github_repository_link_unavailable');
        const repository = await github.repository(row.installation_id, Number(appRepository[1]), input.signal);
        const catalog = createMonitoringRepositoryCatalog({ repositoryRoot: '/nonexistent', repositories: [{
          organizationId: input.organizationId, applicationId: input.applicationId, repositoryKey: input.repositoryKey, displayName: repository.fullName,
          provider: 'github', owner: repository.owner, repository: repository.repository, ref: row.default_branch,
        }] });
        return createGitHubRepositoryReader(catalog, { installationTokenProvider: () => github.installationToken(row.installation_id, input.signal) }).read(input);
      }
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
    ...(kev ? { exploitedVulnerabilities: (advisories, signal) => kev.correlate(advisories, signal) } : {}),
    provider: (name, signal) => (name === 'cloudflare' ? cloudflare : railway).read(signal),
    httpsHealth: (target, route, signal) => httpsHealth.read(target, signal, route),
  };
}
