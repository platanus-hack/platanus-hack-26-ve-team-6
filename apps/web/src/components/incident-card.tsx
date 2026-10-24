import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TriageRevision } from '@gotchu/contracts';
import { triageApi } from './triage-client';

const statusLabel = { open:'Abierto', monitoring:'En seguimiento', closed:'Cerrado por el equipo' } as const;
const impactLabel = { none_observed_at_checked_points:'No se observó impacto en los puntos comprobados', degraded:'Impacto degradado observado', unavailable:'Punto comprobado no disponible', unknown:'Impacto desconocido' } as const;
const kindLabel = { application_regression:'Regresión de aplicación', abuse:'Abuso', provider_dependency:'Dependencia o proveedor', legitimate_load:'Aumento de carga', unknown:'Sin explicación confirmada' } as const;
function revisionChange(current:TriageRevision, previous:TriageRevision|undefined) {
  if(!previous)return 'Primera revisión';
  const changes:string[]=[];
  if(current.impact.observed!==previous.impact.observed)changes.push(`impacto: ${impactLabel[previous.impact.observed]} → ${impactLabel[current.impact.observed]}`);
  const oldStatus=new Map(previous.hypotheses.map(item=>[item.kind,item.status]));
  for(const hypothesis of current.hypotheses){const before=oldStatus.get(hypothesis.kind);if(before!==hypothesis.status)changes.push(`${kindLabel[hypothesis.kind]}: ${before??'nueva'} → ${hypothesis.status}`);}
  if(changes.length===0)changes.push('Impacto e hipótesis sin cambio; cambió la evidencia o la ventana evaluada.');
  return changes.join('; ');
}
export function IncidentCard({ organizationId, applicationId, incidentId, canManage }: { organizationId:string; applicationId:string; incidentId:string; canManage:boolean }) {
  const scope={organizationId,applicationId}; const queryClient=useQueryClient();
  const query=useQuery({queryKey:['triage-incident',organizationId,applicationId,incidentId],queryFn:()=>triageApi.get(scope,incidentId),refetchInterval:10_000,refetchIntervalInBackground:false});
  const refresh=()=>Promise.all([
    queryClient.invalidateQueries({queryKey:['triage-incident',organizationId,applicationId,incidentId]}),
    queryClient.invalidateQueries({queryKey:['triage-incidents',organizationId,applicationId]}),
  ]);
  const status=useMutation({mutationFn:(value:'open'|'monitoring'|'closed')=>triageApi.status(scope,incidentId,value),onSuccess:refresh});
  const evidence=useMutation({mutationFn:()=>triageApi.requestEvidence(scope,incidentId),onSuccess:()=>queryClient.invalidateQueries({queryKey:['triage-incident',organizationId,applicationId,incidentId]})});
  if(query.isPending)return <section className="customer-card customer-panel" role="status">Cargando incidente…</section>;
  if(query.error)return <section className="customer-card customer-panel" role="alert"><h3>No se pudo cargar el incidente</h3><button className="customer-link-button" onClick={()=>query.refetch()}>Reintentar</button></section>;
  const detail=query.data; if(!detail)return <section className="customer-card customer-panel">No hay revisiones disponibles.</section>;
  const latest=detail.revisions[0]?.revision; if(!latest)return <section className="customer-card customer-panel"><h3>Incidente sin evidencia</h3><p>La evaluación todavía no produjo una revisión.</p></section>;
  const requestable=detail.requestableEvidence.length>0 && (detail.incident.latest?.impact.missingData.length || latest.hypotheses.some(h=>h.missingData.length));
  return <article className="customer-card customer-panel" aria-labelledby={`incident-${incidentId}`}>
    <header className="customer-card-heading"><div><h2 id={`incident-${incidentId}`}>Incidente · {impactLabel[latest.impact.observed]}</h2><span className="customer-eyebrow">{detail.incident.environment} · {detail.incident.latest?.rulesVersion}</span></div><label className="customer-incident-status">Estado del triage<select aria-label="Estado del triage" disabled={!canManage||status.isPending} value={detail.incident.status} onChange={e=>status.mutate(e.target.value as 'open'|'monitoring'|'closed')}>{Object.entries(statusLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></header>
    <section className="customer-incident-section"><h3>Qué observamos</h3><p>{impactLabel[latest.impact.observed]}</p>{latest.impact.affectedServices.length>0&&<p>Servicios afectados: {latest.impact.affectedServices.join(', ')}</p>}<ul>{latest.impact.checkedPoints.map(item=><li key={item.ref}>{item.detail}</li>)}</ul></section>
    <section className="customer-incident-section"><h3>Qué puede explicarlo</h3>{latest.hypotheses.map((hypothesis,index)=><details key={`${hypothesis.kind}-${index}`}><summary>{kindLabel[hypothesis.kind]} · {hypothesis.status} · confianza {hypothesis.confidence}</summary><p>Evidencia a favor</p><ul>{hypothesis.evidenceFor.map(item=><li key={item.ref}>{item.detail}</li>)}</ul><p>Evidencia en contra</p><ul>{hypothesis.evidenceAgainst.map(item=><li key={item.ref}>{item.detail}</li>)}</ul><p>Reglas: {hypothesis.ruleIds.join(', ')||'ninguna'}</p>{hypothesis.missingData.length>0&&<p>Falta: {hypothesis.missingData.join(' ')}</p>}</details>)}</section>
    <section className="customer-incident-section"><h3>Qué no comprobamos</h3><ul>{[...latest.impact.missingData,...latest.unknownInvestigable].length===0?<li>No hay datos faltantes declarados para esta ventana; la cobertura sigue limitada a los puntos comprobados.</li>:[...latest.impact.missingData,...latest.unknownInvestigable].map((item,index)=><li key={`${index}-${item}`}>{item}</li>)}</ul></section>
    <section className="customer-incident-section"><h3>Historial</h3><ol className="customer-incident-history">{detail.revisions.map(({revision,createdAt},index)=><li key={revision.id}>Revisión {revision.revision} · {new Date(createdAt).toLocaleString('es')} · {revisionChange(revision,detail.revisions[index+1]?.revision)}</li>)}</ol></section>
    {detail.revisions.some(({revision})=>revision.hypotheses.some(h=>h.kind==='provider_dependency'&&h.evidenceFor.some(item=>item.detail.includes('(fixture)'))))&&<p role="note">Feed de proveedor simulado (fixture).</p>}
    <button className="customer-button customer-button-secondary" disabled={!canManage||!requestable||evidence.isPending} title={!requestable?'No hay evidencia faltante solicitada mediante una comprobación ya configurada.':undefined} onClick={()=>evidence.mutate()}>Obtener evidencia faltante</button>{!requestable&&<p>No hay comprobaciones consentidas disponibles para solicitar.</p>}{evidence.data&&<p role="status">{evidence.data.message}</p>}{evidence.error&&<p role="alert">No se pudo solicitar la evidencia.</p>}{status.error&&<p role="alert">No se pudo actualizar el estado del triage.</p>}
  </article>;
}

export function IncidentList({ organizationId, applicationId, canManage }: { organizationId:string; applicationId:string; canManage:boolean }) {
  const query=useQuery({queryKey:['triage-incidents',organizationId,applicationId],queryFn:()=>triageApi.list({organizationId,applicationId}),refetchInterval:10_000,refetchIntervalInBackground:false});
  if(query.isPending)return <section className="customer-card customer-panel" role="status">Cargando incidentes…</section>;
  if(query.error)return <section className="customer-card customer-panel" role="alert"><h2>No se pudieron cargar los incidentes</h2><button className="customer-link-button" onClick={()=>query.refetch()}>Reintentar</button></section>;
  return <section className="customer-incident-list"><ProbeRouteSettings organizationId={organizationId} applicationId={applicationId} canManage={canManage}/><h2>Incidentes correlacionados</h2>{!query.data?.length?<p>Sin incidentes registrados. Las señales nuevas aparecerán cuando el evaluador produzca una revisión.</p>:query.data.map(incident=><IncidentCard key={incident.id} organizationId={organizationId} applicationId={applicationId} incidentId={incident.id} canManage={canManage}/>)}</section>;
}

function ProbeRouteSettings({organizationId,applicationId,canManage}:{organizationId:string;applicationId:string;canManage:boolean}) {
  const scope={organizationId,applicationId}; const client=useQueryClient();
  const query=useQuery({queryKey:['triage-probe-route',organizationId,applicationId],queryFn:()=>triageApi.getProbeRoute(scope)});
  const [selection,setSelection]=useState(''); const [route,setRoute]=useState<'/'|'/\.well-known/security.txt'|'/security.txt'|'/robots.txt'|'/sitemap.xml'>('/'); const [role,setRole]=useState<'application'|'control'>('application');
  useEffect(()=>{if(query.data){const configured=query.data.routes.find(item=>item.route===route)??query.data.routes[0];setSelection(configured?`${configured.serviceId}:${configured.dependencyId??'none'}`:'');if(configured){setRoute(configured.route);setRole(configured.role);}}},[query.data]);
  const mutation=useMutation({mutationFn:(value:{route:'/'|'/\.well-known/security.txt'|'/security.txt'|'/robots.txt'|'/sitemap.xml';serviceId:string;dependencyId:string|null;role:'application'|'control'})=>triageApi.declareProbeRoute(scope,value),onSuccess:()=>client.invalidateQueries({queryKey:['triage-probe-route',organizationId,applicationId]})});
  const selected=query.data?.options.find(option=>`${option.serviceId}:${option.dependencyId??'none'}`===selection);
  if(query.isPending)return <section className="customer-card customer-panel" role="status">Cargando declaración de ruta HTTPS…</section>;
  if(query.error)return <section className="customer-card customer-panel" role="alert"><h3>No se pudo cargar la configuración de ruta</h3><button className="customer-link-button" onClick={()=>query.refetch()}>Reintentar</button></section>;
  return <section className="customer-card customer-panel"><h2>Declaración de las comprobaciones HTTPS</h2><p>Las rutas disponibles se limitan al target HTTPS consentido. Un perfil raíz permite solo <code>/</code>; el perfil de superficie pública permite cinco rutas estáticas del mismo origen. Estas declaraciones no añaden targets.</p>
    {query.data.options.length===0?<p>Declara primero un servicio en el inventario de la aplicación.</p>:<>
      <label>Ruta consentida<select aria-label="Ruta HTTPS consentida" disabled={!canManage||mutation.isPending} value={route} onChange={event=>setRoute(event.target.value as typeof route)}>{query.data.allowedRoutes.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
      <label>Servicio y dependencia<select aria-label="Servicio y dependencia de la ruta HTTPS" disabled={!canManage||mutation.isPending} value={selection} onChange={event=>{setSelection(event.target.value);if(!event.target.value.endsWith(':none'))setRole('application');}}><option value="">Seleccionar…</option>{query.data.options.map(option=><option key={`${option.serviceId}:${option.dependencyId??'none'}`} value={`${option.serviceId}:${option.dependencyId??'none'}`}>{option.service}{option.provider?` · depende de ${option.provider} / ${option.component}`:' · sin dependencia declarada'}</option>)}</select></label>
      <label>Rol<select aria-label="Rol de la ruta HTTPS" disabled={!canManage||mutation.isPending||Boolean(selected?.dependencyId)} value={role} onChange={event=>setRole(event.target.value as 'application'|'control')}><option value="application">Aplicación</option><option value="control">Control independiente</option></select></label>
      <button className="customer-button customer-button-secondary" disabled={!canManage||!selected||mutation.isPending||(role==='control'&&selected.dependencyId!==null)} onClick={()=>selected&&mutation.mutate({route,serviceId:selected.serviceId,dependencyId:selected.dependencyId,role})}>Guardar declaración</button>
      {query.data.routes.map(item=><p role="note" key={item.route}>{item.route} declarada por {item.declaredBy} el {new Date(item.declaredAt).toLocaleString('es')}: {item.service}, {item.role==='control'?'control independiente':`dependencia ${item.dependsOnProvider??'sin atribución'}`}.</p>)}
      {mutation.error&&<p role="alert">No se pudo guardar. Verifica el inventario y el consentimiento HTTPS activo.</p>}
    </>}
  </section>;
}
