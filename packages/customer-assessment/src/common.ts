import { createHash, randomUUID } from 'node:crypto';
import type { AssessmentAnalysis, AssessmentEvidence, AssessmentFinding, AssessmentComparison } from '@gotchu/contracts';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function analysis(origin: AssessmentAnalysis['origin'], snapshotRef: string): AssessmentAnalysis {
  const now = new Date().toISOString();
  return { origin, snapshotRef, startedAt: now, finishedAt: now, status: 'unavailable', tool: { name: 'gotchu-customer', version: '2.0.0' }, findings: [], evidence: [], coverage: [], limitations: [] };
}
export function evidence(a: AssessmentAnalysis, kind: AssessmentEvidence['kind'], locator: string, data: unknown, tool = a.tool) {
  const excerpt = JSON.stringify(data);
  if (excerpt.length > 4096 || a.evidence.length >= 200) throw new Error('evidence_limit');
  const item: AssessmentEvidence = { id: randomUUID(), origin: a.origin, kind, locator, collectedAt: new Date().toISOString(), snapshotRef: a.snapshotRef, tool, checksum: sha256(excerpt), excerpt };
  a.evidence.push(item);
  return item.id;
}
export function finding(a: AssessmentAnalysis, data: Omit<AssessmentFinding, 'id' | 'origin' | 'exploitability'>) {
  if (a.findings.length >= 100) throw new Error('finding_limit');
  a.findings.push({ ...data, id: randomUUID(), origin: a.origin, exploitability: 'unknown' });
}
export function finish(a: AssessmentAnalysis) {
  a.finishedAt = new Date().toISOString();
  const inspected = a.coverage.some(c => c.state === 'inspected');
  const partialEvidence = a.evidence.length > 0 || a.findings.length > 0;
  a.status = !inspected && !partialEvidence ? 'unavailable' : !inspected || a.coverage.some(c => c.state === 'unavailable') ? 'partial' : 'completed';
  return a;
}
export function compare(internal: AssessmentAnalysis | null, external: AssessmentAnalysis | null): AssessmentComparison[] {
  const groups = new Map<string, { internal: string[]; external: string[] }>();
  for (const a of [internal, external]) for (const f of a?.findings ?? []) {
    const group = groups.get(f.correlationKey) ?? { internal: [], external: [] };
    group[f.origin].push(f.id); groups.set(f.correlationKey, group);
  }
  // Source deployment equivalence and matching opposite-side coverage are not established.
  return [...groups].map(([key, g]) => ({ key, classification: g.internal.length && g.external.length ? 'both' : 'unverified', internalFindingIds: g.internal, externalFindingIds: g.external, explanation: 'Independent evidence grouped by rule; deployment equivalence, opposite-side absence and exploitability remain unknown.' }));
}
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error('deadline_exceeded')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, interrupted]); } finally { signal.removeEventListener('abort', abort); }
}
