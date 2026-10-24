import { randomBytes, randomUUID } from 'node:crypto';
import {
  acceptInvitationSchema, changeMemberRoleSchema, createInvitationSchema, invitationListSchema,
  memberListSchema, memberMutationSchema, revokeInvitationSchema,
  workspaceInvitationSchema, type WorkspaceInvitation, type WorkspaceMember,
} from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { authorize, BackendError, identitySchema, parse, sha256, type BaseDependencies, type Identity } from './core.js';

async function lockManagement(tx: Transaction, organizationId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace-members:'||$1::uuid::text,0))", [organizationId]);
}
async function translateLastOwner<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P0001' && error.message === 'workspace_last_owner') mapSqlError('last_owner');
    if (error instanceof Error && 'code' in error && error.code === 'P0001' && error.message === 'workspace_membership_lock_timeout') mapSqlError('membership_lock_timeout');
    throw error;
  }
}

async function translateMemberLockTimeout<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P0001' && error.message === 'workspace_membership_lock_timeout') mapSqlError('membership_lock_timeout');
    throw error;
  }
}

const organizationSchema = z.object({ organizationId: z.uuid() }).strict();
const principal = (identity: Identity) => parse(identitySchema, identity);
const mapSqlError = (code: string): never => {
  const messages: Record<string, { message: string; status: number }> = {
    forbidden: { message: 'Este cambio requiere el rol Owner.', status: 403 },
    not_found: { message: 'No se encontró el miembro o la invitación.', status: 404 },
    last_owner: { message: 'El último Owner no puede salir, ser eliminado ni perder su rol.', status: 409 },
    cannot_leave_as_owner: { message: 'Un Owner debe transferir su rol antes de salir.', status: 409 },
    pending_invitation_limit: { message: 'El espacio ya tiene 50 invitaciones pendientes.', status: 429 },
    daily_invitation_limit: { message: 'Se alcanzó el límite de 20 invitaciones en 24 horas.', status: 429 },
    member_limit: { message: 'El espacio alcanzó el límite de 100 miembros.', status: 429 },
    invitation_conflict: { message: 'Ya existe una membresía o invitación pendiente para ese correo.', status: 409 },
    invitation_invalid: { message: 'La invitación no es válida.', status: 404 },
    invitation_revoked: { message: 'La invitación fue revocada.', status: 409 },
    invitation_expired: { message: 'La invitación venció.', status: 410 },
    invitation_email_mismatch: { message: 'La cuenta activa no coincide con el correo invitado.', status: 403 },
    invitation_used: { message: 'La invitación ya fue utilizada.', status: 409 },
    already_member: { message: 'La cuenta ya es miembro del espacio.', status: 409 },
    membership_lock_timeout: { message: 'La membresía está cambiando. Inténtalo de nuevo.', status: 503 },
    invalid_role: { message: 'El rol solicitado no es válido.', status: 400 },
  };
  const error = messages[code] ?? { message: 'No se pudo completar el cambio de miembros.', status: 400 };
  throw new BackendError(code, error.message, error.status);
};
const invitationRow = z.object({ id: z.string(), email: z.string(), role: z.string(), invited_by: z.string(), created_at: z.coerce.date(), expires_at: z.coerce.date() });
const createdInvitationRow = z.object({ id: z.string(), email: z.string(), role: z.string(), invitedBy: z.string(), createdAt: z.coerce.date(), expiresAt: z.coerce.date() });
const memberRow = z.object({ user_id: z.string(), email: z.string().nullable(), role: z.string(), joined_at: z.date() });

export function createMemberService(deps: BaseDependencies) {
  const tenant = <T>(organizationId: string, work: (tx: Transaction) => Promise<T>) =>
    translateMemberLockTimeout(() => deps.database.tenant(organizationId, work));
  return {
    async list(identity: Identity, input: z.input<typeof organizationSchema>): Promise<WorkspaceMember[]> {
      const actor = principal(identity); const value = parse(organizationSchema, input);
      return tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor);
        const result = await tx.query('SELECT * FROM gotchu.workspace_members($1)', [value.organizationId]);
        return memberListSchema.parse(result.rows.map(row => {
          const parsed = memberRow.parse(row);
          return { userId: parsed.user_id, email: parsed.email, role: parsed.role, joinedAt: parsed.joined_at.toISOString() };
        }));
      });
    },
    async listInvitations(identity: Identity, input: z.input<typeof organizationSchema>): Promise<WorkspaceInvitation[]> {
      const actor = principal(identity); const value = parse(organizationSchema, input);
      return tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, ['owner']);
        const result = await tx.query('SELECT * FROM gotchu.workspace_invitations_list($1)', [value.organizationId]);
        return invitationListSchema.parse(result.rows.map(row => {
          const parsed = invitationRow.parse(row);
          return { id: parsed.id, email: parsed.email, role: parsed.role, invitedBy: parsed.invited_by,
            createdAt: parsed.created_at.toISOString(), expiresAt: parsed.expires_at.toISOString() };
        }));
      });
    },
    async invite(identity: Identity, input: z.input<typeof createInvitationSchema>) {
      const actor = principal(identity); const value = parse(createInvitationSchema, input);
      const token = randomBytes(32).toString('base64url'); const id = randomUUID();
      return tenant(value.organizationId, async tx => {
        await lockManagement(tx, value.organizationId);
        const result = await tx.query<{ result: unknown }>('SELECT gotchu.workspace_invite($1,$2,$3,$4,$5,$6) AS result',
          [value.organizationId, id, actor.userId, value.email, value.role, sha256(token)]);
        const response = z.object({ error: z.string().optional(), invitation: createdInvitationRow.optional() }).parse(result.rows[0]?.result);
        if (typeof response.error === 'string') mapSqlError(response.error);
        const returned = response.invitation;
        const invitation: WorkspaceInvitation = workspaceInvitationSchema.parse(returned && { ...returned,
          createdAt: returned.createdAt.toISOString(), expiresAt: returned.expiresAt.toISOString() });
        return { invitation, token };
      });
    },
    async revokeInvitation(identity: Identity, input: z.input<typeof revokeInvitationSchema>): Promise<void> {
      const actor = principal(identity); const value = parse(revokeInvitationSchema, input);
      await tenant(value.organizationId, async tx => {
        await lockManagement(tx, value.organizationId);
        const result = await tx.query<{ result: string }>('SELECT gotchu.workspace_invitation_revoke($1,$2,$3) AS result', [value.organizationId, value.invitationId, actor.userId]);
        if (result.rows[0]?.result !== 'ok') mapSqlError(result.rows[0]?.result ?? 'not_found');
      });
    },
    async accept(identity: Identity, accountEmail: string | null, input: z.input<typeof acceptInvitationSchema>) {
      const actor = principal(identity); const value = parse(acceptInvitationSchema, input);
      if (!accountEmail) throw new BackendError('invitation_rejected', 'La invitación no se pudo aceptar con esta cuenta.', 403);
      const email = z.email().parse(accountEmail).toLowerCase();
      return tenant('00000000-0000-0000-0000-000000000000', async tx => {
        const invitation = await tx.query<{ organization_id: string | null }>('SELECT gotchu.workspace_invitation_organization($1) AS organization_id', [sha256(value.token)]);
        const organizationId = invitation.rows[0]?.organization_id;
        if (organizationId) await lockManagement(tx, organizationId);
        const result = await tx.query<{ result: unknown }>('SELECT gotchu.workspace_invitation_accept($1,$2,$3) AS result',
          [sha256(value.token), actor.userId, email]);
        const response = z.record(z.string(), z.unknown()).parse(result.rows[0]?.result);
        if (typeof response.error === 'string') mapSqlError(response.error);
        return z.object({ organizationId: z.uuid(), role: z.enum(['operator','viewer']) }).parse(response);
      });
    },
    async changeRole(identity: Identity, input: z.input<typeof changeMemberRoleSchema>): Promise<void> {
      const actor = principal(identity); const value = parse(changeMemberRoleSchema, input);
      await translateLastOwner(() => deps.database.tenant(value.organizationId, async tx => {
        await lockManagement(tx, value.organizationId);
        const result = await tx.query<{ result: string }>('SELECT gotchu.workspace_member_change_role($1,$2,$3,$4) AS result',
          [value.organizationId, value.userId, value.role, actor.userId]);
        if (result.rows[0]?.result !== 'ok') mapSqlError(result.rows[0]?.result ?? 'not_found');
      }));
    },
    async remove(identity: Identity, input: z.input<typeof memberMutationSchema>): Promise<void> {
      const actor = principal(identity); const value = parse(memberMutationSchema, input);
      await translateLastOwner(() => deps.database.tenant(value.organizationId, async tx => {
        await lockManagement(tx, value.organizationId);
        const result = await tx.query<{ result: string }>('SELECT gotchu.workspace_member_remove($1,$2,$3) AS result',
          [value.organizationId, value.userId, actor.userId]);
        if (result.rows[0]?.result !== 'ok') mapSqlError(result.rows[0]?.result ?? 'not_found');
      }));
    },
    async leave(identity: Identity, input: z.input<typeof organizationSchema>): Promise<void> {
      const actor = principal(identity);
      const value = parse(organizationSchema, input);
      await translateLastOwner(() => deps.database.tenant(value.organizationId, async tx => {
        await lockManagement(tx, value.organizationId);
        const result = await tx.query<{ result: string }>('SELECT gotchu.workspace_member_remove($1,$2,$2) AS result', [value.organizationId, actor.userId]);
        if (result.rows[0]?.result !== 'ok') mapSqlError(result.rows[0]?.result ?? 'not_found');
      }));
    },
  };
}
