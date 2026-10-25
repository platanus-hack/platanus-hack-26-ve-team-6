import { z } from 'zod';
import { createMcpAccessTokenResponseSchema, createMcpAccessTokenSchema, mcpAccessTokenListSchema, mcpAccessTokenSchema } from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { errorResponse, HttpError, json, readBoundedBody } from './http.js';

type Service = Backend['mcpTokens'];

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415,'content_type','Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,4_096))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400,'invalid_json','El cuerpo no contiene JSON válido.'); }
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400,'invalid_input','La solicitud no coincide con el contrato permitido.');
  return parsed.data;
}

/** Session-authenticated management of MCP tokens: `/api/customer/workspaces/:id/mcp-tokens[/:tokenId]`. Same-origin is checked by the caller. */
export async function handleMcpTokensApi(request: Request, identity: Identity, service: Service, parts: readonly string[]): Promise<Response | null> {
  if (parts.length < 5 || parts[0] !== 'api' || parts[1] !== 'customer' || parts[2] !== 'workspaces' || parts[4] !== 'mcp-tokens') return null;
  try {
    const organizationId = parseInput(z.uuid().transform(value => value.toLowerCase()), parts[3]);
    if (parts.length === 5 && request.method === 'GET') return json(mcpAccessTokenListSchema.parse(await service.list(identity, { organizationId })));
    if (parts.length === 5 && request.method === 'POST') {
      const value = parseInput(createMcpAccessTokenSchema, await readBody(request));
      return json(createMcpAccessTokenResponseSchema.parse(await service.create(identity, { organizationId, ...value })), 201);
    }
    if (parts.length === 6 && request.method === 'DELETE') {
      const tokenId = parseInput(z.uuid(), parts[5]);
      return json(mcpAccessTokenSchema.parse(await service.revoke(identity, { organizationId, tokenId })));
    }
    throw new HttpError(404,'not_found','Ruta de tokens MCP no encontrada.');
  } catch (error) { return errorResponse(error); }
}
