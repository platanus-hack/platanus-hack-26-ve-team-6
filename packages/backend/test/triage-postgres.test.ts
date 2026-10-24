import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { fixture,liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';
const live=liveUrl?describe:describe.skip;
live('triage customer authorization on real PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof fixture>>;let api:ReturnType<typeof createBackend>;
 beforeAll(async()=>{f=await fixture();api=createBackend({database:f.databases.gotchu_api});});afterAll(async()=>{await f?.close();});
 it('keeps viewer read-only, audits user status, and never makes closure a health assertion',async()=>{
  const identity={userId:`triage:${randomUUID()}`};const workspace=await api.customers.createWorkspace(identity,{name:'Triage'});const app=await api.customers.createApplication(identity,{organizationId:workspace.id,name:'Application'});const scope={organizationId:workspace.id,applicationId:app.applicationId};
  const incidentId=randomUUID();const window={startedAt:'2026-10-24T11:30:00.000Z',endedAt:'2026-10-24T12:00:00.000Z'};
  const revision={id:'revision-a',revision:1,previousRevisionId:null,rulesVersion:'triage.rules.v1',inputDigest:'a'.repeat(64),impact:{observed:'unknown',affectedServices:[],window,checkedPoints:[],missingData:['No checked evidence']},hypotheses:[{kind:'unknown',status:'weak',confidence:'low',ruleIds:['scenario.unknown.investigable.v1'],evidenceFor:[],evidenceAgainst:[],missingData:['Fresh signals'],nextCheck:'Collect fresh scoped signals.'}],unknownInvestigable:['No catalog scenario is supported.']};
  await f.databases.gotchu_coordinator.tenant(scope.organizationId,tx=>tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',[scope.organizationId,scope.applicationId,incidentId,randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify(revision),JSON.stringify([])]));
  const viewer={userId:randomUUID()};await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')",[scope.organizationId,viewer.userId]);
  await expect(api.triage.updateStatus(viewer,{...scope,incidentId,status:'closed'})).rejects.toMatchObject({status:403});
  const closed=await api.triage.updateStatus(identity,{...scope,incidentId,status:'closed'});
  expect(closed.incident.status).toBe('closed');expect(closed.incident.latest?.impact.observed).toBe('unknown');
  await expect(api.triage.requestEvidence(viewer,{...scope,incidentId})).rejects.toMatchObject({status:403});
  await expect(api.triage.get(identity,{...scope,incidentId:randomUUID()})).rejects.toMatchObject({status:404});
  const audit=await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action='triage.status_changed' AND subject_id=$2",[scope.organizationId,incidentId]);
  expect(audit.rows[0]?.detail).toMatchObject({status:'closed',meaning:'user_triage_only'});
 });
 it('maps probe route settings to the strict DTO and preserves tenant authorization on real PostgreSQL',async()=>{
  const identity={userId:`triage-route:${randomUUID()}`};const workspace=await api.customers.createWorkspace(identity,{name:'Probe route settings'});const app=await api.customers.createApplication(identity,{organizationId:workspace.id,name:'Application'});const scope={organizationId:workspace.id,applicationId:app.applicationId};
  const environment=await api.context.createEnvironment(identity,{...scope,name:'production',kind:'production'});if(!environment)throw new Error('Environment fixture was not created');
  const service=await api.context.createService(identity,{...scope,environmentId:environment.id,name:'checkout',kind:'web'});if(!service)throw new Error('Service fixture was not created');
  const dependency=await api.context.createDependency(identity,{...scope,environmentId:environment.id,serviceId:service.id,kind:'provider_component',provider:'cloudflare',component:'Workers API',region:null});if(!dependency)throw new Error('Dependency fixture was not created');
  const targetId=randomUUID();
  await f.admin.query(`INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,challenge_hash,challenge_expires_at,verified_at,expires_at,scan_profile)
    VALUES($1,$2,$3,'https://example.com',1,'verified',$4,repeat('a',64),clock_timestamp()+interval '30 minutes',clock_timestamp(),clock_timestamp()+interval '1 hour','public_surface')`,[scope.organizationId,scope.applicationId,targetId,identity.userId]);
  await f.admin.query(`INSERT INTO gotchu.operation_monitors(organization_id,application_id,enabled,interval_seconds,target_id,target_version,providers,author_id)
    VALUES($1,$2,true,3600,$3,1,'[]'::jsonb,$4)`,[scope.organizationId,scope.applicationId,targetId,identity.userId]);

  const viewer={userId:`viewer:${randomUUID()}`};
  await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')",[scope.organizationId,viewer.userId]);
  await expect(api.triage.declareProbeRoute(viewer,{...scope,route:'/',serviceId:service.id,dependencyId:dependency.id,role:'application'})).rejects.toMatchObject({status:403});
  const before=await api.triage.getProbeRoute(viewer,scope);
  expect(before.options).toEqual(expect.arrayContaining([
    expect.objectContaining({serviceId:service.id,service:'checkout',dependencyId:null,provider:null,state:'declared'}),
    expect.objectContaining({serviceId:service.id,service:'checkout',dependencyId:dependency.id,provider:'cloudflare',component:'Workers API',state:'declared'}),
  ]));
  await api.triage.declareProbeRoute(identity,{...scope,route:'/',serviceId:service.id,dependencyId:dependency.id,role:'application'});
  await expect(api.triage.getProbeRoute(identity,scope)).resolves.toMatchObject({
    routes:[expect.objectContaining({route:'/',serviceId:service.id,service:'checkout',dependencyId:dependency.id,dependsOnProvider:'cloudflare',declared:true})],
  });
  await expect(api.triage.getProbeRoute({userId:randomUUID()},scope)).rejects.toMatchObject({status:403});
 });
});
