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
      const resolved = await options.database.tenant(input.organizationId, tx => tx.query<{ provenance: string; installation_id: string | null }>(
        `SELECT gotchu.monitor_repository_provenance($1,$2,$3) AS provenance,
          (SELECT installation_id FROM gotchu.monitor_github_repository($1,$2,$3)) AS installation_id`, [input.organizationId, input.applicationId, input.repositoryKey]));
      const row = resolved.rows[0];
      // A revoked App link must not fall back to an operator catalog entry with the same key.
      if (!row || row.provenance === 'revoked') throw new Error('github_repository_link_unavailable');
      const appRepository = githubAppKey.exec(input.repositoryKey);
      if (row.provenance === 'github_app') {
        if (!github) throw new Error('github_app_not_configured');
        if (!appRepository || !row.installation_id) throw new Error('github_repository_link_unavailable');
        const installationId = row.installation_id;
        // Membership and the default branch are re-read live, so removal from the installation or a branch switch is not missed.
        const repository = await github.repository(installationId, Number(appRepository[1]), input.signal);
        const catalog = createMonitoringRepositoryCatalog({ repositoryRoot: '/nonexistent', repositories: [{
          organizationId: input.organizationId, applicationId: input.applicationId, repositoryKey: input.repositoryKey, displayName: repository.fullName,
          provider: 'github', owner: repository.owner, repository: repository.repository, ref: repository.defaultBranch,
        }] });
        return createGitHubRepositoryReader(catalog, { installationTokenProvider: () => github.installationToken(installationId, input.signal) }).read(input);
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
