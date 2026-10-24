import {
  acceptInvitationSchema, changeMemberRoleSchema, createInvitationSchema, createdInvitationSchema,
  invitationListSchema, memberListSchema, memberMutationSchema, revokeInvitationSchema,
} from '@gotchu/contracts';
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client.js';
import { z } from 'zod';

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() }).passthrough();
const responseSchema = z.object({}).passthrough();
async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new CustomerApiError(0, 'network_error', 'No se pudo conectar con Gotchu. Comprueba tu conexión e inténtalo de nuevo.'); }
  const payload: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = errorSchema.safeParse(payload);
    throw new CustomerApiError(response.status, error.success ? error.data.error.code : 'request_failed', error.success ? error.data.error.message : 'No se pudo completar la solicitud.');
  }
  const value = schema.safeParse(payload);
  if (!value.success) throw new CustomerApiError(response.status, 'invalid_response', 'El servidor devolvió una respuesta que no se pudo leer.');
  return value.data;
}
const body = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const orgPath = (organizationId: string, suffix: string) => `/api/customer/workspaces/${encodeURIComponent(z.uuid().parse(organizationId))}/${suffix}`;

export const membersApi = {
  list(organizationId: string): Promise<WorkspaceMember[]> { return request(orgPath(organizationId, 'members'), memberListSchema); },
  invitations(organizationId: string): Promise<WorkspaceInvitation[]> { return request(orgPath(organizationId, 'invitations'), invitationListSchema); },
  invite(organizationId: string, email: string, role: 'operator' | 'viewer') {
    const input = createInvitationSchema.parse({ organizationId, email, role });
    return request(orgPath(input.organizationId, 'invitations'), createdInvitationSchema, body({ email: input.email, role: input.role }));
  },
  async revokeInvitation(organizationId: string, invitationId: string): Promise<void> {
    const input = revokeInvitationSchema.parse({ organizationId, invitationId });
    await request(orgPath(input.organizationId, `invitations/${encodeURIComponent(input.invitationId)}`), responseSchema, { method: 'DELETE' });
  },
  async changeRole(organizationId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const input = changeMemberRoleSchema.parse({ organizationId, userId, role });
    await request(orgPath(input.organizationId, `members/${encodeURIComponent(input.userId)}/role`), responseSchema, { ...body({ role: input.role }), method: 'PATCH' });
  },
  async remove(organizationId: string, userId: string): Promise<void> {
    const input = memberMutationSchema.parse({ organizationId, userId });
    await request(orgPath(input.organizationId, `members/${encodeURIComponent(input.userId)}`), responseSchema, { method: 'DELETE' });
  },
  async leave(organizationId: string): Promise<void> {
    await request(orgPath(organizationId, 'members/leave'), responseSchema, body({}));
  },
  accept(token: string): Promise<{ organizationId: string; role: 'operator' | 'viewer' }> {
    const input = acceptInvitationSchema.parse({ token });
    return request('/api/customer/invitations/accept', z.object({ organizationId: z.uuid(), role: z.enum(['operator', 'viewer']) }).strict(), body(input));
  },
};
