import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const claimsSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), requestId: z.uuid(), issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export type ModelProbeClaims = z.infer<typeof claimsSchema>;

function assertSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) throw new Error('model_probe_secret_invalid');
}

export function issueModelProbeToken(secret: Uint8Array, claims: ModelProbeClaims): string {
  assertSecret(secret);
  const value = claimsSchema.parse(claims);
  if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 30) throw new Error('model_probe_token_lifetime_invalid');
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyModelProbeToken(secret: Uint8Array, token: string, nowSeconds = Math.floor(Date.now() / 1_000)): ModelProbeClaims {
  assertSecret(secret);
  if (token.length > 2_048) throw new Error('model_probe_token_invalid');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) throw new Error('model_probe_token_invalid');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw new Error('model_probe_token_invalid'); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('model_probe_token_invalid');
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('model_probe_token_invalid'); }
  const claims = claimsSchema.parse(raw);
  if (claims.issuedAt > nowSeconds + 5 || claims.expiresAt <= nowSeconds || claims.expiresAt - claims.issuedAt > 30) {
    throw new Error('model_probe_token_expired');
  }
  return claims;
}
