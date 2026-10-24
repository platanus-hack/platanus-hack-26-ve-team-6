import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setRecoveryState } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('real Postgres WebAuthn step-up proof ledger', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  const actionHash = 'a'.repeat(64);
  const digest = (input: string) => createHash('sha256').update(input).digest('hex');
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    backend = createBackend({ database: f.databases.gotchu_api, webAuthn: { rpID: 'localhost', origin: 'http://localhost:3000' } });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: no provider writes are performed' });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function issueProof(options: { organizationId?: string; userId?: string; actionHash?: string; expiresAt?: Date; factorRevoked?: boolean } = {}) {
    const organizationId = options.organizationId ?? f.a.organizationId;
    const userId = options.userId ?? f.a.userId;
    const factorId = randomUUID(); const proof = randomUUID(); const now = new Date();
    await f.admin.query('INSERT INTO gotchu.step_up_factors(organization_id,user_id,id,credential_id,public_key,label,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [organizationId, userId, factorId, randomUUID(), Buffer.from([1, 2, 3]), 'test authenticator', options.factorRevoked ? now : null]);
    const epoch = await f.admin.query('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    await f.admin.query('INSERT INTO gotchu.step_up_proofs(organization_id,id,user_id,proof_hash,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [organizationId, randomUUID(), userId, digest(proof), options.actionHash ?? actionHash, epoch.rows[0].recovery_epoch, now, options.expiresAt ?? new Date(now.getTime() + 60_000), factorId]);
    return { proof, organizationId, userId, actionHash: options.actionHash ?? actionHash };
  }
  it('atomically consumes a proof once, including concurrent calls', async () => {
    const issued = await issueProof();
    const args = { ...issued };
    const results = await Promise.allSettled([backend.stepUp!.verifier.verify(args), backend.stepUp!.verifier.verify(args)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'step_up_proof_invalid' });
    await expect(backend.stepUp!.verifier.verify(args)).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
  });
  it('binds user, organization, action, expiry, active factor, role, and recovery epoch', async () => {
    const wrongAction = await issueProof();
    await expect(backend.stepUp!.verifier.verify({ ...wrongAction, actionHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
    await expect(backend.stepUp!.verifier.verify({ ...wrongAction, organizationId: f.b.organizationId })).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
    await expect(backend.stepUp!.verifier.verify({ ...wrongAction, userId: f.b.userId })).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
    await expect(backend.stepUp!.verifier.verify(wrongAction)).resolves.toMatchObject({ method: 'webauthn', actionHash });
    const expired = await issueProof({ expiresAt: new Date(Date.now() - 1_000) });
    await expect(backend.stepUp!.verifier.verify(expired)).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
    const revoked = await issueProof({ factorRevoked: true });
    await expect(backend.stepUp!.verifier.verify(revoked)).rejects.toMatchObject({ code: 'step_up_factor_revoked' });
    const revokedRole = await issueProof();
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    try { await expect(backend.stepUp!.verifier.verify(revokedRole)).rejects.toMatchObject({ code: 'forbidden' }); }
    finally { await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]); }
    const staleEpoch = await issueProof();
    await f.admin.query('UPDATE gotchu.platform_state SET recovery_epoch=recovery_epoch+1 WHERE singleton');
    await expect(backend.stepUp!.verifier.verify(staleEpoch)).rejects.toMatchObject({ code: 'stale_epoch' });
  });
});
