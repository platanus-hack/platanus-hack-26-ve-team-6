import {
  customerAssessmentReportSchema, dependencyRescanScopeSchema, scoreDependencyRescanCoverage,
  type AssessmentAnalysis, type DependencyRescanScope,
} from '@gotchu/contracts';

export interface BuildDependencyRescanScopeInput {
  beforeReport: unknown;
  afterReport: unknown;
  baseSnapshotDigest: string;
  candidateSnapshotDigest: string;
  /** Freeze this from the requested change, before either advisory rescan. */
  artifactScope: DependencyRescanScope['artifactScope'];
  /** Independently scan every frozen version, including replacements with no advisory match. */
  artifactResults: DependencyRescanScope['artifactResults'];
}

function analysisState(analysis: AssessmentAnalysis): DependencyRescanScope['beforeAnalysis'] {
  const inventory = analysis.dependencyInventory;
  return {
    status: analysis.status, findingCount: analysis.findings.length, evidenceCount: analysis.evidence.length,
    inventory: inventory ? {
      complete: inventory.complete, graphComplete: inventory.graphComplete,
      unknownCount: inventory.unknownCount, lockfiles: inventory.lockfiles,
    } : null,
  };
}

type CoverageScore = ReturnType<typeof scoreDependencyRescanCoverage>;
export type DependencyRescanScopeResult =
  | { scope: DependencyRescanScope; result: CoverageScore['result']; reason: CoverageScore['reason'] }
  | { scope: null; result: 'inconclusive'; reason: 'dependency_rescan_report_invalid' | 'dependency_rescan_snapshot_mismatch' | 'dependency_rescan_scope_invalid' | 'dependency_rescan_package_missing' };

/** Pure projection of independent reports and real adapter outcomes; never invokes a scanner. */
export function buildDependencyRescanScope(input: BuildDependencyRescanScopeInput): DependencyRescanScopeResult {
  const before = customerAssessmentReportSchema.safeParse(input.beforeReport);
  const after = customerAssessmentReportSchema.safeParse(input.afterReport);
  if (!before.success || !after.success || !before.data.internal || !after.data.internal
    || before.data.mode !== 'internal' || after.data.mode !== 'internal'
    || before.data.organizationId !== after.data.organizationId || before.data.applicationId !== after.data.applicationId) {
    return { scope: null, result: 'inconclusive', reason: 'dependency_rescan_report_invalid' };
  }
  const base = before.data.internal;
  const candidate = after.data.internal;
  if (before.data.subject.sourceDigest !== input.baseSnapshotDigest || after.data.subject.sourceDigest !== input.candidateSnapshotDigest
    || base.snapshotRef !== `source:${before.data.subject.sourceSnapshotId}:sha256:${input.baseSnapshotDigest}`
    || candidate.snapshotRef !== `source:${after.data.subject.sourceSnapshotId}:sha256:${input.candidateSnapshotDigest}`) {
    return { scope: null, result: 'inconclusive', reason: 'dependency_rescan_snapshot_mismatch' };
  }
  const parsed = dependencyRescanScopeSchema.safeParse({
    coverageScope: 'dependency_rescan_v1', baseSnapshotDigest: input.baseSnapshotDigest, candidateSnapshotDigest: input.candidateSnapshotDigest,
    beforeCapabilities: base.coverage, afterCapabilities: candidate.coverage,
    beforeAnalysis: analysisState(base), afterAnalysis: analysisState(candidate),
    artifactScope: input.artifactScope, artifactResults: input.artifactResults,
  });
  if (!parsed.success) return { scope: null, result: 'inconclusive', reason: 'dependency_rescan_scope_invalid' };
  const scope = parsed.data;
  for (const [analysis, requested] of [[base, scope.artifactScope.before], [candidate, scope.artifactScope.after]] as const) {
    if (requested.some(pkg => !analysis.dependencyInventory?.components.some(component => component.name === pkg.name && component.version === pkg.version))) {
      return { scope: null, result: 'inconclusive', reason: 'dependency_rescan_package_missing' };
    }
  }
  return { scope, ...scoreDependencyRescanCoverage(scope) };
}
