import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { customerApi, CustomerApiError } from './customer-client';
import { requestStepUp } from './step-up-client';

const rules=['invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret'] as const;
export function WorkflowExceptions({userId,organizationId,applicationId,isOwner}:{userId:string;organizationId:string;applicationId:string;isOwner:boolean}){
  const client=useQueryClient(); const key=['customer-data',userId,'workflow-exceptions',organizationId,applicationId];
  const data=useQuery({queryKey:key,queryFn:()=>customerApi.workflowExceptions(organizationId,applicationId),retry:false});
  const [repositoryLinkId,setRepositoryLinkId]=useState(''); const [workflowPath,setWorkflowPath]=useState('.github/workflows/'); const [policyRule,setPolicyRule]=useState<typeof rules[number]>('pull_request_target'); const [justification,setJustification]=useState('');
  const refresh=()=>client.invalidateQueries({queryKey:key});
  const create=useMutation({mutationFn:async()=>{
    const fields={organizationId,applicationId,repositoryLinkId,workflowPath,rule:policyRule,justification};
    const {actionHash}=await customerApi.workflowExceptionHash(fields);
    const stepUpProof=await requestStepUp(organizationId,actionHash);
    return customerApi.createWorkflowException({...fields,stepUpProof});
  },onSuccess:refresh});
  const remove=useMutation({mutationFn:(row:NonNullable<typeof data.data>['exceptions'][number])=>customerApi.removeWorkflowException({organizationId,applicationId,repositoryLinkId:row.repositoryLinkId,id:row.id,version:row.version}),onSuccess:refresh});
  const selected=repositoryLinkId||data.data?.repositories[0]?.id||'';
  const error=create.error??remove.error??data.error;
  return <section className="customer-card" aria-labelledby="workflow-exceptions-title">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">REPOSITORIOS</span><h2 id="workflow-exceptions-title">Excepciones de workflow</h2></div></div>
    <p>Un Owner puede permitir una regla concreta para un archivo de workflow tras verificar su identidad.</p>
    {data.isPending&&<div className="customer-loading" role="status">Cargando vínculos de repositorio…</div>}
    {error&&<div className="customer-error" role="alert">{error instanceof CustomerApiError?error.message:error.message}</div>}
    {isOwner&&data.data?.repositories.length? <form onSubmit={event=>{event.preventDefault();create.mutate();}}>
      <label>Repositorio<select value={selected} onChange={event=>setRepositoryLinkId(event.target.value)}>{data.data.repositories.map(repo=><option key={repo.id} value={repo.id}>{repo.repositoryKey}</option>)}</select></label>
      <label>Archivo de workflow<input value={workflowPath} onChange={event=>setWorkflowPath(event.target.value)} required maxLength={180} /></label>
      <label>Regla exceptuada<select value={policyRule} onChange={event=>setPolicyRule(event.target.value as typeof rules[number])}>{rules.map(rule=><option key={rule}>{rule}</option>)}</select></label>
      <label>Justificación<textarea value={justification} onChange={event=>setJustification(event.target.value)} minLength={12} maxLength={1000} required /></label>
      <button className="customer-button" type="submit" disabled={!selected||create.isPending}>{create.isPending?'Verificando…':'Añadir excepción'}</button>
    </form>:!isOwner?<p>Solo un Owner puede administrar excepciones.</p>:<p>No hay vínculos de repositorio activos.</p>}
    <ul>{data.data?.exceptions.map(row=><li key={`${row.id}:${row.version}`}><code>{row.workflowPath}</code> · {row.rule} · {row.justification}{isOwner&&<button className="customer-link-button" type="button" disabled={remove.isPending} onClick={()=>remove.mutate(row)}>Quitar</button>}</li>)}</ul>
  </section>;
}
