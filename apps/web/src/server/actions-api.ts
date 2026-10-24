import { z } from 'zod';
import type { Backend, Identity } from '@gotchu/backend';
import { HttpError, json, readBoundedBody } from './http.js';

const id = z.uuid().transform(value => value.toLowerCase());
const proposalIdSchema = z.object({ proposalId: id, actionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const proposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_patch_pull_request'), sourceRef: z.object({ type: z.literal('correction_candidate'), candidateId: id }).strict() }).strict(),
  z.object({ kind: z.literal('dependency_pull_request'), sourceRef: z.object({ type: z.literal('dependency_candidate'), candidateId: id }).strict() }).strict(),
]);
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 8_192))); }
  catch { throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return result.data;
}
export async function handleActionsApi(request: Request, identity: Identity, actions: Backend['actions'], parts: string[]): Promise<Response | null> {
  if (parts.length < 7 || parts[6] !== 'actions') return null;
  const organizationId = parse(id, parts[3]);
  const applicationId = parse(id, parts[5]);
  const scope = { organizationId, applicationId };
  if (parts.length === 7 && request.method === 'GET') return json(await actions.list(identity, scope));
  if (parts.length === 7 && request.method === 'POST') {
    const input = parse(proposalSchema, await readJson(request));
    return json(await actions.propose(identity, { ...scope, ...input }), 201);
  }
  if (parts.length === 8 && request.method === 'GET') return json(await actions.get(identity, { ...scope, proposalId: parse(id, parts[7]) }));
  if (parts.length === 9 && request.method === 'POST') {
    const proposalId = parse(id, parts[7]);
    if (parts[8] === 'eligibility') return json(await actions.getEligibility(identity, { ...scope, proposalId }));
    if (parts[8] === 'approve') {
      const input = parse(proposalIdSchema.extend({ stepUpProof: z.string().min(1).max(4096) }), await readJson(request));
      if (input.proposalId !== proposalId) throw new HttpError(400, 'invalid_input', 'La propuesta del cuerpo no coincide con la ruta.');
      return json(await actions.approve(identity, { ...scope, ...input }));
    }
    if (parts[8] === 'reject' || parts[8] === 'cancel') {
      parse(z.object({}).strict(), await readJson(request));
      await actions.cancel(identity, { ...scope, proposalId, reason: parts[8] === 'reject' ? 'rejected' : 'cancelled' });
      return json({ accepted: true }, 202);
    }
  }
  return null;
}
