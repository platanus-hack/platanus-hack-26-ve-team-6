import { createHash, randomUUID } from 'node:crypto';
import type { AssessmentAnalysis, AssessmentEvidence, AssessmentFinding, AssessmentComparison } from '@gotchu/contracts';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function analysis(origin: AssessmentAnalysis['origin'], snapshotRef: string): AssessmentAnalysis {
  const now = new Date().toISOString();
  return { origin, snapshotRef, startedAt: now, finishedAt: now, status: 'unavailable', tool: { name: 'gotchu-customer', version: '2.0.0' }, findings: [], evidence: [], coverage: [], limitations: [] };
}
export function evidence(a: AssessmentAnalysis, kind: AssessmentEvidence['kind'], locator: string, data: unknown, tool = a.tool, collectedAt = new Date().toISOString()) {
  const excerpt = JSON.stringify(data);
  if (excerpt.length > 4096 || a.evidence.length >= 200) throw new Error('evidence_limit');
  const item: AssessmentEvidence = { id: randomUUID(), origin: a.origin, kind, locator, collectedAt, snapshotRef: a.snapshotRef, tool, checksum: sha256(excerpt), excerpt };
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
  return [...groups].map(([key, group]) => {
    const hasBoth = group.internal.length > 0 && group.external.length > 0;
    const other = group.internal.length > 0 ? external : internal;
    const explanation = hasBoth
      ? key === 'http:content-security-policy'
        ? 'Source contains a Helmet CSP-disabling configuration indication; independent HTTPS responses omit CSP. These observations concern the same control. Shared deployment, route association, causal relationship, issue identity and exploitability are unverified.'
        : 'Findings from both analyses share a correlation key. This grouping does not establish deployment equivalence, issue identity, or exploitability.'
      : other === null
        ? 'The other analysis was not requested. This finding is unverified against that side and does not establish absence, deployment equivalence, or exploitability.'
        : other.status === 'unavailable'
          ? 'The other analysis was unavailable. This finding is unverified against that side and does not establish absence, deployment equivalence, or exploitability.'
          : other.status === 'partial'
            ? 'The other analysis was partial and recorded no matching finding. This does not establish absence, deployment equivalence, or exploitability.'
            : 'The other analysis completed without a matching finding. This does not establish absence, deployment equivalence, or exploitability.';
    return {
      key,
      classification: hasBoth ? 'both' : 'unverified',
      internalFindingIds: group.internal,
      externalFindingIds: group.external,
      explanation,
    };
  });
}
/** Cancellation stops new work; callers retain ownership until started work and cleanup settle. */
export async function bounded<T>(work: Promise<T> | (() => Promise<T>), signal: AbortSignal): Promise<T> {
  if (typeof work === 'function') {
    signal.throwIfAborted();
    work = work();
  }
  // Always observe an already-created promise, even when the signal was already aborted.
  // A cleanup rejection takes precedence over the deadline and must reach the supervisor.
  const result = await work;
  signal.throwIfAborted();
  return result;
}
export function isScannerCleanupError(error: unknown): error is Error {
  return error instanceof Error && error.message === 'scanner_cleanup_unavailable';
}
