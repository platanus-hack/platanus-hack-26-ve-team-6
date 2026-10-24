import { z } from 'zod';

const days = z.number().int().min(1).max(3650);
const uuid = z.uuid().transform(value => value.toLowerCase());

export const workspaceRetentionPolicySchema = z.object({
  organizationId: uuid,
  sourceSnapshotDays: days,
  containerImageDays: days,
  reportDays: days,
  observationDays: days,
  runDays: days,
  notificationDeliveryDays: days,
  protectionEventDays: days,
  updatedAt: z.iso.datetime(),
}).strict();

export const workspaceRetentionPolicyInputSchema = workspaceRetentionPolicySchema
  .omit({ organizationId: true, updatedAt: true }).strict();

export type WorkspaceRetentionPolicy = z.infer<typeof workspaceRetentionPolicySchema>;
export type WorkspaceRetentionPolicyInput = z.infer<typeof workspaceRetentionPolicyInputSchema>;
