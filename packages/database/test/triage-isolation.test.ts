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
  }
  const history=await f.databases.gotchu_api.tenant(f.a.organizationId,tx=>tx.query<{revision:number}>(`SELECT revision FROM gotchu.triage_revisions WHERE organization_id=$1 AND application_id=$2 AND incident_id=$3 ORDER BY revision DESC`,[f.a.organizationId,f.a.applicationId,incidentId]));
  expect(history.rows.map(row=>row.revision)).toEqual([2,1]);
 });
});
