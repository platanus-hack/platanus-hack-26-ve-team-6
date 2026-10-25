import { z } from 'zod';
import { assessmentFindingSchema } from './assessment.js';
import { customerSourceFileSchema } from './customer-assessment.js';
import { investigationRunSchema } from './investigation.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const explanation = z.array(z.string().min(1).max(500)).max(5);
export const AI_CORRECTION_MAX_CONTEXT_CHARS = 16_000;

/** The explicit correction action authorizes only these pinned files, never code execution. */
export const aiCorrectionInputSchema = z.object({
  task: z.literal('prepare_correction'),
  scope: z.object({ organizationId: z.uuid(), applicationId: z.uuid(), runId: z.uuid() }).strict(),
  correctionId: z.uuid(), sourceDigest: digest,
  /** Selected by the trusted gateway; null removes token caps without removing usage accounting. */
  modelTokenLimit: z.number().int().min(1).max(20_000).nullable().optional(),
  finding: assessmentFindingSchema,
  suggestion: investigationRunSchema.shape.candidateSuggestion,
  files: z.array(z.object({ path: customerSourceFileSchema.shape.path, sha256: digest, content: z.string().max(12_000) }).strict()).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) context.addIssue({ code: 'custom', message: 'Correction file paths must be unique' });
  if (JSON.stringify(value).length > AI_CORRECTION_MAX_CONTEXT_CHARS) context.addIssue({ code: 'custom', message: 'Correction context exceeds its bound' });
});

/** Search replacements are applied only by trusted code after file digest and uniqueness checks. */
export const aiCorrectionPatchSchema = z.object({
  summary: z.string().min(1).max(800), implications: explanation, risks: explanation, validationPlan: explanation,
  changes: z.array(z.object({
    path: customerSourceFileSchema.shape.path, originalSha256: digest,
    replacements: z.array(z.object({ before: z.string().min(1).max(4_000), after: z.string().max(4_000) }).strict()).min(1).max(8),
  }).strict()).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.changes.map(change => change.path)).size !== value.changes.length) context.addIssue({ code: 'custom', message: 'Changed paths must be unique' });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 24_000) context.addIssue({ code: 'custom', message: 'Correction patch exceeds its bound' });
});

export const aiCorrectionRequestSchema = z.object({ findingId: z.uuid(), expectedSourceDigest: digest, authorized: z.literal(true) }).strict();
export const aiCorrectionSchema = z.object({
  id: z.uuid(), jobId: z.uuid(), organizationId: z.uuid(), applicationId: z.uuid(), reportId: z.uuid(), findingId: z.uuid(),
  sourceDigest: digest, state: z.enum(['queued', 'running', 'prepared', 'failed', 'cancelled', 'reconciliation_required']),
  summary: z.string().max(2_000).nullable(), reasonCode: z.string().max(100).nullable(),
  candidateSourceId: z.uuid().nullable(), patchHash: digest.nullable(), validationRunId: z.uuid().nullable(),
  rescanJobId: z.uuid().nullable(),
  implications: explanation, risks: explanation, validationPlan: explanation,
  diff: z.array(z.object({ path: customerSourceFileSchema.shape.path, before: z.string().max(12_000), after: z.string().max(24_000) }).strict()).max(4),
  createdAt: z.iso.datetime(),
}).strict();

export type AiCorrectionInput = z.infer<typeof aiCorrectionInputSchema>;
export type AiCorrectionPatch = z.infer<typeof aiCorrectionPatchSchema>;
export type AiCorrectionRequest = z.infer<typeof aiCorrectionRequestSchema>;
export type AiCorrection = z.infer<typeof aiCorrectionSchema>;
