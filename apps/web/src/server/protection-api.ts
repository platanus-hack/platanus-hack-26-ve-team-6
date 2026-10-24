import { z } from 'zod';
import {
  customerScopeSchema, runtimeProtectionConfigSchema, runtimeProtectionDetectionSchema,
  runtimeProtectionUpdatePayloadSchema, runtimeProtectionUpdateSchema,
} from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { HttpError, json, readBoundedBody } from './http.js';

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 8_192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}

export async function handleProtectionApi(request: Request, identity: Identity, service: Backend['protection'], parts: string[]): Promise<Response | null> {
  if (parts.length === 7 && parts[6] === 'protection') {
    const scope = customerScopeSchema.parse({ organizationId: parts[3], applicationId: parts[5] });
    if (request.method === 'GET') return json(runtimeProtectionConfigSchema.parse(await service.get(identity, scope)));
    if (request.method === 'PUT') {
      const update = runtimeProtectionUpdatePayloadSchema.parse(await body(request));
      const input = runtimeProtectionUpdateSchema.parse({ ...scope, ...update });
      return json(runtimeProtectionConfigSchema.parse(await service.update(identity, input)));
    }
  }
  if (parts.length === 8 && parts[6] === 'protection' && parts[7] === 'detections' && request.method === 'GET') {
    const scope = customerScopeSchema.parse({ organizationId: parts[3], applicationId: parts[5] });
    return json(z.array(runtimeProtectionDetectionSchema).max(100).parse(await service.listDetections(identity, scope)));
  }
  return null;
}
