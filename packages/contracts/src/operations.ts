import { z } from 'zod';
import { customerScopeSchema } from './customer-assessment.js';

const timestamp = z.iso.datetime().refine(value => new Date(value).getUTCFullYear() >= 2000, 'Timestamp must be in the supported era');
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const monitorConfigInputSchema = customerScopeSchema.extend({
  enabled: z.boolean(), intervalSeconds: z.number().int().min(3600).max(86400),
  providers: z.array(z.enum(['cloudflare', 'railway'])).max(2).default([]),
  sourceSnapshotId: z.uuid().nullable().default(null), targetId: z.uuid().nullable().default(null),
  repositoryKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/).nullable().default(null),
}).strict().refine(v => !v.enabled || v.sourceSnapshotId !== null || v.targetId !== null || v.repositoryKey !== null || v.providers.length > 0,
  'Enabled monitoring requires a source, authorized target or operator-configured repository key');
export const monitorConfigSchema = customerScopeSchema.extend({
  enabled: z.boolean(), intervalSeconds: z.number().int(), sourceSnapshotId: z.uuid().nullable(), targetId: z.uuid().nullable(),
  repositoryKey: z.string().nullable(), providers: z.array(z.enum(['cloudflare', 'railway'])).max(2), revision: z.number().int().positive(), nextDueAt: timestamp, updatedAt: timestamp,
});
export const monitorClaimSchema = customerScopeSchema.extend({ runId: z.uuid(), leaseToken: z.uuid() }).strict();
export const monitorWorkSchema = monitorClaimSchema.extend({
  monitorRevision: z.number().int().positive(), leaseUntil: timestamp, config: monitorConfigSchema,
});
export const operationMetricsSchema = z.object({
  windowStartedAt: timestamp, windowEndedAt: timestamp, requestCount: z.number().int().min(1).max(1_000_000),
  errorCount: z.number().int().nonnegative(), latencyP95Ms: z.number().min(0).max(3_600_000).nullable(),
  capacityUtilization: z.number().min(0).max(1).nullable(),
}).strict().refine(v => v.errorCount <= v.requestCount && Date.parse(v.windowStartedAt) < Date.parse(v.windowEndedAt), 'Invalid metric window or error count');
export const operationEvidenceSchema = z.object({
  source: z.enum(['repository', 'provider_status', 'signed_event', 'assessment', 'advisory_database']),
  reference: z.string().min(1).max(512), checksum, collectedAt: timestamp,
  adapter: z.string().min(1).max(100), adapterVersion: z.string().min(1).max(100),
}).strict();
export const operationObservationBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monitor'), runId: z.uuid(), leaseToken: z.uuid() }).strict(),
  z.object({ kind: z.literal('events'), eventIds: z.array(z.uuid()).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('assessment'), reportId: z.uuid() }).strict(),
]);
export const recordOperationObservationSchema = customerScopeSchema.extend({
  idempotencyKey: z.string().min(1).max(128), basis: operationObservationBasisSchema,
  kind: z.enum(['repository_change', 'dependency_advisory', 'public_surface', 'upstream_outage', 'traffic_pressure', 'application_error', 'security_finding', 'coverage_gap', 'coverage_check']),
  summary: z.string().min(1).max(2000), severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  confidence: z.enum(['low', 'medium', 'high']), observedAt: timestamp, expiresAt: timestamp,
  evidence: z.array(operationEvidenceSchema).min(1).max(20), metrics: operationMetricsSchema.nullable().default(null),
  incidentId: z.uuid().nullable().default(null),
  upstreamImpact: z.enum(['observed', 'unverified', 'not_applicable']).default('not_applicable'),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'traffic_pressure' && (v.metrics === null || v.basis.kind !== 'events')) ctx.addIssue({ code: 'custom', message: 'Traffic pressure requires persisted signed events and measured metrics' });
  if (v.kind === 'upstream_outage' && v.upstreamImpact !== 'unverified') ctx.addIssue({ code: 'custom', message: 'A provider status report does not verify application impact' });
  if (Date.parse(v.observedAt) >= Date.parse(v.expiresAt)) ctx.addIssue({ code: 'custom', message: 'Evidence requires a positive freshness window' });
});
export const operationObservationSchema = customerScopeSchema.extend({
  id: z.uuid(), kind: recordOperationObservationSchema.shape.kind, summary: z.string(),
  severity: recordOperationObservationSchema.shape.severity, confidence: recordOperationObservationSchema.shape.confidence,
  observedAt: timestamp, expiresAt: timestamp, evidence: z.array(operationEvidenceSchema),
  metrics: operationMetricsSchema.nullable(), incidentId: z.uuid().nullable(), upstreamImpact: recordOperationObservationSchema.shape.upstreamImpact,
  verification: z.literal('trusted_observation'), fresh: z.boolean(),
});
export const operationAlertSchema = z.object({
  id: z.uuid(), observation: operationObservationSchema, state: z.enum(['open', 'acknowledged', 'resolved']),
  updatedAt: timestamp, resolution: z.string().nullable(),
});
export const operationCoverageSchema = z.object({
  config: monitorConfigSchema.nullable(), status: z.enum(['not_configured', 'pending', 'active', 'degraded', 'stale']), scopeCurrent: z.boolean(),
  lastRun: z.object({ runId: z.uuid(), jobId: z.uuid().nullable(), status: z.enum(['running', 'completed', 'degraded', 'cancelled']), reason: z.string().nullable(), startedAt: timestamp, finishedAt: timestamp.nullable() }).nullable(),
  observations: z.object({ fresh: z.number().int().nonnegative(), stale: z.number().int().nonnegative() }), limitations: z.array(z.string()),
});
export type OperationCoverage = z.infer<typeof operationCoverageSchema>;
export const operationPlanKindSchema = z.enum(['investigate_capacity', 'migration_readiness', 'review_improvement']);
export const operationPlanRequestSchema = customerScopeSchema.extend({
  kind: operationPlanKindSchema, observationIds: z.array(z.uuid()).min(1).max(20),
}).strict();
export const operationPlanBindingSchema = customerScopeSchema.extend({ planId: z.uuid(), revision: z.number().int().positive(), actionHash: checksum }).strict();
export const operationPlanStepSchema = z.object({
  key: z.enum(['inventory', 'data', 'secrets', 'destination', 'cost', 'health', 'rollback', 'cutover', 'capacity', 'validation']),
  instruction: z.string(), state: z.enum(['todo', 'self_reported']), attestation: z.string().max(2000).nullable(),
});
export const operationPlanSchema = customerScopeSchema.extend({
  id: z.uuid(), kind: operationPlanKindSchema, revision: z.number().int().positive(), actionHash: checksum,
  state: z.enum(['draft', 'preparation_requested']), observationIds: z.array(z.uuid()),
  steps: z.array(operationPlanStepSchema), limitations: z.array(z.string()), createdAt: timestamp, updatedAt: timestamp,
  execution: z.literal('disabled'),
});
export const operationReadinessSchema = z.object({
  planId: z.uuid(), revision: z.number().int().positive(), actionHash: checksum,
  ready: z.literal(false), execution: z.literal('disabled'), requirements: z.array(z.string()),
});
export type MonitorConfigInput = z.input<typeof monitorConfigInputSchema>;
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export type MonitorClaim = z.infer<typeof monitorClaimSchema>;
export type MonitorWork = z.infer<typeof monitorWorkSchema>;
export type OperationMetrics = z.infer<typeof operationMetricsSchema>;
export type OperationEvidence = z.infer<typeof operationEvidenceSchema>;
export type RecordOperationObservation = z.input<typeof recordOperationObservationSchema>;
export type OperationObservation = z.infer<typeof operationObservationSchema>;
export type OperationAlert = z.infer<typeof operationAlertSchema>;
export type OperationPlan = z.infer<typeof operationPlanSchema>;
export type OperationPlanRequest = z.infer<typeof operationPlanRequestSchema>;
export type OperationPlanBinding = z.infer<typeof operationPlanBindingSchema>;
