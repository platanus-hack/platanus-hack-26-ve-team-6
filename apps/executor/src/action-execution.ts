import { BackendError, dependencyCommitMessage, expectedDependencyCommitSha, hashStoredAction, sha256 } from '@gotchu/backend';
import type { ActionV2 } from '@gotchu/contracts';
import type { ExecutionArtifact } from '@gotchu/backend';
import { actionV2Schema } from '@gotchu/contracts';
import type { PullRequest } from '@gotchu/git-adapters';
import { GitAdapterError } from '@gotchu/git-adapters';
import { z } from 'zod';
import { executionRequestSchema } from './execution.js';

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const attemptSchema = z.object({
  attempt: z.number().int().positive(), state: z.enum(['claimed','branch_published','pr_opened','verified','failed','uncertain','reconciliation_required']),
  step: z.enum(['claim','publish_branch','open_pr','verify']),
}).passthrough();
const pullRequestActionSchema = z.union([actionV2Schema.options[0],actionV2Schema.options[1]]);
const claimFieldsSchema = z.object({
  organizationId: uuid, applicationId: uuid, approvalId: uuid, executionId: uuid, claimToken: uuid,
  actionHash: digest, recoveryEpoch: z.string().regex(/^[1-9][0-9]*$/), proposal: pullRequestActionSchema,
  providerReference: z.string().min(1).max(1000).optional(),
}).strict();
const claimSchema = claimFieldsSchema;
const storedExecutionSchema = claimFieldsSchema.extend({
  state: z.enum(['claimed','succeeded','failed','uncertain']), providerReference: z.string().min(1).max(1000).optional(),
}).strict();

export type PullRequestAction = Extract<ActionV2, { kind: 'source_patch_pull_request' | 'dependency_pull_request' }>;
export type RepositoryPublication = {
  readonly action: PullRequestAction;
  readonly actionHash: string;
  readonly executionId: string;
  readonly artifact: ExecutionArtifact;
};
export type ProviderReconciliation =
  | { status: 'pull_request_found'; pullRequest: PullRequest }
  | { status: 'branch_found'; branch: string; commitSha: string }
  | { status: 'definitely_not_applied' }
  | { status: 'stale_base' }
  | { status: 'unknown' };
export type ProviderVerification = 'verified' | 'closed' | 'stale_base' | 'mismatch' | 'unknown';
export interface ActionProvider {
  reconcile(input: RepositoryPublication): Promise<ProviderReconciliation>;
  publishBranch(input: RepositoryPublication & { beforeWrite: () => Promise<void> }): Promise<{ branch: string; commitSha: string }>;
  openPullRequest(input: RepositoryPublication & { branch: string; commitSha: string; beforeWrite: () => Promise<void> }): Promise<PullRequest>;
  verify(input: RepositoryPublication & { pullRequest: PullRequest }): Promise<ProviderVerification>;
}
export interface ActionExecutionLedger {
  claim(input: { organizationId: string; approvalId: string }): Promise<unknown>;
  findByApproval(input: { organizationId: string; approvalId: string }): Promise<unknown | undefined>;
  listAttempts(input: { organizationId: string; executionId: string }): Promise<unknown>;
  recordAttempt(input: { organizationId: string; executionId: string; attempt: number; step: string; state: string; providerReference?: string; detail?: unknown }): Promise<void>;
  assertWritable(input: { organizationId: string; executionId: string; claimToken: string }): Promise<void>;
  finish(input: { organizationId: string; executionId: string; claimToken: string; outcome: 'succeeded'|'failed'|'uncertain'; providerReference?: string }): Promise<void>;
  resolveUncertain(input: { organizationId: string; executionId: string; claimToken: string; outcome: 'succeeded'|'failed'; providerReference?: string }): Promise<void>;
  markStale(input: { organizationId: string; executionId: string; claimToken: string; reason: 'base_changed'|'policy_changed'; providerReference?: string }): Promise<void>;
}
export interface ActionExecutionRequest { organizationId: string; applicationId: string; approvalId: string; expectedActionHash: string; expectedResourceVersion: string }
export type ActionExecutionResult = { status: 'disabled'|'verified'|'failed'|'uncertain'|'rejected'; reasonCode: string; executionId?: string; providerReference?: string };

function backendCode(error: unknown): string | undefined {
  return error instanceof BackendError ? error.code : undefined;
}

function matchesRequest(claim: z.infer<typeof claimSchema>, request: ActionExecutionRequest): boolean {
  return claim.organizationId === request.organizationId && claim.applicationId === request.applicationId
    && claim.approvalId === request.approvalId && claim.actionHash === request.expectedActionHash
    && claim.proposal.organizationId === request.organizationId && claim.proposal.applicationId === request.applicationId
    && claim.proposal.baseCommit === request.expectedResourceVersion
    && hashStoredAction(claim.proposal, claim.recoveryEpoch) === claim.actionHash;
}

export function expectedActionTreeSha(action: PullRequestAction, artifact: ExecutionArtifact): string | null {
  if (artifact.treeSha === null || !artifact.treeComplete || artifact.baseCommit !== action.baseCommit) return null;
  if (artifact.files.some(file => {
    const content=Buffer.from(file.contentBase64,'base64');
    return content.toString('base64') !== file.contentBase64 || sha256(content) !== file.sha256;
  })) return null;
  const candidate = action.evidence.find(item => item.kind === (action.kind === 'source_patch_pull_request' ? 'private_correction_candidate' : 'dependency_candidate'));
  if (!candidate || artifact.snapshotSha256 !== candidate.sha256 || artifact.patchSha256 !== action.patchSha256) return null;
  if (action.kind === 'source_patch_pull_request') return action.expectedTreeSha === artifact.treeSha ? artifact.treeSha : null;

  const change = action.changes.length === 1 ? action.changes[0] : undefined;
  if (!change || artifact.files.length !== 2
    || canonicalPaths(artifact.files.map(file => file.path)) !== 'package-lock.json\u0000package.json') return null;
  const message = dependencyCommitMessage({ packageName: change.name, fromVersion: change.from, toVersion: change.to });
  const lockfile = artifact.files.find(file => file.path === 'package-lock.json');
  const manifest = artifact.files.find(file => file.path === 'package.json');
  if (!lockfile || !manifest || lockfile.mode !== '100644' || manifest.mode !== '100644') return null;
  try {
    if (sha256(Buffer.from(lockfile.contentBase64,'base64')) !== action.lockfileSha256) return null;
    const manifestValue: unknown = JSON.parse(Buffer.from(manifest.contentBase64,'base64').toString('utf8'));
    const lockfileValue: unknown = JSON.parse(Buffer.from(lockfile.contentBase64,'base64').toString('utf8'));
    const packageSchema = z.record(z.string(),z.unknown());
    const parsedManifest = packageSchema.parse(manifestValue);
    const parsedLockfile = packageSchema.parse(lockfileValue);
    const rootPackages = packageSchema.parse(parsedLockfile.packages);
    const lockRoot = packageSchema.parse(rootPackages['']);
    const targetPackage = packageSchema.parse(rootPackages[`node_modules/${change.name}`]);
    const sections = ['dependencies','devDependencies','optionalDependencies'] as const;
    const sectionVersion = (value: Record<string, unknown>) => sections.some(section => {
      if (value[section] === undefined) return false;
      return packageSchema.parse(value[section])[change.name] === change.to;
    });
    if (!sectionVersion(parsedManifest) || !sectionVersion(lockRoot)
      || targetPackage.version !== change.to || targetPackage.name !== undefined && targetPackage.name !== change.name
      || typeof targetPackage.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(targetPackage.integrity)) return null;
    if (artifact.commitMessage !== message || expectedDependencyCommitSha(artifact.treeSha, action.baseCommit, message) !== action.candidateCommit) return null;
  } catch { return null; }
  return artifact.treeSha;
}

function canonicalPaths(paths: string[]): string {
  return paths.sort().join('\u0000');
}

export function createActionExecutor(options: {
  ledger: ActionExecutionLedger;
  provider?: ActionProvider;
  loadArtifact(input: { organizationId: string; applicationId: string; candidateSourceId: string }): Promise<ExecutionArtifact>;
}) {
  async function updateAttempt(claim: z.infer<typeof claimSchema>, attempt: number, step: string, state: string, details: { reasonCode?: string; branch?: string; pullRequestNumber?: number } = {}, providerReference?: string) {
    await options.ledger.recordAttempt({ organizationId: claim.organizationId, executionId: claim.executionId, attempt, step, state, detail: details, ...(providerReference ? { providerReference } : {}) });
  }

  async function settle(claim: z.infer<typeof claimSchema>, previousState: 'claimed'|'uncertain'|'succeeded', outcome: 'succeeded'|'failed'|'uncertain', providerReference?: string) {
    if (previousState === 'succeeded') return;
    const input = { organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken, ...(providerReference ? { providerReference } : {}) };
    if (previousState === 'uncertain') {
      if (outcome !== 'uncertain') await options.ledger.resolveUncertain({ ...input, outcome });
      return;
    }
    await options.ledger.finish({ ...input, outcome });
  }

  async function stale(claim: z.infer<typeof claimSchema>, reason: 'base_changed'|'policy_changed', attempt: number, step: string, providerReference?: string) {
    await updateAttempt(claim, attempt, step, 'failed', { reasonCode: reason }, providerReference);
    await options.ledger.markStale({ organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken, reason, ...(providerReference ? { providerReference } : {}) });
    return result('failed', reason, claim.executionId, providerReference);
  }

  async function uncertain(claim: z.infer<typeof claimSchema>, previousState: 'claimed'|'uncertain'|'succeeded', attempt: number, step: string, reasonCode: string, providerReference?: string) {
    if (previousState === 'succeeded') return result('uncertain', reasonCode, claim.executionId, providerReference);
    await updateAttempt(claim, attempt, step, 'uncertain', { reasonCode }, providerReference);
    if (previousState === 'claimed') await settle(claim, previousState, 'uncertain', providerReference);
    return result('uncertain', reasonCode, claim.executionId, providerReference);
  }

  async function verifyAndSettle(claim: z.infer<typeof claimSchema>, publication: RepositoryPublication, previousState: 'claimed'|'uncertain'|'succeeded', attempt: number, pullRequest: PullRequest, recordPullRequestStage = false) {
    if (previousState === 'succeeded') {
      let verification: ProviderVerification;
      try { verification = await options.provider!.verify({ ...publication, pullRequest }); }
      catch { return result('uncertain', 'provider_verification_unknown', claim.executionId, pullRequest.url); }
      return result(verification === 'verified' ? 'verified' : 'uncertain', verification === 'verified' ? 'provider_verified' : `provider_${verification}`, claim.executionId, pullRequest.url);
    }
    if (recordPullRequestStage) await updateAttempt(claim, attempt, 'open_pr', 'pr_opened', { pullRequestNumber: pullRequest.number }, pullRequest.url);
    await updateAttempt(claim, attempt, 'verify', 'pr_opened', { pullRequestNumber: pullRequest.number }, pullRequest.url);
    let verification: ProviderVerification;
    try { verification = await options.provider!.verify({ ...publication, pullRequest }); }
    catch { return uncertain(claim, previousState, attempt, 'verify', 'provider_verification_unknown', pullRequest.url); }
    if (verification === 'stale_base') return stale(claim, 'base_changed', attempt, 'verify', pullRequest.url);
    if (verification === 'closed') {
      await updateAttempt(claim, attempt, 'verify', 'failed', { reasonCode: 'pull_request_closed' }, pullRequest.url);
      await settle(claim, previousState, 'failed', pullRequest.url);
      return result('failed', 'pull_request_closed', claim.executionId, pullRequest.url);
    }
    if (verification !== 'verified') return uncertain(claim, previousState, attempt, 'verify', verification === 'mismatch' ? 'provider_verification_mismatch' : 'provider_verification_unknown', pullRequest.url);
    await updateAttempt(claim, attempt, 'verify', 'verified', { pullRequestNumber: pullRequest.number }, pullRequest.url);
    await settle(claim, previousState, 'succeeded', pullRequest.url);
    return result('verified', 'provider_verified', claim.executionId, pullRequest.url);
  }

  async function execute(rawRequest: unknown): Promise<ActionExecutionResult> {
    const parsedRequest = executionRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success) return result('rejected', 'approval_rejected');
    if (!options.provider) return result('disabled', 'provider_adapter_disabled');
    const request = parsedRequest.data;

    let claim: z.infer<typeof claimSchema>;
    let previousState: 'claimed'|'uncertain'|'succeeded' = 'claimed';
    try {
      claim = claimSchema.parse(await options.ledger.claim({ organizationId: request.organizationId, approvalId: request.approvalId }));
    } catch (error) {
      if (!['approval_used','already_claimed'].includes(backendCode(error) ?? '')) {
        const code = backendCode(error);
        if (code === 'repository_busy') return result('uncertain', 'repository_busy');
        return result('rejected', code === 'stale_state' || code === 'stale_policy' ? 'stale_proposal' : 'approval_rejected');
      }
      let existing: z.infer<typeof storedExecutionSchema>;
      try {
        const raw = await options.ledger.findByApproval({ organizationId: request.organizationId, approvalId: request.approvalId });
        if (raw === undefined) return result('uncertain', 'already_claimed');
        existing = storedExecutionSchema.parse(raw);
      } catch {
        return result('uncertain', 'ledger_unavailable');
      }
      if (!matchesRequest(existing, request)) return result('rejected', existing.actionHash === request.expectedActionHash ? 'resource_version_stale' : 'action_hash_mismatch', existing.executionId, existing.providerReference);
      if (existing.state === 'failed') return result('failed', 'already_failed', existing.executionId, existing.providerReference);
      if (existing.state === 'succeeded') previousState = 'succeeded';
      else previousState = existing.state === 'uncertain' ? 'uncertain' : 'claimed';
      claim = existing;
    }
    if (!matchesRequest(claim, request)) return result('rejected', claim.actionHash === request.expectedActionHash ? 'resource_version_stale' : 'action_hash_mismatch', claim.executionId);

    const action = claim.proposal;
    let artifact: ExecutionArtifact;
    try {
      const evidenceKind = action.kind === 'source_patch_pull_request' ? 'private_correction_candidate' : 'dependency_candidate';
      const candidateSourceId = action.evidence.find(item => item.kind === evidenceKind)?.id;
      if (!candidateSourceId) throw new Error('candidate_artifact_missing');
      artifact = await options.loadArtifact({ organizationId: claim.organizationId, applicationId: claim.applicationId, candidateSourceId });
    } catch {
      if (previousState === 'claimed') {
        await settle(claim, previousState, 'failed');
        return result('failed', 'artifact_unavailable', claim.executionId);
      }
      return result('uncertain', 'artifact_unavailable', claim.executionId, claim.providerReference);
    }
    if (!expectedActionTreeSha(action, artifact)) {
      if (previousState === 'claimed') {
        await settle(claim, previousState, 'failed');
        return result('failed', 'artifact_mismatch', claim.executionId);
      }
      return result('uncertain', 'artifact_mismatch', claim.executionId, claim.providerReference);
    }
    const publication: RepositoryPublication = { action, actionHash: claim.actionHash, executionId: claim.executionId, artifact };
    let attempts: z.infer<typeof attemptSchema>[];
    try { attempts = z.array(attemptSchema).parse(await options.ledger.listAttempts({ organizationId: claim.organizationId, executionId: claim.executionId })); }
    catch { return result('uncertain', 'ledger_unavailable', claim.executionId); }
    let latest = attempts.at(-1);
    let attempt = latest?.attempt ?? 1;
    if (!latest && previousState === 'claimed') {
      await updateAttempt(claim, attempt, 'claim', 'claimed');
      latest = { attempt, state: 'claimed', step: 'claim' };
    }
    let reconciliation: ProviderReconciliation;
    try { reconciliation = await options.provider.reconcile(publication); }
    catch (error) {
      if (error instanceof GitAdapterError && error.code === 'provider_access_revoked' && previousState === 'claimed' && latest?.step === 'claim') {
        await updateAttempt(claim, attempt, 'claim', 'failed', { reasonCode:'provider_access_revoked' });
        await settle(claim, previousState, 'failed');
        return result('failed', 'provider_access_revoked', claim.executionId);
      }
      return uncertain(claim, previousState, attempt, latest?.step ?? 'claim', 'provider_reconciliation_unknown', claim.providerReference);
    }

    if (reconciliation.status === 'stale_base') {
      if (previousState === 'succeeded') return result('uncertain', 'provider_base_changed', claim.executionId, claim.providerReference);
      return stale(claim, 'base_changed', attempt, latest?.step ?? 'claim', claim.providerReference);
    }
    if (reconciliation.status === 'pull_request_found') return verifyAndSettle(claim, publication, previousState, attempt, reconciliation.pullRequest, latest?.step !== 'verify');
    if (previousState === 'succeeded') return result('uncertain', 'provider_effect_unavailable', claim.executionId, claim.providerReference);
    const previouslyAttemptedPullRequest = attempts.some(item => item.step === 'open_pr' || item.step === 'verify');
    if (reconciliation.status === 'branch_found' && previouslyAttemptedPullRequest) {
      return uncertain(claim, previousState, attempt, latest?.step ?? 'open_pr', 'provider_pull_request_disappeared', claim.providerReference);
    }
    const previouslyAttemptedBranch = attempts.some(item => item.step === 'publish_branch');
    if (reconciliation.status === 'definitely_not_applied' && (previouslyAttemptedBranch || previouslyAttemptedPullRequest)) {
      return uncertain(claim, previousState, attempt, latest?.step ?? 'publish_branch', 'provider_effect_disappeared', claim.providerReference);
    }

    let branch: string;
    let commitSha: string;
    if (reconciliation.status === 'branch_found') {
      branch = reconciliation.branch;
      commitSha = reconciliation.commitSha;
      await updateAttempt(claim, attempt, 'publish_branch', 'branch_published', { branch });
    } else if (reconciliation.status === 'unknown') {
      return uncertain(claim, previousState, attempt, latest?.step ?? 'claim', 'provider_reconciliation_unknown', claim.providerReference);
    } else {
      if (latest?.step === 'open_pr') return uncertain(claim, previousState, attempt, 'open_pr', 'provider_outcome_unknown', claim.providerReference);
      if (attempts.length > 0 && attempt < 2 && latest?.step !== 'claim') {
        attempt++;
        await updateAttempt(claim, attempt, 'claim', 'claimed');
      } else if (attempts.length >= 2) {
        await updateAttempt(claim, attempt, latest?.step ?? 'claim', 'failed', { reasonCode: 'retry_budget_exhausted' });
        await settle(claim, previousState, 'failed');
        return result('failed', 'retry_budget_exhausted', claim.executionId);
      } else if (!latest) {
        await updateAttempt(claim, attempt, 'claim', 'claimed');
      }
      await updateAttempt(claim, attempt, 'publish_branch', 'claimed');
      try {
        await options.ledger.assertWritable({ organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken });
        const published = await options.provider.publishBranch({ ...publication, beforeWrite: () => options.ledger.assertWritable({ organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken }) });
        branch = published.branch;
        commitSha = published.commitSha;
      } catch (error) {
        const code = backendCode(error);
        if (code === 'stale_state' || code === 'stale_policy') return stale(claim, code === 'stale_state' ? 'base_changed' : 'policy_changed', attempt, 'publish_branch');
        if (code && ['approval_expired','approval_rejected','stale_execution'].includes(code)) {
          await updateAttempt(claim, attempt, 'publish_branch', 'failed', { reasonCode: code });
          if (previousState === 'claimed') await settle(claim, previousState, 'failed');
          return result('failed', code, claim.executionId);
        }
        if (error instanceof GitAdapterError && error.code === 'conflict') {
          const afterConflict = await options.provider.reconcile(publication).catch(() => ({ status:'unknown' } as const));
          if (afterConflict.status === 'stale_base') return stale(claim, 'base_changed', attempt, 'publish_branch');
          if (afterConflict.status === 'pull_request_found') return verifyAndSettle(claim, publication, previousState, attempt, afterConflict.pullRequest, latest?.step !== 'verify');
          if (afterConflict.status === 'branch_found') {
            branch = afterConflict.branch;
            commitSha = afterConflict.commitSha;
          } else return uncertain(claim, previousState, attempt, 'publish_branch', 'provider_reconciliation_unknown');
        } else if (error instanceof GitAdapterError && error.code === 'provider_access_revoked' && previousState === 'claimed') {
          await updateAttempt(claim, attempt, 'publish_branch', 'failed', { reasonCode:'provider_access_revoked' });
          await settle(claim, previousState, 'failed');
          return result('failed', 'provider_access_revoked', claim.executionId);
        } else {
          return uncertain(claim, previousState, attempt, 'publish_branch', 'provider_outcome_unknown');
        }
      }
      await updateAttempt(claim, attempt, 'publish_branch', 'branch_published', { branch });
    }

    try {
      await options.ledger.assertWritable({ organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken });
      await updateAttempt(claim, attempt, 'open_pr', 'branch_published', { branch });
      const pullRequest = await options.provider.openPullRequest({ ...publication, branch, commitSha, beforeWrite: () => options.ledger.assertWritable({ organizationId: claim.organizationId, executionId: claim.executionId, claimToken: claim.claimToken }) });
      await updateAttempt(claim, attempt, 'open_pr', 'pr_opened', { branch, pullRequestNumber: pullRequest.number }, pullRequest.url);
      return verifyAndSettle(claim, publication, previousState, attempt, pullRequest);
    } catch (error) {
      const code = backendCode(error);
      if (code === 'stale_state' || code === 'stale_policy') return stale(claim, code === 'stale_state' ? 'base_changed' : 'policy_changed', attempt, 'open_pr');
      if (error instanceof GitAdapterError && error.code === 'provider_access_revoked') {
        await updateAttempt(claim, attempt, 'open_pr', 'failed', { reasonCode: 'provider_access_revoked' });
        await settle(claim, previousState, 'failed');
        return result('failed', 'provider_access_revoked', claim.executionId);
      }
      return uncertain(claim, previousState, attempt, 'open_pr', 'provider_outcome_unknown');
    }
  }

  return { execute };
}

function result(status: ActionExecutionResult['status'], reasonCode: string, executionId?: string, providerReference?: string): ActionExecutionResult {
  return { status, reasonCode, ...(executionId ? { executionId } : {}), ...(providerReference ? { providerReference } : {}) };
}
