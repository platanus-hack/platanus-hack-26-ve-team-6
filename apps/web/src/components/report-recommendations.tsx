import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CustomerApiError, customerApi } from './customer-client';
import type {
  RecipeAvailability,
  RecipeCoverage,
  RecipeRecommendation,
  ReportRecommendationsResponse,
} from '@gotchu/scenarios/contracts';

type Props = {
  userId: string;
  organizationId: string;
  applicationId: string;
  reportId: string;
  reportMode: 'internal' | 'external' | 'both';
  reportSourceSnapshotId: string | null;
  reportSourceDigest: string | null;
  findingTitles: ReadonlyMap<string, string>;
  canManage: boolean;
  archived: boolean;
  onQueued: (jobId: string) => void;
};

const availabilityLabels: Record<RecipeAvailability, string> = {
  candidate_patch: 'Propuesta privada disponible',
  guided_review: 'Requiere revisión guiada',
  integration_required: 'Requiere una integración',
};
const coverageLabels: Record<RecipeCoverage, string> = {
  inspected: 'Revisado',
  unknown: 'Sin comprobar',
  not_requested: 'No solicitado',
  unsupported: 'No disponible para este perfil',
  not_reported: 'Sin datos',
};
const severityLabels: Record<RecipeRecommendation['risk']['severity'], string> = {
  unknown: 'Sin evaluar', critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Información',
};
const confidenceLabels: Record<RecipeRecommendation['risk']['confidence'], string> = {
  observed: 'Observada', inferred: 'Indicada', uncertain: 'Sin comprobar',
};
const modeLabels = { internal: 'Código fuente', external: 'HTTPS autorizado', both: 'Código + HTTPS' } as const;

function recommendationError(error: unknown) {
  if (error instanceof CustomerApiError) {
    if (['source_not_found', 'source_snapshot_not_found', 'source_deleted', 'source_unavailable'].includes(error.code)) {
      return 'La instantánea de origen ya no está disponible. No se creó ningún cambio; comparte una instantánea autorizada nueva antes de volver a evaluar.';
    }
    return error.message;
  }
  if (error instanceof Error && error.name !== 'ZodError') return error.message;
  return 'No se pudieron cargar las recomendaciones. Inténtalo de nuevo.';
}

function scopeMatchesReport(data: ReportRecommendationsResponse, props: Props) {
  return data.scope.organizationId === props.organizationId
    && data.scope.applicationId === props.applicationId
    && data.scope.reportId === props.reportId
    && data.scope.mode === props.reportMode
    && data.scope.sourceSnapshotId === props.reportSourceSnapshotId
    && data.scope.sourceDigest === props.reportSourceDigest;
}

export function ReportRecommendations(props: Props) {
  const { userId, organizationId, applicationId, reportId, canManage, archived, onQueued } = props;
  const queryClient = useQueryClient();
  const [confirmingRecipe, setConfirmingRecipe] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const query = useQuery({
    queryKey: ['customer-data', userId, 'report-recommendations', organizationId, applicationId, reportId],
    queryFn: () => customerApi.reportRecommendations(organizationId, applicationId, reportId),
    retry: false,
  });
  const correction = useMutation({
    mutationKey: ['customer-data', userId, 'report-correction', organizationId, applicationId, reportId],
    mutationFn: ({ recipeId, findingId, expectedSourceDigest }: { recipeId: string; findingId: string; expectedSourceDigest: string }) => customerApi.prepareCorrection({
      organizationId,
      applicationId,
      reportId,
      request: { recipeId, findingId, expectedSourceDigest },
    }),
    onSuccess: prepared => {
      setConfirmingRecipe(null);
      setConfirmed(false);
      onQueued(prepared.jobId);
    },
  });
  const actionProposal = useMutation({
    mutationKey: ['customer-data', userId, 'action-proposal', organizationId, applicationId],
    mutationFn: (candidateId: string) => customerApi.proposeCorrectionAction({ organizationId, applicationId, candidateId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'action-proposals', organizationId, applicationId] }),
  });

  if (query.isPending) return <section className="customer-report-section customer-recommendations" aria-labelledby="recommendations-title"><div className="customer-section-heading"><div><span className="customer-eyebrow">ORIENTACIÓN</span><h3 id="recommendations-title">Opciones de corrección</h3></div></div><div className="customer-loading" role="status"><span className="customer-spinner" />Cargando recomendaciones…</div></section>;
  if (query.error) return <section className="customer-report-section customer-recommendations" aria-labelledby="recommendations-title"><div className="customer-section-heading"><div><span className="customer-eyebrow">ORIENTACIÓN</span><h3 id="recommendations-title">Opciones de corrección</h3></div></div><div className="customer-error" role="alert"><strong>No se pudieron cargar las opciones de este informe</strong><p>{recommendationError(query.error)}</p><button className="customer-link-button" type="button" onClick={() => { query.refetch().catch(() => undefined); }}>Reintentar</button></div></section>;
  if (!query.data || !scopeMatchesReport(query.data, props)) return <section className="customer-report-section customer-recommendations" aria-labelledby="recommendations-title"><div className="customer-section-heading"><div><span className="customer-eyebrow">ORIENTACIÓN</span><h3 id="recommendations-title">Opciones de corrección</h3></div></div><div className="customer-error" role="alert"><strong>El alcance de las opciones no coincide con este informe</strong><p>Actualiza el informe antes de preparar una propuesta.</p><button className="customer-link-button" type="button" onClick={() => { query.refetch().catch(() => undefined); }}>Actualizar opciones</button></div></section>;

  const data = query.data;
  const sourceAvailable = data.scope.sourceSnapshotId !== null && data.scope.sourceDigest !== null;
  const prepared = correction.data;
  return <section className="customer-report-section customer-recommendations" aria-labelledby="recommendations-title">
    <div className="customer-section-heading"><div><span className="customer-eyebrow">ORIENTACIÓN</span><h3 id="recommendations-title">Opciones de corrección</h3></div></div>
    <div className="customer-recommendations-intro">
      <p>Estas opciones se basan en este informe ({modeLabels[data.scope.mode]}) y su evidencia. Un aviso o hallazgo no demuestra por sí solo explotación ni garantiza que un cambio sea seguro.</p>
      <p>Al preparar una propuesta, Gotchu crea una instantánea corregida privada y solicita un análisis interno independiente. No modifica el repositorio, la fuente original ni producción. No se ejecutan pruebas de comportamiento.</p>
    </div>

    {correction.error && <div className="customer-error" role="alert"><strong>No se pudo preparar la propuesta</strong><p>{recommendationError(correction.error)}</p></div>}

    {prepared && <div className="customer-correction-result" role="status" aria-live="polite">
      <div><strong>Propuesta preparada en una instantánea privada</strong><p>El análisis interno independiente se puso en cola. Las pruebas de comportamiento no se ejecutaron; valida el cambio antes de considerar cualquier aplicación.</p></div>
      <ul>{prepared.changes.map(change => <li key={`${change.path}:${change.description}`}><code>{change.path}</code><p>{change.description}</p></li>)}</ul>
      <p className="customer-correction-hash">SHA-256 de la propuesta: <code>{prepared.patchHash}</code></p>
      {canManage && !archived && <div className="customer-recommendation-actions"><button className="customer-button" type="button" disabled={actionProposal.isPending} onClick={() => actionProposal.mutate(prepared.sourceId)}>{actionProposal.isPending ? 'Preparando…' : 'Preparar propuesta'}</button></div>}
      {actionProposal.error && <p className="customer-field-note" role="alert">No se pudo preparar la propuesta: {recommendationError(actionProposal.error)}</p>}
      {actionProposal.data && <p className="customer-field-note" role="status">La propuesta quedó registrada. Revisa sus límites y requisitos en «Propuestas de cambio».</p>}
      <a className="customer-link-button" href="#customer-active-job">Seguir el análisis independiente</a>
    </div>}

    {data.recommendations.length === 0
      ? <div className="customer-empty-inline">Este informe no tiene recomendaciones disponibles. Consulta la cobertura para distinguir lo revisado de lo desconocido o no solicitado.</div>
      : <div className="customer-recommendation-list">{data.recommendations.map(recommendation => <RecommendationCard
        key={`${recommendation.recipeId}:${recommendation.evidenceFindingIds[0]}`}
        recommendation={recommendation}
        findingTitles={props.findingTitles}
        sourceAvailable={sourceAvailable}
        canPrepare={canManage && !archived && sourceAvailable}
        archived={archived}
        readOnly={!canManage}
        busy={correction.isPending}
        confirming={confirmingRecipe === recommendation.recipeId}
        confirmed={confirmed}
        onBegin={() => { setConfirmingRecipe(recommendation.recipeId); setConfirmed(false); correction.reset(); }}
        onCancel={() => { setConfirmingRecipe(null); setConfirmed(false); correction.reset(); }}
        onConfirmChange={setConfirmed}
        onPrepare={() => {
          const expectedSourceDigest = recommendation.scope.sourceDigest;
          const findingId = recommendation.evidenceFindingIds[0];
          if (recommendation.availability !== 'candidate_patch' || expectedSourceDigest === null || findingId === undefined || !canManage || archived || !confirmed) return;
          correction.mutate({ recipeId: recommendation.recipeId, findingId, expectedSourceDigest });
        }}
      />)}</div>}

    {data.coverage.length > 0 && <details className="customer-recommendation-coverage"><summary>Cobertura de las recomendaciones ({data.coverage.length})</summary><ul>{data.coverage.map(item => <li key={`${item.recipeId}:${item.recipeVersion}`}><code>{item.recipeId}</code><span>{coverageLabels[item.coverage]}</span>{item.detectorAvailability === 'not_implemented' && <small>Detector no disponible</small>}</li>)}</ul></details>}
  </section>;
}

function RecommendationCard({
  recommendation, findingTitles, sourceAvailable, canPrepare, archived, readOnly, busy, confirming, confirmed, onBegin, onCancel, onConfirmChange, onPrepare,
}: {
  recommendation: RecipeRecommendation;
  findingTitles: ReadonlyMap<string, string>;
  sourceAvailable: boolean;
  canPrepare: boolean;
  archived: boolean;
  readOnly: boolean;
  busy: boolean;
  confirming: boolean;
  confirmed: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onConfirmChange: (checked: boolean) => void;
  onPrepare: () => void;
}) {
  const findingId = recommendation.evidenceFindingIds[0];
  const findingTitle = findingId === undefined ? 'Hallazgo del informe' : findingTitles.get(findingId) ?? 'Observación vinculada';
  return <article className="customer-recommendation-card">
    <div className="customer-recommendation-heading"><div><span className="customer-eyebrow">{availabilityLabels[recommendation.availability]}</span><h4>{recommendation.title}</h4></div><span className="customer-status customer-status-muted">Riesgo: {severityLabels[recommendation.risk.severity]}</span></div>
    <p>{recommendation.risk.summary}</p>
    <div className="customer-tag-row"><span className="customer-status customer-status-muted">Confianza: {confidenceLabels[recommendation.risk.confidence]}</span><span className="customer-status customer-status-muted">Explotabilidad: {recommendation.risk.exploitability === 'demonstrated_in_fixture' ? 'Demostrada en prueba controlada' : recommendation.risk.exploitability === 'not_demonstrated' ? 'No demostrada' : 'Desconocida'}</span></div>
    <p className="customer-recommendation-evidence">Basado en: <strong>{findingTitle}</strong></p>
    <h5>Opciones</h5><ul>{recommendation.options.map(option => <li key={option.id}><strong>{option.title}</strong><p>{option.detail}</p></li>)}</ul>
    {recommendation.requirements.length > 0 && <><h5>Requisitos para revisar el cambio</h5><ul>{recommendation.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></>}
    <p className="customer-recommendation-availability">{recommendation.availabilityReason}</p>

    {recommendation.availability === 'candidate_patch' && <>
      {!sourceAvailable && <p className="customer-field-note">Este informe no tiene una instantánea y huella de código disponibles para preparar una propuesta.</p>}
      {archived && <p className="customer-field-note">La aplicación está archivada; reactívala para preparar una propuesta.</p>}
      {readOnly && <p className="customer-field-note">Una persona propietaria u operadora puede preparar una propuesta.</p>}
      {!canPrepare && <button className="customer-button" type="button" disabled>Preparar propuesta privada</button>}
      {canPrepare && !confirming && <button className="customer-button" type="button" disabled={busy} onClick={onBegin}>Revisar y preparar propuesta</button>}
      {confirming && <form className="customer-recommendation-confirm" onSubmit={event => { event.preventDefault(); onPrepare(); }}>
        <h5>Confirma esta preparación</h5>
        <p>Receta <code>{recommendation.recipeId}</code> para <strong>{findingTitle}</strong>, con la huella de origen <code>{recommendation.scope.sourceDigest}</code>. Se creará solo una instantánea privada y se iniciará un análisis interno independiente. No se tocarán el repositorio, la fuente original ni producción, y no se ejecutarán pruebas de comportamiento.</p>
        <label><input autoFocus={confirming} type="checkbox" checked={confirmed} onChange={event => onConfirmChange(event.target.checked)} /> Confirmo preparar la propuesta «{recommendation.title}» para este hallazgo.</label>
        <div className="customer-recommendation-actions"><button className="customer-button customer-button-primary" type="submit" disabled={!confirmed || busy}>{busy ? 'Preparando…' : 'Confirmar y analizar en privado'}</button><button className="customer-link-button" type="button" disabled={busy} onClick={onCancel}>Cancelar</button></div>
      </form>}
    </>}
    {recommendation.availability === 'guided_review' && <p className="customer-field-note">No se ofrece un cambio automático. Sigue las opciones y requisitos de revisión con tu equipo.</p>}
    {recommendation.availability === 'integration_required' && <p className="customer-field-note">Esta opción depende de una integración disponible y no prepara cambios de código desde este informe.</p>}
  </article>;
}
