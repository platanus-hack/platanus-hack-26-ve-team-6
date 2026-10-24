import { runReadToolSchema, safeCheckpointSchema } from '@gotchu/agent';
import { z } from 'zod';

const uuid = z.uuid();
const evidenceIds = z.array(uuid).min(1).max(20)
  .refine(ids => new Set(ids).size === ids.length, 'Evidence IDs must be unique');

// This is the gateway's exported durable-job input boundary, shared with the coordinator.
export const gatewayJobPayloadSchema = z.object({ incidentId: uuid, evidenceIds }).strict();
export const inputRequestSchema = z.object({ organizationId: uuid, applicationId: uuid }).strict();
export const readRequestSchema = inputRequestSchema.extend({
  callId: uuid,
  callType: z.enum(['required_evidence', 'additional']),
  name: z.enum([...runReadToolSchema.options, 'repository.excerpt.read', 'inventory.snapshot.read']),
  evidenceId: uuid,
});
export const checkpointRequestSchema = z.object({
  organizationId: uuid,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checkpoint: safeCheckpointSchema,
}).strict();
export const modelRequestSchema = inputRequestSchema.extend({
  reservationId: uuid,
  systemInstruction: z.string().max(4_000),
  userContext: z.string().max(17_000),
  maxOutputTokens: z.number().int().min(1).max(2_048),
  remainingTokens: z.number().int().min(1).max(20_000),
  remainingSpendMicroUsd: z.number().int().min(1).max(250_000),
});
export const gatewayOperationSchema = z.enum(['input', 'read', 'checkpoint.load', 'checkpoint.save', 'model']);
export type GatewayOperation = z.infer<typeof gatewayOperationSchema>;
