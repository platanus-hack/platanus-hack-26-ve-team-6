import { z } from 'zod';

export const API_CHECKS_VERSION = '1.0.0';
export const API_CHECKS_MAX_REQUESTS = 16;
export const API_CHECKS_MAX_RESPONSE_BYTES = 98_304;
export const apiScenarioIdSchema = z.enum(['schema_discovery', 'cors_preflight', 'method_policy', 'error_handling', 'auth_boundary']);
export const apiScenarioLabels = {
  schema_discovery: 'Descubrimiento de API',
  cors_preflight: 'Política CORS y preflight',
  method_policy: 'Métodos HTTP',
  error_handling: 'Manejo de rutas inexistentes',
  auth_boundary: 'Respuesta sin autenticación (HEAD)',
} satisfies Record<z.infer<typeof apiScenarioIdSchema>, string>;

export const apiOperationSchema = z.object({
  path: z.string().min(1).max(160),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']),
  authentication: z.enum(['declared', 'not_declared', 'unknown']),
  probeEligible: z.boolean(),
}).strict();

/** Response bodies and arbitrary schema descriptions never enter persisted evidence. */
export const apiCheckEvidenceSchema = z.object({
  profile: z.literal('api_checks'), catalogVersion: z.literal(API_CHECKS_VERSION),
  scenarioId: apiScenarioIdSchema,
  method: z.enum(['GET', 'HEAD', 'OPTIONS']), path: z.string().min(1).max(512),
  status: z.number().int().min(100).max(599).nullable(), tlsVerified: z.boolean(),
  headers: z.record(z.string(), z.string()), bodyBytes: z.number().int().nonnegative(),
  incomplete: z.string().nullable(),
  signals: z.object({
    schema: z.boolean().optional(), documentedOperationCount: z.number().int().nonnegative().optional(),
    operationsTruncated: z.boolean().optional(), operations: z.array(apiOperationSchema).max(8).optional(),
    originAllowed: z.enum(['probe_origin', 'wildcard', 'other', 'absent']).optional(),
    credentialsAllowed: z.boolean().optional(), authorizationAllowed: z.boolean().optional(), allowedMethods: z.array(z.string().max(12)).max(8).optional(),
    errorSignature: z.enum(['stack_trace', 'database_error']).optional(),
  }).strict(),
}).strict();
export type ApiOperation = z.infer<typeof apiOperationSchema>;
export type ApiCheckEvidence = z.infer<typeof apiCheckEvidenceSchema>;
