import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { compareAnalyzedToDeployed, type ContextInventory } from '@gotchu/contracts';
import { contextClient } from './context-client';
import { requestStepUp } from './step-up-client';

const stateName = { declared: 'Declarado', verified: 'Verificado', unknown: 'Desconocido' } as const;
const accessName = { not_granted: 'Sin permiso', granted: 'Lectura concedida', revoked: 'Revocado' } as const;
const writeAccessName = { not_granted: 'No concedido', granted: 'Concedido al Writer App', revoked: 'Revocado' } as const;
const sourceName = { customer_declared: 'declarado por el cliente', signed_telemetry: 'telemetría firmada', operator: 'operador', github_app: 'GitHub App' } as const;
const compareName = { matches: 'Coincide', differs: 'Difiere', unknown: 'Desconocido' } as const;
export function ContextPanel({ userId, organizationId, applicationId, canManage, isOwner, archived, analyzedDigest }: { userId: string; organizationId: string; applicationId: string; canManage: boolean; isOwner: boolean; archived: boolean; analyzedDigest: string | null }) {
  const queryClient = useQueryClient();
  const key = ['customer-data', userId, 'context', organizationId, applicationId];
  const inventory = useQuery({ queryKey: key, queryFn: () => contextClient.list(organizationId, applicationId), retry: 1 });
  const options = useQuery({ queryKey: ['customer-data', userId, 'repository-options', organizationId, applicationId], queryFn: () => contextClient.repositoryOptions(organizationId, applicationId), enabled: canManage && !archived, retry: 1 });
  const [environmentName, setEnvironmentName] = useState('production');
  const [environmentId, setEnvironmentId] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [repositoryKey, setRepositoryKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key }).then(() => undefined);
  const createEnvironment = useMutation({ mutationFn: () => contextClient.createEnvironment({ organizationId, applicationId, name: environmentName, kind: environmentName === 'production' ? 'production' : 'other' }), onSuccess: async () => { setError(null); await refresh(); }, onError: caught => setError(message(caught)) });
  const createService = useMutation({ mutationFn: (environmentId: string) => contextClient.createService({ organizationId, applicationId, environmentId, name: serviceName, kind: 'web' }), onSuccess: async () => { setServiceName(''); setError(null); await refresh(); }, onError: caught => setError(message(caught)) });
  const createRepository = useMutation({ mutationFn: () => { const option = options.data?.find(item => item.key === repositoryKey); if (!option) throw new Error('Selecciona un repositorio del catálogo autorizado.'); return contextClient.createRepositoryLink({ organizationId, applicationId, repositoryKey, subdirectory: null, defaultBranch: 'main' }); }, onSuccess: async () => { setRepositoryKey(''); setError(null); await refresh(); }, onError: caught => setError(message(caught)) });
  const revokeRepository = useMutation({ mutationFn: (repositoryLinkId: string) => contextClient.revokeRepositoryLink({ organizationId, applicationId, repositoryLinkId }), onSuccess: refresh, onError: caught => setError(message(caught)) });
  const writeAccess = useMutation({ mutationFn: async (input:{repositoryLinkId:string;grant:boolean}) => {
    const challenge=await contextClient.repositoryWriteAccessChallenge({organizationId,applicationId,...input});
    const stepUpProof=await requestStepUp(organizationId,challenge.actionHash);
    return contextClient.setRepositoryWriteAccess({organizationId,applicationId,...input,actionHash:challenge.actionHash,stepUpProof});
  },onSuccess:async()=>{setError(null);await refresh();},onError:caught=>setError(message(caught)) });
  const data = inventory.data;
  return <section className="customer-card customer-panel customer-context-panel" aria-labelledby="context-heading">
    <div className="customer-card-heading"><div><h2 id="context-heading">Contexto de la aplicación</h2></div></div>
    <p className="customer-card-copy">Registra dónde corre cada servicio y qué evidencia vincula el código con una versión desplegada. Una coincidencia de nombre no verifica una relación.</p>
    {inventory.isPending ? <p className="customer-empty-inline" role="status">Cargando inventario de contexto…</p>
      : inventory.error ? <div className="customer-empty-inline" role="alert">{message(inventory.error)} <button className="customer-link-button" onClick={() => { inventory.refetch().catch(() => undefined); }}>Reintentar</button></div>
      : data ? <>
        <label className="customer-context-label" htmlFor="context-environment">Entorno</label>
        <select id="context-environment" className="customer-context-select" value={selectedEnvironment(data, environmentId)} onChange={event => setEnvironmentId(event.target.value)} aria-describedby="context-environment-help">
          {data.environments.length === 0 ? <option value="">Todavía no hay entornos</option> : data.environments.map(environment => <option key={environment.id} value={environment.id}>{environment.name} · {stateName[environment.state]}{environment.archived ? ' · archivado' : ''}</option>)}
        </select>
        <p id="context-environment-help" className="customer-field-note">El entorno seleccionado agrupa servicios, dependencias y orígenes conocidos.</p>
        {canManage && !archived && <div className="customer-context-forms">
          <form onSubmit={event => { event.preventDefault(); createEnvironment.mutate(); }}><label htmlFor="context-new-env">Añadir entorno</label><div><input id="context-new-env" value={environmentName} onChange={event => setEnvironmentName(event.target.value)} maxLength={63} pattern="[a-z][a-z0-9-]*" required /><button className="customer-button customer-button-secondary" disabled={createEnvironment.isPending}>Añadir</button></div></form>
          {data.environments.length > 0 && <form onSubmit={event => { event.preventDefault(); const selected = selectedEnvironment(data, environmentId); if (selected) createService.mutate(selected); }}><label htmlFor="context-new-service">Añadir servicio al entorno</label><div><input id="context-new-service" placeholder="api" value={serviceName} onChange={event => setServiceName(event.target.value)} maxLength={120} required /><button className="customer-button customer-button-secondary" disabled={createService.isPending}>Añadir</button></div></form>}
          {options.data && options.data.length > 0 && <form onSubmit={event => { event.preventDefault(); createRepository.mutate(); }}><label htmlFor="context-repository">Vincular repositorio del catálogo</label><div><select id="context-repository" value={repositoryKey} onChange={event => setRepositoryKey(event.target.value)} required><option value="">Selecciona un repositorio</option>{options.data.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select><button className="customer-button customer-button-secondary" disabled={createRepository.isPending || !repositoryKey}>Vincular</button></div></form>}
        </div>}
        <ContextLists data={data} environmentId={selectedEnvironment(data, environmentId)} analyzedDigest={analyzedDigest} canManage={canManage && !archived} isOwner={isOwner && !archived} writeAccessPending={writeAccess.isPending} revoke={id => revokeRepository.mutate(id)} changeWriteAccess={(id,grant)=>writeAccess.mutate({repositoryLinkId:id,grant})} />
        {error && <p className="customer-form-error" role="alert">{error}</p>}
      </> : null}
  </section>;
}
function selectedEnvironment(data: ContextInventory, selectedId: string) { return data.environments.some(environment => environment.id === selectedId) ? selectedId : data.environments.find(environment => !environment.archived)?.id ?? data.environments[0]?.id ?? ''; }
function message(error: unknown) { return error instanceof Error ? error.message : 'No se pudo actualizar el contexto.'; }
function ContextLists({ data, environmentId, analyzedDigest, canManage, isOwner, writeAccessPending, revoke, changeWriteAccess }: { data: ContextInventory; environmentId: string; analyzedDigest: string | null; canManage: boolean; isOwner:boolean; writeAccessPending:boolean; revoke: (id: string) => void; changeWriteAccess:(id:string,grant:boolean)=>void }) {
  const services = data.services.filter(service => service.environmentId === environmentId);
  const serviceName = (id: string) => services.find(service => service.id === id)?.name ?? 'Servicio desconocido';
  const environmentName = (id: string) => data.environments.find(environment => environment.id === id)?.name ?? 'Entorno desconocido';
  return <div className="customer-context-lists">
    <section><h3>Servicios</h3>{services.length ? <ul>{services.map(service => <li key={service.id}><strong>{service.name}</strong><span>{environmentName(service.environmentId)} · {service.kind} · {stateName[service.state]}</span></li>)}</ul> : <p className="customer-empty-inline">Aún no hay servicios en este entorno.</p>}</section>
    <section><h3>Repositorios vinculados</h3>{data.repositoryLinks.length ? <ul>{data.repositoryLinks.map(repository => <li key={repository.id}><strong>{repository.repositoryKey}</strong><span>{repository.subdirectory ?? 'Raíz'} · {accessName[repository.readAccess]} · {stateName[repository.state]} · Escritura: {writeAccessName[repository.writeAccess]} · Fuente: {sourceName[repository.source]}</span>{isOwner && !repository.revoked && repository.readAccess === 'granted' && repository.state === 'verified' && repository.writeAccess !== 'granted' && <button className="customer-link-button" disabled={writeAccessPending} onClick={()=>changeWriteAccess(repository.id,true)}>Conceder escritura con WebAuthn</button>}{isOwner && !repository.revoked && repository.writeAccess === 'granted' && <button className="customer-link-button customer-danger-link" disabled={writeAccessPending} onClick={()=>changeWriteAccess(repository.id,false)}>Revocar escritura con WebAuthn</button>}{canManage && !repository.revoked && <button className="customer-link-button customer-danger-link" onClick={() => revoke(repository.id)}>Revocar repositorio</button>}</li>)}</ul> : <p className="customer-empty-inline">Aún no hay repositorios vinculados. El acceso de lectura sigue al catálogo autorizado; la escritura requiere permiso expreso de un Owner.</p>}</section>
    <section><h3>Despliegues</h3>{data.deployments.filter(deployment => deployment.environmentId === environmentId).length ? <ul>{data.deployments.filter(deployment => deployment.environmentId === environmentId).map(deployment => { const comparison = compareAnalyzedToDeployed({ digest: analyzedDigest }, deployment); return <li key={deployment.id}><strong>{deployment.releaseId}</strong><span>{serviceName(deployment.serviceId)} · {environmentName(deployment.environmentId)} · {stateName[deployment.state]}</span><span className={`customer-context-badge is-${comparison}`}>Analizado vs desplegado: {compareName[comparison]}</span></li>; })}</ul> : <p className="customer-empty-inline">Aún no hay despliegues vinculados.</p>}</section>
    <section><h3>Dependencias y proveedor</h3>{data.dependencies.filter(item => item.environmentId === environmentId).length ? <ul>{data.dependencies.filter(item => item.environmentId === environmentId).map(item => <li key={item.id}><strong>{item.provider} · {item.component}</strong><span>{serviceName(item.serviceId)} · {item.region ?? 'Región no indicada'} · {stateName[item.state]}</span></li>)}</ul> : <p className="customer-empty-inline">Aún no hay dependencias registradas.</p>}</section>
    <section><h3>Orígenes candidatos</h3>{data.origins.filter(origin => origin.environmentId === environmentId).length ? <ul>{data.origins.filter(origin => origin.environmentId === environmentId).map(origin => <li key={origin.id}><strong>{origin.origin}</strong><span>Descubrimiento: {origin.discoverySource} · Propiedad declarada: {origin.ownership} · Relación: {stateName[origin.state]}</span><span>Alcance de evaluación vinculado: {origin.authorizationTargetId ? 'sí; su vigencia se comprueba al solicitar una evaluación' : 'no'}</span></li>)}</ul> : <p className="customer-empty-inline">No hay candidatos. Descubrir un origen no lo añade automáticamente al alcance de evaluación.</p>}</section>
  </div>;
}
