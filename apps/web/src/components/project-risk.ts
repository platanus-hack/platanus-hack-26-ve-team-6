import type {
  AssessmentFinding, CustomerAssessmentReport, CustomerContainerImageSummary, CustomerReportSummary, CustomerSourceSummary, CustomerTarget,
} from '@gotchu/contracts';

/** Something the project can be assessed on: a code snapshot, a container image or an authorized HTTPS origin. */
export type ProjectSource =
  | { kind: 'snapshot'; id: string; label: string; detail: string }
  | { kind: 'image'; id: string; label: string; detail: string }
  | { kind: 'target'; id: string; label: string; detail: string };

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational', 'unknown'] as const satisfies readonly AssessmentFinding['severity'][];
export type SeverityCounts = Record<AssessmentFinding['severity'], number>;

export function projectSources(input: { sources: readonly CustomerSourceSummary[]; images: readonly CustomerContainerImageSummary[]; targets: readonly CustomerTarget[] }): ProjectSource[] {
  return [
    ...input.sources.map(source => ({ kind: 'snapshot' as const, id: source.id, label: source.revision, detail: `Código · ${source.fileCount} ${source.fileCount === 1 ? 'archivo' : 'archivos'}` })),
    ...input.images.map(image => ({ kind: 'image' as const, id: image.id, label: image.label, detail: 'Imagen de contenedor' })),
    // Revoked or expired origins can no longer be assessed, so they do not count against coverage.
    ...input.targets.filter(target => target.status === 'authorized').map(target => ({ kind: 'target' as const, id: target.id, label: target.origin.replace(/^https:\/\//, ''), detail: 'Origen HTTPS' })),
  ];
}

function covers(report: CustomerReportSummary, source: ProjectSource) {
  switch (source.kind) {
    case 'snapshot': return report.subject.sourceSnapshotId === source.id;
    case 'image': return report.subject.containerImageId === source.id;
    case 'target': return report.subject.targetId === source.id;
  }
}

/** Pairs each source with its most recent report; reports arrive newest first. */
export function examineSources(sources: readonly ProjectSource[], reports: readonly CustomerReportSummary[]) {
  const examined: { source: ProjectSource; report: CustomerReportSummary }[] = [];
  const pending: ProjectSource[] = [];
  for (const source of sources) {
    const report = reports.find(item => covers(item, source));
    if (report) examined.push({ source, report });
    else pending.push(source);
  }
  return { examined, pending, reportIds: [...new Set(examined.map(item => item.report.id))] };
}

/** Findings still standing in the latest report of each examined source; one report can cover several sources. */
export function openFindings(reports: readonly CustomerAssessmentReport[]) {
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0])) as SeverityCounts;
  const seen = new Set<string>();
  for (const report of reports) {
    if (seen.has(report.id)) continue;
    seen.add(report.id);
    for (const finding of [...report.internal?.findings ?? [], ...report.external?.findings ?? []]) counts[finding.severity] += 1;
  }
  return { counts, total: SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0) };
}

/**
 * Coverage is complete only when every source has a report and none of those reports' analyses
 * stopped partway. Anything less is shown as partial, never as healthy.
 */
export function coverageState(input: { sources: readonly ProjectSource[]; pending: readonly ProjectSource[]; reports: readonly CustomerAssessmentReport[] }): 'none' | 'partial' | 'complete' {
  if (input.sources.length === 0) return 'none';
  if (input.pending.length > 0) return 'partial';
  const finished = input.reports.every(report => [report.internal, report.external].every(analysis => analysis === null || analysis.status === 'completed'));
  return finished ? 'complete' : 'partial';
}

export type NextAction =
  | { kind: 'add_source' }
  | { kind: 'examine'; source: ProjectSource }
  | { kind: 'review'; reportId: string; severity: 'critical' | 'high'; count: number }
  | { kind: 'deepen' }
  | { kind: 'clear' };

/** The single most useful next step: add something to assess, assess what is pending, then review the worst findings. */
export function nextAction(input: { sources: readonly ProjectSource[]; pending: readonly ProjectSource[]; reports: readonly CustomerAssessmentReport[]; coverage: ReturnType<typeof coverageState> }): NextAction {
  if (input.sources.length === 0) return { kind: 'add_source' };
  const first = input.pending[0];
  if (first) return { kind: 'examine', source: first };
  for (const severity of ['critical', 'high'] as const) {
    const report = input.reports.find(item => [...item.internal?.findings ?? [], ...item.external?.findings ?? []].some(finding => finding.severity === severity));
    if (report) {
      const count = openFindings(input.reports).counts[severity];
      return { kind: 'review', reportId: report.id, severity, count };
    }
  }
  return input.coverage === 'complete' ? { kind: 'clear' } : { kind: 'deepen' };
}
