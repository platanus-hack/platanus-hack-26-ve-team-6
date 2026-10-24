import { jwtVerify, type KeyInput } from 'jose';
import { z } from 'zod';

export const runReadToolSchema = z.enum([
  'evidence.read',
  'auth.events.read',
  'application.context.read',
  'finding.details.read',
  'source.excerpt.read',
  'assessment.diff.read',
  'validation.results.read',
  'triage.results.read',
]);
export type RunReadTool = z.infer<typeof runReadToolSchema>;

export const runCapabilityClaimsSchema = z.object({
  iss: z.literal('gotchu-run-capability-issuer'),
  aud: z.literal('gotchu-investigation-worker'),
  sub: z.uuid(),
  jti: z.uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  organizationId: z.uuid(),
  applicationId: z.uuid(),
  runId: z.uuid(),
  allowedReadTools: z.array(runReadToolSchema).min(1).max(8),
  evidenceIds: z.array(z.uuid()).max(100),
}).strict().superRefine((claims, context) => {
  if (claims.sub !== claims.runId) {
    context.addIssue({ code: 'custom', path: ['sub'], message: 'Subject must equal run ID' });
  }
  if (new Set(claims.allowedReadTools).size !== claims.allowedReadTools.length) {
    context.addIssue({ code: 'custom', path: ['allowedReadTools'], message: 'Read tools must be unique' });
  }
  if (new Set(claims.evidenceIds).size !== claims.evidenceIds.length) {
    context.addIssue({ code: 'custom', path: ['evidenceIds'], message: 'Evidence IDs must be unique' });
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 10 * 60) {
    context.addIssue({ code: 'custom', path: ['exp'], message: 'Capability lifetime must be at most ten minutes' });
  }
});
export type RunCapabilityClaims = z.infer<typeof runCapabilityClaimsSchema>;

export interface VerifiedRunCapability {
  readonly token: string;
  readonly claims: RunCapabilityClaims;
}

export class CapabilityError extends Error {
  constructor(readonly code: 'invalid_capability' | 'capability_scope_mismatch' | 'capability_read_denied') {
    super(code);
    this.name = 'CapabilityError';
  }
}

/** Verify with a public Ed25519 key only. Signing belongs to the trusted coordinator. */
export async function verifyRunCapability(
  token: string,
  publicKey: KeyInput,
  now = Date.now(),
): Promise<VerifiedRunCapability> {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
      issuer: 'gotchu-run-capability-issuer',
      audience: 'gotchu-investigation-worker',
      currentDate: new Date(now),
      clockTolerance: 0,
    });
    const claims = runCapabilityClaimsSchema.parse(payload);
    if (claims.iat > Math.floor(now / 1000) + 30) throw new CapabilityError('invalid_capability');
    return { token, claims };
  } catch {
    throw new CapabilityError('invalid_capability');
  }
}

export function assertCapabilityScope(
  capability: VerifiedRunCapability,
  scope: { organizationId: string; applicationId: string; runId: string },
): void {
  const claims = capability.claims;
  if (
    claims.organizationId !== scope.organizationId
    || claims.applicationId !== scope.applicationId
    || claims.runId !== scope.runId
  ) {
    throw new CapabilityError('capability_scope_mismatch');
  }
}

export function assertCapabilityAllowsRead(
  capability: VerifiedRunCapability,
  tool: RunReadTool,
  evidenceId: string,
): void {
  if (!capability.claims.allowedReadTools.includes(tool) || !capability.claims.evidenceIds.includes(evidenceId)) {
    throw new CapabilityError('capability_read_denied');
  }
}
