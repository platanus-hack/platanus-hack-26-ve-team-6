import { z } from 'zod';
import { sha256, type Backend, type Identity } from '@gotchu/backend';
import { errorResponse, HttpError, json, readBoundedBody } from './http.js';

const uuid = z.uuid().transform(id => id.toLowerCase());
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return result.data;
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 65_536))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}

export async function handleStepUpApi(request: Request, identity: Identity, stepUp: NonNullable<Backend['stepUp']>): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/customer/step-up/')) return null;
  try {
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    const send = (value: unknown, status = 200) => json(value, status, headers);
    const path = url.pathname.slice('/api/customer/step-up/'.length).split('/').filter(Boolean);
    if (path.length === 1 && path[0] === 'factors' && request.method === 'GET') {
      return send(await stepUp.list(identity, parse(uuid, url.searchParams.get('organizationId'))));
    }
    if (path.length === 2 && path[0] === 'factors' && path[1] === 'enrollment-options' && request.method === 'POST') {
      const value = parse(z.object({ organizationId: uuid, proof: z.string().min(32).max(128).optional(), password: z.string().min(1).max(128).optional() }).strict(), await body(request));
      return send(await stepUp.beginEnrollment(identity, value.organizationId, { ...(value.proof ? { proof: value.proof } : {}), ...(value.password ? { password: value.password } : {}) }), 201);
    }
    if (path.length === 2 && path[0] === 'factors' && path[1] === 'recovery-options' && request.method === 'POST') {
      const value = parse(z.object({ organizationId: uuid, recoveryCode: z.string().min(10).max(128) }).strict(), await body(request));
      return send(await stepUp.beginRecoveryEnrollment(identity, value), 201);
    }
    if (path.length === 2 && path[0] === 'factors' && path[1] === 'enrollment' && request.method === 'POST') {
      const value = parse(z.object({ organizationId: uuid, challengeId: uuid, response: z.unknown(), label: z.string().min(1).max(80) }).strict(), await body(request));
      return send(await stepUp.finishEnrollment(identity, value), 201);
    }
    if (path.length === 1 && path[0] === 'challenges' && request.method === 'POST') return send(await stepUp.beginChallenge(identity, await body(request)), 201);
    if (path.length === 1 && path[0] === 'assertions' && request.method === 'POST') {
      const value = parse(z.object({ organizationId: uuid, challengeId: uuid, response: z.unknown() }).strict(), await body(request));
      return send(await stepUp.finishAssertion(identity, value));
    }
    if (path.length === 2 && path[0] === 'factors' && request.method === 'PATCH') {
      const value = parse(z.object({ organizationId: uuid, label: z.string().min(1).max(80) }).strict(), await body(request));
      await stepUp.rename(identity, { ...value, factorId: parse(uuid, path[1]) });
      return send({ renamed: true });
    }
    if (path.length === 2 && path[0] === 'factors' && request.method === 'DELETE') {
      const value = parse(z.union([
        z.object({ organizationId: uuid, actionHash: z.string().regex(/^[a-f0-9]{64}$/), proof: z.string().min(32).max(128) }).strict(),
        z.object({ organizationId: uuid, recoveryCode: z.string().min(10).max(128) }).strict(),
      ]), await body(request));
      const factorId = parse(uuid, path[1]);
      if ('proof' in value) {
        const expectedActionHash = sha256(`gotchu:step-up:revoke:v1:${value.organizationId}:${factorId}`);
        if (value.actionHash !== expectedActionHash) throw new HttpError(400, 'step_up_action_mismatch', 'La verificación no corresponde a la revocación exacta de este factor.');
        await stepUp.verifier.verify({ proof: value.proof, userId: identity.userId, organizationId: value.organizationId, actionHash: value.actionHash });
        await stepUp.revoke(identity, { organizationId: value.organizationId, factorId });
      } else await stepUp.revokeWithRecovery(identity, { organizationId: value.organizationId, factorId, recoveryCode: value.recoveryCode });
      return send({ revoked: true });
    }
    throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
  } catch (error) { return errorResponse(error); }
}
