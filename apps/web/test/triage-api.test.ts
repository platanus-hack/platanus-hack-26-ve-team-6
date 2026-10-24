import { describe,expect,it,vi } from 'vitest';
import { triageIncidentDetailSchema } from '@gotchu/contracts';
import { handleTriageApi } from '../src/server/triage-api.js';
const organizationId='10000000-0000-4000-8000-000000000001';const applicationId='20000000-0000-4000-8000-000000000002';const incidentId='30000000-0000-4000-8000-000000000003';
describe('customer triage API handler',()=>{
 it('passes the exact tenant, application and incident scope to an evidence request',async()=>{
  const scope={organizationId,applicationId};const identity={userId:'owner'};const requestEvidence=vi.fn(async()=>({requested:[],message:'No hay comprobaciones configuradas.'}));
  const detail=triageIncidentDetailSchema.parse({incident:{...scope,id:incidentId,environment:'production',windowStartedAt:'2026-10-24T11:30:00.000Z',windowEndedAt:'2026-10-24T12:00:00.000Z',status:'open',latest:null,createdAt:'2026-10-24T12:00:00.000Z',updatedAt:'2026-10-24T12:00:00.000Z'},revisions:[],requestableEvidence:[]});
  const service={list:async()=>[],get:async()=>detail,updateStatus:async()=>detail,requestEvidence};
  const response=await handleTriageApi(new Request('https://gotchu.test/api',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),identity,service,scope,['api','customer','workspaces',organizationId,'applications',applicationId,'incidents',incidentId,'evidence-requests']);
  expect(response).toEqual({requested:[],message:'No hay comprobaciones configuradas.'});
  expect(requestEvidence).toHaveBeenCalledWith(identity,{...scope,incidentId});
 });
});
