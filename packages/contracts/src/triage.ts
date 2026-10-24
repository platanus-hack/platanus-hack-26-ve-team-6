import { z } from 'zod';
import { customerScopeSchema } from './customer-assessment.js';
import { triageRevisionSchema } from '@gotchu/triage/output';
export { triageRevisionSchema };

const timestamp = z.iso.datetime();
export const incidentStatusSchema = z.enum(['open', 'monitoring', 'closed']);
export const triageRevisionSummarySchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), rulesVersion: z.string(),
  impact: triageRevisionSchema.shape.impact, hypothesisCount: z.number().int().nonnegative(), createdAt: timestamp,
}).strict();
export const triageIncidentSchema = customerScopeSchema.extend({
  id: z.uuid(), environment: z.string().min(1).max(128), windowStartedAt: timestamp,
  windowEndedAt: timestamp, status: incidentStatusSchema, latest: triageRevisionSummarySchema.nullable(),
  createdAt: timestamp, updatedAt: timestamp,
}).strict();
export const triageRevisionListItemSchema = triageRevisionSummarySchema.extend({ previousRevisionId: z.string().nullable() }).strict();
export const triageIncidentDetailSchema = z.object({
  incident: triageIncidentSchema, revisions: z.array(z.object({
    revision: triageRevisionSchema, createdAt: timestamp,
  }).strict()).max(200), requestableEvidence: z.array(z.enum(['https_health','provider_status'])).max(2),
}).strict();
export const updateIncidentStatusSchema = z.object({ status: incidentStatusSchema }).strict();
export const evidenceRequestResponseSchema = z.object({ requested: z.array(z.enum(['https_health', 'provider_status'])), message: z.string() }).strict();
export type TriageIncident = z.infer<typeof triageIncidentSchema>;
export type TriageIncidentDetail = z.infer<typeof triageIncidentDetailSchema>;
export type TriageRevision = z.infer<typeof triageRevisionSchema>;
