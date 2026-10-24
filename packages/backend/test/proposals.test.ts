import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actionV2Schema, type ActionV2 } from '@gotchu/contracts';
import { assertProposalEligibility, assertStepUp, hashActionV2, hashProposal, proposalSchema, type VerifiedStepUp } from '../src/index.js';
import { present } from '../../database/test/support.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';
const proposal = proposalFixture({ organizationId: randomUUID(), applicationId: randomUUID() });
const now = new Date();
const actionV2: ActionV2 = {
  version: 2, kind: 'source_patch_pull_request', capabilityId: 'repository.source_patch_pr', organizationId: randomUUID(), applicationId: randomUUID(), policyVersion: 'policy-v2',
  target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: 'catalog:key', branch: 'main' }, recipeId: 'tls-certificate-verification', recipeVersion: '1',
  snapshotSha256: 'a'.repeat(64), patchSha256: 'b'.repeat(64), findingIdentities: ['finding-1'], validationAttestationIds: [randomUUID()], evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), kind: 'candidate' }],
};
describe('exact proposals and verifier contracts (unit fixtures, not live provider evidence)', () => {
  it('hashes every typed binding and the recovery epoch deterministically', () => {
    expect(hashProposal(proposal, '1')).toBe(hashProposal(JSON.parse(JSON.stringify(proposal)), '1'));
    const variants = [
      { ...proposal, target: { ...proposal.target, branch: 'other' } },
      { ...proposal, baseCommit: '3'.repeat(40) },
      { ...proposal, artifact: { ...proposal.artifact, patchSha256: 'd'.repeat(64) } },
      { ...proposal, evidence: [{ ...present(proposal.evidence[0]), toolVersion: 'new' }] },
      { ...proposal, policyVersion: 'next' },
      { ...proposal, validation: { ...proposal.validation, suiteAttestationId: randomUUID() } },
      { ...proposal, changes: [{ ...present(proposal.changes[0]), to: '1.3.0' }] },
    ];
    for (const changed of variants) expect(hashProposal(changed, '1')).not.toBe(hashProposal(proposal, '1'));
    expect(hashProposal(proposal, '2')).not.toBe(hashProposal(proposal, '1'));
  });
  it('canonicalizes v2 actions and changes identity when any bound field changes', () => {
    expect(hashActionV2(actionV2, '1')).toBe(hashActionV2(JSON.parse(JSON.stringify(actionV2)), '1'));
    for (const changed of [
      { ...actionV2, target: { ...actionV2.target, branch: 'release' } },
      { ...actionV2, patchSha256: 'd'.repeat(64) },
      { ...actionV2, findingIdentities: ['finding-2'] },
      { ...actionV2, policyVersion: 'policy-v3' },
    ]) expect(hashActionV2(changed, '1')).not.toBe(hashActionV2(actionV2, '1'));
    expect(hashActionV2(actionV2, '2')).not.toBe(hashActionV2(actionV2, '1'));
  });
  it('rejects caller payload fields and invalid dependency versions', () => {
    expect(actionV2Schema.safeParse({ ...actionV2, approved: true }).success).toBe(false);
    const dependencyAction: ActionV2 = { version: 2, kind: 'dependency_pull_request', capabilityId: 'repository.dependency_pr', organizationId: actionV2.organizationId, applicationId: actionV2.applicationId, policyVersion: 'policy-v2', target: { kind: 'repository', repositoryLinkId: randomUUID(), repositoryKey: 'catalog:key', branch: 'main' }, baseCommit: '1'.repeat(40), candidateCommit: '2'.repeat(40), changes: [{ name: 'library', from: '1.2.1', to: '1.3.0' }], lockfileSha256: 'd'.repeat(64), patchSha256: 'e'.repeat(64), rescanAttestationId: randomUUID(), suiteAttestationId: randomUUID(), evidence: [{ id: randomUUID(), sha256: 'c'.repeat(64), kind: 'manifest' }] };
    expect(actionV2Schema.safeParse(dependencyAction).success).toBe(true);
    expect(actionV2Schema.safeParse({ ...dependencyAction, changes: [{ name: 'library', from: '1.2.1', to: '2.0.0' }] }).success).toBe(false);
  });
  it('rejects unknown keys, unsupported adapters, major upgrades and downgrades', () => {
    for (const to of ['2.0.0', '1.2.2', '1.2.3', '1.3.0-beta.1']) expect(proposalSchema.safeParse({ ...proposal, changes: [{ ...proposal.changes[0], to }] }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...proposal, approved: true }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...proposal, adapter: 'github.merge' }).success).toBe(false);
  });
  it('fails closed on missing/failed tests, isolation, unsafe automation, stale head, and mismatched artifacts', () => {
    const facts = eligibilityFixture(proposal, now);
    expect(() => assertProposalEligibility(proposal, facts, now)).not.toThrow();
    for (const flag of ['rescanPassed', 'suitePassed', 'suiteRelevant', 'vmIsolationVerified', 'repositoryAutomationSafe']) expect(() => assertProposalEligibility(proposal, { ...facts, [flag]: false }, now)).toThrow('gates');
    expect(() => assertProposalEligibility(proposal, { ...facts, currentBaseCommit: '3'.repeat(40) }, now)).toThrow('head changed');
    expect(() => assertProposalEligibility(proposal, { ...facts, patchSha256: 'd'.repeat(64) }, now)).toThrow('exact');
    expect(() => assertProposalEligibility(proposal, { ...facts, observedAt: new Date(now.getTime() - 61_000) }, now)).toThrow('fresh');
  });
  it('requires a fresh proof bound to user, tenant and exact action', () => {
    const expected = { userId: 'github:123', organizationId: proposal.organizationId, actionHash: hashProposal(proposal, '1') };
    const proof: VerifiedStepUp = { ...expected, proofId: randomUUID(), method: 'webauthn', authenticatedAt: now, expiresAt: new Date(now.getTime() + 60_000) };
    expect(() => assertStepUp(proof, expected, now)).not.toThrow();
    for (const changed of [{ ...proof, userId: 'github:456' }, { ...proof, organizationId: randomUUID() }, { ...proof, actionHash: 'd'.repeat(64) }, { ...proof, authenticatedAt: new Date(now.getTime() + 1) }, { ...proof, authenticatedAt: new Date(now.getTime() - 301_000) }, { ...proof, expiresAt: now }]) expect(() => assertStepUp(changed, expected, now)).toThrow('second-factor');
  });
});
