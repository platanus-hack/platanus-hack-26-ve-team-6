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

export const runtimeAttackKindSchema = z.enum(['sql_injection', 'path_traversal', 'command_injection', 'ssrf']);
export const runtimeSinkSchema = z.enum(['sql', 'filesystem', 'child_process', 'fetch', 'http']);
export const runtimeAttackEvidenceSchema = z.enum([
  'sql_boolean_tautology', 'sql_union_select', 'sql_statement_chain', 'sql_comment_termination',
  'path_outside_root', 'shell_operator_in_input', 'private_destination',
]);
export const runtimeAttackEventAttributesSchema = z.object({
  attackKind: runtimeAttackKindSchema,
  sink: runtimeSinkSchema,
  route: z.string().min(1).max(200).regex(/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/),
  evidence: runtimeAttackEvidenceSchema,
}).strict().superRefine((value, context) => {
  const expectedSink = { sql_injection: 'sql', path_traversal: 'filesystem', command_injection: 'child_process' } as const;
  if (value.attackKind === 'ssrf' ? value.sink !== 'fetch' && value.sink !== 'http' : value.sink !== expectedSink[value.attackKind]) {
    context.addIssue({ code: 'custom', path: ['sink'], message: 'The sink does not match the runtime attack kind' });
  }
});
export const runtimeProtectionHeartbeatAttributesSchema = z.object({ sdk: z.literal('node'), guardInstalled: z.literal(true) }).strict();

export type TelemetryIntegration = z.infer<typeof telemetryIntegrationSchema>;
