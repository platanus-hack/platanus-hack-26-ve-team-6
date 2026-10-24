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
export type TelemetryIntegration = z.infer<typeof telemetryIntegrationSchema>;
