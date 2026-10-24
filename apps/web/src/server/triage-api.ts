import { evidenceRequestResponseSchema, triageIncidentDetailSchema, triageIncidentSchema, updateIncidentStatusSchema } from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { HttpError, readBoundedBody } from './http.js';

export async function handleTriageApi(request: Request, identity: Identity, service: Backend['triage'], scope: { organizationId: string; applicationId: string }, parts: string[]) {
  const segment = parts[6];
  if (segment !== 'incidents') return null;
  if (parts.length === 7 && request.method === 'GET') return triageIncidentSchema.array().max(500).parse(await service.list(identity,scope));
  const incidentId = parts[7];
  if (!incidentId) throw new HttpError(404,'not_found','Incidente no encontrado.');
  if (parts.length === 8 && request.method === 'GET') return triageIncidentDetailSchema.parse(await service.get(identity,{...scope,incidentId}));
  if (parts.length === 8 && request.method === 'PATCH') {
    const input = updateIncidentStatusSchema.parse(await readJson(request));
    return triageIncidentDetailSchema.parse(await service.updateStatus(identity,{...scope,incidentId,...input}));
  }
  if (parts.length === 9 && parts[8] === 'evidence-requests' && request.method === 'POST') {
    await readJson(request);
    return evidenceRequestResponseSchema.parse(await service.requestEvidence(identity,{...scope,incidentId}));
  }
  throw new HttpError(404,'not_found','Ruta de incidentes no encontrada.');
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415,'content_type','Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,8192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400,'invalid_json','El cuerpo no contiene JSON válido.'); }
}
