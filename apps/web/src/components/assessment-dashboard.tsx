import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssessmentComparison, AssessmentFinding, AssessmentMode, AssessmentReport, DemoRevision } from '@gotchu/contracts';
import { loadJob, loadReport, loadWorkspace, queueAssessment } from './assessment-client';
import './dashboard.css';

const icons = {
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z M8 12l3 3 5-6',
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  compare: 'M8 3v18 M16 3v18 M3 8l5-5 5 5 M11 16l5 5 5-5',
  report: 'M6 2h8l4 4v16H6V2Z M14 2v5h4 M9 12h6 M9 16h6',
  coverage: 'M3 12h5l3-8 4 16 3-8h3',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  close: 'm6 6 12 12 M18 6 6 18',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  chevron: 'm9 5 7 7-7 7',
} as const;
function Icon({ name, size = 19 }: { name: keyof typeof icons; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}
const navigation = [
  { id: 'overview', label: 'Resumen', icon: 'overview' }, { id: 'comparison', label: 'Comparación', icon: 'compare' },
  { id: 'reports', label: 'Informes', icon: 'report' }, { id: 'coverage', label: 'Cobertura', icon: 'coverage' },
] as const;
type View = typeof navigation[number]['id'];
const modeLabels: Record<AssessmentMode, string> = { internal: 'Interno', external: 'Externo', both: 'Interno + externo' };
const revisionLabels: Record<DemoRevision, string> = { vulnerable: 'Con fallos conocidos', corrected: 'Versión corregida' };
const sourceLabels = { internal: 'Código', external: 'HTTP', both: 'Ambos', internal_only: 'Sólo interno', external_only: 'Sólo externo', unverified: 'Sin contraste' };
const severityLabels = { critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Información' };
const confidenceLabels = { observed: 'Observado', inferred: 'Inferido', uncertain: 'Sin comprobar' };
const coverageLabels = { inspected: 'Evaluado', not_requested: 'No solicitado', unsupported: 'Fuera de alcance', unavailable: 'No disponible' };
function date(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function message(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación.'; }
function findings(report: AssessmentReport, item: AssessmentComparison): AssessmentFinding[] {
  const ids = new Set([...item.internalFindingIds, ...item.externalFindingIds]);
  return [...report.internal?.findings ?? [], ...report.external?.findings ?? []].filter((finding) => ids.has(finding.id));
}
function useReport(id: string | null, enabled = true) {
  return useQuery({ queryKey: ['assessment-report', id], enabled: id !== null && enabled, retry: 1, queryFn: () => {
    if (!id) throw new Error('Selecciona un informe.');
    return loadReport(id);
  } });
}
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog className="gc-dialog" ref={ref} aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="gc-dialog-heading"><span className="gc-eyebrow">EVIDENCIA DEL ANÁLISIS</span><button className="gc-icon-button" onClick={close} aria-label="Cerrar evidencias"><Icon name="close" /></button></div>
    <h2 id="dialog-title">{title}</h2>{children}
  </dialog>;
}
function Evidence({ report, item, close }: { report: AssessmentReport; item: AssessmentComparison; close: () => void }) {
  const items = findings(report, item);
  return <Modal title={items[0]?.title ?? 'Límite de cobertura'} close={close}>
    <p className="gc-reading-note">{item.explanation}</p>
    {items.map((finding) => <section className="gc-evidence-finding" key={finding.id}>
      <div className="gc-tags"><span className="gc-tag">{sourceLabels[finding.origin]}</span><span className={`gc-severity gc-severity-${finding.severity}`}>{severityLabels[finding.severity]}</span><span className="gc-tag">{confidenceLabels[finding.confidence]}</span></div>
      <p>{finding.description}</p><dl className="gc-detail-grid"><div><dt>Ubicación</dt><dd>{finding.location}</dd></div><div><dt>Explotabilidad</dt><dd>{finding.exploitability === 'demonstrated_in_fixture' ? 'Demostrada en la prueba autorizada' : 'No demostrada'}</dd></div></dl>
      <h3>Impacto posible</h3><p>{finding.impact}</p><h3>Recomendación</h3><p>{finding.recommendation}</p>
      {finding.limitations.length > 0 && <><h3>Qué no se comprobó</h3><ul>{finding.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul></>}
      {[...report.internal?.evidence ?? [], ...report.external?.evidence ?? []].filter((entry) => finding.evidenceIds.includes(entry.id)).map((entry) => <details className="gc-evidence" key={entry.id}>
        <summary>{entry.locator}</summary><p>{entry.tool.name} · v{entry.tool.version} · {date(entry.collectedAt)}</p><pre>{entry.excerpt}</pre><p className="gc-checksum">SHA-256: {entry.checksum}</p><p className="gc-checksum">Snapshot: {entry.snapshotRef}</p>
      </details>)}
    </section>)}
    <div className="gc-observation-note">Modo observación. No se han realizado cambios ni acciones sobre la aplicación.</div>
  </Modal>;
}
function ReportRows({ report, onSelect, filter = 'all' }: { report: AssessmentReport; onSelect: (key: string) => void; filter?: string }) {
  const entries = report.comparison.filter((item) => filter === 'all' || item.classification === filter);
  return entries.length ? <ul className="gc-findings-list">{entries.map((item) => {
    const entry = findings(report, item)[0];
    return <li key={item.key}><button className="gc-finding-row" onClick={() => onSelect(item.key)}>
      <span className="gc-finding-summary"><strong>{entry?.title ?? 'Aspecto no verificable'}</strong><span>{entry?.location ?? item.explanation}</span></span>
      <span className="gc-tag">{sourceLabels[item.classification]}</span>
      {entry ? <span className={`gc-severity gc-severity-${entry.severity}`}>{severityLabels[entry.severity]}</span> : <span className="gc-tag">Limitación</span>}<Icon name="chevron" size={16} />
    </button></li>;
  })}</ul> : <div className="gc-empty"><Icon name="shield" size={30} /><h3>No hay observaciones en esta categoría</h3><p>Esto describe el perfil evaluado; no demuestra que la aplicación sea segura.</p></div>;
}
function Improvement({ before, after }: { before: AssessmentReport | undefined; after: AssessmentReport | undefined }) {
  if (!before || !after) return <div className="gc-reading-note">Analiza ambas versiones en modo «Interno + externo» para contrastar los cambios con evidencias equivalentes.</div>;
  const comparable = (['internal', 'external'] as const).every((origin) => {
    const first = before[origin];
    const second = after[origin];
    return first && second && first.status !== 'unavailable' && second.status !== 'unavailable'
      && first.tool.name === second.tool.name && first.tool.version === second.tool.version
      && first.coverage.length === second.coverage.length
      && first.coverage.every((entry) => entry.state !== 'unavailable' && second.coverage.some((other) => other.capability === entry.capability && other.state === entry.state));
  });
  if (!comparable) return <div className="gc-reading-note">No se pueden comparar las mejoras: los perfiles o las fuentes disponibles difieren. Repite ambas versiones con la misma cobertura.</div>;
  const keysAfter = new Set(after.comparison.map((item) => item.key));
  const absent = before.comparison.filter((item) => !keysAfter.has(item.key));
  return <div className="gc-improvement"><Icon name="compare" size={22} /><div><strong>{absent.length} observaciones anteriores no aparecen en el perfil corregido</strong><p>Comparación de dos ejecuciones reales. Revisa las limitaciones de ambos informes antes de concluir que una corrección está verificada.</p></div></div>;
}
function download(report: AssessmentReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `gotchu-${report.revision}-${report.id}.json`; link.click(); URL.revokeObjectURL(url);
}

export function AssessmentDashboard() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('overview');
  const [mode, setMode] = useState<AssessmentMode>('both');
  const [revision, setRevision] = useState<DemoRevision>('vulnerable');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const workspace = useQuery({ queryKey: ['demo-workspace'], queryFn: loadWorkspace, retry: 1 });
  const enqueue = useMutation({ mutationFn: queueAssessment, onSuccess: ({ jobId }) => { setActiveJob(jobId); setOperationError(null); }, onError: (error) => setOperationError(message(error)) });
  const job = useQuery({ queryKey: ['demo-job', activeJob], enabled: activeJob !== null, queryFn: () => {
    if (!activeJob) throw new Error('No hay evaluación en curso.');
    return loadJob(activeJob);
  }, refetchInterval: (query) => query.state.data?.state === 'succeeded' || query.state.data?.state === 'failed' ? false : 750, retry: 1 });
  const jobState = job.data?.state;
  const completedReportId = job.data?.reportId;
  useEffect(() => {
    if (jobState === 'succeeded' && completedReportId) {
      setSelectedId(completedReportId); setActiveJob(null); setSelectedKey(null);
      queryClient.invalidateQueries({ queryKey: ['demo-workspace'] }).catch((error: unknown) => setOperationError(message(error)));
    } else if (jobState === 'failed') {
      setActiveJob(null); setOperationError('La evaluación no finalizó. Los informes anteriores siguen disponibles.');
    }
  }, [jobState, completedReportId, queryClient]);
  const reportId = selectedId ?? workspace.data?.reports[0]?.id ?? null;
  const selected = useReport(reportId);
  const report = selected.data;
  const beforeId = workspace.data?.reports.find((item) => item.revision === 'vulnerable' && item.mode === 'both')?.id ?? null;
  const afterId = workspace.data?.reports.find((item) => item.revision === 'corrected' && item.mode === 'both')?.id ?? null;
  const before = useReport(beforeId, view === 'comparison');
  const after = useReport(afterId, view === 'comparison');
  const busy = enqueue.isPending || activeJob !== null;
  const title = navigation.find((item) => item.id === view)?.label ?? 'Resumen';
  const detail = report?.comparison.find((item) => item.key === selectedKey);

  return <div className="gc-dashboard"><aside className="gc-sidebar">
    <a className="gc-brand" href="/dashboard"><span><Icon name="shield" size={23} /></span>gotchu<span className="gc-brand-period">.</span></a>
    <div className="gc-workspace"><span className="gc-workspace-avatar">D</span><div><strong>Tu entorno de pruebas</strong><span>Aplicación controlada</span></div></div>
    <span className="gc-nav-label">ESPACIO DE TRABAJO</span><nav aria-label="Navegación principal">{navigation.map((item) => <button key={item.id} className={view === item.id ? 'gc-nav-item gc-nav-active' : 'gc-nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><Icon name={item.icon} size={18} />{item.label}</button>)}</nav>
    <div className="gc-sidebar-bottom"><div className="gc-preview-note"><strong>Sin API de IA obligatoria</strong><p>Comprobaciones deterministas, evidencias y límites explícitos.</p></div><span className="gc-mode-label"><span />Modo observación</span></div>
  </aside><div className="gc-content">
    <header className="gc-topbar"><span className="gc-breadcrumb">Demo <span>/</span><strong>{title}</strong></span><span className="gc-preview-badge">Entorno controlado</span></header>
    <main className="gc-main"><div className="gc-demo-banner"><Icon name="shield" size={18} /><span><strong>Datos obtenidos por análisis reales de una demo.</strong> Sólo se consulta la aplicación de pruebas autorizada. No se realizan cambios.</span></div>
      <div className="gc-page-heading"><div><span className="gc-eyebrow">OBSERVAR · CONTRASTAR · ENTENDER</span><h1>{view === 'overview' ? 'Seguridad con evidencias' : title}</h1><p>Lo que dice el código. Lo que muestra HTTP. Y lo que todavía no sabemos.</p></div>{report && <button className="gc-button" onClick={() => download(report)}><Icon name="download" size={16} />Exportar JSON</button>}</div>
      {(workspace.error || operationError || job.error || selected.error) && <div className="gc-error" role="alert"><strong>No se pudo completar la operación</strong><p>{operationError ?? message(workspace.error ?? job.error ?? selected.error)}</p><button className="gc-text-button" onClick={() => { setOperationError(null); workspace.refetch().catch((error: unknown) => setOperationError(message(error))); if (activeJob) job.refetch().catch((error: unknown) => setOperationError(message(error))); if (reportId) selected.refetch().catch((error: unknown) => setOperationError(message(error))); }}>Reintentar conexión</button></div>}
      <section className="gc-panel gc-run-panel" aria-labelledby="run-title"><div className="gc-run-heading"><div><h2 id="run-title">Analiza la tienda de demostración</h2><p>Elige una versión y el alcance. El análisis externo funciona sin acceso al repositorio.</p></div><span className="gc-tag">Sólo lectura</span></div>
        <div className="gc-run-controls"><fieldset disabled={busy}><legend>1. Versión de la aplicación</legend><div className="gc-segmented">{(['vulnerable', 'corrected'] as const).map((value) => <button key={value} aria-pressed={revision === value} onClick={() => setRevision(value)}>{revisionLabels[value]}</button>)}</div></fieldset>
          <fieldset disabled={busy}><legend>2. Perspectiva del análisis</legend><div className="gc-segmented">{(['internal', 'external', 'both'] as const).map((value) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{modeLabels[value]}</button>)}</div></fieldset>
          <button className="gc-button gc-button-primary" disabled={busy || !workspace.data?.targetConfigured} onClick={() => enqueue.mutate({ mode, revision })}>{busy ? <span className="gc-spinner" /> : <Icon name="shield" size={17} />}{busy ? jobState === 'queued' ? 'En cola…' : 'Analizando…' : 'Analizar demo'}</button>
        </div><div className="gc-run-caption" role="status">{busy ? 'El trabajo está guardado y se procesa en segundo plano. Puedes consultar los informes anteriores.' : workspace.isPending ? 'Comprobando la disponibilidad del entorno…' : !workspace.data?.targetConfigured ? 'La demo necesita su configuración inicial antes de poder analizarla.' : 'Sin cuenta de GitHub, modelo de pago ni acciones sobre producción.'}</div>
      </section>
      {workspace.data && workspace.data.reports.length > 0 && <div className="gc-report-picker"><label htmlFor="report-picker">Informe seleccionado</label><select id="report-picker" value={reportId ?? ''} onChange={(event) => { setSelectedId(event.target.value); setSelectedKey(null); }}>{workspace.data.reports.map((entry) => <option key={entry.id} value={entry.id}>{revisionLabels[entry.revision]} · {modeLabels[entry.mode]} · {date(entry.createdAt)}</option>)}</select>{report && <span className="gc-tag">{date(report.finishedAt)}</span>}</div>}
      {reportId && selected.isPending && <div className="gc-loading" role="status"><span className="gc-spinner" /> Cargando evidencias del informe…</div>}
      {!report && !selected.error && !selected.isFetching && <section className="gc-panel gc-first-run"><span className="gc-next-icon"><Icon name="compare" size={30} /></span><h2>Un primer análisis que puedes comprobar</h2><p>Empieza por la versión con fallos y compara ambas perspectivas. Después ejecuta la versión corregida para ver qué cambia y qué sigue sin verificarse.</p><div className="gc-first-run-steps"><span>1. Analiza</span><span>2. Revisa evidencias</span><span>3. Contrasta versiones</span></div></section>}
      {report && <>
        <div className="gc-report-status"><span className="gc-tag">{revisionLabels[report.revision]}</span><span>{modeLabels[report.mode]} · {report.internal?.status === 'unavailable' || report.external?.status === 'unavailable' ? 'Hay fuentes no disponibles' : report.internal?.status === 'partial' || report.external?.status === 'partial' ? 'Perfil limitado; revisa la cobertura' : 'Perfil completado'}</span></div>
        {view === 'overview' && <><div className="gc-metrics">{[
          ['Observaciones', report.comparison.filter((item) => item.internalFindingIds.length + item.externalFindingIds.length > 0).length, 'Agrupadas por regla y recurso'],
          ['Coinciden', report.comparison.filter((item) => item.classification === 'both').length, 'Observadas desde código y HTTP'],
          ['Sin contraste', report.comparison.filter((item) => item.classification === 'unverified').length, 'La otra perspectiva no lo comprobó'],
          ['Acciones realizadas', report.actionsPerformed.length, 'La severidad no concede permisos'],
        ].map(([label, value, note]) => <article className="gc-metric" key={label}><h2>{label}</h2><strong className="gc-metric-value">{value}</strong><p>{note}</p></article>)}</div><section className="gc-panel"><div className="gc-panel-heading"><div><h2>Qué necesita tu atención</h2><p>Cada observación conserva su origen, confianza y evidencia.</p></div><button className="gc-text-button" onClick={() => setView('comparison')}>Comparar fuentes <Icon name="arrow" size={15} /></button></div><ReportRows report={report} onSelect={setSelectedKey} /></section></>}
        {view === 'comparison' && <><Improvement before={before.data} after={after.data} /><section className="gc-panel"><div className="gc-panel-heading"><div><h2>Interno frente a externo</h2><p>Que dos fuentes coincidan no demuestra que un problema sea explotable.</p></div></div><div className="gc-filter-bar">{(['all', 'both', 'internal_only', 'external_only', 'unverified'] as const).map((value) => <button className="gc-filter" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'Todas' : sourceLabels[value]}</button>)}</div><ReportRows report={report} filter={filter} onSelect={setSelectedKey} /></section></>}
        {view === 'reports' && <section className="gc-panel"><div className="gc-panel-heading"><div><h2>Historial de evaluaciones</h2><p>Resultados persistidos de esta aplicación de demostración.</p></div></div><ul className="gc-history">{workspace.data?.reports.map((entry) => <li key={entry.id}><button onClick={() => { setSelectedId(entry.id); setSelectedKey(null); setView('overview'); }}><Icon name="report" /><span><strong>{revisionLabels[entry.revision]}</strong><small>{modeLabels[entry.mode]} · {date(entry.createdAt)}</small></span><Icon name="chevron" size={16} /></button></li>)}</ul></section>}
        {view === 'coverage' && <section className="gc-panel gc-coverage-panel"><h2>Qué se evaluó y qué no</h2><p>Una fuente ausente o un perfil limitado no se presenta como una comprobación aprobada.</p>{(['internal', 'external'] as const).map((origin) => <section key={origin}><h3>{sourceLabels[origin]}</h3>{report[origin] ? <ul className="gc-coverage-list">{report[origin].coverage.map((item) => <li key={item.capability}><div><strong>{item.capability}</strong><p>{item.detail}</p></div><span className="gc-tag">{coverageLabels[item.state]}</span></li>)}</ul> : <p className="gc-reading-note">Esta perspectiva no se solicitó en esta ejecución.</p>}</section>)}</section>}
        <section className="gc-panel gc-limitations"><h2>Límites del informe</h2><p>Este perfil comprueba reglas concretas. No es una auditoría completa ni una prueba de que la aplicación sea segura.</p><details><summary>Ver alcance y limitaciones de las evidencias</summary><ul>{[...new Set([...report.limitations, ...report.internal?.limitations ?? [], ...report.external?.limitations ?? []])].map((limit) => <li key={limit}>{limit}</li>)}</ul></details><p>Modo observación. No se han realizado acciones. La respuesta con aprobación, la automatización limitada y la recuperación requieren capacidades adicionales.</p></section>
      </>}
      <footer className="gc-footer"><span>Evidencia antes que suposiciones.</span><span>Gotchu · Demo controlada</span></footer>
    </main>
  </div>{report && detail && <Evidence report={report} item={detail} close={() => setSelectedKey(null)} />}</div>;
}
