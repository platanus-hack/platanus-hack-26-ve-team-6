import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DependencyInventory, LicensePolicy, WorkspaceRetentionPolicyInput, AssessmentFinding } from '@gotchu/contracts';
import { CustomerApiError, customerApi } from './customer-client';

const policyLabels = { allowed: 'Permitida', review: 'Revisión', denied: 'No permitida' } as const;
const relationshipLabels = { direct: 'Directa', transitive: 'Transitiva', unknown: 'Desconocida' } as const;
const reachabilityLabels = { reachable: 'Símbolo referenciado', imported: 'Paquete importado', not_found_static: 'Sin importación estática', unknown: 'Desconocida' } as const;
const artifactLabels = { not_requested: 'No priorizado', verified: 'Verificado y escaneado', checksum_mismatch: 'Checksum distinto', unavailable: 'No disponible', unsafe_archive: 'Archivo rechazado', scan_incomplete: 'Cobertura parcial' } as const;
const severityLabels = { unknown: 'Desconocida', informational: 'Informativa', low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' } as const;
const confidenceLabels = { observed: 'Observada', inferred: 'Inferida', uncertain: 'Incierta' } as const;
const exploitabilityLabels = { unknown: 'Desconocida', not_demonstrated: 'No demostrada', demonstrated_in_fixture: 'Demostrada en fixture' } as const;
const priority = { reachable: 0, imported: 1, unknown: 2, not_found_static: 3 } as const;

export function DependencyInventoryPanel({ inventory, findings, busy, error, onDownload }: {
  inventory: DependencyInventory | undefined;
  findings: AssessmentFinding[];
  busy: boolean;
  error: string | null;
  onDownload: () => void;
}) {
  const [search, setSearch] = useState('');
  const [policyStatus, setPolicyStatus] = useState<'all' | 'allowed' | 'review' | 'denied'>('all');
  const [relationship, setRelationship] = useState<'all' | 'direct' | 'transitive' | 'unknown'>('all');
  const [reachability, setReachability] = useState<'all' | 'reachable' | 'imported' | 'not_found_static' | 'unknown'>('all');
  if (!inventory) return <div className="customer-empty-inline">Este informe no contiene inventario de dependencias. La cobertura de SCA es desconocida.</div>;
  const findingsByPackage = new Map<string, AssessmentFinding[]>();
  for (const finding of findings) {
    const purl = finding.dependencyAssessment?.purl;
    if (!purl) continue;
    const packageFindings = findingsByPackage.get(purl) ?? [];
    packageFindings.push(finding);
    findingsByPackage.set(purl, packageFindings);
  }
  const query = search.trim().toLowerCase();
  const components = inventory.components.filter(component =>
    (policyStatus === 'all' || component.policyStatus === policyStatus)
    && (relationship === 'all' || component.relationship === relationship)
    && (reachability === 'all' || (findingsByPackage.has(component.purl)
      && (component.reachability?.state ?? findingsByPackage.get(component.purl)?.[0]?.dependencyAssessment?.reachability.state ?? 'unknown') === reachability))
    && (!query || `${component.name} ${component.version} ${component.declaredLicense ?? ''} ${component.sourceFile}`.toLowerCase().includes(query)));
  components.sort((left, right) => {
    const leftFindings = findingsByPackage.get(left.purl) ?? [];
    const rightFindings = findingsByPackage.get(right.purl) ?? [];
    if ((leftFindings.length > 0) !== (rightFindings.length > 0)) return leftFindings.length > 0 ? -1 : 1;
    const leftState = left.reachability?.state ?? leftFindings[0]?.dependencyAssessment?.reachability.state ?? 'unknown';
    const rightState = right.reachability?.state ?? rightFindings[0]?.dependencyAssessment?.reachability.state ?? 'unknown';
    return priority[leftState] - priority[rightState] || left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
  });
  return <section className="customer-report-section customer-dependency-inventory">
    <div className="customer-section-heading"><div><h3>{inventory.components.length} paquetes exactos</h3></div><button className="customer-button customer-button-primary" disabled={busy} onClick={onDownload}>{busy ? 'Preparando SBOM…' : 'Descargar SBOM (CycloneDX)'}</button></div>
    {error && <p className="customer-form-error" role="alert">{error}</p>}
    <div className="customer-dependency-coverage" role="status">
      <strong>{inventory.complete ? 'Lockfiles compatibles inspeccionados' : 'Cobertura parcial o desconocida'}</strong>
      <span>{inventory.unknownCount} entradas sin resolver · grafo {inventory.graphComplete ? 'disponible' : 'parcial'}</span>
      {inventory.lockfiles.map(file => <span key={file.sourceFile}>{file.sourceFile} · {file.format} · {file.packageCount} paquetes · {file.state === 'inspected' ? 'evaluado' : file.state === 'unsupported' ? 'no compatible' : 'no disponible'}</span>)}
    </div>
    {inventory.components.length === 0
      ? <div className="customer-empty-inline">No se encontraron versiones exactas en los lockfiles cargados. Revisa la cobertura antes de interpretar este resultado.</div>
      : <>
        <div className="customer-dependency-filters">
          <label>Buscar paquete o archivo<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre, versión o lockfile" /></label>
          <label>Política<select value={policyStatus} onChange={event => setPolicyStatus(event.target.value as typeof policyStatus)}><option value="all">Todos los estados</option><option value="allowed">Permitida</option><option value="review">Revisión</option><option value="denied">No permitida</option></select></label>
          <label>Relación<select value={relationship} onChange={event => setRelationship(event.target.value as typeof relationship)}><option value="all">Todas</option><option value="direct">Directa</option><option value="transitive">Transitiva</option><option value="unknown">Desconocida</option></select></label>
          <label>Alcance estático (uso en el código)<select value={reachability} onChange={event => setReachability(event.target.value as typeof reachability)}><option value="all">Todos</option><option value="reachable">Símbolo referenciado</option><option value="imported">Paquete importado</option><option value="not_found_static">Sin importación estática</option><option value="unknown">Desconocido</option></select></label>
        </div>
        {components.length === 0 ? <div className="customer-empty-inline">Ningún paquete coincide con estos filtros.</div> : <div className="customer-dependency-table-wrap"><table className="customer-dependency-table"><thead><tr><th>Paquete</th><th>Relación</th><th>Uso en el código</th><th>Aviso / gravedad</th><th>Confianza</th><th>Explotabilidad</th><th>Artefacto</th><th>Licencia</th><th>Política</th><th>Origen</th></tr></thead><tbody>
          {components.map(component => {
            const packageFindings = findingsByPackage.get(component.purl) ?? [];
            const packageReachability = component.reachability ?? packageFindings[0]?.dependencyAssessment?.reachability;
            return <tr key={`${component.purl}:${component.location}`}>
            <td><strong>{component.name}</strong><small>{component.version}</small></td>
            <td>{relationshipLabels[component.relationship]}</td>
            <td><strong>{packageReachability ? reachabilityLabels[packageReachability.state] : 'Sin aviso relacionado'}</strong>{packageReachability?.importEvidence.slice(0, 2).map(item => <small key={`${item.file}:${item.line}`}>{item.file}:{item.line} · {item.specifier}</small>)}{packageReachability?.symbolEvidence.slice(0, 2).map(item => <small key={`${item.file}:${item.line}:${item.symbol}`}>{item.file}:{item.line} · {item.symbol}</small>)}{packageFindings.length > 0 && <small>{packageReachability?.dependencyPath ? 'Ruta directa en el lockfile' : component.relationship === 'transitive' ? 'Ruta directa sin comprobar' : 'La búsqueda estática no descarta carga dinámica'}</small>}</td>
            <td>{packageFindings.map(finding => <div key={finding.id}><strong>{finding.title}</strong><small>Gravedad: {severityLabels[finding.severity]}</small></div>)}{packageFindings.length === 0 && <span>Sin aviso asociado</span>}</td>
            <td>{packageFindings.map(finding => <div key={finding.id}>{confidenceLabels[finding.confidence]}</div>)}</td>
            <td>{packageFindings.map(finding => <div key={finding.id}>{exploitabilityLabels[finding.exploitability]}</div>)}</td>
            <td><strong>{artifactLabels[component.artifactAnalysis?.status ?? 'not_requested']}</strong>{component.artifactAnalysis?.integrity && <small>Integridad del archivo de dependencias: {component.artifactAnalysis.integrity}</small>}{component.artifactAnalysis?.findings.map((artifactFinding, index) => <details key={`${artifactFinding.ruleId}:${index}`}><summary>{artifactFinding.tool}: {artifactFinding.title} · {severityLabels[artifactFinding.severity]}</summary><p>{artifactFinding.description}</p><code>{artifactFinding.location}</code><small>Confianza: {confidenceLabels[artifactFinding.confidence]} · Explotabilidad: {exploitabilityLabels[artifactFinding.exploitability]}</small></details>)}{component.artifactAnalysis?.limitation.map((item, index) => <small key={`${index}:${item}`}>{item}</small>)}</td>
            <td>{component.licenseExpression ?? component.declaredLicense ?? 'Sin declarar'}<small>{component.licenseConfidence === 'declared' ? 'Declarada; no verificada' : 'No disponible'}</small></td>
            <td><span className={`customer-license-status customer-license-${component.policyStatus}`}>{policyLabels[component.policyStatus]}</span></td>
            <td><code>{component.location}</code><small>{component.licenseSource === 'registry' ? 'Metadatos npm por versión exacta' : component.licenseSource === 'lockfile' ? 'Metadatos del lockfile' : 'Origen de licencia desconocido'}</small></td>
          </tr>;
          })}
        </tbody></table></div>}
      </>}
  </section>;
}

type PolicyDraft = { allow: string; deny: string; review: string };
const toDraft = (policy: LicensePolicy): PolicyDraft => ({ allow: policy.allow.join('\n'), deny: policy.deny.join('\n'), review: policy.review.join('\n') });
const fromDraft = (draft: PolicyDraft): LicensePolicy => ({
  allow: draft.allow.split('\n').map(value => value.trim()).filter(Boolean),
  deny: draft.deny.split('\n').map(value => value.trim()).filter(Boolean),
  review: draft.review.split('\n').map(value => value.trim()).filter(Boolean),
});

export function LicensePolicyPanel({ userId, organizationId, canManage }: { userId: string; organizationId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: ['customer-data', userId, 'license-policy', organizationId], queryFn: () => customerApi.licensePolicy(organizationId), retry: false });
  useEffect(() => { if (query.data) setDraft(toDraft(query.data.policy)); }, [query.data]);
  const update = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('La política todavía no está disponible.');
      return customerApi.updateLicensePolicy(organizationId, fromDraft(draft));
    },
    onSuccess: async value => {
      setDraft(toDraft(value.policy)); setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'license-policy', organizationId] });
    },
    onError: () => setSaved(false),
  });
  if (query.isPending) return <section className="customer-card"><div className="customer-loading" role="status">Cargando la política de licencias…</div></section>;
  if (query.error) return <section className="customer-card"><div className="customer-error" role="alert"><strong>No se pudo cargar la política</strong><p>{query.error instanceof CustomerApiError ? query.error.message : 'Inténtalo de nuevo.'}</p><button className="customer-link-button" onClick={() => { query.refetch().catch(() => undefined); }}>Reintentar</button></div></section>;
  if (!draft) return <section className="customer-card"><div className="customer-empty-inline">La política de licencias está vacía o no disponible.</div></section>;
  return <section className="customer-card customer-license-policy-panel">
    <div className="customer-card-heading"><div><p className="customer-card-copy">Las no permitidas generan observaciones; las de revisión o sin declarar requieren atención.</p></div><span className="customer-status customer-status-muted">{query.data?.configured ? 'Configurada' : 'Valores predeterminados'}</span></div>
    {!query.data?.configured && <p className="customer-license-default-note">Por defecto, se permiten algunas licencias permisivas; GPL, AGPL, SSPL, las desconocidas y las que no están en la lista de permitidas requieren revisión.</p>}
    <p className="customer-field-note">Escribe un identificador o expresión SPDX por línea.</p>
    <div className="customer-license-policy-grid">
      {(['allow', 'deny', 'review'] as const).map(field => <label key={field}>{field === 'allow' ? 'Permitir' : field === 'deny' ? 'Denegar' : 'Requieren revisión'}<textarea rows={8} value={draft[field]} disabled={!canManage || update.isPending} onChange={event => { setSaved(false); setDraft(current => current ? { ...current, [field]: event.target.value } : current); }} /></label>)}
    </div>
    {update.error && <p className="customer-form-error" role="alert">{update.error instanceof CustomerApiError ? update.error.message : 'No se pudo guardar la política.'}</p>}
    {saved && <p className="customer-license-saved" role="status">La política del espacio de trabajo se guardó.</p>}
    {canManage ? <button className="customer-button customer-button-primary" disabled={update.isPending} onClick={() => update.mutate()}>{update.isPending ? 'Guardando política…' : 'Guardar política'}</button> : <p className="customer-field-note">Sólo Owner u Operator puede cambiar esta política.</p>}
  </section>;
}

const retentionFields = [
  ['sourceSnapshotDays', 'Instantáneas de código', 'Contenido del código subido.'],
  ['containerImageDays', 'Imágenes de contenedor', 'Archivos de imagen subidos.'],
  ['reportDays', 'Informes', 'Informes y hallazgos.'],
  ['observationDays', 'Observaciones', 'Observaciones y alertas.'],
  ['runDays', 'Ejecuciones de vigilancia', 'Ejecuciones finalizadas.'],
  ['notificationDeliveryDays', 'Entregas de notificaciones', 'Historial de entregas; los canales siguen activos.'],
  ['protectionEventDays', 'Eventos de protección', 'Eventos procesados; los firmados tienen su propio plazo.'],
] as const;

export function RetentionPolicyPanel({ userId, organizationId, isOwner }: { userId: string; organizationId: string; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WorkspaceRetentionPolicyInput | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: ['customer-data', userId, 'retention-policy', organizationId], queryFn: () => customerApi.retentionPolicy(organizationId), retry: false });
  useEffect(() => {
    if (!query.data) return;
    setDraft({ sourceSnapshotDays: query.data.sourceSnapshotDays, containerImageDays: query.data.containerImageDays,
      reportDays: query.data.reportDays, observationDays: query.data.observationDays, runDays: query.data.runDays,
      notificationDeliveryDays: query.data.notificationDeliveryDays, protectionEventDays: query.data.protectionEventDays });
  }, [query.data]);
  const update = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('La política todavía no está disponible.');
      return customerApi.updateRetentionPolicy(organizationId, draft);
    },
    onSuccess: async value => {
      setDraft({ sourceSnapshotDays: value.sourceSnapshotDays, containerImageDays: value.containerImageDays,
        reportDays: value.reportDays, observationDays: value.observationDays, runDays: value.runDays,
        notificationDeliveryDays: value.notificationDeliveryDays, protectionEventDays: value.protectionEventDays });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'retention-policy', organizationId] });
    },
    onError: () => setSaved(false),
  });
  if (query.isPending) return <section className="customer-card"><div className="customer-loading" role="status">Cargando la política de retención…</div></section>;
  if (query.error) return <section className="customer-card"><div className="customer-error" role="alert"><strong>No se pudo cargar la política</strong><p>{query.error instanceof CustomerApiError ? query.error.message : 'Inténtalo de nuevo.'}</p><button className="customer-link-button" onClick={() => { query.refetch().catch(() => undefined); }}>Reintentar</button></div></section>;
  if (!draft) return <section className="customer-card"><div className="customer-empty-inline">La política de retención no está disponible.</div></section>;
  return <section className="customer-card customer-license-policy-panel">
    <div className="customer-card-heading"><div><p className="customer-card-copy">Gotchu elimina los datos vencidos. Las propuestas pendientes se invalidan antes de borrar su fuente; los eventos recibidos tienen su propio plazo.</p></div><span className="customer-status customer-status-muted">Actualizada: {new Date(query.data.updatedAt).toLocaleDateString('es')}</span></div>
    <div className="customer-license-policy-grid">
      {retentionFields.map(([key, label, help]) => <label key={key}>{label}<input type="number" min={1} max={3650} step={1} value={draft[key]} disabled={!isOwner || update.isPending} onChange={event => { setSaved(false); const value = Number(event.target.value); setDraft(current => current ? { ...current, [key]: value } : current); }} /><small>{help}</small></label>)}
    </div>
    {update.error && <p className="customer-form-error" role="alert">{update.error instanceof CustomerApiError ? update.error.message : 'No se pudo guardar la política.'}</p>}
    {saved && <p className="customer-license-saved" role="status">La política de retención se guardó.</p>}
    {isOwner ? <button className="customer-button customer-button-primary" disabled={update.isPending || !draft || retentionFields.some(([key]) => !Number.isInteger(draft[key]) || draft[key] < 1 || draft[key] > 3650)} onClick={() => update.mutate()}>{update.isPending ? 'Guardando política…' : 'Guardar política'}</button> : <p className="customer-field-note">Sólo Owner puede cambiar la retención del espacio de trabajo.</p>}
  </section>;
}
