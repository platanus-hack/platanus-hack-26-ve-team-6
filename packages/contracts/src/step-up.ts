import { z } from 'zod';

export const stepUpActionSchema = z.object({ organizationId: z.uuid(), actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const stepUpFactorSchema = z.object({ id: z.uuid(), credentialId: z.string().min(1).max(1024), label: z.string().min(1).max(80), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable() }).strict();
export const stepUpFactorLabelSchema = z.string().trim().min(1).max(80);
export const stepUpChallengeSchema = z.object({ challengeId: z.uuid(), expiresAt: z.iso.datetime(), options: z.record(z.string(), z.unknown()) }).strict();
export const stepUpProofSchema = z.object({ proof: z.string().min(32).max(128), expiresAt: z.iso.datetime() }).strict();
export type StepUpFactor = z.infer<typeof stepUpFactorSchema>;
