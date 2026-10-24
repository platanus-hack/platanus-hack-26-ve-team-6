import { z } from 'zod';
import { assessmentModeSchema, demoRevisionSchema } from './assessment.js';

export const demoWorkspaceSchema = z.object({
  kind: z.literal('controlled_demo'),
  application: z.object({ id: z.uuid(), name: z.string().min(1).max(200) }).strict(),
  targetConfigured: z.boolean(),
  reports: z.array(z.object({ id: z.uuid(), mode: assessmentModeSchema, revision: demoRevisionSchema, createdAt: z.iso.datetime() }).strict()).max(20),
  responseMode: z.literal('observation'),
  providerRequired: z.literal(false),
}).strict();
export const assessmentQueuedSchema = z.object({ jobId: z.uuid() }).strict();
export const demoAssessmentJobSchema = z.object({
  id: z.uuid(), state: z.enum(['queued', 'running', 'succeeded', 'failed']), reportId: z.uuid().nullable(), reasonCode: z.string().max(256).nullable(),
}).strict();
export type DemoWorkspace = z.infer<typeof demoWorkspaceSchema>;
export type DemoAssessmentJob = z.infer<typeof demoAssessmentJobSchema>;
