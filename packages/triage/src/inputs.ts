import { z } from 'zod';

const timestamp = z.iso.datetime();
const boundedName = z.string().min(1).max(128);
const contextIdentifier = z.string().min(1).max(200);
export const serviceContextSchema = z.object({
  environment: boundedName.optional(),
  service: boundedName.optional(),
  deployments: z.array(z.object({
    service: boundedName, releaseId: contextIdentifier.nullable(), commit: z.string().max(128).nullable(),
    deployedAt: timestamp, state: z.enum(['declared', 'verified', 'unknown']),
  }).strict()).max(100).default([]),
  dependencies: z.array(z.object({
    service: boundedName, provider: boundedName, component: contextIdentifier.nullable(), region: boundedName.nullable(),
    state: z.enum(['declared', 'verified', 'unknown']),
  }).strict()).max(200).default([]),
}).strict();

export const signalSampleSchema = z.object({
  eventAt: timestamp, acceptedAt: timestamp, value: z.number().finite().nonnegative(),
}).strict().refine(sample => Date.parse(sample.acceptedAt) >= Date.parse(sample.eventAt), 'acceptedAt cannot precede eventAt');
export const signalSeriesSchema = z.object({
  id: boundedName, metric: z.enum(['error_rate', 'latency_ms', 'request_rate', 'resource_utilization', 'auth_failures']),
  service: boundedName, environment: boundedName, samples: z.array(signalSampleSchema).min(1).max(500),
  sampling: z.number().gt(0).lte(1), freshnessMs: z.number().int().min(1_000).max(86_400_000),
}).strict();
export const providerStatusInputSchema = z.object({
  provider: boundedName, component: boundedName.nullable(), region: boundedName.nullable(),
  state: z.enum(['operational', 'degraded', 'partial_outage', 'major_outage', 'unknown']),
  observedAt: timestamp, scope: z.enum(['global', 'regional', 'component']), fixture: z.boolean(),
}).strict();
export const httpsProbeSchema = z.object({
  route: z.string().min(1).max(256), service: boundedName, dependsOnProvider: boundedName.nullable(),
  role: z.enum(['application', 'control']).default('application'),
  outcome: z.enum(['healthy', 'degraded', 'unavailable', 'unknown']), at: timestamp,
}).strict();
export const baselineSchema = z.object({
  service: boundedName, environment: boundedName,
  errorRate: z.number().min(0).max(1), latencyMs: z.number().nonnegative(), requestRate: z.number().nonnegative(),
  resourceUtilization: z.number().min(0).max(1), authFailures: z.number().nonnegative(),
}).strict();
export const correlationWindowInputSchema = z.object({
  window: z.object({ startedAt: timestamp, endedAt: timestamp }).strict()
    .refine(w => Date.parse(w.startedAt) < Date.parse(w.endedAt), 'window must be positive'),
  context: serviceContextSchema.optional(),
  signals: z.array(signalSeriesSchema).max(100),
  providerStatuses: z.array(providerStatusInputSchema).max(100),
  probes: z.array(httpsProbeSchema).max(200),
  baselines: z.array(baselineSchema).max(100),
  anomalies: z.array(z.string().min(1).max(256)).max(100).default([]),
}).strict();
export type CorrelationWindowInput = z.infer<typeof correlationWindowInputSchema>;
