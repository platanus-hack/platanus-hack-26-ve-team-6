import { z } from 'zod';
import { customerScopeSchema } from './customer-assessment.js';

export const telemetryIntegrationSchema = customerScopeSchema.extend({
  id: z.uuid(), status: z.enum(['active', 'disabled']), lastEventAt: z.iso.datetime().nullable(),
}).strict();
export const telemetryConnectionSchema = z.object({
  integration: telemetryIntegrationSchema,
  signingKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict();
export const telemetryDisableSchema = customerScopeSchema.extend({ integrationId: z.uuid() }).strict();
export const telemetryContextAttributesSchema = z.object({
  release: z.string().min(1).max(120).optional(),
  service: z.string().min(1).max(120).optional(),
  dependency: z.string().min(1).max(160).optional(),
  route: z.string().min(1).max(200).regex(/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/).optional(),
}).strict();
export type TelemetryIntegration = z.infer<typeof telemetryIntegrationSchema>;
