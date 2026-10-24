import { randomUUID } from 'node:crypto';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, canonicalJson, parse, sha256, systemClock, type BaseDependencies, type Identity } from './core.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const version = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
const dependencyChange = z.object({ name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/).max(214), from: version, to: version }).strict().refine(change => {
  const [oldMajor = NaN, oldMinor = NaN, oldPatch = NaN] = change.from.split('.').map(Number);
  const [newMajor = NaN, newMinor = NaN, newPatch = NaN] = change.to.split('.').map(Number);
  return oldMajor === newMajor && (newMinor > oldMinor || (newMinor === oldMinor && newPatch > oldPatch));
}, 'Only increasing patch or minor dependency versions are eligible');
export const proposalSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), applicationId: z.uuid(), adapter: z.literal('github.pull_request'),
  target: z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), branch: z.string().min(1).max(200) }).strict(),
  baseCommit: commit, candidateCommit: commit,
  changes: z.array(dependencyChange).min(1).max(100).refine(changes => new Set(changes.map(c => c.name)).size === changes.length, 'Dependencies must be unique'),
  artifact: z.object({ id: z.uuid(), patchSha256: digest, lockfileSha256: digest }).strict(),
  evidence: z.array(z.object({ id: z.uuid(), sha256: digest, tool: z.string().min(1).max(100), toolVersion: z.string().min(1).max(100), observedAt: z.iso.datetime(), snapshotCommit: commit }).strict()).min(1).max(50),
  policyVersion: z.string().min(1).max(100),
  validation: z.object({ rescanAttestationId: z.uuid(), suiteAttestationId: z.uuid() }).strict(),
  verificationPlan: z.object({ expectedCandidateCommit: commit, checkPatchDigest: z.literal(true), checkPullRequestHead: z.literal(true) }).strict(),
}).strict().refine(p => p.baseCommit !== p.candidateCommit && p.candidateCommit === p.verificationPlan.expectedCandidateCommit, 'Verification plan must bind the distinct candidate commit');
export type Proposal = z.infer<typeof proposalSchema>;

export const proposalEligibilitySchema = z.object({
  policyVersion: z.string(), currentBaseCommit: commit, candidateCommit: commit, patchSha256: digest, lockfileSha256: digest,
  rescanAttestationId: z.uuid(), suiteAttestationId: z.uuid(),
  rescanPassed: z.boolean(), suitePassed: z.boolean(), suiteRelevant: z.boolean(), vmIsolationVerified: z.boolean(), repositoryAutomationSafe: z.boolean(),
  observedAt: z.date(),
}).strict();
export type ProposalEligibility = z.infer<typeof proposalEligibilitySchema>;
/** Trusted independent gateway: inspect policy, immutable artifacts, attestations, and provider head.
 * Never implement this as a pass-through of model/HTTP-supplied claims. No provider writes here. */
export interface ProposalVerifier { verify(proposal: Proposal, context: { phase: 'proposal' | 'approval' | 'execution' }): Promise<ProposalEligibility> }
export const verifiedStepUpSchema = z.object({
  proofId: z.string().min(1).max(256), userId: z.string().min(1).max(256), organizationId: z.uuid(), actionHash: digest,
  authenticatedAt: z.date(), expiresAt: z.date(), method: z.enum(['webauthn', 'totp']),
}).strict();
export type VerifiedStepUp = z.infer<typeof verifiedStepUpSchema>;
/** Validate a server-issued second-factor ceremony bound to the supplied expected identity/action.
 * The opaque proof must not be a caller-provided timestamp. Return facts from trusted verifier state. */
export interface StepUpVerifier { verify(input: { proof: string; userId: string; organizationId: string; actionHash: string }): Promise<VerifiedStepUp> }
export interface ApprovalDependencies extends BaseDependencies { proposalVerifier?: ProposalVerifier; stepUpVerifier?: StepUpVerifier }
export const APPROVAL_TTL_MS = 5 * 60_000;
export const STEP_UP_MAX_AGE_MS = 5 * 60_000;
export const ELIGIBILITY_MAX_AGE_MS = 60_000;
export function hashProposal(proposal: Proposal, recoveryEpoch: string): string {
  return sha256('gotchu-proposal-v1\n' + canonicalJson({ proposal: parse(proposalSchema, proposal), recoveryEpoch: parse(z.string().regex(/^[1-9][0-9]*$/), recoveryEpoch) }));
}
export function assertProposalEligibility(proposal: Proposal, input: ProposalEligibility, now: Date): void {
  const fact = parse(proposalEligibilitySchema, input);
  if (fact.observedAt.getTime() > now.getTime() || now.getTime() - fact.observedAt.getTime() > ELIGIBILITY_MAX_AGE_MS) throw new BackendError('stale_verification', 'Independent eligibility verification is not fresh', 409);
  if (fact.currentBaseCommit !== proposal.baseCommit) throw new BackendError('stale_state', 'Target head changed; regenerate, validate, and approve a new proposal', 409);
  if (fact.policyVersion !== proposal.policyVersion || fact.candidateCommit !== proposal.candidateCommit || fact.patchSha256 !== proposal.artifact.patchSha256 || fact.lockfileSha256 !== proposal.artifact.lockfileSha256 || fact.rescanAttestationId !== proposal.validation.rescanAttestationId || fact.suiteAttestationId !== proposal.validation.suiteAttestationId) throw new BackendError('artifact_mismatch', 'Independent verification does not bind the exact proposal artifacts and policy', 409);
  if (!fact.rescanPassed || !fact.suitePassed || !fact.suiteRelevant || !fact.vmIsolationVerified || !fact.repositoryAutomationSafe) throw new BackendError('proposal_ineligible', 'Required independent policy, tests, isolation, or repository safety gates are unavailable', 409);
}
export function assertStepUp(fact: VerifiedStepUp, expected: { userId: string; organizationId: string; actionHash: string }, now: Date): void {
  if (fact.userId !== expected.userId || fact.organizationId !== expected.organizationId || fact.actionHash !== expected.actionHash || fact.authenticatedAt.getTime() > now.getTime() || now.getTime() - fact.authenticatedAt.getTime() > STEP_UP_MAX_AGE_MS || fact.expiresAt.getTime() <= now.getTime() || fact.expiresAt.getTime() <= fact.authenticatedAt.getTime()) throw new BackendError('step_up_required', 'Fresh second-factor proof bound to this exact action is required', 403);
}
export async function authorizationState(tx: Transaction, requireUnfrozen = true): Promise<{ recoveryEpoch: string; writesFrozen: boolean }> {
  const result = await tx.query<{ recovery_epoch: string; writes_frozen: boolean }>('SELECT * FROM gotchu.lock_authorization_state()');
  const row = result.rows[0];
  if (!row || (requireUnfrozen && row.writes_frozen)) throw new BackendError('writes_frozen', 'Provider writes are frozen pending operator reconciliation', 409);
  return { recoveryEpoch: String(row.recovery_epoch), writesFrozen: row.writes_frozen };
}
export async function checkedProposal(tx: Transaction, organizationId: string, proposalId: string): Promise<{ proposal: Proposal; actionHash: string; recoveryEpoch: string }> {
  const result = await tx.query<{ body: unknown; action_hash: string; recovery_epoch: string; invalidated_at: Date | null }>('SELECT body,action_hash,recovery_epoch,invalidated_at FROM gotchu.proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, proposalId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Proposal not found', 404);
  if (row.invalidated_at) throw new BackendError('proposal_invalidated', 'Proposal was invalidated; regenerate and validate a new proposal', 409);
  const proposal = parse(proposalSchema, row.body);
  if (proposal.organizationId !== organizationId || hashProposal(proposal, String(row.recovery_epoch)) !== row.action_hash) throw new BackendError('proposal_corrupt', 'Proposal binding does not match the immutable action hash', 409);
  return { proposal, actionHash: row.action_hash, recoveryEpoch: String(row.recovery_epoch) };
}
export async function verifyProposal(deps: ApprovalDependencies, proposal: Proposal, phase: 'proposal' | 'approval' | 'execution'): Promise<void> {
  if (!deps.proposalVerifier) throw new BackendError('verification_unavailable', 'No independent proposal verifier is configured', 503);
  assertProposalEligibility(proposal, await deps.proposalVerifier.verify(proposal, { phase }), (deps.clock ?? systemClock).now());
}
/** Return the rejection so the caller can COMMIT its invalidation before throwing. */
export async function verifyStoredProposal(tx: Transaction, deps: ApprovalDependencies, proposal: Proposal, proposalId: string, phase: 'approval' | 'execution'): Promise<BackendError | null> {
  try { await verifyProposal(deps, proposal, phase); return null; }
  catch (error) {
    if (!(error instanceof BackendError) || !['stale_state', 'artifact_mismatch', 'proposal_ineligible'].includes(error.code)) throw error;
    await tx.query('UPDATE gotchu.proposals SET invalidated_at=clock_timestamp(),invalidation_reason=$3 WHERE organization_id=$1 AND id=$2', [proposal.organizationId, proposalId, error.code]);
    await audit(tx, proposal.organizationId, 'independent-verifier', 'proposal.invalidated', proposalId, { reason: error.code });
    return error;
  }
}
export function createProposalService(deps: ApprovalDependencies) {
  const clock = deps.clock ?? systemClock;
  return {
    /** Trusted preparation service only. No direct model or public route should expose this method. */
    async create(input: { organizationId: string; proposal: Proposal }): Promise<{ proposalId: string; actionHash: string; recoveryEpoch: string }> {
      const value = parse(z.object({ organizationId: z.uuid(), proposal: proposalSchema }).strict(), input);
      if (value.proposal.organizationId !== value.organizationId) throw new BackendError('tenant_mismatch', 'Proposal belongs to another organization', 403);
      return deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx, false);
        await verifyProposal(deps, value.proposal, 'proposal');
        const actionHash = hashProposal(value.proposal, state.recoveryEpoch);
        const proposalId = randomUUID();
        const inserted = await tx.query('INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (organization_id,action_hash) DO NOTHING RETURNING id', [value.organizationId, value.proposal.applicationId, proposalId, actionHash, JSON.stringify(value.proposal), state.recoveryEpoch]);
        if (!inserted.rowCount) {
          const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.proposals WHERE organization_id=$1 AND action_hash=$2', [value.organizationId, actionHash]);
          const row = prior.rows[0];
          if (!row) throw new BackendError('proposal_conflict', 'Idempotent proposal disappeared during creation', 409);
          return { proposalId: row.id, actionHash, recoveryEpoch: state.recoveryEpoch };
        }
        await audit(tx, value.organizationId, 'trusted-preparer', 'proposal.created', proposalId, { actionHash });
        return { proposalId, actionHash, recoveryEpoch: state.recoveryEpoch };
      });
    },
    async approve(identity: Identity, input: { organizationId: string; proposalId: string; actionHash: string; stepUpProof: string }): Promise<{ approvalId: string; expiresAt: Date }> {
      const value = parse(z.object({ organizationId: z.uuid(), proposalId: z.uuid(), actionHash: digest, stepUpProof: z.string().min(1).max(4096) }).strict(), input);
      const stepUpVerifier = deps.stepUpVerifier;
      if (!stepUpVerifier) throw new BackendError('step_up_unavailable', 'A trusted second-factor verifier must be configured before approvals can be issued', 503);
      const result = await deps.database.tenant(value.organizationId, async tx => {
        const state = await authorizationState(tx);
        await authorize(tx, value.organizationId, identity, ['owner']);
        const stored = await checkedProposal(tx, value.organizationId, value.proposalId);
        if (stored.actionHash !== value.actionHash) throw new BackendError('hash_mismatch', 'Approval must bind the exact stored action hash', 409);
        if (stored.recoveryEpoch !== state.recoveryEpoch) throw new BackendError('stale_epoch', 'A new post-recovery proposal is required', 409);
        const rejected = await verifyStoredProposal(tx, deps, stored.proposal, value.proposalId, 'approval');
        if (rejected) return rejected;
        const expected = { userId: identity.userId, organizationId: value.organizationId, actionHash: value.actionHash };
        const proof = parse(verifiedStepUpSchema, await stepUpVerifier.verify({ ...expected, proof: value.stepUpProof }));
        const now = clock.now();
        assertStepUp(proof, expected, now);
        const expiresAt = new Date(Math.min(now.getTime() + APPROVAL_TTL_MS, proof.authenticatedAt.getTime() + STEP_UP_MAX_AGE_MS, proof.expiresAt.getTime()));
        const approvalId = randomUUID();
        const inserted = await tx.query('INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,proof_id,recovery_epoch,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (proof_id) DO NOTHING RETURNING id', [value.organizationId, approvalId, value.proposalId, value.actionHash, identity.userId, proof.proofId, state.recoveryEpoch, expiresAt]);
        if (!inserted.rowCount) throw new BackendError('proof_replayed', 'Second-factor proof has already been used', 409);
        await audit(tx, value.organizationId, identity.userId, 'proposal.approved', approvalId, { proposalId: value.proposalId, actionHash: value.actionHash });
        return { approvalId, expiresAt };
      });
      if (result instanceof BackendError) throw result;
      return result;
    },
  };
}
