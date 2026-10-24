import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => !value.startsWith('0000-'));

export const decisionRecordSubjectTypeSchema = z.enum([
  'workspace', 'application', 'alert', 'plan', 'action', 'execution', 'report', 'assessment',
  'target', 'source', 'correction', 'member', 'invitation', 'integration', 'event_batch',
  'incident', 'operation', 'validation', 'credential', 'model', 'environment', 'service',
  'repository', 'deployment', 'dependency', 'origin', 'other',
]);
export const decisionRecordOutcomeSchema = z.enum([
  'recorded', 'requested', 'acknowledged', 'resolved', 'approved', 'rejected', 'cancelled',
  'completed', 'failed', 'uncertain', 'changed', 'unknown',
]);

/** A customer-safe projection of one workspace audit row. It deliberately has no raw detail or actor ID. */
export const decisionRecordSchema = z.object({
  id: uuid,
  actor: z.object({ kind: z.enum(['member', 'system']), displayName: z.string().min(1).max(254) }).strict(),
  action: z.string().min(1).max(100),
  subject: z.object({ type: decisionRecordSubjectTypeSchema, id: uuid.nullable() }).strict(),
  createdAt: timestamp,
  outcome: decisionRecordOutcomeSchema,
  summary: z.string().min(1).max(300),
}).strict();

export const decisionRecordQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  subjectType: decisionRecordSubjectTypeSchema.optional(),
  subjectId: uuid.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: 'The start time must not be after the end time', path: ['from'],
});

export const decisionRecordPageSchema = z.object({
  records: z.array(decisionRecordSchema).max(50),
  nextCursor: z.string().max(200).nullable(),
}).strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export type DecisionRecordQuery = z.infer<typeof decisionRecordQuerySchema>;
export type DecisionRecordPage = z.infer<typeof decisionRecordPageSchema>;
