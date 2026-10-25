import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
// Synthetic persistence fixtures only; no model, scanner, or customer execution.
live('private AI correction source lifecycle with real PostgreSQL roles', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function correction() {
    const identity = { userId: `source-lifecycle:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Lifecycle fixture' });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Fixture' });
    const scope = { organizationId: workspace.id, applicationId: application.applicationId };
    const upload = (revision: string) => api.customers.uploadSource(identity, { ...scope, authorized: true,
      snapshot: { revision, files: [{ path: 'src/value.ts', content: `export const value = '${revision}';` }] } });
    const base = await upload('base'); const candidate = await upload('candidate');
    const assessment = await api.customers.queue(identity, { ...scope, mode: 'internal', sourceSnapshotId: base.id,
      targetId: null, idempotencyKey: randomUUID() });
    const rescan = await api.customers.queue(identity, { ...scope, mode: 'internal', sourceSnapshotId: candidate.id,
      targetId: null, idempotencyKey: randomUUID() });
    const reportId = randomUUID(); const jobId = randomUUID(); const id = randomUUID();
    const findingId = randomUUID(); const validationId = randomUUID();
    await f.admin.query("UPDATE gotchu.jobs SET state='succeeded' WHERE organization_id=$1", [scope.organizationId]);
    await f.admin.query(`INSERT INTO gotchu.customer_reports(organization_id,application_id,id,job_id,body)
      SELECT organization_id,application_id,$3,job_id,jsonb_build_object('version',2,'organizationId',organization_id,
        'applicationId',application_id,'id',$3::uuid,'jobId',job_id,'responseMode','observation','actionsPerformed','[]'::jsonb,
        'mode',input->'mode','applicationName',input->'applicationName','subject',jsonb_build_object(
          'sourceSnapshotId',input->'source'->'id','sourceDigest',input->'source'->'digest',
          'targetId',NULL,'targetVersion',NULL,'origin',NULL,'containerImageId',NULL,'containerImageDigest',NULL,'containerImageReference',NULL))
      FROM gotchu.customer_requests WHERE organization_id=$1 AND job_id=$2`, [scope.organizationId, assessment.jobId, reportId]);
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,state)
      VALUES($1,$2,$3,'investigation',$3::text,'succeeded')`, [scope.organizationId, scope.applicationId, jobId]);
    await f.admin.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,
      candidate_source_id,base_source_id,base_snapshot_digest,candidate_tree_digest,patch_digest,state,finished_at,runner_profile,sandbox_kind,limits)
      VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8,repeat('a',64),'inconclusive',clock_timestamp(),'node24-npm-test','bwrap+systemd-scope','{}')`,
    [scope.organizationId, scope.applicationId, validationId, candidate.id, findingId, base.id, base.digest, candidate.digest]);
    await f.databases.gotchu_api.tenant(scope.organizationId, tx => tx.query(`INSERT INTO gotchu.ai_correction_requests(
      organization_id,application_id,id,job_id,report_id,finding_id,base_source_id,source_digest,requested_by,model_config_sha256,
      authorized_files,state,candidate_source_id,patch_hash,validation_run_id,rescan_job_id,model_patch,diff,suggestion,summary,implications,risks,validation_plan)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,repeat('a',64),'[{"path":"src/value.ts","sha256":"${'a'.repeat(64)}"}]',
        'prepared',$10,repeat('b',64),$11,$12,'{"before":"synthetic-private-code"}',
        '[{"path":"src/value.ts","before":"synthetic-private-code","after":"replacement"}]',
        '{"summary":"synthetic-private-code"}','synthetic-private-code','["synthetic-private-code"]',
        '["synthetic-private-code"]','["synthetic-private-code"]')`,
    [scope.organizationId, scope.applicationId, id, jobId, reportId, findingId, base.id, base.digest, identity.userId,
      candidate.id, validationId, rescan.jobId]));
    return { identity, scope, base, candidate, id, jobId, reportId, validationId, rescanJobId: rescan.jobId };
  }
  type Correction = Awaited<ReturnType<typeof correction>>;
  const row = async (c: Correction) => present((await f.admin.query<Record<string, unknown>>(
    'SELECT * FROM gotchu.ai_correction_requests WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.id])).rows[0]);
  async function assertErased(c: Correction) {
    expect(await row(c)).toMatchObject({ state: 'failed', reason_code: 'correction_source_unavailable',
      model_patch: null, diff: [], suggestion: null, summary: null, implications: [], risks: [], validation_plan: [],
      base_source_id: c.base.id, candidate_source_id: c.candidate.id, source_digest: c.base.digest,
      patch_hash: 'b'.repeat(64), validation_run_id: c.validationId, rescan_job_id: c.rescanJobId });
  }
  const remove = (c: Correction, sourceId: string) => api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: sourceId });

  async function expireReport(c: Correction) {
    await f.admin.query("UPDATE gotchu.customer_reports SET created_at=clock_timestamp()-interval '366 days' WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, c.reportId]);
  }
  async function purgeReports(c: Correction) {
    await f.admin.query('UPDATE gotchu.retention_purge_jobs SET next_due_at=clock_timestamp() WHERE organization_id=$1', [c.scope.organizationId]);
    return coordinator.retention.purge(present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]));
  }

  it.each(['prepared', 'failed', 'cancelled'])('purges an expired report and its %s private request, preserving independent records', async state => {
    const c = await correction(); const other = await correction();
    await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.ai_correction_requests SET state=$3 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.id, state]));
    expect(await purgeReports(c)).toMatchObject({ reports: 0 });
    await expireReport(c);
    expect(await purgeReports(c)).toMatchObject({ reports: 1, sourceSnapshots: 0 });
    for (const table of ['customer_reports', 'ai_correction_requests']) {
      expect((await f.admin.query(`SELECT id FROM gotchu.${table} WHERE organization_id=$1`, [c.scope.organizationId])).rowCount).toBe(0);
    }
    expect((await f.admin.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.jobId])).rowCount).toBe(1);
    expect((await f.admin.query('SELECT id FROM gotchu.validation_runs WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.validationId])).rowCount).toBe(1);
    expect((await api.customers.listSources(c.identity, c.scope)).map(source => source.id)).toEqual(expect.arrayContaining([c.base.id, c.candidate.id]));
    expect((await row(other)).model_patch).not.toBeNull();
    const audits = await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action='retention.purged'", [c.scope.organizationId]);
    expect(JSON.stringify(audits.rows)).not.toContain('synthetic-private-code');
  });

  it.each(['queued', 'running', 'reconciliation_required'])('defers expired reports for a %s request', async state => {
    const c = await correction(); await expireReport(c);
    await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.ai_correction_requests SET state=$3 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.id, state]));
    expect(await purgeReports(c)).toMatchObject({ reports: 0 });
    expect((await row(c)).model_patch).not.toBeNull();
  });

  it('retains reports until jobs, usage holds, rescans and validations settle', async () => {
    const c = await correction(); await expireReport(c);
    const retained = async () => {
      expect(await purgeReports(c)).toMatchObject({ reports: 0 });
      expect((await row(c)).model_patch).not.toBeNull();
    };
    for (const jobId of [c.jobId, c.rescanJobId]) {
      for (const state of ['queued', 'running']) {
        await f.admin.query('UPDATE gotchu.jobs SET state=$3 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, jobId, state]);
        await retained();
      }
      await f.admin.query(`UPDATE gotchu.jobs SET state='failed',result='{"reasonCode":"assessment_reconciliation_required"}'
        WHERE organization_id=$1 AND id=$2`, [c.scope.organizationId, jobId]);
      await retained();
      await f.admin.query("UPDATE gotchu.jobs SET state='succeeded',result=NULL WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, jobId]);
    }
    const runId = randomUUID(); const reservationId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.agent_runs(organization_id,application_id,id,job_id,state,deadline)
      VALUES($1,$2,$3,$4,'pending',clock_timestamp())`, [c.scope.organizationId, c.scope.applicationId, runId, c.jobId]);
    await retained();
    await f.admin.query("UPDATE gotchu.agent_runs SET state='running' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, runId]);
    await retained();
    await f.admin.query("UPDATE gotchu.agent_runs SET state='failed',reserved_micros=1 WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, runId]);
    await retained();
    await f.admin.query('UPDATE gotchu.agent_runs SET reserved_micros=0,tokens_reserved=1 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, runId]);
    await retained();
    await f.admin.query('UPDATE gotchu.agent_runs SET tokens_reserved=0 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, runId]);
    await f.admin.query(`INSERT INTO gotchu.model_reservations(organization_id,id,run_id,amount_micros,state)
      VALUES($1,$2,$3,1,'unknown')`, [c.scope.organizationId, reservationId, runId]);
    await retained();
    expect((await f.admin.query('SELECT state,charged_micros FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2',
      [c.scope.organizationId, reservationId])).rows[0]).toEqual({ state: 'unknown', charged_micros: null });
    await f.admin.query("UPDATE gotchu.model_reservations SET state='settled',charged_micros=1,charged_tokens=0 WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, reservationId]);
    for (const state of ['queued', 'running', 'quarantined']) {
      await f.admin.query(`UPDATE gotchu.validation_runs SET state=$3,
        lease_token=CASE WHEN $3='queued' THEN NULL ELSE gen_random_uuid() END,
        lease_until=CASE WHEN $3='queued' THEN NULL ELSE clock_timestamp()+interval '1 hour' END
        WHERE organization_id=$1 AND id=$2`, [c.scope.organizationId, c.validationId, state]);
      await retained();
    }
    await f.admin.query("UPDATE gotchu.validation_runs SET state='inconclusive',lease_token=NULL,lease_until=NULL WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, c.validationId]);
    expect(await purgeReports(c)).toMatchObject({ reports: 1 });
    expect((await f.admin.query('SELECT state,charged_micros FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2',
      [c.scope.organizationId, reservationId])).rows[0]).toEqual({ state: 'settled', charged_micros: '1' });
  });

  it.each(['executing', 'uncertain', 'reconciliation_required'])('retains the report for a directly linked %s proposal', async state => {
    const c = await correction(); await expireReport(c);
    const proposalId = randomUUID();
    // No correction.prepared audit: exercise the request's canonical candidate link.
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,
      version,kind,capability_id,state,source_ref) VALUES($1,$2,$3,repeat('a',64),'{}',1,2,
      'source_patch_pull_request','repository.source_patch_pr',$4,jsonb_build_object('candidateId',$5::text))`,
    [c.scope.organizationId, c.scope.applicationId, proposalId, state, c.candidate.id]);
    expect(await purgeReports(c)).toMatchObject({ reports: 0 });
    expect((await row(c)).model_patch).not.toBeNull();
    await f.admin.query("UPDATE gotchu.proposals SET state='succeeded' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, proposalId]);
    expect(await purgeReports(c)).toMatchObject({ reports: 1 });
  });

  async function newJob(c: Correction) {
    const id = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key)
      VALUES($1,$2,$3,'investigation',$3::text)`, [c.scope.organizationId, c.scope.applicationId, id]);
    return id;
  }
  const insertRequest = (tx: Transaction, c: Correction, jobId: string) => tx.query(`INSERT INTO gotchu.ai_correction_requests(
    organization_id,application_id,id,job_id,report_id,finding_id,base_source_id,source_digest,requested_by,model_config_sha256,authorized_files)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,repeat('a',64),'[{"path":"src/value.ts"}]')`,
  [c.scope.organizationId, c.scope.applicationId, randomUUID(), jobId, c.reportId, randomUUID(), c.base.id, c.base.digest, c.identity.userId]);

  it('serializes report deletion against a newly inserted request before allowing retention', async () => {
    const c = await correction(); await expireReport(c);
    const jobId = await newJob(c);
    const claim = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    await f.databases.gotchu_api.tenant(c.scope.organizationId, async tx => {
      await insertRequest(tx, c, jobId);
      await expect(f.databases.gotchu_coordinator.tenant(c.scope.organizationId, async purge => {
        await purge.query("SET LOCAL lock_timeout='100ms'");
        return purge.query('SELECT gotchu.retention_purge($1,$2,$3,$4)',
          [claim.organization_id, claim.application_id, claim.job_id, claim.lease_token]);
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect(await coordinator.retention.purge(claim)).toMatchObject({ reports: 0 });
    expect((await row(c)).model_patch).not.toBeNull();
  });

  it('rejects request admission after a concurrent report purge commits', async () => {
    const c = await correction(); await expireReport(c);
    const jobId = await newJob(c);
    const claim = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    await f.databases.gotchu_coordinator.tenant(c.scope.organizationId, async tx => {
      const purged = await tx.query('SELECT gotchu.retention_purge($1,$2,$3,$4) AS result',
        [claim.organization_id, claim.application_id, claim.job_id, claim.lease_token]);
      expect(purged.rows[0]?.result).toMatchObject({ reports: 1 });
      await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, async insert => {
        await insert.query("SET LOCAL lock_timeout='100ms'");
        return insertRequest(insert, c, jobId);
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => insertRequest(tx, c, jobId)))
      .rejects.toMatchObject({ code: '23503', message: 'correction_report_unavailable' });
  });

  it('defers a locked dependency and grants no report or request deletion capability', async () => {
    const c = await correction(); await expireReport(c);
    await f.databases.gotchu_api.tenant(c.scope.organizationId, async tx => {
      await tx.query('SELECT id FROM gotchu.ai_correction_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE', [c.scope.organizationId, c.id]);
      expect(await purgeReports(c)).toMatchObject({ reports: 0 });
    });
    for (const helper of ['erase_private_correction_report', 'guard_private_correction_report']) {
      await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(`SELECT gotchu.${helper}()`)))
        .rejects.toMatchObject({ code: '42501' });
    }
    for (const table of ['customer_reports', 'ai_correction_requests']) {
      await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, async tx => {
        await tx.query("SET LOCAL gotchu.retention_purge='enabled'");
        return tx.query(`DELETE FROM gotchu.${table} WHERE organization_id=$1`, [c.scope.organizationId]);
      })).rejects.toMatchObject({ code: '42501' });
    }
    expect(await purgeReports(c)).toMatchObject({ reports: 1 });
  });

  it.each(['base', 'candidate'] as const)('erases all model content when the %s is deleted, retaining references', async which => {
    const c = await correction();
    await remove(c, c[which].id);
    await remove(c, c[which].id);
    await assertErased(c);
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      "UPDATE gotchu.ai_correction_requests SET model_patch='{}' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.id])))
      .rejects.toMatchObject({ code: '55000', message: 'correction_source_unavailable' });
  });

  it('releases prepared deduplication after candidate deletion while leaving the base usable', async () => {
    const c = await correction();
    await remove(c, c.candidate.id);
    const nextJob = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key)
      VALUES($1,$2,$3,'investigation',$3::text)`, [c.scope.organizationId, c.scope.applicationId, nextJob]);
    await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(`INSERT INTO gotchu.ai_correction_requests(
      organization_id,application_id,id,job_id,report_id,finding_id,base_source_id,source_digest,requested_by,model_config_sha256,authorized_files)
      SELECT organization_id,application_id,$3,$4,report_id,finding_id,base_source_id,source_digest,requested_by,model_config_sha256,authorized_files
      FROM gotchu.ai_correction_requests WHERE organization_id=$1 AND id=$2`, [c.scope.organizationId, c.id, randomUUID(), nextJob]));
    expect((await api.customers.listSources(c.identity, c.scope)).map(source => source.id)).toContain(c.base.id);
  });

  it.each(['base', 'candidate'] as const)('blocks deleting a %s for active AI work and unresolved usage', async which => {
    const c = await correction();
    await f.admin.query("UPDATE gotchu.jobs SET state='queued' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.jobId]);
    await expect(remove(c, c[which].id)).rejects.toMatchObject({ status: 409, code: 'source_in_use' });
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.jobId]);
    const runId = randomUUID(); const reservationId = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.agent_runs(organization_id,application_id,id,job_id,state,deadline)
      VALUES($1,$2,$3,$4,'failed',clock_timestamp())`, [c.scope.organizationId, c.scope.applicationId, runId, c.jobId]);
    // Even inconsistent zero aggregate counters cannot hide an unresolved reservation.
    await f.admin.query(`INSERT INTO gotchu.model_reservations(organization_id,id,run_id,amount_micros,state)
      VALUES($1,$2,$3,1,'unknown')`, [c.scope.organizationId, reservationId, runId]);
    await expect(remove(c, c[which].id)).rejects.toMatchObject({ status: 409, code: 'source_in_use' });
    await f.admin.query("UPDATE gotchu.customer_sources SET created_at=clock_timestamp()-interval '91 days' WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, c[which].id]);
    const claim = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    expect(await coordinator.retention.purge(claim)).toMatchObject({ sourceSnapshots: 0 });
    expect((await row(c)).model_patch).not.toBeNull();
    expect((await f.admin.query('SELECT state,charged_micros FROM gotchu.model_reservations WHERE organization_id=$1 AND id=$2',
      [c.scope.organizationId, reservationId])).rows[0]).toEqual({ state: 'unknown', charged_micros: null });
    await f.admin.query("UPDATE gotchu.model_reservations SET state='settled',charged_micros=1,charged_tokens=0 WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, reservationId]);
    await remove(c, c[which].id);
    await assertErased(c);
  });

  it('protects the base while candidate rescans or validation still depend on it', async () => {
    const c = await correction();
    await f.admin.query("UPDATE gotchu.jobs SET state='queued' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.rescanJobId]);
    await expect(remove(c, c.base.id)).rejects.toMatchObject({ code: 'source_in_use' });
    await f.admin.query("UPDATE gotchu.jobs SET state='succeeded' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.rescanJobId]);
    await f.admin.query("UPDATE gotchu.validation_runs SET state='queued' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.validationId]);
    await expect(remove(c, c.base.id)).rejects.toMatchObject({ code: 'source_in_use' });
  });

  it.each(['queued', 'running', 'reconciliation_required'])('preserves snapshots while the request is %s', async state => {
    const c = await correction();
    await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.ai_correction_requests SET state=$3 WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.id, state]));
    await expect(remove(c, c.base.id)).rejects.toMatchObject({ code: 'source_in_use' });
    await expect(remove(c, c.candidate.id)).rejects.toMatchObject({ code: 'source_in_use' });
    expect((await api.customers.listSources(c.identity, c.scope)).map(source => source.id)).toEqual(expect.arrayContaining([c.base.id, c.candidate.id]));
  });

  it.each(['base', 'candidate'] as const)('retention skips a busy %s and erases it after work settles', async which => {
    const c = await correction();
    await f.admin.query("UPDATE gotchu.customer_sources SET created_at=clock_timestamp()-interval '91 days' WHERE organization_id=$1 AND id=$2",
      [c.scope.organizationId, c[which].id]);
    await f.admin.query("UPDATE gotchu.jobs SET state='running' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.jobId]);
    const claim = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    expect(await coordinator.retention.purge(claim)).toMatchObject({ sourceSnapshots: 0 });
    expect((await row(c)).diff).not.toEqual([]);
    await f.admin.query("UPDATE gotchu.jobs SET state='succeeded' WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.jobId]);
    await f.admin.query("UPDATE gotchu.retention_purge_jobs SET next_due_at=clock_timestamp() WHERE organization_id=$1", [c.scope.organizationId]);
    const next = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    expect(await coordinator.retention.purge(next)).toMatchObject({ sourceSnapshots: 1 });
    await assertErased(c);
  });

  it('preserves retained diffs and does not expose source writes or helpers to API tenants', async () => {
    const c = await correction(); const other = await correction();
    const claim = present((await coordinator.retention.claimDue({ organizationId: c.scope.organizationId }))[0]);
    expect(await coordinator.retention.purge(claim)).toMatchObject({ sourceSnapshots: 0 });
    expect((await row(c)).diff).not.toEqual([]);
    await expect(api.customers.deleteSource(other.identity, { ...c.scope, sourceSnapshotId: c.base.id })).rejects.toMatchObject({ status: 403 });
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.customer_sources SET body=NULL,deleted_at=clock_timestamp() WHERE id=$1', [c.base.id])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query('SELECT gotchu.erase_private_correction_source()')))
      .rejects.toMatchObject({ code: '42501' });
    await remove(c, c.base.id);
    expect((await row(other)).diff).not.toEqual([]);
    expect((await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'SELECT id FROM gotchu.ai_correction_requests WHERE id=$1', [other.id]))).rowCount).toBe(0);
  });
});
