import { CheckIcon, CircleIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import type { CustomerJob } from './customer-client';
import { Badge } from './ui/badge';
import './https-audit.css';

export type AssessmentProgressStatus = CustomerJob['state'] | 'idle' | 'loading' | 'unavailable';

export function AssessmentProgress({ status, reportAvailable = false }: { status: AssessmentProgressStatus; reportAvailable?: boolean }) {
  const labels: Record<AssessmentProgressStatus, string> = {
    idle: 'Lista para empezar', loading: 'Consultando estado', queued: 'En cola', running: 'Evaluando',
    succeeded: reportAvailable ? 'Informe disponible' : 'Evaluación terminada', failed: 'No se pudo completar', unavailable: 'Estado sin confirmar',
  };
  const hasJob = ['queued', 'running', 'succeeded', 'failed'].includes(status);
  const stages = [
    { title: 'Solicitud registrada', detail: 'Origen y perfil guardados', state: hasJob ? 'done' : 'pending' },
    { title: 'Evaluación', detail: 'Comprobaciones en segundo plano', state: status === 'running' ? 'running' : status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : 'pending' },
    { title: 'Informe guardado', detail: 'Evidencia, hallazgos y cobertura', state: status === 'succeeded' && reportAvailable ? 'done' : 'pending' },
  ];
  return <section className="https-progress" aria-labelledby="https-progress-title" aria-busy={status === 'running' || status === 'queued' || status === 'loading'}>
    <div className="https-section-heading"><h2 id="https-progress-title">Proceso de evaluación</h2><Badge variant="outline" role="status">{labels[status]}</Badge></div>
    <ol className="https-progress-graph" aria-label="Estado de la evaluación">
      {stages.map(stage => <li key={stage.title} data-state={stage.state} aria-current={stage.state === 'running' ? 'step' : undefined}>
        <span className="https-progress-mark" aria-hidden="true">{stage.state === 'done' ? <CheckIcon /> : stage.state === 'running' ? <LoaderCircleIcon /> : stage.state === 'failed' ? <XIcon /> : <CircleIcon />}</span>
        <div><strong>{stage.title}</strong><small>{stage.detail}</small><span className="sr-only">{stage.state === 'done' ? 'Completada' : stage.state === 'running' ? 'En curso' : stage.state === 'failed' ? 'Fallida' : 'Pendiente'}</span></div>
      </li>)}
    </ol>
    {(status === 'queued' || status === 'running') && <p>El análisis sigue en segundo plano. Puedes navegar por el proyecto o volver a esta página.</p>}
    {status === 'unavailable' && <p>No se pudo consultar el estado. Esto no confirma que el análisis se haya detenido.</p>}
    {status === 'failed' && <p>Consulta el error antes de iniciar otra evaluación. Un análisis interrumpido no confirma seguridad.</p>}
  </section>;
}
