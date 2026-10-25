import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  investigationDataScopeSchema,
  investigationProviderCatalog,
  investigationProviderPresetIdSchema,
  type InvestigationDataScope,
  type InvestigationProviderPreset,
  type InvestigationProviderPresetId,
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
const modelKey = (organizationId: string) => ['customer-data', organizationId, 'investigation-model'] as const;
const runsKey = (organizationId: string, applicationId: string) => ['customer-data', organizationId, applicationId, 'investigations'] as const;
const probeReasons = {
  invalid_api_key: 'La clave API no es válida.', access_denied: 'La clave no tiene acceso al modelo solicitado.',
  cli_unavailable: 'El servidor de Gotchu no encuentra el CLI de este proveedor (claude o codex) o su versión no es compatible.',
  billing_or_credits: 'El proveedor rechazó la solicitud por facturación o créditos.',
  model_or_endpoint_not_found: 'No se encontró el modelo o endpoint.', rate_limited: 'El proveedor limitó la velocidad de solicitudes.',
  request_rejected: 'El proveedor rechazó la solicitud.', provider_unavailable: 'El proveedor no está disponible ahora.',
  network_error: 'No se pudo conectar con el proveedor.', invalid_response: 'El proveedor devolvió una respuesta no válida.',
  missing_usage: 'El proveedor no informó el uso de tokens; la reserva se conserva para conciliación.',
  model_output_invalid: 'El proveedor respondió, pero no respetó el formato de prueba.',
  unsafe_endpoint: 'El endpoint personalizado no es HTTPS público y seguro.',
  probe_unavailable: 'La prueba de conexión no está disponible.',
} as const;

type ProbeResult = Awaited<ReturnType<typeof customerApi.testInvestigationModel>>;

function probeText(result: ProbeResult, preset: InvestigationProviderPreset | undefined) {
  const reason = result.reason ?? 'probe_unavailable';
  if (reason === 'budget_exhausted') return `No queda presupuesto suficiente para una prueba de ${(preset?.probeTokenAllowance ?? 64).toLocaleString('es')} tokens.`;
  if (preset?.billing === 'subscription' && (reason === 'invalid_api_key' || reason === 'access_denied')) {
    return 'La suscripción rechazó la sesión: el token o el auth.json caducó, se revocó o no incluye este modelo. Genera uno nuevo y pégalo.';
  }
  if (preset?.billing === 'subscription' && reason === 'rate_limited') return 'Alcanzaste el límite de uso de tu suscripción. Espera a que se renueve o elige otro modelo.';
  return probeReasons[reason];
}

/** How to obtain each subscription login; the gateway host also needs the matching CLI installed. */
const subscriptionCredentialHelp = {
  claude_code: {
    label: 'Token de Claude Code',
    placeholder: 'sk-ant-oat01-…',
    steps: <>En una terminal con Claude Code instalado ejecuta <code>claude setup-token</code>, inicia sesión con tu cuenta Claude Pro o Max y pega el token que empieza por <code>sk-ant-oat01-</code>. Dura un año y puedes revocarlo desde claude.ai.</>,
  },
  codex: {
    label: 'auth.json de Codex',
    placeholder: '{"auth_mode":"chatgpt","tokens":{…}}',
    steps: <>Inicia una sesión sólo para Gotchu con <code>CODEX_HOME=~/.codex-gotchu codex login</code> (o <code>codex login --device-auth</code> en un servidor sin navegador) y pega el contenido de <code>~/.codex-gotchu/auth.json</code>. No reutilices la sesión de tu terminal: Codex renueva sus tokens y dos copias de la misma sesión se invalidan entre sí.</>,
  },
} as const;

function errorText(error: unknown) {
  if (error instanceof CustomerApiError) {
    if (error.code === 'model_credential_invalid') return 'La credencial no tiene el formato esperado. Pega el token de claude setup-token o el auth.json completo de codex login con una cuenta ChatGPT.';
    if (error.code === 'investigation_disabled') return 'Investigación deshabilitada. Configura un modelo y concede permiso para los datos que quieras compartir.';
    if (error.code === 'model_budget_below_usage') return 'El presupuesto no puede quedar por debajo del gasto o las reservas existentes.';
    return error.message;
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function InvestigationModelSettings({ organizationId, isOwner }: { organizationId: string; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: modelKey(organizationId), queryFn: () => customerApi.investigationModel(organizationId), retry: false });
  const [providerPresetId, setProviderPresetId] = useState<InvestigationProviderPresetId>('openai');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [modelId, setModelId] = useState<string>(investigationProviderCatalog[0].defaultModelId ?? '');
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
    const selectedPresetId = value.providerPresetId ?? 'openai';
    const selectedPreset = investigationProviderCatalog.find(preset => preset.id === selectedPresetId);
    setProviderPresetId(selectedPresetId);
    setCustomEndpoint(selectedPresetId === 'custom_openai_compatible' ? value.endpoint ?? '' : '');
    setModelId(value.modelId ?? selectedPreset?.defaultModelId ?? '');
    setConsent(value.consentToExternalProcessing);
    setScopes(value.dataScopes);
    setInputRate(String(value.inputPriceMicroUsdPerMillionTokens));
    setOutputRate(String(value.outputPriceMicroUsdPerMillionTokens));
    setBudgetCents(String(value.organizationBudgetCents || 100));
    setTokenBudget(String(value.organizationTokenBudget || 100_000));
  }, [settings.data]);

  const preset = investigationProviderCatalog.find(item => item.id === providerPresetId);
  const subscription = preset?.billing === 'subscription' ? subscriptionCredentialHelp[preset.id] : null;
  const save = useMutation({
    mutationFn: () => customerApi.configureInvestigationModel(organizationId, {
      providerPresetId, ...(providerPresetId === 'custom_openai_compatible' ? { customEndpoint: customEndpoint.trim() } : {}), modelId: modelId.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}),
      consentToExternalProcessing: consent, dataScopes: scopes,
      // Subscriptions are not billed per token; the server rejects any price for them.
      inputPriceMicroUsdPerMillionTokens: subscription ? 0 : Number(inputRate), outputPriceMicroUsdPerMillionTokens: subscription ? 0 : Number(outputRate),
      organizationBudgetCents: Number(budgetCents), organizationTokenBudget: Number(tokenBudget),
    }),
    onSuccess: value => {
      setApiKey(''); setClearApiKey(false); setNotice(value.status === 'ready' ? 'Investigación habilitada.' : 'Investigación deshabilitada.');
      void queryClient.invalidateQueries({ queryKey: modelKey(organizationId) });
      void queryClient.invalidateQueries({ queryKey: ['customer-data', organizationId] });
    },
  });
  const testConnection = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return customerApi.testInvestigationModel(organizationId);
    },
    onSuccess: result => {
      setNotice(result.status === 'succeeded'
        ? `Conexión correcta · ${result.inputTokens ?? 0} tokens de entrada y ${result.outputTokens ?? 0} de salida.`
        : probeText(result, preset));
      void queryClient.invalidateQueries({ queryKey: modelKey(organizationId) });
    },
  });
  const disable = useMutation({
    mutationFn: () => customerApi.disableInvestigationModel(organizationId),
    onSuccess: () => { setApiKey(''); setConsent(false); setScopes([]); setNotice('La investigación y la credencial guardada se deshabilitaron.'); void queryClient.invalidateQueries({ queryKey: modelKey(organizationId) }); },
  });

  if (settings.isPending) return <section className="customer-card customer-panel"><p>Cargando configuración de investigación…</p></section>;
  const ready = settings.data?.status === 'ready';
  return <section className="customer-card customer-panel customer-investigation-settings">
    <div className="customer-card-heading"><div><h2>Modelo y consentimiento</h2></div><span className={`customer-status ${ready ? 'customer-ops-status-ready' : 'customer-ops-status-warning'}`}>{ready ? 'Disponible' : 'Investigación deshabilitada'}</span></div>
    <p>La revisión determinista sigue disponible sin modelo. Al habilitarlo, Gotchu enviará sólo las categorías marcadas y los fragmentos redactados. La clave se guarda en el servidor y sólo se muestra si ya está configurada.</p>
    {settings.error && <p className="customer-form-error" role="alert">{errorText(settings.error)}</p>}
    <label htmlFor="investigation-provider">Proveedor</label>
    <select id="investigation-provider" value={providerPresetId} onChange={event => {
      const parsed = investigationProviderPresetIdSchema.safeParse(event.target.value);
      if (!parsed.success) return;
      const next = parsed.data;
      const nextPreset = investigationProviderCatalog.find(item => item.id === next);
      setProviderPresetId(next);
      setCustomEndpoint(next === 'custom_openai_compatible' ? customEndpoint : '');
      setModelId(nextPreset?.defaultModelId ?? '');
    }} disabled={!isOwner || save.isPending || testConnection.isPending}>
      <optgroup label="Con tu suscripción">
        {investigationProviderCatalog.filter(item => item.billing === 'subscription').map(item => <option value={item.id} key={item.id}>{item.displayName}</option>)}
      </optgroup>
      <optgroup label="Con clave API">
        {investigationProviderCatalog.filter(item => item.billing === 'per_token').map(item => <option value={item.id} key={item.id}>{item.displayName}</option>)}
      </optgroup>
    </select>
    {providerPresetId === 'custom_openai_compatible' && <>
      <label htmlFor="investigation-endpoint">Endpoint HTTPS personalizado</label>
      <input id="investigation-endpoint" type="url" value={customEndpoint} onChange={event => setCustomEndpoint(event.target.value)} maxLength={2048} disabled={!isOwner || save.isPending || testConnection.isPending} placeholder="https://api.example.com/v1" />
      <p className="customer-field-note">Debe resolver a direcciones públicas. El modo de autohospedaje requiere habilitación del operador.</p>
    </>}
    <label htmlFor="investigation-model-id">Modelo</label>
    <input id="investigation-model-id" list="investigation-model-suggestions" value={modelId} onChange={event => setModelId(event.target.value)} maxLength={200} disabled={!isOwner || save.isPending || testConnection.isPending} placeholder="Escribe un ID de modelo" />
    <datalist id="investigation-model-suggestions">{preset?.suggestedModelIds.map(model => <option value={model} key={model} />)}</datalist>
    <label htmlFor="investigation-api-key">{subscription?.label ?? 'Clave API'}</label>
    {subscription && <p className="customer-field-note" id="investigation-credential-help">{subscription.steps}</p>}
    <input id="investigation-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={event => { setApiKey(event.target.value); if (event.target.value) setClearApiKey(false); }} maxLength={16384} disabled={!isOwner || save.isPending || testConnection.isPending} placeholder={settings.data?.apiKeyConfigured ? 'Credencial nueva (vacío conserva la configurada)' : subscription?.placeholder ?? 'Pega la clave API'} {...(subscription ? { 'aria-describedby': 'investigation-credential-help' } : {})} />
    {settings.data?.apiKeyConfigured && <p className="customer-field-note" aria-label="Credencial configurada">•••••••• configurada</p>}
    {isOwner && settings.data?.apiKeyConfigured && <label className="customer-investigation-consent"><input type="checkbox" checked={clearApiKey} onChange={event => setClearApiKey(event.target.checked)} disabled={save.isPending || testConnection.isPending} />Eliminar la clave guardada al guardar</label>}
    <fieldset disabled={!isOwner || save.isPending || testConnection.isPending}>
      <legend>Datos que autorizas enviar al modelo</legend>
      {(investigationDataScopeSchema.options).map(scope => <label className="customer-investigation-consent" key={scope}>
        <input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(item => item !== scope))} />
        {scopeNames[scope]}
      </label>)}
    </fieldset>
    <label className="customer-investigation-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={!isOwner || save.isPending || testConnection.isPending} />Autorizo el procesamiento externo de las categorías seleccionadas</label>
    {subscription && <p className="customer-field-note">Con suscripción, cada llamada se descuenta de los límites de tu plan y cuesta $0 en Gotchu. Aun así, el presupuesto en dinero del espacio debe quedar por encima de lo ya gastado con proveedores de clave API, o las investigaciones se bloquean.</p>}
    <div className="customer-investigation-budget-grid">
      {!subscription && <>
      <label htmlFor="investigation-input-rate">Entrada · micro USD por millón de tokens<input id="investigation-input-rate" type="number" min="0" max="1000000000" step="1" value={inputRate} onChange={event => setInputRate(event.target.value)} disabled={!isOwner || save.isPending || testConnection.isPending} /></label>
      <label htmlFor="investigation-output-rate">Salida · micro USD por millón de tokens<input id="investigation-output-rate" type="number" min="0" max="1000000000" step="1" value={outputRate} onChange={event => setOutputRate(event.target.value)} disabled={!isOwner || save.isPending || testConnection.isPending} /></label>
      </>}
      <label htmlFor="investigation-budget">Presupuesto del espacio · centavos<input id="investigation-budget" type="number" min="0" max="100000000" step="1" value={budgetCents} onChange={event => setBudgetCents(event.target.value)} disabled={!isOwner || save.isPending || testConnection.isPending} /></label>
      <label htmlFor="investigation-token-budget">Presupuesto de tokens<input id="investigation-token-budget" type="number" min="0" max="100000000" step="1000" value={tokenBudget} onChange={event => setTokenBudget(event.target.value)} disabled={!isOwner || save.isPending || testConnection.isPending} /></label>
    </div>
    {settings.data && (subscription
      ? <p className="customer-field-note">Uso del espacio: {settings.data.tokensSpent.toLocaleString('es')} tokens · {settings.data.tokensReserved.toLocaleString('es')} reservados{settings.data.spentMicroUsd !== 0 && <> · ${(settings.data.spentMicroUsd / 1_000_000).toFixed(6)} USD gastados</>}{settings.data.reservedMicroUsd !== 0 && <> · ${(settings.data.reservedMicroUsd / 1_000_000).toFixed(6)} USD reservados</>}.</p>
      : <p className="customer-field-note">Uso: {settings.data.tokensSpent.toLocaleString('es')} tokens · ${(settings.data.spentMicroUsd / 1_000_000).toFixed(6)} USD gastados · ${(settings.data.reservedMicroUsd / 1_000_000).toFixed(6)} USD reservados.</p>)}
    {(save.error || disable.error || testConnection.error) && <p className="customer-form-error" role="alert">{errorText(save.error ?? disable.error ?? testConnection.error)}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="customer-ops-alert-actions">
      <button className="customer-button customer-button-primary" type="button" disabled={!isOwner || save.isPending || testConnection.isPending} onClick={() => { setNotice(null); save.mutate(); }}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</button>
      <button className="customer-button" type="button" disabled={!isOwner || save.isPending || testConnection.isPending} onClick={() => { setNotice(null); testConnection.mutate(); }}>{testConnection.isPending ? 'Probando conexión…' : 'Probar conexión'}</button>
      {isOwner && ready && <button className="customer-button" type="button" disabled={disable.isPending || save.isPending || testConnection.isPending} onClick={() => disable.mutate()}>{disable.isPending ? 'Deshabilitando…' : 'Deshabilitar y eliminar clave'}</button>}
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
  return <section className="customer-card customer-panel customer-investigation-timeline">
    <div className="customer-card-heading"><div><h2>Explicaciones y evidencias</h2></div></div>
    {runs.isPending ? <p>Cargando investigaciones…</p> : runs.error ? <p className="customer-form-error" role="alert">{errorText(runs.error)}</p> : runs.data?.length === 0 ? <p className="customer-empty-inline">Todavía no hay investigaciones para esta aplicación.</p> : <ol>
      {runs.data?.map(run => <li key={run.jobId}>
        <div className="customer-investigation-run-heading"><strong>{statusNames[run.status]}</strong><span>{new Date(run.createdAt).toLocaleString('es')}</span></div>
        <p>{run.summary ?? (run.status === 'reconciliation_required' ? 'El coste de una llamada quedó reservado porque el proveedor no confirmó su uso.' : 'La investigación está en curso o no produjo una explicación.')}</p>
        {run.assessment && <span className="customer-status customer-status-muted">Evaluación del modelo: {run.assessment === 'candidate_issue' ? 'indicio candidato' : run.assessment === 'no_issue_supported' ? 'sin indicio respaldado' : 'inconclusa'} · nunca equivale a un hallazgo verificado</span>}
        {run.citedEvidenceIds.length > 0 && <details><summary>Evidencia citada ({run.citedEvidenceIds.length})</summary><ul>{run.citedEvidenceIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>}
        {run.hypotheses.length > 0 && <details><summary>Hipótesis</summary><ul>{run.hypotheses.map((item, index) => <li key={`${run.jobId}:${index}`}>{item.statement}<br /><small>Evidencias: {item.evidenceIds.join(', ')}</small></li>)}</ul></details>}
        {run.candidateSuggestion && <div className="customer-investigation-suggestion"><strong>Sugerencia privada · requiere D05 y aprobación humana</strong><p>{run.candidateSuggestion.summary}</p>{run.candidateSuggestion.path && <code>{run.candidateSuggestion.path}</code>}<p className="customer-field-note">Evidencias: {run.candidateSuggestion.evidenceIds.join(', ')}</p></div>}
        <p className="customer-field-note">{run.tokensSpent.toLocaleString('es')} tokens · ${(run.costMicroUsd / 1_000_000).toFixed(6)} USD gastados · ${(run.reservedCostMicroUsd / 1_000_000).toFixed(6)} USD y {run.reservedTokens.toLocaleString('es')} tokens reservados.</p>
        {canManage && (run.state === 'queued' || run.state === 'running') && <button className="customer-button" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(run.jobId)}>Cancelar</button>}
        {canManage && (['delayed', 'inconclusive'].includes(run.status) || run.state === 'failed') && run.reservedCostMicroUsd === 0 && run.reservedTokens === 0 && <button className="customer-button" type="button" disabled={resume.isPending} onClick={() => resume.mutate(run.jobId)}>Reanudar</button>}
      </li>)}
    </ol>}
  </section>;
}
