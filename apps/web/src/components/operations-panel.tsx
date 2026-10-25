import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { z } from 'zod';
import {
  operationReadinessSchema,
  type CustomerSourceSummary,
  type CustomerTarget,
  type OperationAlert,
  type OperationCoverage,
  type OperationPlan,
} from '@gotchu/contracts';
import { CustomerApiError } from './customer-client';
import { DecisionRecordHistory } from './decision-record-history';
import { InvestigationActionButton } from './investigations-panel';
import { operationsApi, type MonitorSettings, type OperationsScope, type PlanKind, type PlanStepKey } from './operations-client';

type Props = OperationsScope & {
  userId: string;
  sources: CustomerSourceSummary[];
  targets: CustomerTarget[];
  canManage: boolean;
};
type OperationReadiness = z.infer<typeof operationReadinessSchema>;

const providerNames = { cloudflare: 'Cloudflare', railway: 'Railway' } as const;
const statusNames: Record<OperationCoverage['status'], string> = {
  not_configured: 'Sin configurar', pending: 'En proceso', active: 'Ejecución completada', degraded: 'Cobertura incompleta', stale: 'Evidencia atrasada', stopped: 'Vigilancia detenida',
};
const observationNames: Record<OperationAlert['observation']['kind'], string> = {
  repository_change: 'Cambio en el repositorio', dependency_advisory: 'Aviso de dependencia', public_surface: 'Superficie pública',
  upstream_outage: 'Estado de proveedor', traffic_pressure: 'Presión de tráfico', application_error: 'Error de proyecto',
  security_finding: 'Hallazgo de seguridad', coverage_gap: 'Brecha de cobertura', coverage_check: 'Comprobación de cobertura',
};
const severityNames = { info: 'Información', low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' } as const;
const confidenceNames = { low: 'Baja', medium: 'Media', high: 'Alta' } as const;
const evidenceSourceNames: Record<OperationAlert['observation']['evidence'][number]['source'] | 'advisory_database', string> = {
  repository: 'Repositorio', provider_status: 'Estado del proveedor', signed_event: 'Evento firmado', assessment: 'Evaluación',
  advisory_database: 'Base de avisos de seguridad',
};
const planNames: Record<PlanKind, string> = {
  investigate_capacity: 'Investigar capacidad', migration_readiness: 'Preparación de migración', review_improvement: 'Revisar mejora',
};
const stepNames: Record<PlanStepKey, string> = {
  inventory: 'Inventario', data: 'Datos', secrets: 'Secretos', destination: 'Destino', cost: 'Costos', health: 'Salud',
  rollback: 'Reversión', cutover: 'Cambio de tráfico', capacity: 'Capacidad', validation: 'Validación',
};
const intervals = [1, 2, 3, 4, 6, 8, 12, 24] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function errorText(error: unknown) {
  if (error instanceof CustomerApiError) {
    if (error.code === 'monitor_work_in_progress') return 'Hay una evaluación programada en curso. La configuración anterior sigue activa; inténtalo de nuevo cuando termine.';
    if (error.code === 'plan_changed') return 'El plan cambió mientras lo revisabas. Se actualizará con la revisión actual; vuelve a intentarlo.';
    if (error.code === 'evidence_stale') return 'La evidencia ya no está vigente. Actualiza las observaciones antes de crear o preparar una guía.';
    if (error.code === 'capacity_evidence_required') return 'La observación sólo muestra volumen. Se necesita presión medida de errores, latencia o capacidad para investigar balanceo.';
    if (error.code === 'upstream_evidence_required') return 'La preparación de migración requiere una observación del estado de un proveedor.';
    if (error.code === 'target_not_verified') return 'El origen ya no tiene una autorización vigente. Actualiza su verificación antes de incluirlo.';
    return error.message;
  }
  if (error instanceof Error && error.name !== 'ZodError') return error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

function scopeKeys(userId: string, scope: OperationsScope) {
  const root = ['customer-data', userId, 'operations', scope.organizationId, scope.applicationId] as const;
  return {
    coverage: [...root, 'coverage'] as const,
    repositories: [...root, 'repositories'] as const,
    alerts: [...root, 'alerts'] as const,
    plans: [...root, 'plans'] as const,
  };
}

function currentTargets(targets: CustomerTarget[]) {
  const now = Date.now();
  return targets.filter(target => target.status === 'verified' && target.expiresAt !== null && Date.parse(target.expiresAt) > now);
}

function suggestedPlan(alert: OperationAlert): PlanKind {
  const observation = alert.observation;
  if (observation.kind === 'upstream_outage') return 'migration_readiness';
  const metrics = observation.metrics;
  const measuredCapacityPressure = observation.kind === 'traffic_pressure' && metrics !== null
    && (metrics.errorCount > 0 || (metrics.latencyP95Ms ?? 0) > 1000 || (metrics.capacityUtilization ?? 0) > 0.8);
  return measuredCapacityPressure ? 'investigate_capacity' : 'review_improvement';
}

function coverageTone(coverage: OperationCoverage) {
  if (coverage.status === 'stopped') return 'customer-ops-status-stopped';
  if (coverage.status === 'degraded' || coverage.status === 'stale' || !coverage.scopeCurrent) return 'customer-ops-status-warning';
  if (coverage.status === 'active' && coverage.observations.fresh > 0 && coverage.observations.stale === 0) return 'customer-ops-status-ready';
  return 'customer-ops-status-muted';
}

export function OperationsPanel({ userId, organizationId, applicationId, sources, targets, canManage }: Props) {
  const scope = { organizationId, applicationId };
  const keys = scopeKeys(userId, scope);
  const decisionRecordKey = ['customer-data', userId, 'decision-records', organizationId] as const;
  const queryClient = useQueryClient();
  const coverage = useQuery({ queryKey: keys.coverage, queryFn: () => operationsApi.coverage(scope), retry: false, refetchInterval: 10_000 });
  const repositories = useQuery({ queryKey: keys.repositories, queryFn: () => operationsApi.repositories(scope), retry: false });
  const alerts = useQuery({ queryKey: keys.alerts, queryFn: () => operationsApi.alerts(scope), retry: false, refetchInterval: 7_500 });
  const plans = useQuery({ queryKey: keys.plans, queryFn: () => operationsApi.plans(scope), retry: false });
  const verifiedTargets = currentTargets(targets);

  const [enabled, setEnabled] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(21_600);
  const [basis, setBasis] = useState('');
  const [targetId, setTargetId] = useState('');
  const [providers, setProviders] = useState<Array<'cloudflare' | 'railway'>>([]);
  const appliedRevision = useRef<number | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});
  const [stepDrafts, setStepDrafts] = useState<Record<string, string>>({});
  const [readiness, setReadiness] = useState<Record<string, OperationReadiness>>({});

  useEffect(() => {
    const config = coverage.data?.config;
    if (!config || appliedRevision.current === config.revision) return;
    appliedRevision.current = config.revision;
    setEnabled(config.enabled);
    setIntervalSeconds(config.intervalSeconds);
    setBasis(config.sourceSnapshotId ? `snapshot:${config.sourceSnapshotId}` : config.repositoryKey ? `repository:${config.repositoryKey}` : '');
    setTargetId(verifiedTargets.some(target => target.id === config.targetId) ? config.targetId ?? '' : '');
    setProviders([...config.providers]);
  }, [coverage.data?.config, verifiedTargets]);

  const configure = useMutation({
    mutationFn: (settings: MonitorSettings) => operationsApi.configure(scope, settings),
    onSuccess: async config => {
      setOperationError(null);
      setNotice(config.enabled ? 'La vigilancia quedó configurada.' : 'La vigilancia está desactivada y su alcance se limpió.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.coverage }),
        queryClient.invalidateQueries({ queryKey: decisionRecordKey }),
      ]);
    },
    onError: caught => {
      setOperationError(errorText(caught));
      if (caught instanceof CustomerApiError && caught.code === 'monitor_work_in_progress') {
        const saved = queryClient.getQueryData<OperationCoverage>(keys.coverage)?.config;
        if (saved) {
          setEnabled(saved.enabled);
          setIntervalSeconds(saved.intervalSeconds);
          setBasis(saved.sourceSnapshotId ? `snapshot:${saved.sourceSnapshotId}` : saved.repositoryKey ? `repository:${saved.repositoryKey}` : '');
          setTargetId(verifiedTargets.some(target => target.id === saved.targetId) ? saved.targetId ?? '' : '');
          setProviders([...saved.providers]);
        }
        queryClient.invalidateQueries({ queryKey: keys.coverage }).catch(() => undefined);
      }
    },
  });
  const updateAlert = useMutation({
    mutationFn: ({ alert, state, resolution }: { alert: OperationAlert; state: 'acknowledged' | 'resolved'; resolution?: string }) =>
      operationsApi.updateAlert(scope, alert.id, { state, ...(resolution === undefined ? {} : { resolution }) }),
    onSuccess: async updated => {
      setOperationError(null);
      setNotice(updated.state === 'resolved' ? 'La alerta se marcó como resuelta por el equipo.' : 'La alerta quedó marcada como revisada.');
      queryClient.setQueryData<OperationAlert[]>(keys.alerts, current => current?.map(alert => alert.id === updated.id ? updated : alert));
      await queryClient.invalidateQueries({ queryKey: decisionRecordKey });
    },
    onError: caught => setOperationError(errorText(caught)),
  });
  const createPlan = useMutation({
    mutationFn: ({ alert, kind }: { alert: OperationAlert; kind: PlanKind }) => operationsApi.createPlan(scope, { kind, observationIds: [alert.observation.id] }),
    onSuccess: async plan => {
      setOperationError(null);
      setNotice(`Se creó la guía «${planNames[plan.kind]}».`);
      queryClient.setQueryData<OperationPlan[]>(keys.plans, current => current ? [plan, ...current] : [plan]);
      await queryClient.invalidateQueries({ queryKey: decisionRecordKey });
    },
    onError: caught => setOperationError(errorText(caught)),
  });
  const preparePlan = useMutation({
    mutationFn: (plan: OperationPlan) => operationsApi.preparePlan(scope, plan),
    onSuccess: async plan => {
      updatePlanCache(plan);
      setNotice('Se solicitó la preparación de esta guía consultiva.');
      await queryClient.invalidateQueries({ queryKey: decisionRecordKey });
    },
    onError: caught => { setOperationError(errorText(caught)); queryClient.invalidateQueries({ queryKey: keys.plans }).catch(() => undefined); },
  });
  const attestStep = useMutation({
    mutationFn: ({ plan, key, attestation }: { plan: OperationPlan; key: PlanStepKey; attestation: string }) => operationsApi.attestStep(scope, plan, key, attestation),
    onSuccess: async (plan, variables) => {
      updatePlanCache(plan);
      setStepDrafts(current => { const next = { ...current }; delete next[`${plan.id}:${variables.key}`]; return next; });
      setNotice('La declaración se guardó como autoinformada.');
      await queryClient.invalidateQueries({ queryKey: decisionRecordKey });
    },
    onError: caught => { setOperationError(errorText(caught)); queryClient.invalidateQueries({ queryKey: keys.plans }).catch(() => undefined); },
  });
  const checkReadiness = useMutation({
    mutationFn: (plan: OperationPlan) => operationsApi.readiness(scope, plan),
    onSuccess: result => {
      setOperationError(null);
      setReadiness(current => ({ ...current, [result.planId]: result }));
    },
    onError: caught => { setOperationError(errorText(caught)); queryClient.invalidateQueries({ queryKey: keys.plans }).catch(() => undefined); },
  });

  function updatePlanCache(plan: OperationPlan) {
    queryClient.setQueryData<OperationPlan[]>(keys.plans, current => current?.map(item => item.id === plan.id ? plan : item));
    setReadiness(current => { const next = { ...current }; delete next[plan.id]; return next; });
    setOperationError(null);
  }

  function saveMonitoring(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const isSnapshot = basis.startsWith('snapshot:');
    const isRepository = basis.startsWith('repository:');
    configure.mutate({
      enabled,
      intervalSeconds,
      sourceSnapshotId: enabled && isSnapshot ? basis.slice('snapshot:'.length) : null,
      repositoryKey: enabled && isRepository ? basis.slice('repository:'.length) : null,
      targetId: enabled ? targetId || null : null,
      providers: enabled ? providers : [],
    });
  }

  function changeProvider(provider: 'cloudflare' | 'railway', checked: boolean) {
    setProviders(current => checked ? [...new Set([...current, provider])] : current.filter(item => item !== provider));
  }

  const availableBasis = [
    ...sources.map(source => `snapshot:${source.id}`),
    ...(repositories.data ?? []).map(repository => `repository:${repository.key}`),
  ];
  const currentConfig = coverage.data?.config;
  const selectedBasisIsMissing = basis !== '' && !availableBasis.includes(basis);
  const targetIsCurrent = verifiedTargets.some(target => target.id === targetId);
  const basisSelected = (basis !== '' && !selectedBasisIsMissing) || targetIsCurrent || providers.length > 0;

  return <div className="customer-operations">
    {operationError && <div className="customer-error" role="alert"><strong>No se pudo completar la operación</strong><p>{operationError}</p></div>}
    {notice && <div className="customer-success" role="status"><span>{notice}</span><button className="customer-icon-button" aria-label="Descartar aviso" onClick={() => setNotice(null)}><XIcon size={14} aria-hidden="true" /></button></div>}

    <section className="customer-card customer-panel customer-ops-card" aria-labelledby="monitoring-title">
      <div className="customer-card-heading"><div><h2 id="monitoring-title">Revisiones periódicas</h2></div>
        {coverage.data && <span className={`customer-status ${coverageTone(coverage.data)}`}>{coverage.data.status === 'active' && coverage.data.observations.stale > 0 ? 'Hay evidencia atrasada' : statusNames[coverage.data.status]}</span>}
      </div>
      <p className="customer-card-copy">Las revisiones son periódicas, no en tiempo real.</p>
      {coverage.isPending ? <div className="customer-loading" role="status"><span className="customer-spinner" />Cargando el estado de vigilancia…</div>
        : coverage.error ? <div className="customer-inline-error" role="alert">{errorText(coverage.error)} <button className="customer-link-button" type="button" onClick={() => { coverage.refetch().catch(() => undefined); }}>Reintentar</button></div>
          : coverage.data && <>
            <div className="customer-ops-summary" aria-live="polite">
              <div><span>Observaciones vigentes</span><strong>{coverage.data.observations.fresh}</strong></div>
              <div><span>Observaciones atrasadas</span><strong>{coverage.data.observations.stale}</strong></div>
              <div><span>Fuentes configuradas</span><strong className="customer-ops-summary-text">{coverage.data.scopeCurrent ? 'Vigentes' : 'Por actualizar'}</strong></div>
            </div>
            {coverage.data.lastRun && <div className="customer-ops-last-run"><strong>Última ejecución</strong><span>{coverage.data.lastRun.status === 'completed' ? 'Completada' : coverage.data.lastRun.status === 'running' ? 'En curso' : coverage.data.lastRun.status === 'degraded' ? 'Incompleta' : 'Cancelada'} · {formatDate(coverage.data.lastRun.startedAt)}</span>{coverage.data.lastRun.reason && <p>{coverage.data.lastRun.reason}</p>}</div>}
            {coverage.data.limitations.length > 0 && <details className="customer-ops-limitations"><summary>Límites de esta cobertura</summary><ul>{coverage.data.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}
          </>}
      <form className="customer-form customer-ops-form" onSubmit={saveMonitoring}>
        <label className="customer-checkbox customer-ops-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!canManage || configure.isPending || coverage.isPending || Boolean(coverage.error)} /><span>Activar revisiones periódicas para este proyecto</span></label>
        <label htmlFor="monitor-interval">Frecuencia</label>
        <select id="monitor-interval" value={intervalSeconds} onChange={event => setIntervalSeconds(Number(event.target.value))} disabled={!canManage || configure.isPending}>
          {intervals.map(hours => <option key={hours} value={hours * 3600}>{hours === 1 ? 'Cada hora' : `Cada ${hours} horas`}</option>)}
        </select>
        <label htmlFor="monitor-basis">Instantánea o repositorio <span>(elige una)</span></label>
        <select id="monitor-basis" value={basis} onChange={event => setBasis(event.target.value)} disabled={!canManage || configure.isPending}>
          <option value="">Sin fuente de código o repositorio</option>
          {selectedBasisIsMissing && <option value={basis} disabled>{currentConfig?.repositoryKey ? 'Repositorio configurado, ya no disponible' : 'Instantánea configurada, ya no disponible'}</option>}
          {sources.map(source => <option key={source.id} value={`snapshot:${source.id}`}>{source.revision} · instantánea de {formatDate(source.createdAt)}</option>)}
          {(repositories.data ?? []).map(repository => <option key={repository.key} value={`repository:${repository.key}`}>{repository.label} · repositorio configurado</option>)}
        </select>
        {repositories.isPending && <p className="customer-field-note">Cargando repositorios configurados…</p>}
        {repositories.error && <p className="customer-form-error" role="alert">No se pudo cargar el catálogo de repositorios configurados. Puedes continuar con otras fuentes.</p>}
        <label htmlFor="monitor-target">Origen HTTPS autorizado (opcional)</label>
        <select id="monitor-target" value={targetId} onChange={event => setTargetId(event.target.value)} disabled={!canManage || configure.isPending}>
          <option value="">No incluir origen HTTPS</option>
          {verifiedTargets.map(target => <option key={target.id} value={target.id}>{target.origin} · perfil {target.scanProfile ?? 'root'} · vence {target.expiresAt ? formatDate(target.expiresAt) : 'sin fecha'}</option>)}
        </select>
        {currentConfig?.targetId && !verifiedTargets.some(target => target.id === currentConfig.targetId) && <p className="customer-form-error" role="status">La autorización HTTPS anterior ya no está vigente. Elige una autorización verificada o limpia este alcance.</p>}
        <fieldset className="customer-ops-providers" disabled={!canManage || configure.isPending}>
          <legend>Estado del proveedor (opcional)</legend>
          {(['cloudflare', 'railway'] as const).map(provider => <label className="customer-checkbox" key={provider}><input type="checkbox" checked={providers.includes(provider)} onChange={event => changeProvider(provider, event.target.checked)} /><span>{providerNames[provider]}</span></label>)}
        </fieldset>
        {enabled && !basisSelected && <p className="customer-form-error" role="status">Elige una instantánea, repositorio, origen verificado o estado de proveedor antes de activar.</p>}
        {!canManage && <p className="customer-field-note">Sólo una persona propietaria u operadora puede cambiar la vigilancia.</p>}
        <button className="customer-button customer-button-primary" disabled={!canManage || configure.isPending || coverage.isPending || Boolean(coverage.error) || (enabled && !basisSelected)}>
          {configure.isPending ? 'Guardando…' : enabled ? 'Guardar vigilancia' : currentConfig?.enabled ? 'Desactivar y limpiar alcance' : 'Guardar configuración'}
        </button>
      </form>
    </section>

    <section className="customer-card customer-panel customer-ops-card" aria-labelledby="alerts-title">
      <div className="customer-card-heading"><div><h2 id="alerts-title">Alertas de evaluación</h2></div>{alerts.data && <span className="customer-status customer-status-muted">{alerts.data.length} registros</span>}</div>
      {alerts.isPending ? <div className="customer-loading" role="status"><span className="customer-spinner" />Cargando alertas…</div>
        : alerts.error ? <div className="customer-inline-error" role="alert">{errorText(alerts.error)} <button className="customer-link-button" type="button" onClick={() => { alerts.refetch().catch(() => undefined); }}>Reintentar</button></div>
          : alerts.data?.length === 0 ? <div className="customer-empty-inline">Todavía no hay alertas para este proyecto. La cobertura seleccionada aparecerá aquí cuando genere observaciones.</div>
            : <div className="customer-ops-alert-list">{alerts.data?.map(alert => <AlertCard key={alert.id} userId={userId} organizationId={organizationId} alert={alert} canManage={canManage} busy={updateAlert.isPending || createPlan.isPending} resolution={resolutionDrafts[alert.id] ?? ''}
              onResolutionChange={value => setResolutionDrafts(current => ({ ...current, [alert.id]: value }))}
              onAcknowledge={() => updateAlert.mutate({ alert, state: 'acknowledged' })}
              onResolve={() => updateAlert.mutate({ alert, state: 'resolved', resolution: resolutionDrafts[alert.id]?.trim() ?? '' })}
              onCreatePlan={kind => createPlan.mutate({ alert, kind })} />)}</div>}
    </section>

    {plans.data?.length === 0 && !plans.isPending && !plans.error ? null : <section className="customer-card customer-panel customer-ops-card" aria-labelledby="plans-title">
      <div className="customer-card-heading"><div><h2 id="plans-title">Guías de revisión</h2></div>{plans.data && <span className="customer-status customer-status-muted">{plans.data.length} guías</span>}</div>
      {plans.isPending ? <div className="customer-loading" role="status"><span className="customer-spinner" />Cargando guías…</div>
        : plans.error ? <div className="customer-inline-error" role="alert">{errorText(plans.error)} <button className="customer-link-button" type="button" onClick={() => { plans.refetch().catch(() => undefined); }}>Reintentar</button></div>
          : plans.data?.length === 0 ? <div className="customer-empty-inline">Las guías aparecerán a partir de observaciones.</div>
            : <div className="customer-ops-plan-list">{plans.data?.map(plan => <PlanCard key={plan.id} userId={userId} organizationId={organizationId} plan={plan} readiness={readiness[plan.id] ?? null} canManage={canManage} busy={preparePlan.isPending || attestStep.isPending || checkReadiness.isPending}
              stepDrafts={stepDrafts} onStepDraft={(key, value) => setStepDrafts(current => ({ ...current, [`${plan.id}:${key}`]: value }))}
              onPrepare={() => preparePlan.mutate(plan)}
              onAttest={(key, attestation) => attestStep.mutate({ plan, key, attestation })}
              onReadiness={() => checkReadiness.mutate(plan)} />)}</div>}
    </section>}

    <TelemetrySection userId={userId} scope={scope} canManage={canManage} />
  </div>;
}

function AlertCard({ userId, organizationId, alert, canManage, busy, resolution, onResolutionChange, onAcknowledge, onResolve, onCreatePlan }: {
  userId: string;
  organizationId: string;
  alert: OperationAlert;
  canManage: boolean;
  busy: boolean;
  resolution: string;
  onResolutionChange: (value: string) => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onCreatePlan: (kind: PlanKind) => void;
}) {
  const observation = alert.observation;
  const planKind = suggestedPlan(alert);
  const canCreatePlan = observation.fresh;
  const statusText = alert.state === 'open' ? 'Nueva' : alert.state === 'acknowledged' ? 'En revisión' : 'Resuelta por el equipo';
  const planLabel = planKind === 'investigate_capacity' && observation.metrics
    ? 'Preparar investigación de capacidad'
    : planKind === 'migration_readiness' ? 'Preparar revisión de migración' : 'Preparar guía basada en la alerta';

  return <article className="customer-ops-alert">
    <div className="customer-ops-alert-heading"><div><h3>{observation.summary}</h3><span className="customer-eyebrow">{observationNames[observation.kind]}</span></div><div className="customer-ops-badges"><span className={`customer-severity customer-severity-${observation.severity === 'info' ? 'informational' : observation.severity}`}>{severityNames[observation.severity]}</span><span className={`customer-status ${observation.fresh ? 'customer-ops-status-ready' : 'customer-ops-status-warning'}`}>{observation.fresh ? 'Evidencia vigente' : 'Evidencia atrasada'}</span><span className="customer-status customer-status-muted">{statusText}</span></div></div>
    <div className="customer-ops-meta"><span>Confianza: {confidenceNames[observation.confidence]}</span><span>Observada: {formatDate(observation.observedAt)}</span><span>Vence: {formatDate(observation.expiresAt)}</span>{observation.incidentId && <span>Incidente: {observation.incidentId}</span>}</div>
    {observation.metrics && <div className="customer-ops-metrics"><span>{observation.metrics.requestCount} solicitudes</span><span>{observation.metrics.errorCount} errores</span><span>Latencia p95 {observation.metrics.latencyP95Ms === null ? 'sin medir' : `${observation.metrics.latencyP95Ms} ms`}</span><span>Uso de capacidad {observation.metrics.capacityUtilization === null ? 'sin medir' : `${Math.round(observation.metrics.capacityUtilization * 100)}%`}</span></div>}
    {observation.upstreamImpact !== 'not_applicable' && <p className="customer-field-note">Impacto de proveedor: {observation.upstreamImpact === 'observed' ? 'observado' : 'no verificado'}.</p>}
    <details className="customer-ops-evidence"><summary>Evidencia y procedencia ({observation.evidence.length})</summary>
      <ul>{observation.evidence.map((item, index) => <li key={`${item.source}:${item.reference}:${index}`}><strong>{evidenceSourceNames[item.source]}</strong><span>Referencia: {item.reference}</span><span>{item.adapter} · versión {item.adapterVersion}</span><span>Recopilada: {formatDate(item.collectedAt)}</span><code>SHA-256: {item.checksum}</code></li>)}</ul>
    </details>
    {alert.resolution && <p className="customer-ops-resolution"><strong>Nota del equipo:</strong> {alert.resolution}</p>}
    {alert.state !== 'resolved' && <InvestigationActionButton organizationId={organizationId} applicationId={observation.applicationId} subject={{ kind: 'alert', subjectId: alert.id }} canManage={canManage && observation.fresh && ['medium', 'high', 'critical'].includes(observation.severity)} />}
    {alert.state !== 'resolved' && <div className="customer-ops-alert-actions">
      {alert.state === 'open' && <button className="customer-button" type="button" disabled={!canManage || busy} onClick={onAcknowledge}>Reconocer alerta</button>}
      <label htmlFor={`resolution-${alert.id}`}>Nota para resolver</label>
      <input id={`resolution-${alert.id}`} value={resolution} maxLength={2000} onChange={event => onResolutionChange(event.target.value)} disabled={!canManage || busy} placeholder="Describe la decisión o seguimiento" />
      <button className="customer-button" type="button" disabled={!canManage || busy || !resolution.trim()} onClick={onResolve}>Resolver alerta</button>
      <button className="customer-button customer-button-primary" type="button" disabled={!canManage || busy || !canCreatePlan} title={!canCreatePlan ? 'Actualiza la evidencia antes de crear una guía.' : undefined} onClick={() => onCreatePlan(planKind)}>{planLabel}</button>
    </div>}
    <DecisionRecordHistory userId={userId} organizationId={organizationId} filter={{ subjectType: 'alert', subjectId: alert.id }} compact />
  </article>;
}

function PlanCard({ userId, organizationId, plan, readiness, canManage, busy, stepDrafts, onStepDraft, onPrepare, onAttest, onReadiness }: {
  userId: string;
  organizationId: string;
  plan: OperationPlan;
  readiness: OperationReadiness | null;
  canManage: boolean;
  busy: boolean;
  stepDrafts: Record<string, string>;
  onStepDraft: (key: PlanStepKey, value: string) => void;
  onPrepare: () => void;
  onAttest: (key: PlanStepKey, attestation: string) => void;
  onReadiness: () => void;
}) {
  const currentReadiness = readiness !== null && readiness.revision === plan.revision && readiness.actionHash === plan.actionHash ? readiness : null;
  return <article className="customer-ops-plan">
    <div className="customer-ops-plan-heading"><div><h3>{plan.state === 'draft' ? 'Borrador consultivo' : 'Preparación solicitada'}</h3><span className="customer-eyebrow">{planNames[plan.kind]}</span><p>Revisión {plan.revision} · actualizada {formatDate(plan.updatedAt)}</p></div></div>
    <p className="customer-ops-meta">Observaciones de origen: {plan.observationIds.join(', ')}</p>
    <ol className="customer-ops-steps">{plan.steps.map(step => {
      const key = step.key;
      const draftKey = `${plan.id}:${key}`;
      const draft = stepDrafts[draftKey] ?? '';
      return <li key={key}>
        <div><strong>{stepNames[key]}</strong><span className={step.state === 'self_reported' ? 'customer-ops-step-self' : 'customer-ops-step-todo'}>{step.state === 'self_reported' ? 'Declarado por el equipo' : 'Pendiente'}</span><p>{step.instruction}</p></div>
        {step.state === 'self_reported' ? <blockquote>{step.attestation}</blockquote> : <form onSubmit={event => { event.preventDefault(); onAttest(key, draft.trim()); }}>
          <label htmlFor={`attestation-${plan.id}-${key}`}>Tu declaración</label>
          <textarea id={`attestation-${plan.id}-${key}`} value={draft} maxLength={2000} onChange={event => onStepDraft(key, event.target.value)} disabled={!canManage || busy} placeholder="Anota qué revisaste o qué falta por hacer" />
          <button className="customer-button customer-button-small" type="submit" disabled={!canManage || busy || !draft.trim()}>Guardar como autoinformado</button>
        </form>}
      </li>;
    })}</ol>
    {plan.limitations.length > 0 && <details className="customer-ops-limitations"><summary>Límites de esta guía</summary><ul>{plan.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}
    <div className="customer-ops-plan-actions">
      {plan.state === 'draft' && <button className="customer-button" type="button" disabled={!canManage || busy} onClick={onPrepare}>Solicitar preparación consultiva</button>}
      <button className="customer-button" type="button" disabled={busy} onClick={onReadiness}>Revisar requisitos de preparación</button>
    </div>
    {currentReadiness && <div className="customer-ops-readiness" role="status"><strong>Requisitos pendientes</strong><ul>{currentReadiness.requirements.map(item => <li key={item}>{item}</li>)}</ul></div>}
    <DecisionRecordHistory userId={userId} organizationId={organizationId} filter={{ subjectType: 'plan', subjectId: plan.id }} compact />
  </article>;
}

function TelemetrySection({ userId, scope, canManage }: { userId: string; scope: OperationsScope; canManage: boolean }) {
  const queryClient = useQueryClient();
  const telemetryKey = ['customer-data', userId, 'telemetry', scope.organizationId, scope.applicationId] as const;
  const integrations = useQuery({ queryKey: telemetryKey, queryFn: () => operationsApi.telemetry(scope), retry: false, refetchInterval: 10_000 });
  const [now, setNow] = useState<number | null>(null);
  const [signingKey, setSigningKey] = useState<string | null>(null);
  const [createdIntegrationId, setCreatedIntegrationId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const disconnect = useMutation({
    mutationFn: (integrationId: string) => operationsApi.disableTelemetry(scope, integrationId),
    onSuccess: async () => {
      setSigningKey(null);
      setCreatedIntegrationId(null);
      setError(null);
      setNotice('La integración quedó desactivada.');
      await queryClient.invalidateQueries({ queryKey: telemetryKey });
    },
    onError: caught => setError(errorText(caught)),
  });

  const activeIntegrations = integrations.data?.filter(item => item.status === 'active') ?? [];
  async function connectIntegration() {
    setConnecting(true);
    setError(null);
    try {
      const latest = await integrations.refetch();
      if (latest.error) throw latest.error;
      const hasActiveIntegration = latest.data?.some(integration => integration.status === 'active') ?? false;
      if (hasActiveIntegration && !window.confirm('Crear otra clave rotará la integración activa. La clave anterior dejará de servir. ¿Quieres continuar?')) return;
      const connection = await operationsApi.connectTelemetry(scope);
      setSigningKey(connection.signingKey);
      setCreatedIntegrationId(connection.integration.id);
      setCopyState('idle');
      setNotice('Se creó una nueva clave de firma. Sólo se mostrará esta vez.');
      await queryClient.invalidateQueries({ queryKey: telemetryKey });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setConnecting(false);
    }
  }
  async function copySigningKey() {
    if (!signingKey) return;
    try {
      await navigator.clipboard.writeText(signingKey);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return <section className="customer-card customer-panel customer-ops-card" aria-labelledby="telemetry-title">
    <div className="customer-card-heading"><div><h2 id="telemetry-title">Telemetría firmada</h2></div>
      {activeIntegrations.length > 0 && <span className="customer-status customer-ops-status-muted">{activeIntegrations.length} integración(es)</span>}
    </div>
    <p className="customer-card-copy">La vigencia requiere un evento recibido en los últimos cinco minutos.</p>
    {error && <div className="customer-inline-error" role="alert">{error}</div>}
    {notice && <div className="customer-success" role="status"><span>{notice}</span><button className="customer-icon-button" aria-label="Descartar aviso" onClick={() => setNotice(null)}><XIcon size={14} aria-hidden="true" /></button></div>}
    {integrations.isPending ? <div className="customer-loading" role="status"><span className="customer-spinner" />Cargando integraciones…</div>
      : integrations.error ? <div className="customer-inline-error" role="alert">{errorText(integrations.error)} <button className="customer-link-button" type="button" onClick={() => { integrations.refetch().catch(() => undefined); }}>Reintentar</button></div>
        : integrations.data?.length === 0 ? <div className="customer-empty-inline">No hay una integración configurada para este proyecto.</div>
          : <div className="customer-ops-integrations">{integrations.data?.map(integration => {
            const lastEventTime = integration.lastEventAt ? Date.parse(integration.lastEventAt) : null;
            const fresh = now !== null && integration.status === 'active' && lastEventTime !== null && lastEventTime <= now && now - lastEventTime < 5 * 60_000;
            return <article className="customer-ops-integration" key={integration.id}>
              <div><strong>Integración {integration.id}</strong><span className={`customer-status ${fresh ? 'customer-ops-status-ready' : integration.status === 'disabled' ? 'customer-ops-status-muted' : 'customer-ops-status-warning'}`}>{fresh ? 'Activa · evento reciente' : integration.status === 'disabled' ? 'Desactivada' : 'Activa · sin evento reciente'}</span></div>
              <p>{integration.lastEventAt ? `Último evento: ${formatDate(integration.lastEventAt)}` : 'Todavía no se ha recibido un evento.'}</p>
              {canManage && integration.status === 'active' && <button className="customer-link-button customer-danger-link" type="button" disabled={disconnect.isPending} onClick={() => { if (window.confirm('¿Desactivar esta integración? Dejará de aceptar eventos con su clave actual.')) disconnect.mutate(integration.id); }}>Desactivar integración</button>}
            </article>;
          })}</div>}
    {signingKey && <div className="customer-ops-secret" role="status"><div><strong>Clave nueva · sólo visible ahora</strong><p>Guárdala en un secreto o variable de entorno privada del servidor de tu proyecto. No la incluyas en código de navegador, registros ni repositorios.</p></div><code>{signingKey}</code><p>Identificador de integración: {createdIntegrationId}</p><div className="customer-ops-secret-actions"><button className="customer-button" type="button" onClick={copySigningKey}>{copyState === 'copied' ? 'Copiada' : 'Copiar clave'}</button><button className="customer-link-button" type="button" onClick={() => { setSigningKey(null); setCreatedIntegrationId(null); setCopyState('idle'); }}>Ocultar clave</button></div>{copyState === 'error' && <p className="customer-form-error" role="alert">No se pudo copiar. Selecciona la clave para copiarla manualmente.</p>}</div>}
    {canManage && <button className="customer-button customer-button-primary customer-ops-connect" type="button" disabled={connecting || integrations.isPending || Boolean(integrations.error)} onClick={connectIntegration}>{connecting ? 'Creando clave…' : activeIntegrations.length > 0 ? 'Rotar clave de firma' : 'Crear clave de firma'}</button>}
    <details className="customer-ops-sdk"><summary>Integrar eventos en Node.js</summary><p>Genera eventos en el servidor y envíalos con la clave privada de esta integración.</p><pre>{`import { httpRequestEvent, applicationErrorEvent, sendEventBatch } from '@gotchu/sdk';

const batch = { applicationId, events: [
  httpRequestEvent({ route: '/orders/:id', statusCode: 200, durationMs: 34 }),
  applicationErrorEvent('database'),
] };

await sendEventBatch({
  baseUrl, // URL de tu despliegue Gotchu
  integrationId, // identificador mostrado arriba
  secret: Buffer.from(signingKey, 'base64'), // cargar desde el entorno privado del servidor
  batch,
});`}</pre></details>
  </section>;
}
