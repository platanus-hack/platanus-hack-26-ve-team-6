import { z } from 'zod';
import { customerScopeSchema } from './customer-assessment.js';
import { runtimeAttackKindSchema, runtimeAttackEvidenceSchema, runtimeSinkSchema } from './telemetry.js';

export const runtimeProtectionModeSchema = z.enum(['monitor', 'block']);
export const runtimeProtectionConfigSchema = customerScopeSchema.extend({
  mode: runtimeProtectionModeSchema,
  enabledDetectors: z.array(runtimeAttackKindSchema).max(4),
  version: z.number().int().nonnegative(),
  receiving: z.boolean(),
  lastEventAt: z.iso.datetime().nullable(),
}).strict();
const runtimeProtectionUpdateShape = {
  mode: runtimeProtectionModeSchema,
  enabledDetectors: z.array(runtimeAttackKindSchema).max(4),
};
function validateUniqueDetectors(value: { enabledDetectors: string[] }, context: z.RefinementCtx) {
  if (new Set(value.enabledDetectors).size !== value.enabledDetectors.length) context.addIssue({ code: 'custom', path: ['enabledDetectors'], message: 'Detector selections must be unique' });
}
export const runtimeProtectionUpdatePayloadSchema = z.object(runtimeProtectionUpdateShape).strict().superRefine(validateUniqueDetectors);
export const runtimeProtectionUpdateSchema = customerScopeSchema.extend(runtimeProtectionUpdateShape).strict().superRefine(validateUniqueDetectors);
export const runtimeProtectionPolicySchema = z.object({
  applicationId: z.uuid(),
  mode: runtimeProtectionModeSchema,
  enabledDetectors: z.array(runtimeAttackKindSchema).max(4),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();
export const signedRuntimeProtectionPolicySchema = z.object({
  policy: runtimeProtectionPolicySchema,
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const runtimeProtectionDetectionSchema = z.object({
  id: z.uuid(),
  kind: runtimeAttackKindSchema,
  sink: runtimeSinkSchema,
  route: z.string().min(1).max(200),
  evidence: runtimeAttackEvidenceSchema,
  outcome: z.enum(['blocked', 'unknown']),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
}).strict();

export type RuntimeProtectionConfig = z.infer<typeof runtimeProtectionConfigSchema>;
export type RuntimeProtectionPolicy = z.infer<typeof runtimeProtectionPolicySchema>;
export type RuntimeProtectionDetection = z.infer<typeof runtimeProtectionDetectionSchema>;
