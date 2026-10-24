import { z } from 'zod';
import { idSchema } from '@gotchu/contracts';
import type { AuthService } from './auth.js';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';

const scope = { organizationId: idSchema, applicationId: idSchema };
const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applications.list'), organizationId: idSchema }).strict(),
  z.object({ kind: z.literal('incidents.list'), ...scope }).strict(),
  z.object({ kind: z.literal('coverage.get'), ...scope }).strict(),
  z.object({ kind: z.literal('proposals.list'), ...scope }).strict(),
  z.object({ kind: z.literal('audit.queue'), ...scope, idempotencyKey: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('job.get'), organizationId: idSchema, jobId: idSchema }).strict(),
  z.object({ kind: z.literal('proposal.approve'), organizationId: idSchema, proposalId: idSchema, actionHash: z.string().regex(/^[a-f0-9]{64}$/), stepUpProof: z.string().min(1).max(4096) }).strict(),
]);
export type ApiOperation = z.infer<typeof operationSchema>;
export interface ApiServices {
  auth: AuthService;
  origin: string;
  ingest(input: { integrationId: string; timestamp: string; signature: string; rawBody: Buffer }): Promise<unknown>;
  execute(identity: { userId: string }, operation: ApiOperation): Promise<unknown>;
}

const approvalBody = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/), stepUpProof: z.string().min(1).max(4096) }).strict();
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'Input does not match the required contract');
  return result.data;
}

async function parseJson(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Use application/json');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 8192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON'); }
}

function operationFrom(request: Request, pathname: string): ApiOperation | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'organizations' || !parts[3]) return null;
  const organizationId = parts[3];
  if (request.method === 'GET' && parts.length === 5 && parts[4] === 'applications') return validated(operationSchema, { kind: 'applications.list', organizationId });
  if (request.method === 'GET' && parts.length === 6 && parts[4] === 'jobs') return validated(operationSchema, { kind: 'job.get', organizationId, jobId: parts[5] });
  if (parts.length === 7 && parts[4] === 'applications') {
    const applicationId = parts[5];
    const resource = parts[6];
    if (request.method === 'GET') {
      switch (resource) {
        case 'incidents': return validated(operationSchema, { kind: 'incidents.list', organizationId, applicationId });
        case 'coverage': return validated(operationSchema, { kind: 'coverage.get', organizationId, applicationId });
        case 'proposals': return validated(operationSchema, { kind: 'proposals.list', organizationId, applicationId });
      }
    }
    if (request.method === 'POST' && resource === 'audits') return validated(operationSchema, { kind: 'audit.queue', organizationId, applicationId, idempotencyKey: request.headers.get('Idempotency-Key') });
  }
  return null;
}

export function createApi(services: ApiServices) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/v1/events') {
        if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Use application/json');
        const integrationId = validated(idSchema, request.headers.get('X-Gotchu-Integration'));
        const timestamp = request.headers.get('X-Gotchu-Timestamp');
        const signature = request.headers.get('X-Gotchu-Signature');
        if (!timestamp || !signature) throw new HttpError(401, 'signature_required', 'Signed integration credentials are required');
        const result = await services.ingest({ integrationId, timestamp, signature, rawBody: await readBoundedBody(request, 256 * 1024) });
        return json(result, 202);
      }
      const identity = await services.auth.identity(request);
      if (!identity) throw new HttpError(401, 'unauthenticated', 'Sign in to access this resource');
      if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, services.origin);
      if (url.pathname === '/api/v1/session' && request.method === 'GET') {
        const headers = new Headers();
        for (const cookie of identity.cookies) headers.append('Set-Cookie', cookie);
        return json({ userId: identity.userId }, 200, headers);
      }
      let operation = operationFrom(request, url.pathname);
      const approval = /^\/api\/v1\/organizations\/([^/]+)\/proposals\/([^/]+)\/approvals$/.exec(url.pathname);
      if (approval && request.method === 'POST') {
        operation = validated(operationSchema, { kind: 'proposal.approve', organizationId: approval[1], proposalId: approval[2], ...validated(approvalBody, await parseJson(request)) });
      }
      if (!operation) throw new HttpError(404, 'not_found', 'No API operation matches this request');
      const result = await services.execute({ userId: identity.userId }, operation);
      const headers = new Headers();
      for (const cookie of identity.cookies) headers.append('Set-Cookie', cookie);
      return json(result, operation.kind === 'audit.queue' ? 202 : 200, headers);
    } catch (error) { return errorResponse(error); }
  };
}
