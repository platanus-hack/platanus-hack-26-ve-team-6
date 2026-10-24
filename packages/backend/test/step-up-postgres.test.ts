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
    await f.admin.query('INSERT INTO gotchu.step_up_user_factors(user_id,id,credential_id,public_key,label,revoked_at) VALUES($1,$2,$3,$4,$5,$6)', [userId, factorId, randomUUID(), Buffer.from([1, 2, 3]), 'test authenticator', options.factorRevoked ? now : null]);
    const epoch = await f.admin.query('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    await f.admin.query('INSERT INTO gotchu.step_up_proofs(organization_id,id,user_id,proof_hash,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id,factor_count,factor_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)', [organizationId, randomUUID(), userId, digest(proof), options.actionHash ?? actionHash, epoch.rows[0].recovery_epoch, now, options.expiresAt ?? new Date(now.getTime() + 60_000), factorId, [factorId]]);
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
    const crossWorkspace = await issueProof({ organizationId: f.b.organizationId, userId: f.a.userId });
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator') ON CONFLICT DO NOTHING", [f.b.organizationId, f.a.userId]);
    try { await expect(backend.stepUp!.verifier.verify(crossWorkspace)).resolves.toMatchObject({ organizationId: f.b.organizationId }); }
    finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.b.organizationId, f.a.userId]); }
    const expired = await issueProof({ expiresAt: new Date(Date.now() - 1_000) });
    await expect(backend.stepUp!.verifier.verify(expired)).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
    const revoked = await issueProof({ factorRevoked: true });
    await expect(backend.stepUp!.verifier.verify(revoked)).rejects.toMatchObject({ code: 'step_up_factor_revoked' });
    const revokedRole = await issueProof();
    const secondaryOwner = `step-up-owner:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, secondaryOwner]);
    try {
      await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
      await expect(backend.stepUp!.verifier.verify(revokedRole)).rejects.toMatchObject({ code: 'forbidden' });
      await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    } finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, secondaryOwner]); }
    const staleEpoch = await issueProof();
    await f.admin.query('UPDATE gotchu.platform_state SET recovery_epoch=recovery_epoch+1 WHERE singleton');
    await expect(backend.stepUp!.verifier.verify(staleEpoch)).rejects.toMatchObject({ code: 'stale_epoch' });
  });
  it('invalidates outstanding proofs when the Auth.js session signs out', async () => {
    const first = await issueProof();
    const second = await issueProof({ organizationId: f.b.organizationId, userId: first.userId });
    const epoch = await f.admin.query('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    const challengeId = randomUUID();
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator') ON CONFLICT DO NOTHING", [f.b.organizationId, first.userId]);
    await f.admin.query("INSERT INTO gotchu.step_up_challenges(organization_id,id,user_id,purpose,action_hash,challenge,recovery_epoch,expires_at) VALUES($1,$2,$3,'assert',$4,$5,$6,clock_timestamp()+interval '2 minutes')", [f.b.organizationId, challengeId, first.userId, actionHash, randomUUID().replaceAll('-', '').padEnd(43, 'a'), epoch.rows[0].recovery_epoch]);
    try {
      await backend.stepUp!.invalidateSession(first.userId);
      await expect(backend.stepUp!.verifier.verify(first)).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
      await expect(backend.stepUp!.verifier.verify(second)).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
      const outstanding = await f.admin.query<{ invalidated: number }>('SELECT count(*)::int AS invalidated FROM gotchu.step_up_challenges WHERE organization_id=$1 AND id=$2 AND consumed_at IS NOT NULL', [f.b.organizationId, challengeId]);
      expect(outstanding.rows[0]?.invalidated).toBe(1);
    } finally { await f.admin.query('DELETE FROM gotchu.memberships WHERE organization_id=$1 AND user_id=$2', [f.b.organizationId, first.userId]); }
  });
});
