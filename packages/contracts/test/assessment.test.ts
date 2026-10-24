import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assessmentAnalysisSchema, assessmentReportSchema } from '../src/assessment.js';

const time = '2026-10-24T00:00:00.000Z';
function fixture() {
  const evidenceId = randomUUID();
  const findingId = randomUUID();
  const internal = assessmentAnalysisSchema.parse({
    origin: 'internal', status: 'partial', startedAt: time, finishedAt: time, snapshotRef: 'fixture:source', tool: { name: 'fixture-check', version: '1' },
    evidence: [{ id: evidenceId, origin: 'internal', kind: 'configuration', locator: 'config.json', collectedAt: time, snapshotRef: 'fixture:source', checksum: 'a'.repeat(64), excerpt: 'sample', tool: { name: 'fixture-check', version: '1' } }],
    findings: [{ id: findingId, ruleId: 'headers.example', correlationKey: 'headers.example', origin: 'internal', title: 'Example observation', location: 'config.json', description: 'A bounded test observation.', severity: 'high', confidence: 'observed', exploitability: 'unknown', impact: 'Impact has not been demonstrated.', recommendation: 'Review configuration.', limitations: ['Not an exploitation test.'], evidenceIds: [evidenceId] }],
    coverage: [{ capability: 'configuration', state: 'inspected', detail: 'Controlled fixture only.' }], limitations: [],
  });
  return { version: 1, id: randomUUID(), organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(), applicationName: 'Controlled demo', mode: 'internal', revision: 'vulnerable', startedAt: time, finishedAt: time,
    internal, external: null, comparison: [{ key: 'headers.example', classification: 'unverified', internalFindingIds: [findingId], externalFindingIds: [], explanation: 'External analysis was not requested.' }], limitations: [], responseMode: 'observation', actionsPerformed: [] };
}

describe('assessment evidence and permission boundaries', () => {
  it('keeps a one-sided observation unverified and permits severity without authority', () => {
    const report = assessmentReportSchema.parse(fixture());
    expect(report.internal?.findings[0]?.severity).toBe('high');
    expect(report.responseMode).toBe('observation');
    expect(report.actionsPerformed).toEqual([]);
  });
  it('rejects evidence-free findings and invented comparison matches', () => {
    const value = fixture();
    expect(assessmentReportSchema.safeParse({ ...value, internal: { ...value.internal, evidence: [] } }).success).toBe(false);
    expect(assessmentReportSchema.safeParse({ ...value, comparison: [{ ...value.comparison[0], classification: 'both' }] }).success).toBe(false);
    expect(assessmentReportSchema.safeParse({ ...value, comparison: [] }).success).toBe(false);
  });
  it('does not allow source observations in an external-only report or actions in observation mode', () => {
    const value = fixture();
    expect(assessmentReportSchema.safeParse({ ...value, mode: 'external' }).success).toBe(false);
    expect(assessmentReportSchema.safeParse({ ...value, actionsPerformed: ['changed production'] }).success).toBe(false);
  });
});
