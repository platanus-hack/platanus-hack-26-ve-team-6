import { randomUUID } from 'node:crypto';
import type { AssessmentAnalysis, AssessmentReport, AssessmentRunInput } from '@gotchu/contracts';

/** Synthetic evidence for persistence tests; this is not scanner/HTTP verification. */
export function assessmentReportFixture(input: AssessmentRunInput): AssessmentReport {
  const timestamp = new Date().toISOString();
  const analysis = (origin: 'internal' | 'external'): AssessmentAnalysis => {
    const evidenceId = randomUUID();
    return {
      origin, status: 'completed', startedAt: timestamp, finishedAt: timestamp,
      snapshotRef: 'synthetic-persistence-fixture', tool: { name: 'test-fixture', version: '1' },
      evidence: [{ id: evidenceId, origin, kind: origin === 'internal' ? 'source' : 'http_response', locator: 'synthetic-fixture', collectedAt: timestamp,
        snapshotRef: 'synthetic-persistence-fixture', tool: { name: 'test-fixture', version: '1' }, checksum: 'a'.repeat(64), excerpt: 'Synthetic fixture evidence' }],
      findings: [{ id: randomUUID(), origin, ruleId: 'fixture.rule', correlationKey: 'fixture.shared', title: 'Synthetic fixture finding', location: 'synthetic-fixture',
        description: 'For storage boundary testing only', severity: 'low', confidence: 'observed', exploitability: 'not_demonstrated', impact: 'Synthetic fixture impact',
        recommendation: 'No production recommendation', limitations: ['Synthetic fixture, not a live scanner result'], evidenceIds: [evidenceId] }],
      coverage: [{ capability: 'fixture', state: 'inspected', detail: 'Synthetic fixture only' }], limitations: ['Synthetic fixture'],
    };
  };
  const internal = input.mode === 'external' ? null : analysis('internal');
  const external = input.mode === 'internal' ? null : analysis('external');
  return {
    version: 1, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId,
    applicationName: 'Synthetic persistence fixture', mode: input.mode, revision: input.revision, startedAt: timestamp, finishedAt: timestamp,
    internal, external, comparison: [{ key: 'fixture.shared', classification: input.mode === 'both' ? 'both' : 'unverified',
      internalFindingIds: internal?.findings.map(item => item.id) ?? [], externalFindingIds: external?.findings.map(item => item.id) ?? [], explanation: 'Synthetic comparison' }],
    limitations: ['Only tests report persistence; not actual assessment coverage'], responseMode: 'observation', actionsPerformed: [],
  };
}
