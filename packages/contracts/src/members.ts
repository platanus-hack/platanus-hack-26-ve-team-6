import { z } from 'zod';

export const workspaceRoleSchema = z.enum(['owner', 'operator', 'viewer']);
export const inviteRoleSchema = z.enum(['operator', 'viewer']);
export const memberSchema = z.object({
  userId: z.string().min(1).max(256),
  email: z.email().nullable(),
  role: workspaceRoleSchema,
  joinedAt: z.iso.datetime(),
}).strict();
export const memberListSchema = z.array(memberSchema).max(100);
export const workspaceInvitationSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: inviteRoleSchema,
  invitedBy: z.string().min(1).max(256),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();
export const invitationListSchema = z.array(workspaceInvitationSchema).max(50);
export const createInvitationSchema = z.object({
  organizationId: z.uuid(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: inviteRoleSchema,
}).strict();
export const memberMutationSchema = z.object({
  organizationId: z.uuid(),
  userId: z.string().min(1).max(256),
}).strict();
export const changeMemberRoleSchema = memberMutationSchema.extend({ role: workspaceRoleSchema }).strict();
export const revokeInvitationSchema = z.object({ organizationId: z.uuid(), invitationId: z.uuid() }).strict();
export const acceptInvitationSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const createdInvitationSchema = z.object({
  invitation: workspaceInvitationSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  invitationUrl: z.url(),
}).strict();

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceMember = z.infer<typeof memberSchema>;
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;
