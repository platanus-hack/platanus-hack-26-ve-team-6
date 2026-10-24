import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertProposalEligibility, assertStepUp, hashProposal, proposalSchema, type VerifiedStepUp } from '../src/index.js';
import { present } from '../../database/test/support.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';
const proposal = proposalFixture({ organizationId: randomUUID(), applicationId: randomUUID() });
const now = new Date();
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
