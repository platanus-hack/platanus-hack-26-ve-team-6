import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowUpRightIcon, PlayIcon } from 'lucide-react';
import { customerOriginSchema, customerScanProfileSchema, type CustomerReportSummary, type CustomerTarget } from '@gotchu/contracts';
import { customerApi, CustomerApiError, type CustomerJob } from './customer-client';
import { ChoiceSelect } from './choice-select';
import { AssessmentProgress } from './assessment-progress';
import { Button } from './ui/button';
import { Input } from './ui/input';
import './https-audit.css';

const profiles = [
  { value: 'root', label: 'Raíz · 1 solicitud GET' },
  { value: 'public_surface', label: 'Superficie pública · hasta 10 GET' },
  { value: 'api_checks', label: 'Web y API · escenarios HTTP activos' },
];
function errorMessage(error: unknown) {
  if (error instanceof CustomerApiError && error.code === 'target_assessment_in_progress') return 'Ya hay una evaluación pendiente para este origen. Espera a que termine antes de renovar el alcance.';
  return error instanceof Error && error.name !== 'ZodError' ? error.message : 'No se pudo iniciar la evaluación. Revisa el origen e inténtalo de nuevo.';
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function ProjectHttpsAudit({ organizationId, applicationId, targets, reports, canManage, archived, activeJob, lastJob, checkingJob, jobError, onRetryJob, onQueued, onChanged, onViewReport }: {
  organizationId: string; applicationId: string; targets: CustomerTarget[]; reports: CustomerReportSummary[];
  canManage: boolean; archived: boolean; activeJob: CustomerJob | null; lastJob: CustomerJob | null; checkingJob: boolean;
  jobError: boolean; onRetryJob: () => void; onQueued: (jobId: string) => void; onChanged: () => void; onViewReport: (reportId: string) => void;
}) {
  const target = targets.find(item => item.status === 'authorized') ?? targets[0];
  const [origin, setOrigin] = useState(target?.origin ?? '');
  const [profile, setProfile] = useState(customerScanProfileSchema.parse(target?.scanProfile ?? 'api_checks'));
  const [error, setError] = useState<string | null>(null);
  const [retryTargetId, setRetryTargetId] = useState<string | null>(null);
  useEffect(() => { setRetryTargetId(null); }, [origin, profile]);
  const externalReports = reports.filter(report => report.mode !== 'internal');
  const observedJob = activeJob ?? lastJob;
  const unfinished = checkingJob || activeJob?.state === 'queued' || activeJob?.state === 'running';
  const parsedOrigin = customerOriginSchema.safeParse(/^[a-z][a-z0-9+.-]*:\/\//i.test(origin.trim()) ? origin.trim() : `https://${origin.trim()}`);
  const analyze = useMutation({
    mutationFn: async () => {
      if (!parsedOrigin.success) throw new Error('Usa un origen HTTPS público, sin ruta, parámetros ni puerto personalizado.');
      // If queuing fails after enrollment, retry that exact scope without renewing it again.
      const targetId = retryTargetId ?? (await customerApi.enrollTarget({ organizationId, applicationId, origin: parsedOrigin.data, scanProfile: profile })).target.id;
      setRetryTargetId(targetId);
      onChanged();
      return customerApi.queue({ organizationId, applicationId, mode: 'external', sourceSnapshotId: null, targetId });
    },
    onSuccess: result => { setError(null); setRetryTargetId(null); onQueued(result.jobId); },
    onError: caught => setError(errorMessage(caught)),
  });
  const revoke = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('No hay un alcance para revocar.');
      return customerApi.revokeTarget(organizationId, applicationId, target.id);
    },
    onSuccess: () => { setError(null); setRetryTargetId(null); onChanged(); }, onError: caught => setError(errorMessage(caught)),
  });
  const locked = !canManage || archived || analyze.isPending || revoke.isPending || unfinished || jobError;
  return <div className="https-audit">
    <section className="https-audit-request" aria-label="Auditar una web">
      <form className="https-audit-form" onSubmit={event => { event.preventDefault(); setError(null); analyze.mutate(); }}>
        <div><label htmlFor="https-audit-origin">Origen HTTPS</label><Input id="https-audit-origin" value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://tu-app.com" inputMode="url" autoComplete="url" disabled={locked} required aria-describedby="https-audit-scope" aria-invalid={origin.length > 0 && !parsedOrigin.success} /></div>
        <div><label htmlFor="https-audit-profile">Perfil de evaluación</label><ChoiceSelect id="https-audit-profile" value={profile} options={profiles} onChange={value => setProfile(customerScanProfileSchema.parse(value))} disabled={locked} /></div>
        <Button type="submit" size="sm" disabled={locked || !parsedOrigin.success}><PlayIcon aria-hidden="true" />{analyze.isPending ? 'Iniciando…' : 'Analizar HTTPS'}</Button>
      </form>
      <p id="https-audit-scope" className="https-audit-note">{profile === 'api_checks' ? 'Descubre OpenAPI y comprueba CORS, métodos HTTP, rutas de control y respuestas HEAD sin autenticación. Hasta 16 peticiones GET/HEAD/OPTIONS al mismo origen, sin modificar datos.' : profile === 'root' ? 'Una petición GET a la raíz.' : 'Hasta diez peticiones GET a rutas públicas del mismo origen.'} Sin credenciales ni redirecciones. Los límites y las rutas no observadas aparecen en el informe.</p>
      {target && <div className="https-scope-summary"><span><strong>{target.origin}</strong><small>{target.status === 'revoked' ? 'Alcance revocado' : target.expiresAt && Date.parse(target.expiresAt) > Date.now() ? `Vigente hasta ${formatDate(target.expiresAt)}` : 'Alcance vencido'}</small></span>{target.status === 'authorized' && canManage && <Button type="button" variant="link" size="sm" disabled={locked} onClick={() => revoke.mutate()}>Revocar alcance</Button>}</div>}
      {!canManage && <p className="https-audit-note">Una persona propietaria u operadora puede iniciar la evaluación.</p>}
      {archived && <p className="https-audit-note">Reactiva el proyecto para iniciar otra evaluación.</p>}
      {error && <p className="customer-form-error" role="alert">{error}</p>}
    </section>
    {/* A new request never reuses the previous job's completion. */}
    <AssessmentProgress key={analyze.isPending ? 'submitting' : observedJob?.id ?? 'idle'} purpose="assessment" mode="external"
      job={analyze.isPending ? undefined : observedJob ?? undefined}
      waiting={analyze.isPending ? 'submitting' : checkingJob ? 'loading' : 'idle'}
      failure={observedJob?.state === 'failed' ? `La evaluación no finalizó${observedJob.reasonCode ? ` (${observedJob.reasonCode})` : ''}. Un análisis interrumpido no confirma seguridad.` : null}
      error={jobError ? 'No se pudo consultar el estado.' : null} retry={onRetryJob} />
    <section className="https-audit-results" aria-labelledby="https-results-title">
      <div className="https-section-heading"><h2 id="https-results-title">Informes externos</h2><span className="customer-status customer-status-muted">{externalReports.length} {externalReports.length === 1 ? "informe" : "informes"}</span></div>
      {externalReports.length === 0 ? <p className="https-audit-note">El informe aparecerá aquí cuando termine la primera evaluación.</p> : <ul>{externalReports.map(report => <li key={report.id}><div><strong>{report.subject.origin}</strong><small>{formatDate(report.finishedAt)} · {report.mode === 'both' ? 'Código + HTTPS' : 'HTTPS externo'}</small></div><span>{report.findingCount} observaciones{report.mode === 'both' ? ' en total' : ''}</span><button className="customer-button" type="button" onClick={() => onViewReport(report.id)}>Ver informe<ArrowUpRightIcon aria-hidden="true" /></button></li>)}</ul>}
    </section>
  </div>;
}
