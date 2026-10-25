import type { ReactNode } from 'react';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { SEVERITIES, type NextAction, type ProjectSource, type SeverityCounts } from './project-risk';

const severityNames: Record<(typeof SEVERITIES)[number], string> = {
  critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Informativa', unknown: 'Sin evaluar',
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

/** Risk first: open findings by severity, how much of the project they speak for, and the one thing to do next. */
export function ProjectOverview({ risk, onAddSource, onExamine, examining, examineError, onOpenReport, onOpenSources, onRetry, assessmentForm, recentReports, onViewReports }: {
  risk: ProjectRisk;
  onAddSource: () => void;
  onExamine: (source: ProjectSource) => void;
  examining: boolean;
  examineError: string | null;
  onOpenReport: (reportId: string) => void;
  onOpenSources: () => void;
  onRetry: () => void;
  assessmentForm: ReactNode;
  recentReports: ReactNode;
  onViewReports: () => void;
}) {
  const max = Math.max(1, ...SEVERITIES.map(severity => risk.counts[severity]));
  const examinedIds = new Set(risk.examined.map(item => `${item.source.kind}:${item.source.id}`));
  return <>
    <div className="customer-risk-grid" aria-busy={risk.state === 'loading'}>
      <section className="customer-risk-tile" aria-labelledby="risk-findings-title">
        <h2 id="risk-findings-title">Observaciones abiertas</h2>
        {risk.state === 'error' ? <p className="customer-risk-note">No se pudieron cargar los informes. <button className="customer-link-button" type="button" onClick={onRetry}>Reintentar</button></p>
          : <>
            <p className="customer-risk-figure"><strong>{risk.state === 'loading' ? '—' : risk.total}</strong><span>{risk.examined.length === 0 ? 'sin informes todavía' : 'en los últimos informes de cada fuente'}</span></p>
            <ul className="customer-severity-bars">
              {SEVERITIES.map(severity => <li key={severity} data-severity={severity} className={risk.counts[severity] === 0 ? 'is-zero' : undefined}>
                <span>{severityNames[severity]}</span>
                <span className="customer-severity-track" aria-hidden="true"><i style={{ width: `${(risk.counts[severity] / max) * 100}%` }} /></span>
                <strong>{risk.counts[severity]}</strong>
              </li>)}
            </ul>
          </>}
      </section>

      <section className="customer-risk-tile" aria-labelledby="risk-coverage-title">
        <div className="customer-risk-head">
          <h2 id="risk-coverage-title">Cobertura</h2>
          <span className={`customer-coverage-status is-${risk.coverage}`}>{risk.coverage === 'complete' ? 'Completa' : risk.coverage === 'partial' ? 'Parcial' : 'Sin fuentes'}</span>
        </div>
        <p className="customer-risk-figure"><strong>{risk.examined.length}<small> de {risk.sources.length}</small></strong><span>{risk.sources.length === 1 ? 'fuente examinada' : 'fuentes examinadas'}</span></p>
        {risk.sources.length > 0 && <ul className="customer-coverage-list">
          {risk.sources.map(source => {
            const done = examinedIds.has(`${source.kind}:${source.id}`);
            const date = risk.examined.find(item => item.source.kind === source.kind && item.source.id === source.id)?.reportDate;
            return <li key={`${source.kind}:${source.id}`} className={done ? 'is-done' : undefined}>
              <span className="customer-coverage-mark" aria-hidden="true">{done && <CheckIcon />}</span>
              <span><strong>{source.label}</strong><small>{source.detail}</small></span>
              <small>{done ? date : 'Pendiente'}</small>
            </li>;
          })}
        </ul>}
        {risk.coverage === 'partial' && risk.pending.length === 0 && <p className="customer-risk-note">Algún análisis terminó con cobertura parcial; revisa «Qué se evaluó» en el informe.</p>}
      </section>

      <section className="customer-risk-tile customer-next-step" aria-labelledby="risk-next-title">
        <h2 id="risk-next-title">Siguiente paso</h2>
        <NextStep next={risk.next} examining={examining} onAddSource={onAddSource} onExamine={onExamine} onOpenReport={onOpenReport} onOpenSources={onOpenSources} />
        {examineError && <p className="customer-form-error" role="alert">{examineError}</p>}
      </section>
    </div>

    <div className="customer-overview-split">
      <section className="customer-overview-reports" aria-labelledby="recent-reports-title">
        <div className="customer-section-head"><h2 id="recent-reports-title">Informes recientes</h2><button className="customer-link-button" type="button" onClick={onViewReports}>Ver todos</button></div>
        {recentReports}
      </section>
      {assessmentForm}
    </div>
  </>;
}

function NextStep({ next, examining, onAddSource, onExamine, onOpenReport, onOpenSources }: {
  next: NextAction; examining: boolean;
  onAddSource: () => void; onExamine: (source: ProjectSource) => void; onOpenReport: (reportId: string) => void; onOpenSources: () => void;
}) {
  switch (next.kind) {
    case 'add_source': return <>
      <p className="customer-next-copy">Añade el código, una imagen o un origen HTTPS para tener la primera lectura del riesgo.</p>
      <button className="customer-button customer-button-primary" type="button" onClick={onAddSource}>Añadir una fuente<ArrowRightIcon aria-hidden="true" /></button>
    </>;
    case 'examine': return <>
      <p className="customer-next-copy"><strong>{next.source.label}</strong> todavía no tiene informe. Evalúala para que la cobertura cuente toda la aplicación.</p>
      {next.source.kind === 'image'
        ? <button className="customer-button customer-button-primary" type="button" onClick={onOpenSources}>Evaluar la imagen<ArrowRightIcon aria-hidden="true" /></button>
        : <button className="customer-button customer-button-primary" type="button" disabled={examining} onClick={() => onExamine(next.source)}>{examining ? 'Iniciando…' : 'Evaluar ahora'}<ArrowRightIcon aria-hidden="true" /></button>}
    </>;
    case 'review': return <>
      <p className="customer-next-copy">Hay <strong>{next.count} {next.count === 1 ? 'observación' : 'observaciones'} {next.severity === 'critical' ? (next.count === 1 ? 'crítica' : 'críticas') : (next.count === 1 ? 'alta' : 'altas')}</strong>. Revisa su evidencia antes que el resto.</p>
      <button className="customer-button customer-button-primary" type="button" onClick={() => onOpenReport(next.reportId)}>Revisar el informe<ArrowRightIcon aria-hidden="true" /></button>
    </>;
    case 'deepen': return <>
      <p className="customer-next-copy">No hay observaciones altas, pero algún análisis quedó incompleto. Revisa qué faltó en tus fuentes.</p>
      <button className="customer-button" type="button" onClick={onOpenSources}>Ver fuentes<ArrowRightIcon aria-hidden="true" /></button>
    </>;
    case 'clear': return <p className="customer-next-copy">Todas las fuentes tienen un informe completo y no hay observaciones altas ni críticas. Vuelve a evaluar cuando cambie el código o el origen.</p>;
  }
}
