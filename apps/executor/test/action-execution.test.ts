import { randomUUID } from 'node:crypto';
import { BackendError, dependencyCommitMessage, expectedDependencyCommitSha, hashActionV2, sha256, type ExecutionArtifact } from '@gotchu/backend';
import type { ActionV2 } from '@gotchu/contracts';
import { computeGitTreeSha, GitAdapterError, type PullRequest } from '@gotchu/git-adapters';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, expectedActionTreeSha, type ActionExecutionLedger, type ActionProvider } from '../src/action-execution.js';

function fixture(options: { crashAfterBranch?: boolean; crashAfterPullRequest?: boolean; revoked?: boolean; staleBase?: boolean; unknown?: boolean; closedPullRequest?: boolean; verifyUnknown?: boolean } = {}) {
  const organizationId = randomUUID();
  const applicationId = randomUUID();
  const approvalId = randomUUID();
  const proposalId = randomUUID();
  const candidateId = randomUUID();
  const baseCommit = '1'.repeat(40);
  const treeSha = '2'.repeat(40);
  const action: ActionV2 = {
    version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId, applicationId,
    policyVersion: 'gotchu-source-patch-pr-v1', target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: 'github:owner/repo', branch: 'main' },
    baseCommit, expectedTreeSha: treeSha, recipeId: 'safe-correction', recipeVersion: '1', snapshotSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64),
    findingIdentities: ['finding-1'], validationAttestationIds: [randomUUID()], evidence: [{ id: candidateId, sha256: 'a'.repeat(64), kind: 'private_correction_candidate' }],
  };
  const recoveryEpoch = '1';
  const actionHash = hashActionV2(action, recoveryEpoch);
  const claim = { organizationId, applicationId, approvalId, executionId: proposalId, claimToken: randomUUID(), actionHash, recoveryEpoch, proposal: action };
  const artifact: ExecutionArtifact = {
    baseCommit, files: [], candidateTreeSha: '3'.repeat(40), treeSha, treeComplete: true, unsupportedReason: null,
    commitMessage: 'Approved correction', snapshotSha256: action.snapshotSha256, patchSha256: action.patchSha256,
    artifactSha256: action.snapshotSha256, sizeBytes: 0,
  };
  const events: Array<{ attempt: number; state: string; step: string; providerReference?: string }> = [];
  const attempts = new Map<number, { attempt: number; state: string; step: string }>();
  let state: 'claimed'|'succeeded'|'failed'|'uncertain' = 'claimed';
  let providerReference: string | undefined;
  let consumed = false;
  const ledger: ActionExecutionLedger = {
    claim: vi.fn(async () => {
      if (consumed) throw new BackendError('approval_used', 'already consumed');
      consumed = true;
      return claim;
    }),
    findByApproval: vi.fn(async () => consumed ? { ...claim, state, ...(providerReference ? { providerReference } : {}) } : undefined),
    listAttempts: vi.fn(async () => [...attempts.values()].sort((a,b) => a.attempt-b.attempt)),
    recordAttempt: vi.fn(async input => {
      const { attempt, step, state: attemptState, providerReference: ref } = input;
      attempts.set(attempt, { attempt, step, state: attemptState });
      events.push({ attempt, step, state: attemptState, ...(ref ? { providerReference: ref } : {}) });
    }),
    assertWritable: vi.fn(async () => {}),
    finish: vi.fn(async input => { state = input.outcome; providerReference = input.providerReference; }),
    resolveUncertain: vi.fn(async input => { state = input.outcome; providerReference = input.providerReference; }),
    markStale: vi.fn(async () => { state = 'failed'; }),
  };
  let branch: { name: string; commitSha: string } | undefined;
  let pullRequest: PullRequest | undefined;
  const url = 'https://github.com/owner/repo/pull/41';
  const provider: ActionProvider = {
    reconcile: vi.fn(async () => {
      if (options.revoked) throw new GitAdapterError('provider_access_revoked');
      if (options.unknown) return { status: 'unknown' as const };
      if (options.staleBase) return { status: 'stale_base' as const };
      if (pullRequest) return { status: 'pull_request_found' as const, pullRequest };
      if (branch) return { status: 'branch_found' as const, branch: branch.name, commitSha: branch.commitSha };
      return { status: 'definitely_not_applied' as const };
    }),
    publishBranch: vi.fn(async input => {
      await input.beforeWrite();
      branch = { name: 'gotchu/action-' + actionHash.slice(0,16), commitSha: '4'.repeat(40) };
      if (options.crashAfterBranch) throw new GitAdapterError('unknown_outcome');
      return { branch: branch.name, commitSha: branch.commitSha };
    }),
    openPullRequest: vi.fn(async input => {
      await input.beforeWrite();
      pullRequest = { number:41,url,state:options.closedPullRequest ? 'closed' : 'open',draft:true,headSha:input.commitSha,headBranch:input.branch,baseSha:baseCommit,baseBranch:'main' };
      if (options.crashAfterPullRequest) throw new GitAdapterError('unknown_outcome');
      return pullRequest;
    }),
    verify: vi.fn(async () => options.verifyUnknown ? 'unknown' as const : options.closedPullRequest ? 'closed' as const : 'verified' as const),
  };
  const executor = createActionExecutor({ ledger, provider, loadArtifact: async () => artifact });
  const request = { organizationId, applicationId, approvalId, expectedActionHash: actionHash, expectedResourceVersion: baseCommit };
  return { executor, ledger, provider, request, getState: () => state, events, getBranch: () => branch, getPullRequest: () => pullRequest };
}

describe('independent v2 action executor', () => {
  it('accepts only the exact two-file npm candidate and its deterministic commit digest', async () => {
    const organizationId=randomUUID();
    const applicationId=randomUUID();
    const candidateId=randomUUID();
    const baseCommit='1'.repeat(40);
    const packageJson=JSON.stringify({name:'fixture',dependencies:{lodash:'4.17.21'}})+'\n';
    const integrity=`sha512-${Buffer.alloc(64,7).toString('base64')}`;
    const packageLock=JSON.stringify({lockfileVersion:3,requires:true,packages:{'':{dependencies:{lodash:'4.17.21'}},'node_modules/lodash':{name:'lodash',version:'4.17.21',integrity}}})+'\n';
    const files=[
      {path:'package.json',mode:'100644' as const,content:packageJson},
      {path:'package-lock.json',mode:'100644' as const,content:packageLock},
    ];
    const treeSha=await computeGitTreeSha(files);
    const commitMessage=dependencyCommitMessage({packageName:'lodash',fromVersion:'4.17.20',toVersion:'4.17.21'});
    const action:ActionV2={version:2,kind:'dependency_pull_request',capabilityId:'repository.dependency_pr',organizationId,applicationId,
      policyVersion:'gotchu-dependency-pr-v1',target:{kind:'repository',repositoryLinkId:randomUUID(),repositoryKey:'github:owner/repo',branch:'main'},
      baseCommit,candidateCommit:expectedDependencyCommitSha(treeSha,baseCommit,commitMessage),changes:[{name:'lodash',from:'4.17.20',to:'4.17.21'}],
      advisoryIds:['GHSA-xxxx-yyyy-zzzz'],lockfileSha256:sha256(packageLock),patchSha256:'b'.repeat(64),rescanAttestationId:randomUUID(),
      suiteAttestationId:randomUUID(),evidence:[{id:candidateId,sha256:'a'.repeat(64),kind:'dependency_candidate'}]};
    const artifact:ExecutionArtifact={baseCommit,files:files.map(file=>({path:file.path,mode:file.mode,contentBase64:Buffer.from(file.content).toString('base64'),sha256:sha256(file.content)})),
      candidateTreeSha:treeSha,treeSha,treeComplete:true,unsupportedReason:null,commitMessage,snapshotSha256:'a'.repeat(64),patchSha256:action.patchSha256,
      artifactSha256:'c'.repeat(64),sizeBytes:Buffer.byteLength(packageJson)+Buffer.byteLength(packageLock)};
    expect(expectedActionTreeSha(action,artifact)).toBe(treeSha);
    expect(expectedActionTreeSha(action,{...artifact,commitMessage:'unapproved message'})).toBeNull();
    expect(expectedActionTreeSha(action,{...artifact,files:artifact.files.filter(file=>file.path!=='package-lock.json')})).toBeNull();
  });

  it('publishes once, records every stage, verifies GitHub, and reconciles duplicate delivery read-only', async () => {
    const f = fixture();
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'verified',providerReference:'https://github.com/owner/repo/pull/41' });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'verified' });
    expect(f.provider.publishBranch).toHaveBeenCalledTimes(1);
    expect(f.provider.openPullRequest).toHaveBeenCalledTimes(1);
    expect(f.provider.verify).toHaveBeenCalledTimes(2);
    expect(f.getState()).toBe('succeeded');
    expect(f.events.map(event => event.state)).toEqual(expect.arrayContaining(['claimed','branch_published','pr_opened','verified']));
  });

  it('reconciles a branch written before a timeout and never publishes a second branch', async () => {
    const f = fixture({ crashAfterBranch:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    expect(f.getState()).toBe('uncertain');
    f.provider.reconcile = vi.fn(async () => f.getBranch()
      ? { status:'branch_found' as const,branch:f.getBranch()!.name,commitSha:f.getBranch()!.commitSha }
      : { status:'definitely_not_applied' as const });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'verified' });
    expect(f.provider.publishBranch).toHaveBeenCalledTimes(1);
    expect(f.provider.openPullRequest).toHaveBeenCalledTimes(1);
  });

  it('finds a PR created before a timeout and settles without a second PR write', async () => {
    const f = fixture({ crashAfterPullRequest:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    f.provider.reconcile = vi.fn(async () => ({ status:'pull_request_found' as const, pullRequest:f.getPullRequest()! }));
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'verified' });
    expect(f.provider.openPullRequest).toHaveBeenCalledTimes(1);
    expect(f.provider.publishBranch).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a branch deleted after an ambiguous publication', async () => {
    const f = fixture({ crashAfterBranch:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    f.provider.reconcile = vi.fn(async () => ({ status:'definitely_not_applied' as const }));
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain',reasonCode:'provider_effect_disappeared' });
    expect(f.provider.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.openPullRequest).not.toHaveBeenCalled();
  });

  it('does not recreate a PR deleted after an ambiguous open', async () => {
    const f = fixture({ crashAfterPullRequest:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    const branch = f.getBranch();
    expect(branch).toBeDefined();
    f.provider.reconcile = vi.fn(async () => ({ status:'branch_found' as const,branch:branch!.name,commitSha:branch!.commitSha }));
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain',reasonCode:'provider_pull_request_disappeared' });
    expect(f.provider.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.openPullRequest).toHaveBeenCalledOnce();
  });

  it('does not write with missing approval, revoked writer credentials, or stale base', async () => {
    const missing = fixture();
    missing.ledger.claim = vi.fn(async () => { throw new BackendError('not_found','missing approval'); });
    expect(await missing.executor.execute(missing.request)).toMatchObject({ status:'rejected' });
    expect(missing.provider.publishBranch).not.toHaveBeenCalled();

    const credentials = fixture({ revoked:true });
    expect(await credentials.executor.execute(credentials.request)).toMatchObject({ status:'failed',reasonCode:'provider_access_revoked' });
    expect(credentials.provider.publishBranch).not.toHaveBeenCalled();
    expect(credentials.getState()).toBe('failed');

    const stale = fixture({ staleBase:true });
    expect(await stale.executor.execute(stale.request)).toMatchObject({ status:'failed',reasonCode:'base_changed' });
    expect(stale.provider.publishBranch).not.toHaveBeenCalled();
    expect(stale.ledger.markStale).toHaveBeenCalledOnce();
  });

  it('keeps an unknown provider result uncertain and prevents another write', async () => {
    const f = fixture({ unknown:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    expect(f.provider.publishBranch).not.toHaveBeenCalled();
    expect(f.provider.openPullRequest).not.toHaveBeenCalled();
    expect(f.getState()).toBe('uncertain');
  });

  it('keeps a queued approval retryable while another execution holds the repository lock', async () => {
    const f = fixture();
    f.ledger.claim = vi.fn(async () => { throw new BackendError('repository_busy', 'another repository execution owns the lock'); });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain',reasonCode:'repository_busy' });
    expect(f.provider.reconcile).not.toHaveBeenCalled();
    expect(f.provider.publishBranch).not.toHaveBeenCalled();
  });

  it('settles a closed PR without publishing a replacement', async () => {
    const f = fixture({ closedPullRequest:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'failed',reasonCode:'pull_request_closed' });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'failed',reasonCode:'already_failed' });
    expect(f.provider.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.openPullRequest).toHaveBeenCalledOnce();
  });

  it('keeps an unavailable PR head uncertain and never republishes', async () => {
    const f = fixture({ verifyUnknown:true });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    expect(await f.executor.execute(f.request)).toMatchObject({ status:'uncertain' });
    expect(f.provider.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.openPullRequest).toHaveBeenCalledOnce();
    expect(f.getState()).toBe('uncertain');
  });
});
