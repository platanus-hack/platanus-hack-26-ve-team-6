import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setRecoveryState, type Transaction } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, createWebAuthnStepUpService, type Proposal } from '../src/index.js';
import { eligibilityFixture, proposalFixture } from './proposal-fixtures.js';

const live = liveUrl ? describe : describe.skip;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
live('workspace invitations and membership lifecycle on real Postgres', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let legacyStepUp: ReturnType<typeof createWebAuthnStepUpService>;
  let executor: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 12 });
    const options = {
      proposalVerifier: { verify: async (proposal: Proposal) => eligibilityFixture(proposal) },
    };
    api = createBackend({ database: f.databases.gotchu_api, ...options });
    legacyStepUp = createWebAuthnStepUpService({ database:f.databases.gotchu_api,webAuthn:{rpID:'localhost',origin:'http://localhost:3000'} });
    executor = createBackend({ database: f.databases.gotchu_executor, ...options });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: membership ledger; no provider writes' });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('isolates member projections across tenants and denies viewer/operator management', async () => {
    const viewer = `oidc:${randomUUID()}`; const operator = `github:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer'),($1,$3,'operator')", [f.a.organizationId, viewer, operator]);
    const visible = await api.members.list({ userId: viewer }, { organizationId: f.a.organizationId });
    expect(visible.map(member => member.userId)).toContain(f.a.userId);
    expect(await api.members.list({ userId: f.b.userId }, { organizationId: f.b.organizationId })).toHaveLength(1);
    await expect(api.members.list({ userId: viewer }, { organizationId: f.b.organizationId })).rejects.toMatchObject({ code: 'forbidden' });
    for (const userId of [viewer, operator]) {
      await expect(api.members.invite({ userId }, { organizationId: f.a.organizationId, email: `${randomUUID()}@example.test`, role: 'viewer' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(api.members.changeRole({ userId }, { organizationId: f.a.organizationId, userId: f.a.userId, role: 'viewer' })).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('keeps one Owner when concurrent role changes target the last two Owners', async () => {
    const owner = `oidc:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, owner]);
    try {
      const changes = await Promise.allSettled([
        api.members.changeRole({ userId: f.a.userId }, { organizationId: f.a.organizationId, userId: f.a.userId, role: 'operator' }),
        api.members.changeRole({ userId: owner }, { organizationId: f.a.organizationId, userId: owner, role: 'viewer' }),
      ]);
      expect(changes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(changes.filter(result => result.status === 'rejected')).toHaveLength(1);
      const owners = await f.admin.query("SELECT owner_count,(SELECT count(*)::int FROM gotchu.memberships WHERE organization_id=$1 AND role='owner') AS actual FROM gotchu.organizations WHERE id=$1", [f.a.organizationId]);
      expect(owners.rows[0]).toEqual({ owner_count: 1, actual: 1 });
    } finally {
      await f.admin.query("UPDATE gotchu.memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
      await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, owner]);
    }
  });

  it('binds invites to normalized email, rejects revoked/expired/reused tokens and consumes concurrent acceptance once', async () => {
    const invite = await api.members.invite({ userId: f.a.userId }, { organizationId: f.a.organizationId, email: '  JOINER@example.test ', role: 'operator' });
    const mismatchUser = `credentials:${randomUUID()}`;
    await expect(api.members.accept({ userId: mismatchUser }, null, { token: invite.token })).rejects.toMatchObject({ code: 'invitation_email_unavailable' });
    await expect(api.members.accept({ userId: mismatchUser }, 'other@example.test', { token: invite.token })).rejects.toMatchObject({ code: 'invitation_email_mismatch' });
    const acceptedUsers = [`credentials:${randomUUID()}`, `oidc:${randomUUID()}`];
    const attempts = await Promise.allSettled(acceptedUsers.map(userId => api.members.accept({ userId }, 'joiner@example.test', { token: invite.token })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const loser = attempts.find(result => result.status === 'rejected');
    expect(loser?.status === 'rejected' ? loser.reason : null).toMatchObject({ code: 'invitation_used' });
    expect((await f.admin.query('SELECT token_hash FROM gotchu.workspace_invitations WHERE id=$1', [invite.invitation.id])).rows[0]?.token_hash).toBe(digest(invite.token));
    const stored = await f.admin.query('SELECT * FROM gotchu.workspace_invitations WHERE id=$1', [invite.invitation.id]);
    expect(JSON.stringify(stored.rows[0])).not.toContain(invite.token);

    const revoked = await api.members.invite({ userId: f.a.userId }, { organizationId: f.a.organizationId, email: 'revoked@example.test', role: 'viewer' });
    await api.members.revokeInvitation({ userId: f.a.userId }, { organizationId: f.a.organizationId, invitationId: revoked.invitation.id });
    await expect(api.members.accept({ userId: `oidc:${randomUUID()}` }, 'revoked@example.test', { token: revoked.token })).rejects.toMatchObject({ code: 'invitation_revoked' });
    const expired = await api.members.invite({ userId: f.a.userId }, { organizationId: f.a.organizationId, email: 'expired@example.test', role: 'viewer' });
    await f.admin.query("UPDATE gotchu.workspace_invitations SET created_at=clock_timestamp()-interval '8 days', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.invitation.id]);
    await expect(api.members.accept({ userId: `oidc:${randomUUID()}` }, 'expired@example.test', { token: expired.token })).rejects.toMatchObject({ code: 'invitation_expired' });
  });

  it('enforces pending, daily-invite and member bounds and records mutations in the audit ledger', async () => {
    const pendingOrg = randomUUID();
    await f.admin.query("INSERT INTO gotchu.organizations(id,name) VALUES($1,'Pending limit')", [pendingOrg]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [pendingOrg, f.a.userId]);
    await f.admin.query(`INSERT INTO gotchu.workspace_invitations(organization_id,id,email,role,invited_by,token_hash,expires_at)
      SELECT $1,gen_random_uuid(),('pending'||n||'@example.test'),'viewer',$2,md5(random()::text||clock_timestamp()::text)||md5(random()::text),clock_timestamp()+interval '7 days'
      FROM generate_series(1,50) n`, [pendingOrg, f.a.userId]);
    await expect(api.members.invite({ userId: f.a.userId }, { organizationId: pendingOrg, email: 'too-many@example.test', role: 'viewer' })).rejects.toMatchObject({ code: 'pending_invitation_limit' });

    const dailyOrg = randomUUID();
    await f.admin.query("INSERT INTO gotchu.organizations(id,name) VALUES($1,'Daily limit')", [dailyOrg]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [dailyOrg, f.a.userId]);
    for (let i = 0; i < 20; i++) await api.members.invite({ userId: f.a.userId }, { organizationId: dailyOrg, email: `daily-${i}@example.test`, role: 'viewer' });
    await expect(api.members.invite({ userId: f.a.userId }, { organizationId: dailyOrg, email: 'daily-over@example.test', role: 'viewer' })).rejects.toMatchObject({ code: 'daily_invitation_limit' });

    const fullOrg = randomUUID();
    await f.admin.query("INSERT INTO gotchu.organizations(id,name) VALUES($1,'Member limit')", [fullOrg]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [fullOrg, f.a.userId]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) SELECT $1,'limit:'||n,'viewer' FROM generate_series(1,99) n", [fullOrg]);
    await expect(api.members.invite({ userId: f.a.userId }, { organizationId: fullOrg, email: 'member-over@example.test', role: 'viewer' })).rejects.toMatchObject({ code: 'member_limit' });
    const audit = await f.admin.query("SELECT count(*)::int AS count FROM gotchu.audit_records WHERE organization_id=$1 AND action LIKE 'member.%'", [dailyOrg]);
    expect(audit.rows[0]?.count).toBe(20);
  });

  it('removal invalidates historical proofs and an Owner session approval atomically', async () => {
    const anotherOwner = `oidc:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.a.organizationId, anotherOwner]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [f.b.organizationId, f.a.userId]);
    const userId = f.a.userId; const factorId = randomUUID(); const proof = randomUUID(); const proofId = randomUUID();
    const epoch = await f.admin.query('SELECT recovery_epoch FROM gotchu.platform_state WHERE singleton');
    await f.admin.query('INSERT INTO gotchu.step_up_user_factors(user_id,id,credential_id,public_key,label) VALUES($1,$2,$3,$4,$5)', [userId,factorId,randomUUID(),Buffer.from([1,2,3]),'fixture']);
    await f.admin.query(`INSERT INTO gotchu.step_up_proofs(organization_id,id,user_id,proof_hash,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id,factor_count,factor_ids)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '3 minutes',$7,1,ARRAY[$7]::uuid[])`, [f.a.organizationId,proofId,userId,digest(proof),'a'.repeat(64),epoch.rows[0]?.recovery_epoch,factorId]);
    await f.admin.query(`INSERT INTO gotchu.step_up_challenges(organization_id,id,user_id,purpose,action_hash,challenge,recovery_epoch,expires_at)
      VALUES($1,$2,$3,'assert',$4,$5,$6,clock_timestamp()+interval '2 minutes')`, [f.a.organizationId,randomUUID(),userId,'a'.repeat(64),randomUUID()+'-challenge-string-long-enough',epoch.rows[0]?.recovery_epoch]);
    const proposal = proposalFixture(f.a);
    const prepared = await api.proposals.create({ organizationId: f.a.organizationId, proposal });
    const approval = await api.proposals.approve({ userId }, { organizationId: f.a.organizationId, proposalId: prepared.proposalId, actionHash: prepared.actionHash });
    await api.members.remove({ userId: anotherOwner }, { organizationId: f.a.organizationId, userId });
    try {
      await expect(legacyStepUp.verifier.verify({ proof, userId, organizationId: f.a.organizationId, actionHash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'step_up_proof_invalid' });
      await expect(executor.executions.claim({ organizationId: f.a.organizationId, approvalId: approval.approvalId })).rejects.toMatchObject({ code: 'approval_used' });
      const stored = await f.admin.query('SELECT consumed_at FROM gotchu.approvals WHERE organization_id=$1 AND id=$2', [f.a.organizationId, approval.approvalId]);
      expect(stored.rows[0]?.consumed_at).not.toBeNull();
      expect(await legacyStepUp.list({ userId }, f.b.organizationId)).toMatchObject([{ id: factorId, label: 'fixture' }]);
      const factors = await f.admin.query('SELECT count(*)::int AS count FROM gotchu.step_up_user_factors WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [userId, factorId]);
      expect(factors.rows[0]?.count).toBe(1);
    } finally {
      await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT(organization_id,user_id) DO UPDATE SET role='owner'", [f.a.organizationId, userId]);
    }
  });

  it('waits for an in-flight authorization before removal takes effect', async () => {
    const target = `operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [f.a.organizationId,target]);
    let release = () => {};
    let locked = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const held = f.databases.gotchu_api.tenant(f.a.organizationId, async tx => {
      await tx.query('SELECT gotchu.lock_membership($1,$2)', [f.a.organizationId,target]); locked(); await gate;
    });
    await ready;
    const removal = api.members.remove({ userId: f.a.userId }, { organizationId: f.a.organizationId, userId: target });
    const ordinaryRead = removal.then(() => api.members.list({ userId: f.a.userId }, { organizationId: f.a.organizationId }));
    try {
      await expect.poll(async () => {
        const result = await f.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1
          AND wait_event_type='Lock' AND query LIKE 'SELECT gotchu.workspace_member_remove%'`, [new URL(f.runtimeConnectionString('gotchu_api')).username]);
        return result.rows[0]?.count;
      }, { timeout: 3_000 }).toBeGreaterThan(0);
    } finally { release(); }
    await held; await removal;
    expect((await ordinaryRead).map(member => member.userId)).not.toContain(target);
    await expect(api.customers.listApplications({ userId: target }, { organizationId: f.a.organizationId })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns a typed lock-timeout when authorization cannot acquire the shared membership lock', async () => {
    const database = {
      ...f.databases.gotchu_api,
      tenant: <T>(organizationId: string, work: (tx: Transaction) => Promise<T>) =>
        f.databases.gotchu_api.tenant(organizationId, async tx => {
          await tx.query("SET LOCAL lock_timeout='100ms'");
          return work(tx);
        }),
    };
    const shortTimeoutApi = createBackend({ database });
    await f.admin.query('BEGIN');
    try {
      await f.admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-member:${f.a.organizationId}:${f.a.userId}`]);
      await expect(shortTimeoutApi.members.list({ userId: f.a.userId }, { organizationId: f.a.organizationId }))
        .rejects.toMatchObject({ code: 'membership_lock_timeout', status: 503 });
    } finally {
      await f.admin.query('ROLLBACK');
    }
  });
});
