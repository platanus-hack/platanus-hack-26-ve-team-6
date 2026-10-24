import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl, present } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
const candidateBody = { revision: 'validation-test', files: [{ path: 'src/index.ts', content: 'export const ok = true;' }] };

live('validation persistence and leases on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture({ max: 4 }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function createRun(organizationId: string, applicationId: string) {
    const baseId = randomUUID(); const candidateId = randomUUID(); const runId = randomUUID();
    const baseDigest = createHash('sha256').update(baseId).digest('hex'); const candidateDigest = createHash('sha256').update(candidateId).digest('hex');
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,'test'),($1,$2,$6,$7,$5::jsonb,'test')`, [organizationId, applicationId, baseId, baseDigest, JSON.stringify(candidateBody), candidateId, candidateDigest]);
    await f.databases.gotchu_api.tenant(organizationId, async tx => {
      await tx.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,candidate_source_id,base_source_id,
        base_snapshot_digest,candidate_tree_digest,patch_digest,runner_profile,sandbox_kind,limits)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'node24-npm-test','bwrap+systemd-scope',$11::jsonb)`,
      [organizationId, applicationId, runId, candidateId, randomUUID(), candidateId, baseId, baseDigest, candidateDigest, createHash('sha256').update(runId).digest('hex'), JSON.stringify({ vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120000, outputBytes: 262144, diskMiB: 2048 })]);
    });
    return { runId, candidateId };
  }

  it('enforces tenant isolation and immutable attestations for the validator role', async () => {
    const run = await createRun(f.a.organizationId, f.a.applicationId);
    const other = await f.databases.gotchu_validator.tenant(f.b.organizationId, tx => tx.query('SELECT id FROM gotchu.validation_runs WHERE id=$1', [run.runId]));
    expect(other.rowCount).toBe(0);
    await f.admin.query("UPDATE gotchu.validation_runs SET state='inconclusive',reason='test_complete',finished_at=clock_timestamp() WHERE id=$1", [run.runId]);
    const key = await f.databases.gotchu_validator.tenant(f.a.organizationId, async tx => {
      const keyId = 'd'.repeat(64);
      await tx.query("INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,'public-key-test')", [keyId]);
      const body = { id: randomUUID(), runId: run.runId, organizationId: f.a.organizationId, applicationId: f.a.applicationId, evidence: { kind: 'base_reproduction', result: 'unavailable', exitCode: null, durationMs: 0 }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      await tx.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
        VALUES($1,$2,$3,$4,'base_reproduction',$5::jsonb,$6,$7,$8)`, [f.a.organizationId, f.a.applicationId, run.runId, body.id, JSON.stringify(body), keyId, 'A'.repeat(86), body.expiresAt]);
      return { id: body.id };
    });
    await expect(f.databases.gotchu_validator.tenant(f.a.organizationId, tx => tx.query('UPDATE gotchu.validation_attestations SET signature=$4 WHERE organization_id=$1 AND run_id=$2 AND id=$3', [f.a.organizationId, run.runId, key.id, 'B'.repeat(86)]))).rejects.toThrow();
    expect(present(key.id)).toBeTruthy();
  });

  it('claims once, quarantines expired leases, and blocks new capacity until reconciliation', async () => {
    const first = await createRun(f.a.organizationId, f.a.applicationId);
    const claimToken = randomUUID();
    const claimed = await f.databases.gotchu_validator.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.validation_claim($1,300000)', [claimToken]));
    expect(claimed.rows).toContainEqual({ organization_id: f.a.organizationId, application_id: f.a.applicationId, run_id: first.runId });
    await f.databases.gotchu_validator.tenant(f.a.organizationId, tx => tx.query("UPDATE gotchu.validation_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.runId]));
    const blocked = await f.databases.gotchu_validator.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.validation_claim($1,300000)', [randomUUID()]));
    expect(blocked.rowCount).toBe(0);
    const quarantined = await f.databases.gotchu_validator.tenant(f.a.organizationId, tx => tx.query<{ state: string; lease_token: string }>('SELECT state,lease_token FROM gotchu.validation_runs WHERE id=$1', [first.runId]));
    expect(quarantined.rows[0]).toMatchObject({ state: 'quarantined', lease_token: claimToken });
    await f.admin.query("UPDATE gotchu.validation_runs SET state='inconclusive',reason='operator_reconciled',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1", [first.runId]);
    const next = await createRun(f.b.organizationId, f.b.applicationId);
    const after = await f.databases.gotchu_validator.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.validation_claim($1,300000)', [randomUUID()]));
    expect(after.rows[0]).toMatchObject({ organization_id: f.b.organizationId, run_id: next.runId });
  });
});
