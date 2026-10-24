import type { AssessmentAnalysis, AssessmentComparison, AssessmentFinding } from '@gotchu/contracts';

export function compareAnalyses(internal: AssessmentAnalysis | null, external: AssessmentAnalysis | null): AssessmentComparison[] {
  const groups = new Map<string, { internal: AssessmentFinding[]; external: AssessmentFinding[] }>();
  for (const analysis of [internal, external]) {
    for (const finding of analysis?.findings ?? []) {
      let group = groups.get(finding.correlationKey);
      if (!group) {
        group = { internal: [], external: [] };
        groups.set(finding.correlationKey, group);
      }
      group[finding.origin].push(finding);
    }
  }
  return [...groups].map(([key, group]) => {
    let classification: AssessmentComparison['classification'];
    let explanation: string;
    if (group.internal.length && group.external.length) {
      classification = 'both';
      explanation = 'Independent source/configuration and live HTTP observations share this narrowly defined rule key for the same selected target and revision. This correlation does not prove deployment equivalence, exploitability or compromise.';
    } else {
      const opposite = group.internal.length ? external : internal;
      // Partial probes never establish absence in the other analysis.
      if (!opposite || opposite.status !== 'completed') {
        classification = 'unverified';
        explanation = 'The other analysis was not requested or did not complete its bounded profile. No cross-origin confirmation or absence claim is supported.';
      } else if (group.internal.length) {
        classification = 'internal_only';
        explanation = 'Observed internally only. The external profile completed its one allowlisted GET but cannot verify this source/dependency behavior; external reachability and exploitability remain unknown.';
      } else {
        classification = 'external_only';
        explanation = 'Observed externally only. No corresponding finding exists in the three-file internal profile; this does not prove the behavior is absent from uninspected source or infrastructure.';
      }
    }
    return { key, classification, internalFindingIds: group.internal.map((item) => item.id), externalFindingIds: group.external.map((item) => item.id), explanation };
  });
}
