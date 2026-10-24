import { z } from 'zod';
export * from './assessment.js';
export * from './demo-api.js';

export const idSchema = z.uuid();
export const eventTypeSchema = z.enum([
  'auth.login_failed',
  'auth.login_succeeded',
  'auth.privilege_changed',
  'http.request',
  'waf.match',
  'monitor.heartbeat',
]);

const attributeValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const prohibitedAttribute = /password|secret|token|cookie|authorization|api[_-]?key|request[_-]?body/i;
export const eventAttributesSchema = z.record(z.string().max(64), attributeValueSchema)
  .refine((value) => Object.keys(value).length <= 32, 'At most 32 attributes are allowed')
  .refine((value) => !Object.keys(value).some((key) => prohibitedAttribute.test(key)), 'Sensitive attribute names are prohibited');

export const securityEventSchema = z.object({
  id: idSchema,
  type: eventTypeSchema,
  source: z.enum(['application', 'cloudflare']),
  occurredAt: z.iso.datetime().refine((value) => !value.startsWith('0000-'), 'Event timestamps require a year from 0001 through 9999'),
  actor: z.object({
    accountId: z.string().min(1).max(128).optional(),
    ip: z.union([z.ipv4(), z.ipv6()]).optional(),
  }).strict().optional(),
  resource: z.object({
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(256),
  }).strict().optional(),
  outcome: z.enum(['success', 'failure', 'blocked', 'unknown']),
  attributes: eventAttributesSchema.default({}),
}).strict();

export const eventBatchSchema = z.object({
  applicationId: idSchema,
  events: z.array(securityEventSchema).min(1).max(100),
}).strict();

export const jobKindSchema = z.enum(['audit', 'events.aggregate', 'investigation', 'execution', 'notification']);
export const jobEnvelopeSchema = z.object({
  version: z.literal(1),
  id: idSchema.transform((id) => id.toLowerCase()),
  organizationId: idSchema.transform((id) => id.toLowerCase()),
  applicationId: idSchema.transform((id) => id.toLowerCase()),
  kind: jobKindSchema,
}).strict();

export const investigationRequestSchema = z.object({
  runId: idSchema,
  organizationId: idSchema,
  applicationId: idSchema,
  evidenceIds: z.array(idSchema).max(50),
}).strict();

export const coverageStateSchema = z.enum(['not_configured', 'active', 'degraded', 'stale', 'unsupported']);
export const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }).strict(),
}).strict();

export type SecurityEvent = z.infer<typeof securityEventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
export type EventBatchInput = z.input<typeof eventBatchSchema>;
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;
export * from './customer-assessment.js';
export * from './operations.js';
