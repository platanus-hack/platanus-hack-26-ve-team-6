import { randomUUID } from 'node:crypto';
import type { Proposal, ProposalEligibility } from '../src/index.js';
export function proposalFixture(scope: { organizationId: string; applicationId: string }): Proposal {
  return {
    version: 1, organizationId: scope.organizationId, applicationId: scope.applicationId, adapter: 'github.pull_request', target: { repository: 'example/service', branch: 'main' },
    baseCommit: '1'.repeat(40), candidateCommit: '2'.repeat(40), changes: [{ name: 'example-dependency', from: '1.2.3', to: '1.2.4' }],
    artifact: { id: randomUUID(), patchSha256: 'a'.repeat(64), lockfileSha256: 'b'.repeat(64) },
    evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), tool: 'osv-scanner', toolVersion: 'test-only', observedAt: new Date().toISOString(), snapshotCommit: '1'.repeat(40) }],
    policyVersion: 'test-policy-v1', validation: { rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID() },
    verificationPlan: { expectedCandidateCommit: '2'.repeat(40), checkPatchDigest: true, checkPullRequestHead: true },
  };
}
/** Test-only attestation facts. Does NOT prove a VM, real scanner run, or provider access. */
export function eligibilityFixture(proposal: Proposal, now = new Date()): ProposalEligibility {
  return {
    policyVersion: proposal.policyVersion, currentBaseCommit: proposal.baseCommit, candidateCommit: proposal.candidateCommit,
    patchSha256: proposal.artifact.patchSha256, lockfileSha256: proposal.artifact.lockfileSha256,
    ...proposal.validation, rescanPassed: true, suitePassed: true, suiteRelevant: true, vmIsolationVerified: true, repositoryAutomationSafe: true, observedAt: now,
  };
}
