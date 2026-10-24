import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture, liveUrl } from './support.js';
const live=liveUrl?describe:describe.skip;
live('triage revision RLS and append-only storage on real PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof fixture>>;
 beforeAll(async()=>{f=await fixture();});afterAll(async()=>{await f?.close();});
 it('scopes revisions to tenant and application, deduplicates input, preserves order, and rejects mutation',async()=>{
  const incidentId=randomUUID();
  const window={startedAt:'2026-10-24T11:30:00.000Z',endedAt:'2026-10-24T12:00:00.000Z'};
  const revision=(number:number,id:string,digest:string,previousRevisionId:string|null)=>({id,revision:number,previousRevisionId,rulesVersion:'triage.rules.v1',inputDigest:digest,impact:{observed:'unknown',affectedServices:[],window,checkedPoints:[],missingData:['No current signal']},hypotheses:[{kind:'unknown',status:'weak',confidence:'low',ruleIds:['scenario.unknown.investigable.v1'],evidenceFor:[],evidenceAgainst:[],missingData:['Fresh signals'],nextCheck:'Collect fresh scoped signals.'}],unknownInvestigable:['No catalog scenario is supported.']});
  const insert=async(body:unknown)=>f.databases.gotchu_coordinator.tenant(f.a.organizationId,async tx=>tx.query<{inserted:boolean}>('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS inserted',[f.a.organizationId,f.a.applicationId,incidentId,randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify(body),JSON.stringify(['event-1'])]));
  expect((await insert(revision(1,'revision-a','a'.repeat(64),null))).rows[0]?.inserted).toBe(true);
  expect((await insert(revision(1,'revision-a','a'.repeat(64),null))).rows[0]?.inserted).toBe(false);
  expect((await insert(revision(2,'revision-b','b'.repeat(64),'revision-a'))).rows[0]?.inserted).toBe(true);
  for(const role of ['gotchu_api','gotchu_coordinator'] as const){
   await f.databases[role].tenant(f.b.organizationId,async tx=>expect((await tx.query('SELECT * FROM gotchu.triage_revisions WHERE organization_id=$1',[f.a.organizationId])).rows).toEqual([]));
   await f.databases[role].tenant(f.a.organizationId,async tx=>expect((await tx.query('SELECT * FROM gotchu.triage_revisions WHERE organization_id=$1 AND application_id=$2',[f.a.organizationId,f.b.applicationId])).rows).toEqual([]));
   await expect(f.databases[role].tenant(f.a.organizationId,tx=>tx.query('UPDATE gotchu.triage_revisions SET input_digest=$4 WHERE organization_id=$1 AND application_id=$2 AND incident_id=$3',[f.a.organizationId,f.a.applicationId,incidentId,'c'.repeat(64)]))).rejects.toMatchObject({code:'42501'});
   await expect(f.databases[role].tenant(f.a.organizationId,tx=>tx.query("UPDATE gotchu.triage_incidents SET status='closed' WHERE organization_id=$1 AND application_id=$2 AND id=$3",[f.a.organizationId,f.a.applicationId,incidentId]))).rejects.toMatchObject({code:'42501'});
  }
  const history=await f.databases.gotchu_api.tenant(f.a.organizationId,tx=>tx.query<{revision:number}>(`SELECT revision FROM gotchu.triage_revisions WHERE organization_id=$1 AND application_id=$2 AND incident_id=$3 ORDER BY revision DESC`,[f.a.organizationId,f.a.applicationId,incidentId]));
  expect(history.rows.map(row=>row.revision)).toEqual([2,1]);
  const viewer=`viewer:${randomUUID()}`;
  await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')",[f.a.organizationId,viewer]);
  await expect(f.databases.gotchu_api.tenant(f.a.organizationId,tx=>tx.query('SELECT gotchu.triage_update_status($1,$2,$3,$4,$5)',[f.a.organizationId,f.a.applicationId,viewer,incidentId,'closed']))).rejects.toThrow();
  await expect(f.databases.gotchu_api.tenant(f.a.organizationId,tx=>tx.query('SELECT gotchu.triage_update_status($1,$2,$3,$4,$5)',[f.a.organizationId,f.a.applicationId,f.a.userId,incidentId,'monitoring']))).resolves.toBeDefined();

  const oldIds=[randomUUID(),randomUUID(),randomUUID()];
  for(let index=0;index<oldIds.length;index++) {
   const oldId=oldIds[index];
   if(!oldId) throw new Error('missing incident fixture');
   const body={id:`retention-${index}`,revision:1,previousRevisionId:null,rulesVersion:'triage.rules.v1',inputDigest:String(index+1).repeat(64),impact:{observed:'unknown',affectedServices:[],window,checkedPoints:[],missingData:['No current signal']},hypotheses:[{kind:'unknown',status:'weak',confidence:'low',ruleIds:['scenario.unknown.investigable.v1'],evidenceFor:[],evidenceAgainst:[],missingData:['Fresh signals'],nextCheck:'Collect fresh scoped signals.'}],unknownInvestigable:['No catalog scenario is supported.']};
   await f.databases.gotchu_coordinator.tenant(f.a.organizationId,tx=>tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',[f.a.organizationId,f.a.applicationId,oldId,randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify(body),JSON.stringify([])]));
   await f.admin.query('UPDATE gotchu.triage_incidents SET last_evidence_at=$4,created_at=$4 WHERE organization_id=$1 AND application_id=$2 AND id=$3',[f.a.organizationId,f.a.applicationId,oldId,new Date(Date.parse('2026-10-24T10:00:00.000Z')+index*60_000)]);
  }
  await f.admin.query('SET ROLE gotchu_owner');
  try {
   const owner=await f.admin.query<{owner:string}>(`SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid='gotchu.triage_prune_old_incidents(integer,integer)'::regprocedure`);
   expect(owner.rows[0]?.owner).toBe('gotchu_owner');
   expect((await f.admin.query('SELECT gotchu.triage_prune_old_incidents(3,10) AS removed')).rows[0]?.removed).toBe(1);
  }
  finally { await f.admin.query('RESET ROLE'); }
  expect((await f.admin.query('SELECT incident_id FROM gotchu.triage_retention_audit WHERE organization_id=$1 AND application_id=$2',[f.a.organizationId,f.a.applicationId])).rows).toEqual([expect.objectContaining({incident_id:oldIds[0]})]);
  expect((await f.admin.query('SELECT id FROM gotchu.triage_incidents WHERE organization_id=$1 AND application_id=$2',[f.a.organizationId,f.a.applicationId])).rowCount).toBe(3);
  const saturatedBody={id:'capacity-new',revision:1,previousRevisionId:null,rulesVersion:'triage.rules.v1',inputDigest:'e'.repeat(64),impact:{observed:'unknown',affectedServices:[],window,checkedPoints:[],missingData:['No current signal']},hypotheses:[{kind:'unknown',status:'weak',confidence:'low',ruleIds:['scenario.unknown.investigable.v1'],evidenceFor:[],evidenceAgainst:[],missingData:['Fresh signals'],nextCheck:'Collect fresh scoped signals.'}],unknownInvestigable:['No catalog scenario is supported.']};
  await f.admin.query(`INSERT INTO gotchu.triage_incidents(organization_id,application_id,id,environment,window_started_at,window_ended_at)
    SELECT $1,$2,gen_random_uuid(),'production',$3,$4 FROM generate_series(1,497)`,[f.a.organizationId,f.a.applicationId,window.startedAt,window.endedAt]);
  const full=await f.databases.gotchu_coordinator.tenant(f.a.organizationId,tx=>tx.query<{inserted:boolean}>('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS inserted',[f.a.organizationId,f.a.applicationId,randomUUID(),randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify(saturatedBody),JSON.stringify([])]));
  expect(full.rows[0]?.inserted).toBe(false);
  expect((await f.admin.query("SELECT state FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2 AND capability='triage_projection'",[f.a.organizationId,f.a.applicationId])).rows[0]?.state).toBe('degraded');
  for(let revision=3;revision<=200;revision++) {
   const body={...saturatedBody,id:`revision-${revision}`,inputDigest:revision.toString(16).padStart(64,'0')};
   const inserted=await f.databases.gotchu_coordinator.tenant(f.a.organizationId,tx=>tx.query<{inserted:boolean}>('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS inserted',[f.a.organizationId,f.a.applicationId,incidentId,randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify(body),JSON.stringify([])]));
   expect(inserted.rows[0]?.inserted).toBe(true);
  }
  const capped=await f.databases.gotchu_coordinator.tenant(f.a.organizationId,tx=>tx.query<{inserted:boolean}>('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) AS inserted',[f.a.organizationId,f.a.applicationId,incidentId,randomUUID(),'production',window.startedAt,window.endedAt,JSON.stringify({...saturatedBody,inputDigest:'f'.repeat(64)}),JSON.stringify([])]));
  expect(capped.rows[0]?.inserted).toBe(false);
 });
});
