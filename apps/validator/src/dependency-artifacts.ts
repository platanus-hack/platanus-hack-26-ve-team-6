import { dependencyArtifactIdentities, type CustomerAssessmentReport, type DependencyRescanArtifactResult, type DependencyRescanPackage } from '@gotchu/contracts';
import type { NpmArtifactAdapter } from '@gotchu/customer-assessment';

type Change = { name: string; version: string };

/** Freeze matched packages before rescanning; fixed versions remain in artifact scope. */
export async function scanFrozenDependencyArtifacts(
  before: CustomerAssessmentReport, after: CustomerAssessmentReport, changes: readonly Change[],
  adapter: NpmArtifactAdapter, signal: AbortSignal,
) {
  const matched = before.internal?.findings.flatMap(finding =>
    finding.ruleId.startsWith('osv.') && finding.dependencyAssessment
      ? [{ name: finding.dependencyAssessment.name, version: finding.dependencyAssessment.version }] : []) ?? [];
  const requested = [...new Map(matched.map(pkg => [`${pkg.name}\0${pkg.version}`, pkg])).values()];
  if (!requested.length || requested.length > 2 || changes.some(change => !requested.some(pkg => pkg.name === change.name))) {
    throw new Error('dependency_artifact_scope_unavailable');
  }
  const artifactScope = {
    before: requested,
    after: requested.map(pkg => ({ name: pkg.name, version: changes.find(change => change.name === pkg.name)?.version ?? pkg.version })),
  };
  async function scan(report: CustomerAssessmentReport, packages: DependencyRescanPackage[]): Promise<DependencyRescanArtifactResult[]> {
    const components = packages.map(pkg => {
      const matches = report.internal?.dependencyInventory?.components.filter(component => component.name === pkg.name && component.version === pkg.version) ?? [];
      const component = matches[0];
      if (!component || matches.some(match => match.integrity !== component.integrity)) throw new Error('dependency_artifact_package_unavailable');
      return component;
    });
    const missing = components.filter(component => !component.artifactAnalysis || component.artifactAnalysis.status === 'not_requested');
    const fresh = await adapter.analyze(missing.map(component => ({ name: component.name, version: component.version, integrity: component.integrity ?? null })), signal);
    return components.map(component => {
      const analysis = fresh.get(`${component.name}\0${component.version}`)?.analysis ?? component.artifactAnalysis;
      if (!analysis) throw new Error('dependency_artifact_result_missing');
      return { name: component.name, version: component.version, analysis };
    });
  }
  // Scanner adapters own cleanup and are deliberately consumed sequentially.
  const beforeResults = await scan(before, artifactScope.before);
  const afterResults = await scan(after, artifactScope.after);
  const artifactResults = { before: beforeResults, after: afterResults };
  return { artifactScope, artifactResults, beforeIdentities: dependencyArtifactIdentities(beforeResults), afterIdentities: dependencyArtifactIdentities(afterResults) };
}
