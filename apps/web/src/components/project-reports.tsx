import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowLeftIcon, ChevronDownIcon } from 'lucide-react';
import type { AssessmentEvidence, AssessmentFinding, CustomerAssessmentReport } from '@gotchu/contracts';
import { AiCorrectionPanel } from './ai-correction-panel';
import { CopyFindingPrompt } from './copy-finding-prompt';
import { comparisonPresence, coverageCapabilitiesLabel, coverageTally, exploitabilityLabel, groupCoverage, reportTabs, severityRank, type ReportTab } from './customer-report-model';
import { findingPrompt } from './finding-prompt';
import { InvestigationActionButton } from './investigations-panel';
import { SEVERITIES } from './project-risk';

const sourceLabels = { internal: 'Código', external: 'HTTPS' };
const severityLabels = { unknown: 'Sin evaluar', critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Informativa' };
const severityNames: Record<AssessmentFinding['severity'], [string, string]> = {
  critical: ['crítica', 'críticas'], high: ['alta', 'altas'], medium: ['media', 'medias'], low: ['baja', 'bajas'], informational: ['informativa', 'informativas'], unknown: ['sin evaluar', 'sin evaluar'],
};
const confidenceLabels = { observed: 'Observado', inferred: 'Indicado', uncertain: 'Sin comprobar' };
const coverageLabels = { inspected: 'Evaluado', not_requested: 'No solicitado', unsupported: 'No disponible en este perfil', unavailable: 'No disponible' };
const analysisLabels = { completed: 'Completado', partial: 'Parcial', unavailable: 'No disponible' };

function date(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function reportFindings(report: CustomerAssessmentReport) {
  return [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
}

export function ReportHeading({ title, detail, onBack, actions }: { title: string; detail: string; onBack: () => void; actions: ReactNode }) {
  return <header className="customer-report-heading">
    <button className="customer-link-button customer-report-back" type="button" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />Todos los informes</button>
    <div className="customer-report-heading-row">
      <div><h2>{title}</h2><p>{detail}</p></div>
      {actions}
    </div>
  </header>;
}

/** One line under the title: how many observations by severity, and whether coverage was complete. */
export function ReportSummary({ report, onOpenCoverage }: { report: CustomerAssessmentReport; onOpenCoverage: () => void }) {
  const findings = reportFindings(report);
  const parts = SEVERITIES.flatMap(severity => {
    const count = findings.filter(finding => finding.severity === severity).length;
    return count > 0 ? [{ severity, label: `${count} ${severityNames[severity][count === 1 ? 0 : 1]}` }] : [];
  });
  const coverage = coverageTally(report);
  return <div className="customer-report-summary">
    <p className="customer-report-summary-counts">
      <strong>{findings.length} {findings.length === 1 ? 'observación' : 'observaciones'}</strong>
      {parts.map(part => <span key={part.severity}><i className={`customer-report-dot is-${part.severity}`} aria-hidden="true" />{part.label}</span>)}
    </p>
    <p className="customer-report-summary-coverage">
      Cobertura <b className={coverage.complete ? 'is-complete' : 'is-partial'}>{coverage.complete ? 'completa' : 'parcial'}</b>
      {coverage.total > 0 && ` · ${coverage.inspected} de ${coverage.total} comprobaciones`} · <button className="customer-link-button" type="button" onClick={onOpenCoverage}>Ver qué se evaluó</button>
    </p>
  </div>;
}

export function ReportTabs({ active, counts, onChange }: { active: ReportTab; counts: Partial<Record<ReportTab, number>>; onChange: (tab: ReportTab) => void }) {
  const move = (event: KeyboardEvent) => {
    const index = reportTabs.findIndex(tab => tab.id === active);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? reportTabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = reportTabs[(next + reportTabs.length) % reportTabs.length];
    if (!tab) return;
    onChange(tab.id);
    document.getElementById(`report-${tab.id}-tab`)?.focus();
  };
  return <div className="customer-report-tabs" role="tablist" aria-label="Contenido del informe" onKeyDown={move}>
    {reportTabs.map(tab => <button key={tab.id} type="button" className="customer-report-tab" id={`report-${tab.id}-tab`} role="tab" aria-controls={`report-${tab.id}-panel`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}>
      {tab.label}{counts[tab.id] !== undefined && <span className="customer-report-tab-count">{counts[tab.id]}</span>}
    </button>)}
  </div>;
}

export function ReportTabPanel({ tab, children }: { tab: ReportTab; children: ReactNode }) {
  return <div id={`report-${tab}-panel`} className="customer-report-tabpanel" role="tabpanel" aria-labelledby={`report-${tab}-tab`} tabIndex={0}>{children}</div>;
}

/** Observations grouped by severity, worst first. Each row opens to what it means, how to fix it and the evidence behind it. */
export function FindingList({ report, organizationId, applicationId, canManage }: { report: CustomerAssessmentReport; organizationId: string; applicationId: string; canManage: boolean }) {
  const findings = reportFindings(report);
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const evidenceById = new Map([...report.internal?.evidence ?? [], ...report.external?.evidence ?? []].map(item => [item.id, item]));
  const rows = report.comparison.map(item => {
    const linked = [...item.internalFindingIds, ...item.externalFindingIds].flatMap(id => byId.get(id) ?? []).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return { item, linked, severity: linked[0]?.severity ?? 'unknown' };
  });
  if (rows.length === 0) return <p className="customer-empty-inline">Este informe no registra observaciones. Eso no confirma que el proyecto sea seguro: revisa «Qué se evaluó».</p>;
  const groups = SEVERITIES.map(severity => ({ severity, rows: rows.filter(row => row.severity === severity) })).filter(group => group.rows.length > 0);
  return <div className="customer-finding-groups">{groups.map(group => <section key={group.severity} className="customer-finding-group" aria-label={severityLabels[group.severity]}>
    <h3 className="customer-finding-group-title"><i className={`customer-report-dot is-${group.severity}`} aria-hidden="true" />{severityLabels[group.severity]}<span>{group.rows.length}</span></h3>
    <ul className="customer-findings">{group.rows.map(({ item, linked }) => {
      const lead = linked[0];
      return <li key={item.key}><details className="customer-finding">
        <summary>
          <span className="customer-finding-title"><strong>{lead?.title ?? 'Aspecto no verificable'}</strong><small>{lead?.location ?? item.explanation}</small></span>
          <span className="customer-finding-origin">{comparisonPresence(item)}</span>
          <ChevronDownIcon className="customer-finding-chevron" aria-hidden="true" />
        </summary>
        <div className="customer-finding-content">
          {linked.length === 0 && <p>{item.explanation}</p>}
          {linked.map(finding => <FindingDetail key={finding.id} finding={finding} evidence={finding.evidenceIds.flatMap(id => evidenceById.get(id) ?? [])} report={report} organizationId={organizationId} applicationId={applicationId} canManage={canManage} />)}
        </div>
      </details></li>;
    })}</ul>
  </section>)}</div>;
}

function FindingDetail({ finding, evidence, report, organizationId, applicationId, canManage }: {
  finding: AssessmentFinding;
  evidence: AssessmentEvidence[];
  report: CustomerAssessmentReport;
  organizationId: string;
  applicationId: string;
  canManage: boolean;
}) {
  return <section className="customer-finding-body">
    <dl className="customer-finding-facts">
      <div><dt>Severidad</dt><dd>{severityLabels[finding.severity]}</dd></div>
      <div><dt>Origen</dt><dd>{sourceLabels[finding.origin]}</dd></div>
      <div><dt>Confianza</dt><dd>{confidenceLabels[finding.confidence]}</dd></div>
      <div><dt>Explotabilidad</dt><dd>{exploitabilityLabel(finding.exploitability)}</dd></div>
    </dl>
    <p>{finding.description}</p>
    <h4>Impacto posible</h4>
    <p>{finding.impact}</p>
    <h4>Cómo corregirlo</h4>
    <p>{finding.recommendation}</p>
    {finding.limitations.length > 0 && <><h4>Límites de esta observación</h4><ul>{finding.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></>}
    {evidence.length > 0 && <><h4>Evidencia</h4>{evidence.map(item => <details className="customer-evidence" key={item.id}>
      <summary>{item.locator}</summary>
      <p>{item.tool.name} · v{item.tool.version} · {date(item.collectedAt)}</p>
      <pre>{item.excerpt}</pre>
      <p className="customer-evidence-meta">SHA-256: {item.checksum}</p>
      <p className="customer-evidence-meta">Instantánea: {item.snapshotRef}</p>
    </details>)}</>}
    <div className="customer-finding-actions">
      <CopyFindingPrompt prompt={() => findingPrompt({ applicationName: report.applicationName, origin: report.subject.origin, finding, evidence })} />
      <InvestigationActionButton organizationId={organizationId} applicationId={applicationId} subject={{ kind: 'finding', subjectId: finding.id, reportId: report.id }} canManage={canManage && ['medium', 'high', 'critical'].includes(finding.severity)} />
    </div>
    {finding.origin === 'internal' && report.subject.sourceSnapshotId && report.subject.sourceDigest && <AiCorrectionPanel organizationId={organizationId} applicationId={applicationId} reportId={report.id} findingId={finding.id} expectedSourceDigest={report.subject.sourceDigest} canManage={canManage} />}
  </section>;
}

/** What was assessed: the exact subject, each perspective's checks and the report's stated limits. */
export function ReportCoverage({ report, children }: { report: CustomerAssessmentReport; children?: ReactNode }) {
  const subject = report.subject;
  return <>
    <dl className="customer-report-subject">
      {subject.origin && <div><dt>Origen HTTPS</dt><dd>{subject.origin}</dd></div>}
      {subject.sourceDigest && <div><dt>Instantánea de código</dt><dd>{subject.sourceDigest.slice(0, 16)}…</dd></div>}
      {subject.containerImageDigest && <div><dt>Imagen {subject.containerImageReference ? 'pública' : 'subida'}</dt><dd>{subject.containerImageReference ?? `${subject.containerImageDigest.slice(0, 24)}…`}</dd></div>}
      {subject.targetVersion !== null && <div><dt>Versión del alcance</dt><dd>{subject.targetVersion}</dd></div>}
      <div><dt>Terminado</dt><dd>{date(report.finishedAt)}</dd></div>
    </dl>
    <section className="customer-report-section">
      <div className="customer-section-heading"><div><h3>Comprobaciones</h3></div></div>
      <div className="customer-analysis-grid">{(['internal', 'external'] as const).map(origin => {
        const analysis = report[origin];
        return <article className="customer-analysis-card" key={origin}>
          <div className="customer-card-heading"><h4>{subject.containerImageDigest && origin === 'internal' ? 'Imagen' : sourceLabels[origin]}</h4><span className="customer-status customer-status-muted">{analysis ? analysisLabels[analysis.status] : 'No solicitado'}</span></div>
          {analysis ? <>
            <p>{analysis.tool.name} · v{analysis.tool.version}</p>
            <ul>{groupCoverage(analysis.coverage).map(item => <li key={`${item.state}:${item.detail}`}><span><strong>{coverageCapabilitiesLabel(item.capabilities)}</strong><small>{item.detail}</small></span><span className="customer-status customer-status-muted">{coverageLabels[item.state]}</span></li>)}</ul>
            {analysis.limitations.length > 0 && <details className="customer-analysis-limits"><summary>Límites del perfil ({analysis.limitations.length})</summary><ul>{analysis.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>}
          </> : <p>Esta perspectiva no se solicitó para este informe.</p>}
        </article>;
      })}</div>
    </section>
    {children}
    {report.limitations.length > 0 && <section className="customer-report-section"><div className="customer-section-heading"><div><h3>Límites del informe</h3></div></div><ul className="customer-report-limitations">{report.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></section>}
  </>;
}
