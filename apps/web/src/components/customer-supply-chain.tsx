import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DependencyInventory, LicensePolicy } from '@gotchu/contracts';
import { CustomerApiError, customerApi } from './customer-client';

const policyLabels = { allowed: 'Permitida', review: 'Revisión', denied: 'No permitida' } as const;
const relationshipLabels = { direct: 'Directa', transitive: 'Transitiva', unknown: 'Desconocida' } as const;

export function DependencyInventoryPanel({ inventory, busy, error, onDownload }: {
  inventory: DependencyInventory | undefined;
  busy: boolean;
  error: string | null;
  onDownload: () => void;
}) {
  const [search, setSearch] = useState('');
  const [policyStatus, setPolicyStatus] = useState<'all' | 'allowed' | 'review' | 'denied'>('all');
  const [relationship, setRelationship] = useState<'all' | 'direct' | 'transitive' | 'unknown'>('all');
  if (!inventory) return <div className="customer-empty-inline">Este informe no contiene inventario de dependencias. La cobertura de SCA es desconocida.</div>;
  const query = search.trim().toLowerCase();
  const components = inventory.components.filter(component =>
    (policyStatus === 'all' || component.policyStatus === policyStatus)
    && (relationship === 'all' || component.relationship === relationship)
    && (!query || `${component.name} ${component.version} ${component.declaredLicense ?? ''} ${component.sourceFile}`.toLowerCase().includes(query)));
  return <section className="customer-report-section customer-dependency-inventory">
    <div className="customer-section-heading"><div><span className="customer-eyebrow">INVENTARIO DE DEPENDENCIAS</span><h3>{inventory.components.length} paquetes exactos</h3></div><button className="customer-button customer-button-primary" disabled={busy} onClick={onDownload}>{busy ? 'Preparando SBOM…' : 'Descargar SBOM (CycloneDX)'}</button></div>
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
        </div>
        {components.length === 0 ? <div className="customer-empty-inline">Ningún paquete coincide con estos filtros.</div> : <div className="customer-dependency-table-wrap"><table className="customer-dependency-table"><thead><tr><th>Paquete</th><th>Relación</th><th>Licencia declarada</th><th>Política</th><th>Origen</th></tr></thead><tbody>
          {components.map(component => <tr key={`${component.purl}:${component.location}`}>
            <td><strong>{component.name}</strong><small>{component.version}</small></td>
            <td>{relationshipLabels[component.relationship]}</td>
            <td>{component.licenseExpression ?? component.declaredLicense ?? 'Sin declarar'}<small>{component.licenseConfidence === 'declared' ? 'Declarada; no verificada' : 'No disponible'}</small></td>
            <td><span className={`customer-license-status customer-license-${component.policyStatus}`}>{policyLabels[component.policyStatus]}</span></td>
            <td><code>{component.location}</code><small>{component.licenseSource === 'registry' ? 'Metadatos npm por versión exacta' : component.licenseSource === 'lockfile' ? 'Metadatos del lockfile' : 'Origen de licencia desconocido'}</small></td>
          </tr>)}
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
    <div className="customer-card-heading"><div><span className="customer-eyebrow">POLÍTICA DEL ESPACIO DE TRABAJO</span><h2>Licencias de dependencias</h2></div><span className="customer-status customer-status-muted">{query.data?.configured ? 'Configurada' : 'Valores predeterminados'}</span></div>
    <p className="customer-card-copy">Las licencias no permitidas generan una observación. Las licencias en revisión y las no declaradas requieren atención. El origen es metadato declarado, no verificación del texto de licencia.</p>
    {!query.data?.configured && <p className="customer-license-default-note">Se aplica la política predeterminada: algunas licencias permisivas comunes se permiten; GPL, AGPL, SSPL, licencias desconocidas y licencias que no figuran como permitidas requieren revisión.</p>}
    <div className="customer-license-policy-grid">
      {(['allow', 'deny', 'review'] as const).map(field => <label key={field}>{field === 'allow' ? 'Permitir' : field === 'deny' ? 'Denegar' : 'Revisar'}<textarea rows={8} value={draft[field]} disabled={!canManage || update.isPending} onChange={event => { setSaved(false); setDraft(current => current ? { ...current, [field]: event.target.value } : current); }} placeholder="Un identificador SPDX por línea" /><small>Un identificador o expresión SPDX por línea</small></label>)}
    </div>
    {update.error && <p className="customer-form-error" role="alert">{update.error instanceof CustomerApiError ? update.error.message : 'No se pudo guardar la política.'}</p>}
    {saved && <p className="customer-license-saved" role="status">La política del espacio de trabajo se guardó.</p>}
    {canManage ? <button className="customer-button customer-button-primary" disabled={update.isPending} onClick={() => update.mutate()}>{update.isPending ? 'Guardando política…' : 'Guardar política'}</button> : <p className="customer-field-note">Sólo Owner u Operator puede cambiar esta política.</p>}
  </section>;
}
