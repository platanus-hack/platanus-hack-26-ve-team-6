import { z } from 'zod';
import { evidenceRequestResponseSchema, triageIncidentDetailSchema, triageIncidentSchema, updateIncidentStatusSchema, triageProbeRouteSettingsSchema, triageProbeRouteInputSchema } from '@gotchu/contracts';
import { customerRequest } from './customer-client';
const listSchema = z.array(triageIncidentSchema).max(500);
type Scope = { organizationId: string; applicationId: string };
function path(scope: Scope) { return `/api/customer/workspaces/${encodeURIComponent(scope.organizationId)}/applications/${encodeURIComponent(scope.applicationId)}/incidents`; }
export const triageApi = {
  list: (scope: Scope) => customerRequest(path(scope),listSchema),
  get: (scope: Scope,id: string) => customerRequest(`${path(scope)}/${encodeURIComponent(z.uuid().parse(id))}`,triageIncidentDetailSchema),
  status: (scope: Scope,id: string,status: 'open'|'monitoring'|'closed') => customerRequest(`${path(scope)}/${encodeURIComponent(z.uuid().parse(id))}`,triageIncidentDetailSchema,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updateIncidentStatusSchema.parse({status}))}),
  requestEvidence: (scope: Scope,id: string) => customerRequest(`${path(scope)}/${encodeURIComponent(z.uuid().parse(id))}/evidence-requests`,evidenceRequestResponseSchema,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),
  getProbeRoute: (scope: Scope) => customerRequest(`${path(scope)}/probe-route`,triageProbeRouteSettingsSchema),
  declareProbeRoute: (scope: Scope,input: {route:'/'|'/\.well-known/security.txt'|'/security.txt'|'/robots.txt'|'/sitemap.xml';serviceId:string;dependencyId:string|null;role:'application'|'control'}) => customerRequest(`${path(scope)}/probe-route`,triageProbeRouteSettingsSchema,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(triageProbeRouteInputSchema.omit({organizationId:true,applicationId:true}).parse(input))}),
};
