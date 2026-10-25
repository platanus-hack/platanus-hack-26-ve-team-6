import { z } from 'zod';
import { runtimeAttackEventAttributesSchema, runtimeProtectionHeartbeatAttributesSchema } from './telemetry.js';
export * from './assessment.js';
export * from './supply-chain.js';
export * from './demo-api.js';

export const idSchema = z.uuid();
export const eventTypeSchema = z.enum([
  'auth.login_failed',
  'auth.login_succeeded',
  'auth.privilege_changed',
  'http.request',
  'waf.match',
  'monitor.heartbeat',
  'app.error',
  'runtime.resource',
  'runtime.attack_detected',
  'runtime.protection_heartbeat',
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
  .refine((value) => !Object.keys(value).some((key) => prohibitedAttribute.test(key)), 'Sensitive attribute names are prohibited')
  .superRefine((value, context) => {
    for (const key of ['release', 'service', 'dependency'] as const) {
      const field = value[key];
      if (field !== undefined && (typeof field !== 'string' || field.length < 1 || field.length > 160 || /^https?:\/\//i.test(field))) context.addIssue({ code: 'custom', path: [key], message: `${key} must be a bounded identifier, not a URL` });
    }
    const route = value.route;
    if (route !== undefined && (typeof route !== 'string' || route.length > 200 || !/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/.test(route))) {
      context.addIssue({ code: 'custom', path: ['route'], message: 'route must be a templated path without a host, query or fragment' });
    }
  });

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
}).strict().superRefine((event, context) => {
  const attributes = event.type === 'runtime.attack_detected'
    ? runtimeAttackEventAttributesSchema.safeParse(event.attributes)
    : event.type === 'runtime.protection_heartbeat'
      ? runtimeProtectionHeartbeatAttributesSchema.safeParse(event.attributes)
      : null;
  if (attributes && !attributes.success) {
    for (const issue of attributes.error.issues) context.addIssue({ code: 'custom', path: ['attributes', ...issue.path], message: issue.message });
  }
  if ((event.type === 'runtime.attack_detected' || event.type === 'runtime.protection_heartbeat') && event.source !== 'application') {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Runtime protection events must come from an application integration' });
  }
  if (event.type === 'runtime.attack_detected' && event.outcome !== 'blocked' && event.outcome !== 'unknown') {
    context.addIssue({ code: 'custom', path: ['outcome'], message: 'Runtime detections must distinguish blocked from observed attempts' });
  }
});

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
export * from './external-api.js';
export * from './operations.js';
export * from './telemetry.js';
export * from './protection.js';
export * from './context.js';
export * from './step-up.js';
export * from './triage.js';
export * from './members.js';
export * from './actions.js';
export * from './dependency-fix.js';
export * from './dependency-validation.js';
export * from './validation.js';
export * from './github.js';
export * from './github-broker.js';
export * from './decision-records.js';
export * from './notifications.js';
export * from './investigation.js';
export * from './retention.js';
export * from './investigation-providers.js';
export * from './provider-connection.js';
export * from './ai-correction.js';
export * from './mcp.js';
