import { createHash, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Database } from '@gotchu/database';
import type { ValidationEvidence } from '@gotchu/contracts';

export const passingValidationEvidence: readonly ValidationEvidence[] = [
  { kind: 'base_reproduction', result: 'failed_for_target', exitCode: 1, durationMs: 20 },
  { kind: 'candidate_regression', result: 'passed', exitCode: 0, durationMs: 25 },
  { kind: 'functional_suite', suiteName: 'security regression suite', result: 'passed', counts: { passed: 1, failed: 0, skipped: 0 }, baseCounts: { passed: 1, failed: 0, skipped: 0 }, requiredCounts: 1 },
  { kind: 'independent_rescan', result: 'passed', before: { identities: ['finding-1'], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: ['finding-1'] },
];

export async function insertValidationAttestations(input: {
  database: Database;
  organizationId: string;
  applicationId: string;
  runId: string;
  actionRef: string;
  evidence: readonly ValidationEvidence[];
  publicKeyPem: string;
  publicKeyDer: Uint8Array;
  privateKey: KeyObject;
  expiresAt: string;
  invalidSignatureKind?: ValidationEvidence['kind'];
}): Promise<{ keyId: string }> {
  const keyId = createHash('sha256').update(input.publicKeyDer).digest('hex');
  await input.database.tenant(input.organizationId, async tx => {
    await tx.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [keyId, input.publicKeyPem]);
    for (const evidence of input.evidence) {
      const payload = {
        id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId,
        runId: input.runId, actionRef: input.actionRef, evidence,
        createdAt: new Date().toISOString(), expiresAt: input.expiresAt,
      };
      const signature = input.invalidSignatureKind === evidence.kind
        ? 'A'.repeat(86)
        : sign(null, Buffer.from(JSON.stringify(payload)), input.privateKey).toString('base64url');
      await tx.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [input.organizationId, input.applicationId, input.runId, payload.id, evidence.kind, JSON.stringify(payload), keyId, signature, input.expiresAt]);
    }
  });
  return { keyId };
}
