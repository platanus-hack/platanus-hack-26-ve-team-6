import { createHash, randomUUID } from 'node:crypto';
import type { AssessmentAnalysis, AssessmentEvidence, AssessmentFinding } from '@gotchu/contracts';

export function checksum(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function addEvidence(analysis: AssessmentAnalysis, kind: AssessmentEvidence['kind'], locator: string, bytes: Uint8Array, excerpt?: string) {
  const digest = checksum(bytes);
  const evidence: AssessmentEvidence = {
    id: randomUUID(), origin: analysis.origin, kind, locator,
    collectedAt: new Date().toISOString(), snapshotRef: `sha256:${digest}`, tool: analysis.tool,
    checksum: digest, excerpt: (excerpt ?? new TextDecoder('utf-8', { fatal: true }).decode(bytes)).slice(0, 4_096),
  };
  analysis.evidence.push(evidence);
  return evidence;
}

export function addFinding(analysis: AssessmentAnalysis, finding: Omit<AssessmentFinding, 'id' | 'origin' | 'exploitability'>) {
  analysis.findings.push({ id: randomUUID(), origin: analysis.origin, exploitability: 'not_demonstrated', ...finding });
}

export function createAnalysis(origin: AssessmentAnalysis['origin'], tool: AssessmentAnalysis['tool'], snapshotRef: string): AssessmentAnalysis {
  const now = new Date().toISOString();
  return { origin, tool, snapshotRef, startedAt: now, finishedAt: now, status: 'unavailable', findings: [], evidence: [], coverage: [], limitations: [] };
}

export function finishAnalysis(analysis: AssessmentAnalysis, inspected: number, expected: number) {
  analysis.status = inspected === expected ? 'completed' : inspected === 0 && analysis.evidence.length === 0 ? 'unavailable' : 'partial';
  analysis.snapshotRef = `sha256:${checksum(JSON.stringify(analysis.evidence.map(({ locator, checksum }) => ({ locator, checksum }))))}`;
  analysis.finishedAt = new Date().toISOString();
  return analysis;
}
