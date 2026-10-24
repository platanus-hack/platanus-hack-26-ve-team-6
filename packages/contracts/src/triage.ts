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
export const probeRoutePathSchema = z.enum(['/','/.well-known/security.txt','/security.txt','/robots.txt','/sitemap.xml']);
export const probeRouteOptionSchema = z.object({ serviceId: z.uuid(), service: z.string().min(1).max(120), dependencyId: z.uuid().nullable(), provider: z.string().min(1).max(64).nullable(), component: z.string().min(1).max(200).nullable(), state: z.enum(['declared','verified','unknown']) }).strict();
export const triageProbeRouteSchema = z.object({ route: probeRoutePathSchema, serviceId: z.uuid(), service: z.string().min(1).max(120), dependencyId: z.uuid().nullable(), dependsOnProvider: z.string().min(1).max(64).nullable(), role: z.enum(['application','control']), declared: z.literal(true), declaredBy: z.string().min(1).max(256), declaredAt: timestamp }).strict();
export const triageProbeRouteInputSchema = customerScopeSchema.extend({ route: probeRoutePathSchema, serviceId: z.uuid(), dependencyId: z.uuid().nullable(), role: z.enum(['application','control']) }).strict().refine(value => value.role !== 'control' || value.dependencyId === null, 'A control route must be explicitly independent');
export const triageProbeRouteSettingsSchema = z.object({ routes: z.array(triageProbeRouteSchema).max(5), allowedRoutes: z.array(probeRoutePathSchema).max(5), options: z.array(probeRouteOptionSchema).max(200) }).strict();
export type TriageIncident = z.infer<typeof triageIncidentSchema>;
export type TriageIncidentDetail = z.infer<typeof triageIncidentDetailSchema>;
export type TriageRevision = z.infer<typeof triageRevisionSchema>;
export type TriageProbeRoute = z.infer<typeof triageProbeRouteSchema>;
