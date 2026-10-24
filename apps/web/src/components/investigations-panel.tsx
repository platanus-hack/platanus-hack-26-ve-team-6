import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  investigationDataScopeSchema,
  investigationModelSuggestions,
  type InvestigationDataScope,
  type InvestigationSubject,
} from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';

const scopeNames: Record<InvestigationDataScope, string> = {
  application_context: 'Contexto declarado de la aplicación',
  finding_details: 'Detalles de hallazgos e incidentes',
  source_excerpts: 'Fragmentos de código alrededor del hallazgo',
  assessment_diffs: 'Comparación entre evaluaciones',
  validation_results: 'Resultados de validación D05',
  triage_summaries: 'Resúmenes de triaje',
  runtime_summaries: 'Resumen de eventos y alertas',
};
const providerNames = { openai_compatible: 'OpenAI compatible', anthropic_messages: 'Anthropic Messages' } as const;
const modelKey = (organizationId: string) => ['customer-data', organizationId, 'investigation-model'] as const;
const runsKey = (organizationId: string, applicationId: string) => ['customer-data', organizationId, applicationId, 'investigations'] as const;

function errorText(error: unknown) {
  if (error instanceof CustomerApiError) {
    if (error.code === 'investigation_disabled') return 'Investigación deshabilitada. Configura un modelo y concede permiso para los datos que quieras compartir.';
    if (error.code === 'model_budget_below_usage') return 'El presupuesto no puede quedar por debajo del gasto o las reservas existentes.';
    return error.message;
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function InvestigationModelSettings({ organizationId, isOwner }: { organizationId: string; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: modelKey(organizationId), queryFn: () => customerApi.investigationModel(organizationId), retry: false });
  const [provider, setProvider] = useState<'openai_compatible' | 'anthropic_messages'>('openai_compatible');
  const [endpoint, setEndpoint] = useState(investigationModelSuggestions.openai_compatible.endpoint);
  const [modelId, setModelId] = useState(investigationModelSuggestions.openai_compatible.modelId);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [consent, setConsent] = useState(false);
  const [scopes, setScopes] = useState<InvestigationDataScope[]>([]);
  const [inputRate, setInputRate] = useState('0');
  const [outputRate, setOutputRate] = useState('0');
  const [budgetCents, setBudgetCents] = useState('100');
  const [tokenBudget, setTokenBudget] = useState('100000');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const value = settings.data;
    if (!value) return;
    const selectedProvider = value.provider ?? 'openai_compatible';
    setProvider(selectedProvider);
    setEndpoint(value.endpoint ?? investigationModelSuggestions[selectedProvider].endpoint);
    setModelId(value.modelId ?? investigationModelSuggestions[selectedProvider].modelId);
    setConsent(value.consentToExternalProcessing);
    setScopes(value.dataScopes);
    setInputRate(String(value.inputPriceMicroUsdPerMillionTokens));
    setOutputRate(String(value.outputPriceMicroUsdPerMillionTokens));
    setBudgetCents(String(value.organizationBudgetCents || 100));
    setTokenBudget(String(value.organizationTokenBudget || 100_000));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => customerApi.configureInvestigationModel(organizationId, {
      provider, endpoint: endpoint.trim(), modelId: modelId.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}),
      consentToExternalProcessing: consent, dataScopes: scopes,
      inputPriceMicroUsdPerMillionTokens: Number(inputRate), outputPriceMicroUsdPerMillionTokens: Number(outputRate),
      organizationBudgetCents: Number(budgetCents), organizationTokenBudget: Number(tokenBudget),
    }),
    onSuccess: value => {
      setApiKey(''); setClearApiKey(false); setNotice(value.status === 'ready' ? 'Investigación habilitada.' : 'Investigación deshabilitada.');
      void queryClient.invalidateQueries({ queryKey: modelKey(organizationId) });
      void queryClient.invalidateQueries({ queryKey: ['customer-data', organizationId] });
    },
  });
  const disable = useMutation({
    mutationFn: () => customerApi.disableInvestigationModel(organizationId),
    onSuccess: () => { setApiKey(''); setConsent(false); setScopes([]); setNotice('La investigación y la credencial guardada se deshabilitaron.'); void queryClient.invalidateQueries({ queryKey: modelKey(organizationId) }); },
  });

  if (settings.isPending) return <section className="customer-card"><p>Cargando configuración de investigación…</p></section>;
  const ready = settings.data?.status === 'ready';
  return <section className="customer-card customer-investigation-settings">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">INVESTIGACIÓN ASISTIDA</span><h2>Modelo y consentimiento</h2></div><span className={`customer-status ${ready ? 'customer-ops-status-ready' : 'customer-ops-status-warning'}`}>{ready ? 'Disponible' : 'Investigación deshabilitada'}</span></div>
    <p>La revisión determinista sigue disponible sin modelo. Al habilitarlo, Gotchu enviará al endpoint configurado sólo las categorías marcadas y los fragmentos redactados que correspondan.</p>
    {settings.error && <p className="customer-form-error" role="alert">{errorText(settings.error)}</p>}
    <label htmlFor="investigation-provider">Proveedor compatible</label>
    <select id="investigation-provider" value={provider} onChange={event => {
      const next = event.target.value as typeof provider;
      setProvider(next); setEndpoint(investigationModelSuggestions[next].endpoint); setModelId(investigationModelSuggestions[next].modelId);
    }} disabled={!isOwner || save.isPending}>
      <option value="openai_compatible">OpenAI compatible · servidores locales u hospedados</option>
      <option value="anthropic_messages">Anthropic Messages</option>
    </select>
    <label htmlFor="investigation-endpoint">Endpoint HTTPS o servidor local</label>
    <input id="investigation-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} maxLength={2048} disabled={!isOwner || save.isPending} />
    <label htmlFor="investigation-model-id">ID del modelo</label>
    <input id="investigation-model-id" value={modelId} onChange={event => setModelId(event.target.value)} maxLength={200} disabled={!isOwner || save.isPending} />
      <label htmlFor="investigation-api-key">Clave API <span>(se guarda sólo en el servidor y nunca se devuelve)</span></label>
    <input id="investigation-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={event => { setApiKey(event.target.value); if (event.target.value) setClearApiKey(false); }} maxLength={4096} disabled={!isOwner || save.isPending} placeholder={settings.data?.apiKeyConfigured ? 'Clave configurada · déjalo vacío para conservarla' : 'Opcional para servidores locales'} />
    {isOwner && settings.data?.apiKeyConfigured && <label className="customer-investigation-consent"><input type="checkbox" checked={clearApiKey} onChange={event => setClearApiKey(event.target.checked)} disabled={save.isPending} />Eliminar la clave guardada al guardar</label>}
    <fieldset disabled={!isOwner || save.isPending}>
      <legend>Datos que autorizas enviar al modelo</legend>
      {(investigationDataScopeSchema.options).map(scope => <label className="customer-investigation-consent" key={scope}>
        <input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(item => item !== scope))} />
        {scopeNames[scope]}
      </label>)}
    </fieldset>
    <label className="customer-investigation-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={!isOwner || save.isPending} />Autorizo el procesamiento externo de las categorías seleccionadas</label>
    <div className="customer-investigation-budget-grid">
      <label htmlFor="investigation-input-rate">Entrada · micro USD por millón de tokens<input id="investigation-input-rate" type="number" min="0" max="1000000000" step="1" value={inputRate} onChange={event => setInputRate(event.target.value)} disabled={!isOwner || save.isPending} /></label>
      <label htmlFor="investigation-output-rate">Salida · micro USD por millón de tokens<input id="investigation-output-rate" type="number" min="0" max="1000000000" step="1" value={outputRate} onChange={event => setOutputRate(event.target.value)} disabled={!isOwner || save.isPending} /></label>
      <label htmlFor="investigation-budget">Presupuesto del espacio · centavos<input id="investigation-budget" type="number" min="0" max="100000000" step="1" value={budgetCents} onChange={event => setBudgetCents(event.target.value)} disabled={!isOwner || save.isPending} /></label>
      <label htmlFor="investigation-token-budget">Presupuesto de tokens<input id="investigation-token-budget" type="number" min="0" max="100000000" step="1000" value={tokenBudget} onChange={event => setTokenBudget(event.target.value)} disabled={!isOwner || save.isPending} /></label>
    </div>
    {settings.data && <p className="customer-field-note">Uso: {settings.data.tokensSpent.toLocaleString('es')} tokens · ${(settings.data.spentMicroUsd / 1_000_000).toFixed(6)} USD gastados · ${(settings.data.reservedMicroUsd / 1_000_000).toFixed(6)} USD reservados.</p>}
    {(save.error || disable.error) && <p className="customer-form-error" role="alert">{errorText(save.error ?? disable.error)}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="customer-ops-alert-actions">
      <button className="customer-button customer-button-primary" type="button" disabled={!isOwner || save.isPending} onClick={() => { setNotice(null); save.mutate(); }}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</button>
      {isOwner && ready && <button className="customer-button" type="button" disabled={disable.isPending} onClick={() => disable.mutate()}>{disable.isPending ? 'Deshabilitando…' : 'Deshabilitar y eliminar clave'}</button>}
    </div>
    {!isOwner && <p className="customer-field-note">Sólo la persona propietaria puede cambiar el proveedor, los permisos y los presupuestos.</p>}
  </section>;
}

export function InvestigationActionButton({ organizationId, applicationId, subject, canManage }: {
  organizationId: string; applicationId: string; subject: InvestigationSubject; canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: modelKey(organizationId), queryFn: () => customerApi.investigationModel(organizationId), retry: false });
  const request = useMutation({
    mutationFn: () => customerApi.requestInvestigation(organizationId, applicationId, subject),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: runsKey(organizationId, applicationId) }); },
  });
  const requiredScope: InvestigationDataScope = subject.kind === 'finding' ? 'finding_details' : 'runtime_summaries';
  const enabled = settings.data?.status === 'ready' && settings.data.dataScopes.includes(requiredScope);
  return <div className="customer-investigation-action">
    <button className="customer-button customer-button-secondary" type="button" disabled={!canManage || !enabled || request.isPending} title={!enabled ? 'Investigación deshabilitada: revisa modelo, consentimiento y categorías autorizadas.' : undefined} onClick={() => request.mutate()}>{request.isPending ? 'Solicitando…' : 'Investigar'}</button>
    {!enabled && <small>Investigación deshabilitada</small>}
    {request.error && <small role="alert">{errorText(request.error)}</small>}
  </div>;
}

const statusNames = {
  pending: 'En cola', investigating: 'En investigación', investigated: 'Explicada · no verificada',
  inconclusive: 'Inconclusa', delayed: 'Detenida por límites', cancelled: 'Cancelada', reconciliation_required: 'Requiere conciliación',
} as const;

export function InvestigationsTimeline({ organizationId, applicationId, canManage }: { organizationId: string; applicationId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const key = runsKey(organizationId, applicationId);
  const runs = useQuery({ queryKey: key, queryFn: () => customerApi.investigations(organizationId, applicationId), retry: false, refetchInterval: 5_000 });
  const cancel = useMutation({ mutationFn: (jobId: string) => customerApi.cancelInvestigation(organizationId, applicationId, jobId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); } });
  const resume = useMutation({ mutationFn: (jobId: string) => customerApi.resumeInvestigation(organizationId, applicationId, jobId), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); } });
  return <section className="customer-card customer-investigation-timeline">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">INVESTIGACIONES</span><h2>Explicaciones y evidencias</h2></div></div>
    {runs.isPending ? <p>Cargando investigaciones…</p> : runs.error ? <p className="customer-form-error" role="alert">{errorText(runs.error)}</p> : runs.data?.length === 0 ? <p className="customer-empty-inline">Todavía no hay investigaciones para esta aplicación.</p> : <ol>
      {runs.data?.map(run => <li key={run.jobId}>
        <div className="customer-investigation-run-heading"><strong>{statusNames[run.status]}</strong><span>{new Date(run.createdAt).toLocaleString('es')}</span></div>
        <p>{run.summary ?? (run.status === 'reconciliation_required' ? 'El coste de una llamada quedó reservado porque el proveedor no confirmó su uso.' : 'La investigación está en curso o no produjo una explicación.')}</p>
        {run.assessment && <span className="customer-status customer-status-muted">Evaluación del modelo: {run.assessment === 'candidate_issue' ? 'indicio candidato' : run.assessment === 'no_issue_supported' ? 'sin indicio respaldado' : 'inconclusa'} · nunca equivale a un hallazgo verificado</span>}
        {run.citedEvidenceIds.length > 0 && <details><summary>Evidencia citada ({run.citedEvidenceIds.length})</summary><ul>{run.citedEvidenceIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>}
        {run.hypotheses.length > 0 && <details><summary>Hipótesis</summary><ul>{run.hypotheses.map((item, index) => <li key={`${run.jobId}:${index}`}>{item.statement}<br /><small>Evidencias: {item.evidenceIds.join(', ')}</small></li>)}</ul></details>}
        {run.candidateSuggestion && <div className="customer-report-callout"><strong>Sugerencia privada · requiere D05 y aprobación humana</strong><p>{run.candidateSuggestion.summary}</p>{run.candidateSuggestion.path && <code>{run.candidateSuggestion.path}</code>}<p className="customer-field-note">Evidencias: {run.candidateSuggestion.evidenceIds.join(', ')}</p></div>}
        <p className="customer-field-note">{run.tokensSpent.toLocaleString('es')} tokens · ${(run.costMicroUsd / 1_000_000).toFixed(6)} USD gastados · ${(run.reservedCostMicroUsd / 1_000_000).toFixed(6)} USD y {run.reservedTokens.toLocaleString('es')} tokens reservados.</p>
        {canManage && (run.state === 'queued' || run.state === 'running') && <button className="customer-button" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(run.jobId)}>Cancelar</button>}
        {canManage && (['delayed', 'inconclusive'].includes(run.status) || run.state === 'failed') && run.reservedCostMicroUsd === 0 && run.reservedTokens === 0 && <button className="customer-button" type="button" disabled={resume.isPending} onClick={() => resume.mutate(run.jobId)}>Reanudar</button>}
      </li>)}
    </ol>}
  </section>;
}
