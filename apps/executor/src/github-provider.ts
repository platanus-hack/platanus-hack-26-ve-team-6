import type { Database } from '@gotchu/database';
import { computeGitTreeShaAfterPatch, createGitHubAppAdapter, deterministicBranch, GitAdapterError, type GitHubAppOptions, type PullRequestAdapter, type WorkflowPolicyException } from '@gotchu/git-adapters';
import { loadMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { z } from 'zod';
import { expectedActionTreeSha, type ActionProvider, type ProviderReconciliation, type ProviderVerification, type RepositoryPublication } from './action-execution.js';
import type { GitHubWriterAppCredentials } from './github-credentials.js';

const exceptionSchema = z.object({
  path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  rule: z.enum(['invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret']),
}).strict();
export function createGitHubActionProvider(options: {
  database: Database;
  writer: GitHubWriterAppCredentials;
  installationId: string;
  monitoringConfigFile: string;
  publicAppUrl: string;
  fetchImplementation?: GitHubAppOptions['fetchImplementation'];
}): ActionProvider {
  async function adapterFor(publication: RepositoryPublication): Promise<{ adapter: PullRequestAdapter; owner: string; repository: string }> {
    const catalog = await loadMonitoringRepositoryCatalog(options.monitoringConfigFile);
    const entry = catalog.resolve(publication.action, publication.action.target.repositoryKey);
    if (entry.provider !== 'github') throw new GitAdapterError('not_found');
    const adapter = createGitHubAppAdapter({
      appId: options.writer.appId, privateKeyPem: options.writer.privateKeyPem,
      installationId: options.installationId, owner: entry.owner, repository: entry.repository,
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    });
    return { adapter, owner: entry.owner, repository: entry.repository };
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
