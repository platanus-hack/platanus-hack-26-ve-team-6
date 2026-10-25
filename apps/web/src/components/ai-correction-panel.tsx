import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { investigationProviderCatalog, type AiCorrection } from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';
import { Button, buttonVariants } from './ui/button';

type Props = {
  organizationId: string;
  applicationId: string;
  reportId: string;
  findingId: string;
  expectedSourceDigest?: string | null;
  canManage: boolean;
};

const stateLabels: Record<AiCorrection['state'], string> = {
  queued: 'Corrección en cola', running: 'Preparando cambios de código', prepared: 'Cambios privados preparados · sin validar',
  failed: 'No se pudo preparar la corrección', cancelled: 'Corrección cancelada', reconciliation_required: 'Corrección pendiente de conciliación',
};
const active = (correction: AiCorrection) => correction.state === 'queued' || correction.state === 'running';

function errorText(error: unknown) {
  if (!(error instanceof CustomerApiError)) return 'No se pudo completar la operación. Inténtalo de nuevo.';
  const messages: Record<string, string> = {
    repository_link_ambiguous: 'La PR requiere un único repositorio vinculado y verificado. La propuesta privada sigue disponible.',
    repository_link_unavailable: 'Vincula un repositorio verificado en Fuentes antes de preparar una PR.',
    source_not_repository_bound: 'Esta instantánea no está vinculada a un repositorio y commit verificados. Puedes revisar el cambio privado, pero la PR está bloqueada.',
    investigation_disabled: 'Configura un modelo y autoriza los detalles del hallazgo y los fragmentos de código en Modelos de IA.',
    budget_exhausted: 'No queda presupuesto suficiente en el espacio. Revisa los límites en Modelos de IA antes de reintentar.',
    assessment_changed: 'La fuente o la evidencia cambió. Recarga el informe antes de solicitar otra corrección.',
    candidate_unavailable: 'La instantánea privada ya no está disponible. No se puede preparar una PR con este candidato.',
  };
  return messages[error.code] ?? error.message;
}

/** Timeline entries resolve their own report; finding rows already have its pinned digest. */
export function AiCorrectionPanel(props: Props) {
  const { organizationId, applicationId, reportId, findingId, expectedSourceDigest } = props;
  const report = useQuery({
    queryKey: ['customer-data', organizationId, applicationId, 'ai-correction-report', reportId],
    queryFn: () => customerApi.report(organizationId, applicationId, reportId),
    enabled: expectedSourceDigest === undefined, retry: false, staleTime: Infinity,
  });
  if (expectedSourceDigest === undefined && report.isPending) return <p role="status">Cargando la fuente del hallazgo…</p>;
  if (expectedSourceDigest === undefined && report.error) return <div role="alert"><p>{errorText(report.error)}</p><Button variant="outline" size="sm" onClick={() => { void report.refetch(); }}>Reintentar carga de la fuente</Button></div>;
  const digest = expectedSourceDigest === undefined
    ? report.data?.internal?.findings.some(finding => finding.id === findingId) ? report.data.subject.sourceDigest : null
    : expectedSourceDigest;
  if (!digest) return <p className="customer-field-note">La corrección con IA requiere un hallazgo de código con una instantánea de fuente disponible.</p>;
  return <CorrectionForSource key={`${organizationId}:${applicationId}:${reportId}:${findingId}:${digest}`} {...props} sourceDigest={digest} />;
}

function CorrectionForSource({ organizationId, applicationId, reportId, findingId, sourceDigest, canManage }: Props & { sourceDigest: string }) {
  const client = useQueryClient();
  const key = ['customer-data', organizationId, applicationId, 'ai-corrections', reportId] as const;
  const modelKey = ['customer-data', organizationId, 'investigation-model'] as const;
  const settings = useQuery({ queryKey: modelKey, queryFn: () => customerApi.investigationModel(organizationId), retry: false, staleTime: 5_000 });
  const corrections = useQuery({
    queryKey: key, queryFn: () => customerApi.aiCorrections(organizationId, applicationId, reportId), retry: false, staleTime: 5_000,
    refetchInterval: query => query.state.data?.some(item => item.findingId === findingId && item.sourceDigest === sourceDigest && active(item)) ? 5_000 : false,
  });
  const [confirming, setConfirming] = useState(false);
  const [authorizedContext, setAuthorizedContext] = useState<string | null>(null);
  const model = settings.data;
  const enabled = model?.status === 'ready' && model.apiKeyConfigured && model.consentToExternalProcessing
    && model.dataScopes.includes('finding_details') && model.dataScopes.includes('source_excerpts');
  const consentContext = JSON.stringify([sourceDigest, model?.providerPresetId, model?.modelId, model?.endpoint, model?.dataScopes, model?.organizationBudgetCents, model?.organizationTokenBudget, model?.inputPriceMicroUsdPerMillionTokens, model?.outputPriceMicroUsdPerMillionTokens]);
  const providerName = investigationProviderCatalog.find(provider => provider.id === model?.providerPresetId)?.displayName ?? model?.provider ?? 'proveedor configurado';
  const saved = (corrections.data ?? []).filter(item => item.organizationId === organizationId && item.applicationId === applicationId && item.reportId === reportId && item.findingId === findingId && item.sourceDigest === sourceDigest)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const current = saved[0];
  const existing = saved.some(item => active(item) || item.state === 'prepared' || item.state === 'reconciliation_required');

  async function saveResult(value: AiCorrection) {
    // A list request started before this mutation must not replace its newer saved state.
    await client.cancelQueries({ queryKey: key });
    client.setQueryData<AiCorrection[]>(key, previous => [value, ...(previous ?? []).filter(item => item.id !== value.id)].slice(0, 50));
    await client.invalidateQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: modelKey });
  }
  const prepare = useMutation({
    mutationFn: () => customerApi.prepareAiCorrection({ organizationId, applicationId, reportId, request: { findingId, expectedSourceDigest: sourceDigest, authorized: true } }),
    retry: false,
    onSuccess: async value => { setConfirming(false); setAuthorizedContext(null); await saveResult(value); },
    onError: () => client.invalidateQueries({ queryKey: key }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => customerApi.cancelAiCorrection(organizationId, applicationId, reportId, id), retry: false, onSuccess: saveResult,
  });
  const canPrepare = canManage && enabled && !settings.error && !corrections.error && corrections.isSuccess && !existing && !prepare.isPending;
  const modelsLink = `/w/${organizationId}/modelos`;

  return <section className="customer-investigation-suggestion customer-ai-correction" aria-label="Corrección de código con IA">
    {settings.isPending && <p role="status">Cargando el modelo y sus permisos…</p>}
    {corrections.isPending && <p role="status">Cargando correcciones guardadas…</p>}
    {corrections.error && <div role="alert"><p>No se pudo actualizar el estado guardado: {errorText(corrections.error)}</p><Button variant="outline" size="sm" onClick={() => { void corrections.refetch(); }}>Reintentar carga de correcciones</Button></div>}
    {settings.error && <p role="alert">No se pudo cargar el modelo: {errorText(settings.error)}</p>}
    {!existing && !confirming && <div className="customer-investigation-action">
      <Button variant="outline" size="sm" disabled={!canPrepare} onClick={() => { prepare.reset(); setAuthorizedContext(null); setConfirming(true); }}>{current?.state === 'failed' || current?.state === 'cancelled' ? 'Reintentar corrección con IA' : 'Corregir con IA'}</Button>
      {!enabled && !settings.isPending && <a href={modelsLink}>Configura el modelo y autoriza hallazgos y código en Modelos de IA</a>}
      {!canManage && <small>Solo una persona propietaria u operadora puede solicitar cambios privados.</small>}
    </div>}
    {confirming && !existing && <form className="customer-form" onSubmit={event => {
      event.preventDefault();
      if (canPrepare && authorizedContext === consentContext) prepare.mutate();
    }}>
      <p>Se enviarán detalles del hallazgo y hasta 4 archivos de código acotados de esta instantánea a <strong>{providerName} · {model?.modelId}</strong>. La preparación consume presupuesto y tokens del espacio.</p>
      <p>La IA preparará cambios reales en una instantánea privada. El código no se ejecutará ni se escribirá en el repositorio. Una PR requiere validación independiente, aprobación humana exacta con segundo factor y un ejecutor independiente habilitado.</p>
      <p className="customer-field-note">Fuente fijada: <code>{sourceDigest}</code></p>
      <label className="customer-checkbox"><input type="checkbox" required checked={authorizedContext === consentContext} disabled={!canPrepare} onChange={event => setAuthorizedContext(event.target.checked ? consentContext : null)} /><span>Autorizo compartir estos archivos con el proveedor seleccionado y consumir el presupuesto para preparar cambios privados.</span></label>
      <div className="customer-investigation-action"><Button type="submit" size="sm" disabled={!canPrepare || authorizedContext !== consentContext}>{prepare.isPending ? 'Solicitando corrección…' : 'Confirmar preparación privada'}</Button><Button type="button" variant="outline" size="sm" disabled={prepare.isPending} onClick={() => { setConfirming(false); setAuthorizedContext(null); prepare.reset(); }}>Volver</Button></div>
      {!enabled && <a href={modelsLink}>Revisar modelo y consentimiento</a>}
    </form>}
    {prepare.error && <p className="customer-form-error" role="alert">{errorText(prepare.error)} <a href={modelsLink}>Revisar modelo y presupuesto</a></p>}
    {saved.length > 0 && <ol className="customer-ai-corrections">{saved.map(item => <li key={item.id}>
      <p role="status"><strong>{stateLabels[item.state]}</strong> · {new Date(item.createdAt).toLocaleString('es')}</p>
      {item.summary && <p>{item.summary}</p>}
      {item.reasonCode && <p>Motivo registrado: <code>{item.reasonCode}</code></p>}
      {active(item) && <><p>El trabajo guardado continuará aunque cierres esta página.</p>{canManage && <Button variant="outline" size="sm" disabled={cancel.isPending || cancel.data?.id === item.id} onClick={() => cancel.mutate(item.id)}>{cancel.isPending && cancel.variables === item.id ? 'Solicitando cancelación…' : 'Cancelar preparación'}</Button>}{cancel.data?.id === item.id && <p role="status">Cancelación solicitada; esperando el estado final guardado.</p>}</>}
      {item.state === 'cancelled' && <p>La preparación se canceló. Puedes autorizar un nuevo intento.</p>}
      {item.state === 'failed' && <p>El intento falló. Revisa el motivo antes de autorizar un nuevo intento.</p>}
      {item.state === 'reconciliation_required' && <p>El resultado o el uso del proveedor necesita revisión. La preparación no se reintentará automáticamente.</p>}
      {cancel.error && cancel.variables === item.id && <p className="customer-form-error" role="alert">{errorText(cancel.error)}</p>}
      {item.diff.map(file => <details className="customer-evidence" key={file.path}><summary>Ver cambios en {file.path}</summary><h4>Antes</h4><pre tabIndex={0} role="region" aria-label={`Antes: ${file.path}`}>{file.before}</pre><h4>Después</h4><pre tabIndex={0} role="region" aria-label={`Después: ${file.path}`}>{file.after}</pre></details>)}
      {(item.state === 'prepared' || item.diff.length > 0) && <>
        <SavedExplanation title="Qué cambiaría" items={item.implications} empty="El resultado guardado no detalló las implicaciones." />
        <SavedExplanation title="Riesgos" items={item.risks} empty="El resultado guardado no evaluó posibles efectos secundarios." />
        <SavedExplanation title="Plan de validación" items={item.validationPlan} empty="Falta definir la validación independiente." />
        <p>Este diff no demuestra que el código funcione ni que el hallazgo esté resuelto. Las pruebas de comportamiento siguen sin verificar.</p>
        {item.patchHash && <p className="customer-field-note">SHA-256 del cambio: <code>{item.patchHash}</code></p>}
      </>}
      {item.state === 'prepared' && item.candidateSourceId && <CorrectionProposal key={item.candidateSourceId} organizationId={organizationId} applicationId={applicationId} candidateId={item.candidateSourceId} canManage={canManage} />}
      {item.state === 'prepared' && !item.candidateSourceId && <p>No hay una instantánea candidata disponible para preparar una PR. Hace falta revisar el resultado guardado.</p>}
    </li>)}</ol>}
  </section>;
}

function SavedExplanation({ title, items, empty }: { title: string; items: readonly string[]; empty: string }) {
  return <><h4>{title}</h4>{items.length > 0 ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{empty}</p>}</>;
}

function CorrectionProposal({ organizationId, applicationId, candidateId, canManage }: { organizationId: string; applicationId: string; candidateId: string; canManage: boolean }) {
  const client = useQueryClient();
  const proposal = useMutation({
    mutationFn: () => customerApi.proposeCorrectionAction({ organizationId, applicationId, candidateId }),
    retry: false,
    onSuccess: () => client.invalidateQueries({ queryKey: ['customer-data'] }),
  });
  const proposalId = proposal.data?.proposalId;
  const proposals = useQuery({
    queryKey: ['customer-data', organizationId, applicationId, 'ai-correction-proposals'],
    queryFn: () => customerApi.actionProposals(organizationId, applicationId), enabled: proposalId !== undefined, retry: false,
  });
  const savedProposal = proposals.data?.find(item => item.id === proposalId);
  const sourcesLink = `/w/${organizationId}/p/${applicationId}/fuentes#${proposal.data ? `action-${proposal.data.actionHash}` : 'action-approvals-title'}`;
  return <div>
    <p>La PR requiere un repositorio y commit verificados, validación independiente D05 en una VM, un ejecutor habilitado y aprobación exacta con segundo factor en Fuentes.</p>
    {!proposal.data && <Button variant="outline" size="sm" disabled={!canManage || proposal.isPending} onClick={() => proposal.mutate()}>{proposal.isPending ? 'Preparando propuesta de PR…' : 'Preparar propuesta de PR'}</Button>}
    {proposal.error && <p className="customer-form-error" role="alert">PR bloqueada: {errorText(proposal.error)}</p>}
    {proposal.data && <p role="status">Propuesta de PR guardada. Revisa sus requisitos y el cambio exacto antes de aprobar.</p>}
    {proposalId && proposals.isPending && <p role="status">Consultando requisitos guardados…</p>}
    {proposals.error && <div role="alert"><p>No se pudieron consultar los requisitos: {errorText(proposals.error)}</p><Button variant="outline" size="sm" onClick={() => { void proposals.refetch(); }}>Reintentar carga de requisitos</Button></div>}
    {savedProposal?.blockingReasons.length ? <><h4>Requisitos pendientes</h4><ul>{savedProposal.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></> : null}
    <a className={buttonVariants({ variant: 'link', size: 'sm' })} href={sourcesLink}>Fuentes · Propuestas de cambio</a>
  </div>;
}
