import type { ReactNode } from 'react';
import { ArrowUpRightIcon, ChevronRightIcon } from 'lucide-react';
import type { AssessmentFinding } from '@gotchu/contracts';
import { SEVERITIES, type NextAction, type ProjectSource, type SeverityCounts } from './project-risk';

const severityNames: Record<(typeof SEVERITIES)[number], [string, string]> = {
  critical: ['crítica', 'críticas'], high: ['alta', 'altas'], medium: ['media', 'medias'], low: ['baja', 'bajas'], informational: ['informativa', 'informativas'], unknown: ['sin evaluar', 'sin evaluar'],
};

export interface ProjectRisk {
  state: 'loading' | 'error' | 'ready';
  sources: readonly ProjectSource[];
  examined: readonly { source: ProjectSource; reportDate: string }[];
  pending: readonly ProjectSource[];
  counts: SeverityCounts;
  total: number;
  coverage: 'none' | 'partial' | 'complete';
  next: NextAction;
}

export interface ProjectHistory { reportCount: number; findingCounts: readonly number[] }
export type ProjectWatch =
  | { state: 'loading' | 'error' | 'off' }
  | { state: 'on'; intervalHours: number; nextDueAt: string; openAlerts: number };
export interface RecentReportRow { id: string; title: string; detail: string; findingCount: number; delta: number | null; severities: readonly AssessmentFinding['severity'][] | null }

/** Four tiles: how risky, how much of the project was examined, what changed, whether it is watched; then reports and a new assessment. */
export function ProjectOverview({ risk, history, watch, recentReports, onOpenReport, onOpenSources, onOpenReports, onOpenWatch, onExamine, examining, examineError, assessmentForm }: {
  risk: ProjectRisk;
  history: ProjectHistory;
  watch: ProjectWatch;
  recentReports: readonly RecentReportRow[];
  onOpenReport: (reportId: string) => void;
  onOpenSources: () => void;
  onOpenReports: () => void;
  onOpenWatch: () => void;
  onExamine: (source: ProjectSource) => void;
  examining: boolean;
  examineError: string | null;
  assessmentForm: ReactNode;
}) {
  const ready = risk.state === 'ready';
  const latestReport = recentReports[0]?.id;
  const severityParts = SEVERITIES.filter(severity => risk.counts[severity] > 0).map(severity => `${risk.counts[severity]} ${severityNames[severity][risk.counts[severity] === 1 ? 0 : 1]}`);
  const lastDelta = history.findingCounts.length > 1 ? (history.findingCounts[0] ?? 0) - (history.findingCounts[1] ?? 0) : null;
  return <>
    <div className="customer-tiles" aria-busy={!ready}>
      <Tile label="Observaciones" onOpen={latestReport ? () => onOpenReport(latestReport) : undefined}
        figure={ready ? risk.total : '—'} sub={risk.examined.length === 0 ? 'sin informes todavía' : 'en los últimos informes'}
        chart={<SeverityColumns counts={risk.counts} />}
        foot={risk.state === 'error' ? 'No se pudieron cargar los informes.' : severityParts.length ? <><b>{severityParts[0]}</b>{severityParts.slice(1).map(part => ` · ${part}`).join('')}</> : 'Sin observaciones abiertas'} />
      <Tile label="Cobertura" onOpen={onOpenSources}
        figure={<>{risk.examined.length}<small> / {risk.sources.length}</small></>} sub={risk.sources.length === 1 ? 'fuente examinada' : 'fuentes examinadas'}
        chart={<CoverageCells sources={risk.sources} pending={risk.pending} />}
        foot={!ready ? 'Comprobando cobertura…' : <>
          <b className={`customer-tile-state is-${risk.coverage}`}>{risk.coverage === 'complete' ? 'Completa' : risk.coverage === 'partial' ? 'Parcial' : 'Sin fuentes'}</b>
          <NextStep next={risk.next} examining={examining} onExamine={onExamine} onOpenSources={onOpenSources} onOpenReport={onOpenReport} />
        </>} />
      <Tile label="Historial" onOpen={onOpenReports}
        figure={history.reportCount} sub={history.reportCount === 1 ? 'informe guardado' : 'informes guardados'}
        chart={<HistoryColumns counts={history.findingCounts} />}
        foot={lastDelta === null ? 'Observaciones por informe' : <>Observaciones por informe · <b>{lastDelta > 0 ? `+${lastDelta}` : lastDelta === 0 ? 'igual' : `−${Math.abs(lastDelta)}`}</b> desde el anterior</>} />
      <Tile label="Vigilancia" onOpen={onOpenWatch}
        figure={watch.state === 'on' ? <>{watch.intervalHours}<small> h</small></> : '—'} sub={watch.state === 'on' ? 'revisión periódica' : watch.state === 'off' ? 'desactivada' : watch.state === 'error' ? 'no disponible' : 'cargando…'}
        chart={<AlertCells open={watch.state === 'on' ? watch.openAlerts : 0} />}
        foot={watch.state === 'on' ? <>Próxima revisión <b>{new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(watch.nextDueAt))}</b> · {watch.openAlerts} {watch.openAlerts === 1 ? 'alerta vigente' : 'alertas vigentes'}</> : watch.state === 'off' ? <button className="customer-link-button" type="button" onClick={onOpenWatch}>Activar revisiones periódicas</button> : watch.state === 'error' ? 'No se pudo cargar la vigilancia' : '—'} />
    </div>
    {examineError && <p className="customer-form-error" role="alert">{examineError}</p>}

    <div className="customer-overview-split">
      <section aria-labelledby="recent-reports-title">
        <div className="customer-section-head"><div><h2 id="recent-reports-title">Informes recientes</h2><p>Cada informe conserva su evidencia, cobertura y límites.</p></div>{recentReports.length > 0 && <button className="customer-link-button" type="button" onClick={onOpenReports}>Ver todos</button>}</div>
        {recentReports.length === 0 ? <p className="customer-empty-inline">Este proyecto aún no tiene informes.</p> : <ReportRows reports={recentReports} onOpenReport={onOpenReport} />}
      </section>
      {assessmentForm}
    </div>
  </>;
}

function Tile({ label, onOpen, figure, sub, chart, foot }: { label: string; onOpen: (() => void) | undefined; figure: ReactNode; sub: string; chart: ReactNode; foot: ReactNode }) {
  return <section className="customer-tile" aria-label={label}>
    <div className="customer-tile-body">
      <h2 className="customer-tile-label">{label}{onOpen && <button type="button" className="customer-tile-open" aria-label={`Abrir ${label.toLowerCase()}`} onClick={onOpen}><ArrowUpRightIcon aria-hidden="true" /></button>}</h2>
      <p className="customer-tile-figure">{figure}</p>
      <p className="customer-tile-sub">{sub}</p>
      <div className="customer-tile-chart" aria-hidden="true">{chart}</div>
    </div>
    <div className="customer-tile-foot">{foot}</div>
    <i className="customer-tile-ticks" aria-hidden="true" />
  </section>;
}

/** One column per severity, a cell per finding (ten at most): ink for critical/high, magenta for medium/low. */
function SeverityColumns({ counts }: { counts: SeverityCounts }) {
  return <span className="customer-px">{SEVERITIES.map(severity => <span key={severity} className="customer-px-col">
    {Array.from({ length: 10 }, (_, index) => <i key={index} className={index < Math.min(10, counts[severity]) ? severity === 'critical' || severity === 'high' ? 'is-hot' : severity === 'medium' || severity === 'low' ? 'is-on' : 'is-mute' : undefined} />)}
  </span>)}</span>;
}

/** Findings per report, oldest left; the latest report is the magenta column. */
function HistoryColumns({ counts }: { counts: readonly number[] }) {
  const shown = counts.slice(0, 10).reverse();
  const max = Math.max(1, ...shown);
  return <span className="customer-px">{shown.map((count, column) => <span key={column} className="customer-px-col">
    {Array.from({ length: 10 }, (_, index) => <i key={index} className={index < Math.ceil((count / max) * 10) ? column === shown.length - 1 ? 'is-on' : 'is-hot' : undefined} />)}
  </span>)}</span>;
}

function CoverageCells({ sources, pending }: { sources: readonly ProjectSource[]; pending: readonly ProjectSource[] }) {
  const pendingKeys = new Set(pending.map(source => `${source.kind}:${source.id}`));
  return <span className="customer-cells">{sources.slice(0, 18).map(source => <i key={`${source.kind}:${source.id}`} className={pendingKeys.has(`${source.kind}:${source.id}`) ? 'is-pending' : 'is-on'} />)}</span>;
}

function AlertCells({ open }: { open: number }) {
  return <span className="customer-cells">{Array.from({ length: 18 }, (_, index) => <i key={index} className={index < open ? 'is-on' : undefined} />)}</span>;
}

/** Report rows with a square per finding, coloured by severity; shared by the overview and the report list. */
export function ReportRows({ reports, onOpenReport }: { reports: readonly RecentReportRow[]; onOpenReport: (reportId: string) => void }) {
  return <>
    <ul className="customer-report-rows">{reports.map(report => <li key={report.id}>
      <button type="button" onClick={() => onOpenReport(report.id)}>
        <i className="customer-report-mark" aria-hidden="true" />
        <span className="customer-report-row-text"><strong>{report.title}</strong><small>{report.detail}</small></span>
        <SeveritySquares severities={report.severities} total={report.findingCount} />
        <span className="customer-report-row-count"><strong>{report.findingCount}</strong><small>{report.delta === null ? '—' : report.delta > 0 ? `+${report.delta}` : report.delta === 0 ? '=' : `−${Math.abs(report.delta)}`}</small></span>
        <ChevronRightIcon aria-hidden="true" />
      </button>
    </li>)}</ul>
    <p className="customer-report-legend"><span><i className="is-high" />Alta</span><span><i className="is-medium" />Media</span><span><i />Sin evaluar</span></p>
  </>;
}

function SeveritySquares({ severities, total }: { severities: readonly AssessmentFinding['severity'][] | null; total: number }) {
  const cells = severities ?? Array.from({ length: total }, () => 'unknown' as const);
  return <span className="customer-sev-squares" aria-hidden="true">{cells.slice(0, 12).map((severity, index) => <i key={index} className={severity === 'critical' || severity === 'high' ? 'is-high' : severity === 'medium' || severity === 'low' ? 'is-medium' : undefined} />)}</span>;
}

function NextStep({ next, examining, onExamine, onOpenSources, onOpenReport }: {
  next: NextAction; examining: boolean; onExamine: (source: ProjectSource) => void; onOpenSources: () => void; onOpenReport: (reportId: string) => void;
}) {
  switch (next.kind) {
    case 'add_source': return <> · <button className="customer-link-button" type="button" onClick={onOpenSources}>Añadir una fuente</button></>;
    case 'examine': return <> · {next.source.kind === 'image'
      ? <button className="customer-link-button" type="button" onClick={onOpenSources}>Evaluar {next.source.label}</button>
      : <button className="customer-link-button" type="button" disabled={examining} onClick={() => onExamine(next.source)}>{examining ? 'Iniciando…' : `Evaluar ${next.source.label}`}</button>}</>;
    case 'review': return <> · <button className="customer-link-button" type="button" onClick={() => onOpenReport(next.reportId)}>Revisar {next.count} {next.severity === 'critical' ? (next.count === 1 ? 'crítica' : 'críticas') : (next.count === 1 ? 'alta' : 'altas')}</button></>;
    case 'deepen': return <> · <button className="customer-link-button" type="button" onClick={onOpenSources}>Ver qué faltó</button></>;
    case 'clear': return <> · sin altas ni críticas</>;
  }
}
