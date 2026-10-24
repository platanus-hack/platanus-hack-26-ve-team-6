import { describe, expect, it } from 'vitest';
import { createGitHubRepositoryReader, createMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { listGitHubInstallationRepositories, mintGitHubInstallationToken } from '../src/server/github-api.js';

const enabled = process.env.GOTCHU_TEST_GITHUB === '1' ? describe : describe.skip;
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const applicationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
enabled('opt-in live GitHub Reader App fixture', () => {
  it('lists only the authorized sandbox repository and snapshots its current default branch', async () => {
    const appFile = process.env.GOTCHU_GITHUB_READER_APP_FILE;
    if (!appFile) throw new Error('Set GOTCHU_GITHUB_READER_APP_FILE before opting into the live GitHub check.');
    const installationId = '174788349';
    const token = await mintGitHubInstallationToken(installationId, appFile);
    const repositories = await listGitHubInstallationRepositories(token);
    expect(repositories.map(repository => repository.full_name)).toEqual(['0bkevin/gotchu-pr-sandbox']);
    const repository = repositories[0];
    if (!repository) throw new Error('The authorized installation returned no repository.');
    const repositoryKey = `gh-${repository.id}`;
    const catalog = createMonitoringRepositoryCatalog({ repositoryRoot: '/tmp', repositories: [{ organizationId, applicationId, repositoryKey, displayName: repository.full_name, provider: 'github', owner: '0bkevin', repository: 'gotchu-pr-sandbox' }] });
    const reader = createGitHubRepositoryReader(catalog, { installationTokenProvider: async () => token });
    const snapshot = await reader.read({ organizationId, applicationId, repositoryKey });
    expect(snapshot.provider).toBe('github');
    expect(snapshot.commit.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.snapshot.revision).toBe(snapshot.commit.sha);
  }, 120_000);
});
