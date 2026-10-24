import {
  acceptInvitationSchema, changeMemberRoleSchema, createInvitationSchema, invitationListSchema,
  memberListSchema, memberMutationSchema, revokeInvitationSchema, workspaceInvitationSchema,
  createdInvitationSchema,
} from '@gotchu/contracts';
import type { Identity } from '@gotchu/backend';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import { z } from 'zod';

export interface MemberApiServices {
  list(identity: Identity, input: { organizationId: string }): Promise<unknown>;
  listInvitations(identity: Identity, input: { organizationId: string }): Promise<unknown>;
  invite(identity: Identity, input: { organizationId: string; email: string; role: 'operator' | 'viewer' }): Promise<{ invitation: unknown; token: string }>;
  revokeInvitation(identity: Identity, input: { organizationId: string; invitationId: string }): Promise<void>;
  accept(identity: Identity, email: string | null, input: { token: string }): Promise<{ organizationId: string; role: 'operator' | 'viewer' }>;
  changeRole(identity: Identity, input: { organizationId: string; userId: string; role: 'owner' | 'operator' | 'viewer' }): Promise<void>;
  remove(identity: Identity, input: { organizationId: string; userId: string }): Promise<void>;
  leave(identity: Identity, input: { organizationId: string }): Promise<void>;
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'content_type', 'Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 8_192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', 'El cuerpo no contiene JSON válido.'); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'La solicitud no coincide con el contrato permitido.');
  return result.data;
}
const uuid = (value: string) => {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'El identificador no es válido.');
  return result.data.toLowerCase();
};

/** Returns null for paths outside the exact member-management routes. */
export async function handleMembersApi(request: Request, identity: Identity, email: string | null, services: MemberApiServices, origin: string): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const isAccept = parts.length === 4 && parts[0] === 'api' && parts[1] === 'customer' && parts[2] === 'invitations' && parts[3] === 'accept';
  const isWorkspacePath = parts.length >= 5 && parts[0] === 'api' && parts[1] === 'customer' && parts[2] === 'workspaces'
    && (parts[4] === 'members' || parts[4] === 'invitations');
  if (!isAccept && !isWorkspacePath) return null;
  try {
    if (url.origin !== origin) throw new HttpError(400, 'untrusted_host', 'El origen del servicio no coincide con su configuración.');
    if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, origin);
    const orgId = isWorkspacePath ? uuid(parts[3] ?? '') : null;
    if (isAccept) {
      const input = parse(acceptInvitationSchema, await readJson(request));
      return json(await services.accept(identity, email, input));
    }
    if (parts.length === 5 && parts[4] === 'members' && request.method === 'GET') return json(memberListSchema.parse(await services.list(identity, { organizationId: orgId! })));
    if (parts.length === 6 && parts[4] === 'members' && request.method === 'DELETE') {
      const userId = decodeURIComponent(parts[5] ?? '');
      await services.remove(identity, { organizationId: orgId!, userId });
      return json({ removed: true });
    }
    if (parts.length === 6 && parts[4] === 'members' && parts[5] === 'leave' && request.method === 'POST') {
      await services.leave(identity, { organizationId: orgId! });
      return json({ left: true });
    }
    if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'role' && request.method === 'PATCH') {
      const userId = decodeURIComponent(parts[5] ?? '');
      const body = parse(changeMemberRoleSchema.pick({ role: true }), await readJson(request));
      await services.changeRole(identity, { organizationId: orgId!, userId, role: body.role });
      return json({ changed: true });
    }
    if (parts.length === 5 && parts[4] === 'invitations' && request.method === 'GET') return json(invitationListSchema.parse(await services.listInvitations(identity, { organizationId: orgId! })));
    if (parts.length === 5 && parts[4] === 'invitations' && request.method === 'POST') {
      const body = parse(createInvitationSchema.pick({ email: true, role: true }), await readJson(request));
      const result = await services.invite(identity, { organizationId: orgId!, ...body });
      const invitation = workspaceInvitationSchema.parse(result.invitation);
      return json(createdInvitationSchema.parse({ invitation, token: result.token, invitationUrl: `${origin}/dashboard#invitation=${encodeURIComponent(result.token)}` }), 201);
    }
    if (parts.length === 6 && parts[4] === 'invitations' && request.method === 'DELETE') {
      const input = parse(revokeInvitationSchema.pick({ invitationId: true }), { invitationId: uuid(parts[5] ?? '') });
      await services.revokeInvitation(identity, { organizationId: orgId!, invitationId: input.invitationId });
      return json({ revoked: true });
    }
    throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
  } catch (error) { return errorResponse(error); }
}
