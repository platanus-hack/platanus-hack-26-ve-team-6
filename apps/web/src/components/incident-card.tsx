import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { triageApi } from './triage-client';

const statusLabel = { open:'Abierto', monitoring:'En seguimiento', closed:'Cerrado por el equipo' } as const;
const impactLabel = { none_observed_at_checked_points:'No se observó impacto en los puntos comprobados', degraded:'Impacto degradado observado', unavailable:'Punto comprobado no disponible', unknown:'Impacto desconocido' } as const;
const kindLabel = { application_regression:'Regresión de aplicación', abuse:'Abuso', provider_dependency:'Dependencia o proveedor', legitimate_load:'Aumento de carga', unknown:'Sin explicación confirmada' } as const;
export function IncidentCard({ organizationId, applicationId, incidentId, canManage }: { organizationId:string; applicationId:string; incidentId:string; canManage:boolean }) {
  const scope={organizationId,applicationId}; const queryClient=useQueryClient();
  const query=useQuery({queryKey:['triage-incident',organizationId,applicationId,incidentId],queryFn:()=>triageApi.get(scope,incidentId)});
  const refresh=()=>queryClient.invalidateQueries({queryKey:['triage-incident',organizationId,applicationId,incidentId]});
  const status=useMutation({mutationFn:(value:'open'|'monitoring'|'closed')=>triageApi.status(scope,incidentId,value),onSuccess:refresh});
  const evidence=useMutation({mutationFn:()=>triageApi.requestEvidence(scope,incidentId)});
  if(query.isPending)return <section className="customer-card" role="status">Cargando incidente…</section>;
  if(query.error)return <section className="customer-card" role="alert"><h3>No se pudo cargar el incidente</h3><button onClick={()=>query.refetch()}>Reintentar</button></section>;
  const detail=query.data; if(!detail)return <section className="customer-card">No hay revisiones disponibles.</section>;
  const latest=detail.revisions[0]?.revision; if(!latest)return <section className="customer-card"><h3>Incidente sin evidencia</h3><p>La evaluación todavía no produjo una revisión.</p></section>;
  const requestable=detail.requestableEvidence.length>0 && (detail.incident.latest?.impact.missingData.length || latest.hypotheses.some(h=>h.missingData.length));
  return <article className="customer-card" aria-labelledby={`incident-${incidentId}`}>
    <header className="customer-card-heading"><div><span className="customer-eyebrow">{detail.incident.environment} · {detail.incident.latest?.rulesVersion}</span><h2 id={`incident-${incidentId}`}>Incidente · {impactLabel[latest.impact.observed]}</h2></div><label>Estado del triage<select aria-label="Estado del triage" disabled={!canManage||status.isPending} value={detail.incident.status} onChange={e=>status.mutate(e.target.value as 'open'|'monitoring'|'closed')}>{Object.entries(statusLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></header>
    <section><h3>Qué observamos</h3><p>{impactLabel[latest.impact.observed]}</p>{latest.impact.affectedServices.length>0&&<p>Servicios afectados: {latest.impact.affectedServices.join(', ')}</p>}<ul>{latest.impact.checkedPoints.map(item=><li key={item.ref}>{item.detail}</li>)}</ul></section>
    <section><h3>Qué puede explicarlo</h3>{latest.hypotheses.map((hypothesis,index)=><details key={`${hypothesis.kind}-${index}`}><summary>{kindLabel[hypothesis.kind]} · {hypothesis.status} · confianza {hypothesis.confidence}</summary><p>Evidencia a favor</p><ul>{hypothesis.evidenceFor.map(item=><li key={item.ref}>{item.detail}</li>)}</ul><p>Evidencia en contra</p><ul>{hypothesis.evidenceAgainst.map(item=><li key={item.ref}>{item.detail}</li>)}</ul><p>Reglas: {hypothesis.ruleIds.join(', ')||'ninguna'}</p>{hypothesis.missingData.length>0&&<p>Falta: {hypothesis.missingData.join(' ')}</p>}</details>)}</section>
    <section><h3>Qué no comprobamos</h3><ul>{[...latest.impact.missingData,...latest.unknownInvestigable].length===0?<li>No hay datos faltantes declarados para esta ventana; la cobertura sigue limitada a los puntos comprobados.</li>:[...latest.impact.missingData,...latest.unknownInvestigable].map((item,index)=><li key={`${index}-${item}`}>{item}</li>)}</ul></section>
    <section><h3>Historial</h3><ol>{detail.revisions.map(({revision,createdAt},index)=><li key={revision.id}>Revisión {revision.revision} · {new Date(createdAt).toLocaleString('es')} · {index===0?'actual':`impacto: ${impactLabel[revision.impact.observed]}`}</li>)}</ol></section>
    {detail.revisions.some(({revision})=>revision.hypotheses.some(h=>h.kind==='provider_dependency'&&h.evidenceFor.some(item=>item.detail.includes('(fixture)'))))&&<p role="note">Feed de proveedor simulado (fixture).</p>}
    <button className="customer-button customer-button-secondary" disabled={!canManage||!requestable||evidence.isPending} title={!requestable?'No hay evidencia faltante solicitada mediante una comprobación ya configurada.':undefined} onClick={()=>evidence.mutate()}>Obtener evidencia faltante</button>{!requestable&&<p>No hay comprobaciones consentidas disponibles para solicitar.</p>}{evidence.data&&<p role="status">{evidence.data.message}</p>}{evidence.error&&<p role="alert">No se pudo solicitar la evidencia.</p>}{status.error&&<p role="alert">No se pudo actualizar el estado del triage.</p>}
  </article>;
}

export function IncidentList({ organizationId, applicationId, canManage }: { organizationId:string; applicationId:string; canManage:boolean }) {
  const query=useQuery({queryKey:['triage-incidents',organizationId,applicationId],queryFn:()=>triageApi.list({organizationId,applicationId})});
  if(query.isPending)return <section className="customer-card" role="status">Cargando incidentes…</section>;
  if(query.error)return <section className="customer-card" role="alert"><h2>No se pudieron cargar los incidentes</h2><button onClick={()=>query.refetch()}>Reintentar</button></section>;
  if(!query.data?.length)return <section className="customer-card"><h2>Sin incidentes registrados</h2><p>Las señales nuevas aparecerán cuando el evaluador produzca una revisión.</p></section>;
  return <section className="customer-section"><h2>Incidentes correlacionados</h2>{query.data.map(incident=><IncidentCard key={incident.id} organizationId={organizationId} applicationId={applicationId} incidentId={incident.id} canManage={canManage}/>)}</section>;
}
