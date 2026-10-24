import { randomUUID } from 'node:crypto';
import { correlate, revise, correlationWindowInputSchema, type CorrelationWindowInput } from '@gotchu/triage';
import { operationObservationSchema } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';

type Observation = { id:string; body:{kind:string;observedAt:string;metrics:{windowStartedAt:string;windowEndedAt:string;requestCount:number;errorCount:number;latencyP95Ms:number|null;capacityUtilization:number|null}|null}; acceptedAt:string };
export function buildCorrelationInput(input:{now:Date;observations:readonly Observation[];context?:CorrelationWindowInput['context'];windowMs?:number}):CorrelationWindowInput {
  const windowMs=input.windowMs??30*60_000; const startMs=Math.floor(input.now.getTime()/windowMs)*windowMs; const startedAt=new Date(startMs).toISOString(); const endedAt=new Date(startMs+windowMs).toISOString();
  // Current stored metrics lack environment/service labels, so keep them app-level.
  const observations=input.observations.filter(item=>item.body.metrics&&Date.parse(item.body.metrics.windowEndedAt)>=Date.parse(startedAt));
  const grouped=new Map<string,{metric:'error_rate'|'latency_ms'|'request_rate'|'resource_utilization';service:string;environment:string;samples:{eventAt:string;acceptedAt:string;value:number}[]}>();
  for(const item of observations){const metrics=item.body.metrics;if(!metrics)continue;const service='application';const environment='application';const measures:[typeof grouped extends Map<string,infer V>?V extends {metric:infer M}?M:never:never,number|null][]=[['error_rate',metrics.requestCount?metrics.errorCount/metrics.requestCount:null],['latency_ms',metrics.latencyP95Ms],['request_rate',metrics.requestCount/Math.max(1,(Date.parse(metrics.windowEndedAt)-Date.parse(metrics.windowStartedAt))/1000)],['resource_utilization',metrics.capacityUtilization]];
    for(const [metric,value] of measures){if(value===null||!Number.isFinite(value))continue;const key=`${metric}:${service}:${environment}`;let series=grouped.get(key);if(!series){series={metric:metric as 'error_rate'|'latency_ms'|'request_rate'|'resource_utilization',service,environment,samples:[]};grouped.set(key,series);}series.samples.push({eventAt:metrics.windowEndedAt,acceptedAt:item.acceptedAt,value});}
  }
  const signals=[...grouped.entries()].map(([id,value])=>({id, ...value,sampling:1,freshnessMs:15*60_000}));
  const baselineRows=new Map<string,{error:number[];latency:number[];requests:number[];resource:number[]}>();
  for(const item of input.observations){const metrics=item.body.metrics;if(!metrics||Date.parse(metrics.windowEndedAt)>=Date.parse(startedAt))continue;const key='application:application';const existing=baselineRows.get(key)??{error:[],latency:[],requests:[],resource:[]};if(metrics.requestCount)existing.error.push(metrics.errorCount/metrics.requestCount);if(metrics.latencyP95Ms!==null)existing.latency.push(metrics.latencyP95Ms);existing.requests.push(metrics.requestCount/Math.max(1,(Date.parse(metrics.windowEndedAt)-Date.parse(metrics.windowStartedAt))/1000));if(metrics.capacityUtilization!==null)existing.resource.push(metrics.capacityUtilization);baselineRows.set(key,existing);}
  const average=(values:number[])=>values.length>=3?values.reduce((sum,value)=>sum+value,0)/values.length:undefined;
  const baselines=[...baselineRows.values()].flatMap(row=>{const errorRate=average(row.error),latencyMs=average(row.latency),requestRate=average(row.requests),resourceUtilization=average(row.resource);return errorRate!==undefined&&latencyMs!==undefined&&requestRate!==undefined&&resourceUtilization!==undefined?[{service:'application',environment:'application',errorRate,latencyMs,requestRate,resourceUtilization,authFailures:0}]:[];});
  return correlationWindowInputSchema.parse({window:{startedAt,endedAt},...(input.context?{context:input.context}:{}),signals,providerStatuses:[],probes:[],baselines,anomalies:[]});
}

export async function evaluateTriage(tx:Transaction,scope:{organizationId:string;applicationId:string},now=new Date()) {
  const observations=await tx.query<{id:string;body:unknown;accepted_at:Date;created_at:Date}>(`SELECT id,body,created_at AS accepted_at,created_at FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND created_at>clock_timestamp()-interval '7 days' ORDER BY created_at DESC LIMIT 500`,[scope.organizationId,scope.applicationId]);
  const context=await loadContext(tx,scope);
  const input=buildCorrelationInput({now,context,observations:observations.rows.map(row=>{const body=operationObservationSchema.parse(row.body);return {id:row.id,body:{kind:body.kind,observedAt:body.observedAt,metrics:body.metrics},acceptedAt:row.accepted_at.toISOString()};})});
  const first=correlate(input,{now,rulesVersion:'triage.rules.v1'});
  const environment=input.context?.environment??'production';
  const active=await tx.query<{id:string;last_evidence_at:Date;revision_body:unknown}>(`SELECT i.id,i.last_evidence_at,r.body AS revision_body FROM gotchu.triage_incidents i LEFT JOIN LATERAL(SELECT body FROM gotchu.triage_revisions WHERE organization_id=i.organization_id AND application_id=i.application_id AND incident_id=i.id ORDER BY revision DESC LIMIT 1)r ON true WHERE i.organization_id=$1 AND i.application_id=$2 AND i.environment=$3 AND i.status<>'closed' AND i.last_evidence_at>clock_timestamp()-interval '2 hours' ORDER BY i.last_evidence_at DESC LIMIT 1`,[scope.organizationId,scope.applicationId,environment]);
  const current=active.rows[0];const prior=current?.revision_body?JSON.parse(JSON.stringify(current.revision_body)):null;
  const revision=prior?revise(prior,input,{now,rulesVersion:'triage.rules.v1'}):first;const incidentId=current?.id??randomUUID();
  const evidenceRefs=[...observations.rows.map(row=>row.id),...revision.impact.checkedPoints,...revision.hypotheses.flatMap(hypothesis=>[...hypothesis.evidenceFor,...hypothesis.evidenceAgainst])].map(item=>typeof item==='string'?item:item.ref).slice(0,500);
  await tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',[scope.organizationId,scope.applicationId,incidentId,randomUUID(),environment,revision.impact.window.startedAt,revision.impact.window.endedAt,JSON.stringify(revision),JSON.stringify(evidenceRefs)]);
}

async function loadContext(tx:Transaction,scope:{organizationId:string;applicationId:string}):Promise<CorrelationWindowInput['context']>{
 const result=await tx.query<{environment:string;deployments:unknown;dependencies:unknown}>(`SELECT (SELECT name FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1) AS environment,
 coalesce((SELECT jsonb_agg(jsonb_build_object('service',s.name,'releaseId',d.release_id,'commit',d.commit_sha,'deployedAt',d.deployed_at,'state',d.state) ORDER BY d.deployed_at DESC) FROM gotchu.application_deployments d JOIN gotchu.application_services s ON s.organization_id=d.organization_id AND s.application_id=d.application_id AND s.id=d.service_id WHERE d.organization_id=$1 AND d.application_id=$2 AND d.environment_id=(SELECT id FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1)),'[]'::jsonb) AS deployments,
 coalesce((SELECT jsonb_agg(jsonb_build_object('service',s.name,'provider',d.provider,'component',d.component,'region',d.region,'state',d.state)) FROM gotchu.application_dependencies d JOIN gotchu.application_services s ON s.organization_id=d.organization_id AND s.application_id=d.application_id AND s.id=d.service_id WHERE d.organization_id=$1 AND d.application_id=$2 AND d.environment_id=(SELECT id FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1)),'[]'::jsonb) AS dependencies`,[scope.organizationId,scope.applicationId]);
 const row=result.rows[0];
 if(!row)return undefined;
 const deployments=Array.isArray(row.deployments)?row.deployments:[];
 const dependencies=Array.isArray(row.dependencies)?row.dependencies:[];
 if(row.environment===null&&deployments.length===0&&dependencies.length===0)return undefined;
 return correlationWindowInputSchema.shape.context.parse({...(row.environment?{environment:row.environment}:{}),service:'application',deployments,dependencies});
}
