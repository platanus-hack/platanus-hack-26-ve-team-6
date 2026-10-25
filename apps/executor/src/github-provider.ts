import type { Database } from '@gotchu/database';
import { computeGitTreeShaAfterPatch, createGitHubAppAdapter, deterministicBranch, GitAdapterError, type GitHubAppOptions, type PullRequestAdapter, type WorkflowPolicyException } from '@gotchu/git-adapters';
import { loadMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { z } from 'zod';
import { expectedActionTreeSha, type ActionProvider, type ProviderReconciliation, type ProviderVerification, type RepositoryPublication } from './action-execution.js';
import type { GitHubSingleAppCredentials, GitHubWriterAppCredentials } from './github-credentials.js';
import { createSingleAppGitHubResolver, type SingleAppRepositoryBinding } from './single-app-resolver.js';

const exceptionSchema = z.object({
  path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  rule: z.enum(['invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret']),
}).strict();
const scopedWriterTokenSchema = z.object({
  token: z.string().min(1), expires_at: z.iso.datetime(), repository_selection: z.literal('selected'),
  permissions: z.record(z.string(), z.string()), repositories: z.array(z.object({ id: z.number().int().positive() }).passthrough()).max(1000),
}).passthrough();

async function isGitHubRateLimit(response: Response): Promise<boolean> {
  if (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0') return true;
  const body = response.clone().body;
  if (!body) return false;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        return false;
      }
      chunks.push(part.value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
    const message = z.object({ message: z.string().max(2000) }).passthrough().safeParse(payload);
    return message.success && /rate limit|abuse detection/i.test(message.data.message);
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function createScopedWriterFetch(fetcher: typeof fetch, installationId: string, repositoryId: number): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input);
    const tokenPath = `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    const isTokenRequest = url.origin === 'https://api.github.com' && url.pathname === tokenPath && (init?.method ?? 'GET') === 'POST';
    const response = await fetcher(input, isTokenRequest ? { ...init, method: 'POST', body: JSON.stringify({
      repository_ids: [repositoryId], permissions: { contents: 'write', pull_requests: 'write' },
    }) } : init);
    if (url.origin === 'https://api.github.com' && response.status === 403 && await isGitHubRateLimit(response)) {
      throw new Error('github_rate_limited');
    }
    if (!isTokenRequest) return response;
    if (!response.ok) return response;
    let payload: unknown;
    try { payload = await response.clone().json(); } catch { throw new GitAdapterError('malformed_response'); }
    const token = scopedWriterTokenSchema.safeParse(payload);
    if (!token.success) throw new GitAdapterError('malformed_response');
    if (token.data.permissions.contents !== 'write' || token.data.permissions.pull_requests !== 'write'
      || !token.data.repositories.some(repository => repository.id === repositoryId)) {
      throw new GitAdapterError('provider_access_revoked');
    }
    const expiresAt = Date.parse(token.data.expires_at);
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 2 * 60 * 60 * 1000) throw new GitAdapterError('malformed_response');
    return response;
  };
}

export function createGitHubSingleAppWriterAdapter(options: {
  app: GitHubSingleAppCredentials;
  installationId: string;
  repositoryId: number;
  owner: string;
  repository: string;
  fetchImplementation?: typeof fetch;
}): PullRequestAdapter {
  return createGitHubAppAdapter({
    appId: options.app.id, privateKeyPem: options.app.privateKeyPem,
    installationId: options.installationId, owner: options.owner, repository: options.repository,
    fetchImplementation: createScopedWriterFetch(options.fetchImplementation ?? fetch, options.installationId, options.repositoryId),
  });
}
export function createGitHubActionProvider(options: {
  database: Database;
  writer: GitHubWriterAppCredentials;
  installationId?: string;
  monitoringConfigFile?: string;
  publicAppUrl: string;
  singleApp?: GitHubSingleAppCredentials;
  writerInstallationIdFor?: (scope: { organizationId: string; applicationId: string; repositoryKey: string; repositoryLinkId: string }) => Promise<string | null>;
  fetchImplementation?: GitHubAppOptions['fetchImplementation'];
}): ActionProvider {
  const singleApp = options.singleApp;
  const singleAppResolver = singleApp ? createSingleAppGitHubResolver({
    database: options.database, app: singleApp,
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  }) : undefined;

  async function adapterFor(publication: RepositoryPublication): Promise<{ adapter: PullRequestAdapter; owner: string; repository: string; installationId: string }> {
    const action = publication.action;
    const scope = { organizationId: action.organizationId, applicationId: action.applicationId,
      repositoryKey: action.target.repositoryKey, repositoryLinkId: action.target.repositoryLinkId };
    if (singleAppResolver && singleApp) {
      if (!options.writerInstallationIdFor) throw new GitAdapterError('provider_access_revoked');
      const binding: SingleAppRepositoryBinding = await singleAppResolver.resolveRepository(scope);
      const installationId = await options.writerInstallationIdFor(scope);
      if (!installationId || !await singleAppResolver.isActiveInstallation(scope.organizationId, scope.applicationId, installationId)) {
        throw new GitAdapterError('provider_access_revoked');
      }
      return singleAppResolver.withRepositoryMetadata(binding, repository => {
        const [owner, name] = repository.fullName.split('/');
        if (!owner || !name) throw new GitAdapterError('malformed_response');
        const adapter = createGitHubSingleAppWriterAdapter({
          app: singleApp, installationId, repositoryId: binding.repositoryId, owner, repository: name,
          ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
        });
        return { adapter, owner, repository: name, installationId };
      });
    }
    if (!options.installationId || !options.monitoringConfigFile) throw new GitAdapterError('provider_access_revoked');
    const catalog = await loadMonitoringRepositoryCatalog(options.monitoringConfigFile);
    const entry = catalog.resolve(action, action.target.repositoryKey);
    if (entry.provider !== 'github') throw new GitAdapterError('not_found');
    const adapter = createGitHubAppAdapter({
      appId: options.writer.appId, privateKeyPem: options.writer.privateKeyPem,
      installationId: options.installationId, owner: entry.owner, repository: entry.repository,
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    });
    return { adapter, owner: entry.owner, repository: entry.repository, installationId: options.installationId };
  }

  async function exceptionsFor(publication: RepositoryPublication): Promise<readonly WorkflowPolicyException[]> {
    const rows = await options.database.tenant(publication.action.organizationId, tx => tx.query<{ workflow_path: string; rule: string }>(`SELECT workflow_path,rule FROM gotchu.workflow_policy_exceptions
      WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 AND removed_at IS NULL`,
    [publication.action.organizationId,publication.action.applicationId,publication.action.target.repositoryLinkId]));
    return z.array(exceptionSchema).parse(rows.rows.map(row => ({ path: row.workflow_path, rule: row.rule })));
  }

  return {
    async reconcile(publication): Promise<ProviderReconciliation> {
      const { adapter } = await adapterFor(publication);
      const branch = deterministicBranch(publication.actionHash);
      try {
        const pullRequest = await adapter.findPullRequestByBranch(branch);
        if (pullRequest) return { status: 'pull_request_found', pullRequest };
        const baseHead = await adapter.readHead(publication.action.target.branch);
        if (baseHead !== publication.action.baseCommit) return { status: 'stale_base' };
        let branchCommit: string;
        try { branchCommit = await adapter.readHead(branch); }
        catch (error) {
          if (error instanceof GitAdapterError && error.code === 'not_found') return { status: 'definitely_not_applied' };
          return { status: 'unknown' };
        }
        const remoteCommit = await adapter.readCommit(branchCommit);
        if (remoteCommit.treeSha !== expectedActionTreeSha(publication.action,publication.artifact)
          || remoteCommit.parents.length !== 1 || remoteCommit.parents[0] !== publication.action.baseCommit
          || publication.action.kind === 'dependency_pull_request' && branchCommit !== publication.action.candidateCommit) return { status: 'unknown' };
        return { status: 'branch_found', branch, commitSha: branchCommit };
      } catch (error) {
        if (error instanceof GitAdapterError && error.code === 'provider_access_revoked') throw error;
        return { status: 'unknown' };
      }
    },
    async publishBranch(input) {
      const { adapter } = await adapterFor(input);
      const action = input.action;
      const baseTree = await adapter.readTree(action.baseCommit);
      const approvedTree = expectedActionTreeSha(action, input.artifact);
      const expectedTree = computeGitTreeShaAfterPatch(baseTree, input.artifact.files.map(file => ({ path:file.path,mode:file.mode,content:Buffer.from(file.contentBase64,'base64').toString('utf8') })));
      if (!approvedTree || expectedTree !== approvedTree) throw new GitAdapterError('malformed_response');
      if (await adapter.readHead(action.target.branch) !== action.baseCommit) throw new GitAdapterError('conflict');
      const workflowExceptions = await exceptionsFor(input);
      const published = await adapter.publishCommit({
        actionHash: input.actionHash, baseBranch: action.target.branch, baseSha: action.baseCommit,
        files: input.artifact.files.map(file => ({ path:file.path,mode:file.mode,content:Buffer.from(file.contentBase64,'base64').toString('utf8') })),
        commitMessage: input.artifact.commitMessage, deterministicCommit:action.kind === 'dependency_pull_request',
        workflowExceptions, beforeWrite: input.beforeWrite,
      });
      const remoteCommit = await adapter.readCommit(published.commitSha);
      if (remoteCommit.treeSha !== approvedTree || remoteCommit.parents.length !== 1 || remoteCommit.parents[0] !== action.baseCommit
        || action.kind === 'dependency_pull_request' && published.commitSha !== action.candidateCommit) throw new GitAdapterError('conflict');
      return published;
    },
    async openPullRequest(input) {
      const { adapter, owner, repository } = await adapterFor(input);
      const action = input.action;
      const evidenceLines = action.evidence.map(item => `- ${item.kind}: \`${item.id}\` · \`${item.sha256}\``);
      const validationIds = action.kind === 'source_patch_pull_request'
        ? action.validationAttestationIds
        : [action.rescanAttestationId, action.suiteAttestationId];
      const actionUrl = new URL(`/dashboard?organizationId=${encodeURIComponent(action.organizationId)}&applicationId=${encodeURIComponent(action.applicationId)}#action-${input.actionHash}`, options.publicAppUrl).toString();
      const validationLines = validationIds.map(id => `- [Signed validation attestation \`${id}\`](${actionUrl})`);
      const changeLines = action.kind === 'dependency_pull_request'
        ? action.changes.map(change => `- \`${change.name}\`: \`${change.from}\` → \`${change.to}\``)
        : [];
      const advisoryLines = action.kind === 'dependency_pull_request'
        ? action.advisoryIds.map(id => `- [${id}](https://osv.dev/vulnerability/${encodeURIComponent(id)})`)
        : [];
      const expectedTree = expectedActionTreeSha(action, input.artifact);
      const body = [
        'This draft PR was created from the exact candidate approved in Gotchu.',
        '',
        `- Action: \`${input.actionHash}\``,
        `- Base: [\`${action.baseCommit}\`](https://github.com/${owner}/${repository}/commit/${action.baseCommit})`,
        `- Expected candidate tree: \`${expectedTree ?? 'unavailable'}\``,
        `- Patch digest: \`${action.patchSha256}\``,
        ...(action.kind === 'dependency_pull_request' ? ['', '### Dependency changes', ...changeLines, '', '### Advisories fixed', ...advisoryLines] : []),
        '',
        '### Validation evidence',
        `[Review the exact action and validation state in Gotchu](${actionUrl}). The independent verifier checked signed evidence for this approved candidate.`,
        ...validationLines,
        '',
        '### Source evidence',
        ...evidenceLines,
      ].join('\n');
      const exceptions = await exceptionsFor(input);
      await adapter.verifyAutomation(action.baseCommit, exceptions, input.branch);
      if (await adapter.readHead(action.target.branch) !== action.baseCommit) throw new GitAdapterError('conflict');
      const pullRequest = await adapter.openOrFindPullRequest({
        actionHash: input.actionHash, branch: input.branch, commitSha: input.commitSha,
        baseBranch: action.target.branch, baseSha: action.baseCommit,
        evidenceSummary: { rescan: 'passed', suite: 'passed', regression: 'passed', runnerIsolation: 'verified' },
        title: action.kind === 'dependency_pull_request'
          ? `Fix ${action.changes.map(change => `${change.name} ${change.from} → ${change.to}`).join(', ')}`
          : `Gotchu approved correction ${input.actionHash.slice(0,16)}`,
        body: z.string().max(50_000).parse(body), draft: true, beforeWrite: input.beforeWrite,
      });
      return pullRequest;
    },
    async verify(input): Promise<ProviderVerification> {
      const { adapter } = await adapterFor(input);
      try {
        const pullRequest = await adapter.getPullRequest(input.pullRequest.number);
        if (pullRequest.state === 'closed') return 'closed';
        const action = input.action;
        if (await adapter.readHead(action.target.branch) !== action.baseCommit
          || pullRequest.baseBranch !== action.target.branch || pullRequest.baseSha !== action.baseCommit) return 'stale_base';
        const expectedTree = expectedActionTreeSha(action, input.artifact);
        if (!expectedTree || pullRequest.draft !== true || pullRequest.headBranch !== deterministicBranch(input.actionHash)
          || action.kind === 'dependency_pull_request' && pullRequest.headSha !== action.candidateCommit) return 'mismatch';
        const head = await adapter.readCommit(pullRequest.headSha);
        if (head.treeSha !== expectedTree || head.parents.length !== 1 || head.parents[0] !== action.baseCommit) return 'mismatch';
        if (await adapter.readHead(pullRequest.headBranch) !== pullRequest.headSha) return 'unknown';
        const url = new URL(pullRequest.url);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)) return 'mismatch';
        return 'verified';
      } catch (error) {
        if (error instanceof GitAdapterError && error.code === 'not_found') return 'unknown';
        return 'unknown';
      }
    },
  };
}
