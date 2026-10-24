import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { assertCapabilityAllowsRead, assertCapabilityScope, CapabilityError, verifyRunCapability } from '../src/capabilities.js';

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
};
const evidenceId = '44444444-4444-4444-8444-444444444444';
const now = 1_800_000_000_000;
const pair = generateKeyPairSync('ed25519');

async function capability(overrides: Record<string, unknown> = {}, timestamps = { iat: now / 1000, exp: now / 1000 + 300 }): Promise<string> {
  return new SignJWT({
    organizationId: scope.organizationId,
    applicationId: scope.applicationId,
    runId: scope.runId,
    allowedReadTools: ['evidence.read'],
    evidenceIds: [evidenceId],
    jti: randomUUID(),
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('gotchu-run-capability-issuer')
    .setAudience('gotchu-investigation-worker')
    .setSubject(scope.runId)
    .setIssuedAt(timestamps.iat)
    .setExpirationTime(timestamps.exp)
    .sign(pair.privateKey);
}

describe('run capabilities', () => {
  it('rejects forged, expired, and cross-tenant capabilities', async () => {
    await expect(verifyRunCapability('forged.token.value', pair.publicKey, now)).rejects.toMatchObject({ code: 'invalid_capability' });

    const expired = await capability({}, { iat: now / 1000 - 400, exp: now / 1000 - 100 });
    await expect(verifyRunCapability(expired, pair.publicKey, now)).rejects.toMatchObject({ code: 'invalid_capability' });

    const valid = await verifyRunCapability(await capability(), pair.publicKey, now);
    expect(() => assertCapabilityScope(valid, { ...scope, organizationId: randomUUID() })).toThrow(CapabilityError);
  });

  it('rejects a read tool or evidence ID outside the signed capability', async () => {
    const verified = await verifyRunCapability(await capability(), pair.publicKey, now);

    expect(() => assertCapabilityAllowsRead(verified, 'repository.excerpt.read', evidenceId)).toThrow(CapabilityError);
    expect(() => assertCapabilityAllowsRead(verified, 'evidence.read', randomUUID())).toThrow(CapabilityError);
  });
});
