import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createCustomerAssessmentRunner } from '@gotchu/customer-assessment';
import { createDatabase, migrate, provisionRuntimeLogin, type Database } from '@gotchu/database';
import type { RunnerResult } from '@gotchu/runner';
import { createValidationWorker } from '../src/validator.js';

const liveUrl = process.env.GOTCHU_TEST_DATABASE_URL;
const live = liveUrl ? describe : describe.skip;

function cleanupUncertainResult(): RunnerResult {
  return {
    status: 'cleanup_uncertain', reason: 'test cleanup could not be confirmed', durationMs: 1,
    isolation: {
      sandbox: { kind: 'bwrap+systemd-scope', memoryMaxMiB: 1536, tasksMax: 144, cpuQuotaPercent: 100 },
      runnerVersion: '0.1.0', firecrackerVersion: 'unavailable', kernelDigest: '0'.repeat(64), rootfsDigest: '0'.repeat(64),
      profile: 'node24-npm-test', networkPolicy: { mode: 'deny' },
      lockfileSha256: '0'.repeat(64), tarballSetSha256: '0'.repeat(64), cleanupVerified: false,
    },
  };
}

live('validator cleanup quarantine on real PostgreSQL (injected runner; no VM proof)', () => {
  let admin: pg.Client | undefined;
  let database: Database | undefined;
  let login = '';
  let organizationId = '';
  let applicationId = '';
  beforeAll(async () => {
    if (!liveUrl) throw new Error('GOTCHU_TEST_DATABASE_URL is required');
    const parsed = new URL(liveUrl);
    if (!/^gotchu_test_[a-zA-Z0-9_]+$/.test(parsed.pathname.slice(1))) throw new Error('Live tests require a dedicated database named gotchu_test_*');
    await migrate({ connectionString: liveUrl });
    await migrate({ connectionString: liveUrl });
    admin = new pg.Client({ connectionString: liveUrl });
    await admin.connect();
    const suffix = randomBytes(6).toString('hex');
    login = `validator_test_${suffix}`;
    const password = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString: liveUrl, username: login, password, role: 'gotchu_validator' });
    const runtimeUrl = new URL(liveUrl);
    runtimeUrl.username = login;
    runtimeUrl.password = password;
    database = createDatabase({ connectionString: runtimeUrl.toString(), role: 'gotchu_validator', max: 2 });
    organizationId = randomUUID();
    applicationId = randomUUID();
    await admin.query("INSERT INTO gotchu.organizations(id,name,model_budget_micros) VALUES($1,'Validator quarantine test',1000)", [organizationId]);
    await admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Validator quarantine test')", [organizationId, applicationId]);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
    if (admin) {
      if (login) await admin.query(`DROP ROLE "${login}"`);
      await admin.end();
    }
  });

  it('fences quarantine by the active lease and retains ownership until reconciliation', async () => {
    const pgAdmin = admin;
    const validatorDatabase = database;
    if (!pgAdmin || !validatorDatabase) throw new Error('PostgreSQL test fixture was not initialized');
    const repositoryLinkId = randomUUID();
    const suiteDefinitionId = randomUUID();
    const runId = randomUUID();
    const actionRef = randomUUID();
    const baseSourceId = randomUUID();
    const candidateSourceId = randomUUID();
    const baseSnapshot = {
      revision: 'quarantine-base',
      files: [
        { path: 'package.json', content: '{"name":"fixture","scripts":{"test":"node test/run.js"}}' },
        { path: 'package-lock.json', content: '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture"}}}' },
        { path: 'test/run.js', content: 'process.exit(0)' },
        { path: 'src/feature.js', content: 'module.exports = 1' },
      ],
    };
    const candidateSnapshot = {
      ...baseSnapshot,
      revision: 'quarantine-candidate',
      files: baseSnapshot.files.map(file => file.path === 'src/feature.js' ? { ...file, content: 'module.exports = 2' } : file),
    };
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const baseDigest = digest(baseSnapshot);
    const candidateDigest = digest(candidateSnapshot);
    await pgAdmin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access)
      VALUES($1,$2,$3,$4,'main','granted')`, [organizationId, applicationId, repositoryLinkId, `validator-test-${runId}`]);
    await pgAdmin.query(`INSERT INTO gotchu.validation_suite_definitions(organization_id,application_id,repository_link_id,id,version,profile,script_name,suite_name,required_count,created_by)
      VALUES($1,$2,$3,$4,1,'node24-npm-test','test','smoke',1,'validator test')`, [organizationId, applicationId, repositoryLinkId, suiteDefinitionId]);
    await pgAdmin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,'validator test'),($1,$2,$6,$7,$8::jsonb,'validator test')`, [
      organizationId, applicationId, baseSourceId, baseDigest, JSON.stringify(baseSnapshot), candidateSourceId, candidateDigest, JSON.stringify(candidateSnapshot),
    ]);
    await pgAdmin.query(`INSERT INTO gotchu.validation_runs(
      organization_id,application_id,id,action_ref,target_finding_id,candidate_source_id,base_source_id,
      suite_repository_link_id,suite_definition_id,suite_version,base_snapshot_digest,candidate_tree_digest,patch_digest,
      runner_profile,sandbox_kind,limits)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,'node24-npm-test','bwrap+systemd-scope',$13::jsonb)`, [
      organizationId, applicationId, runId, actionRef, randomUUID(), candidateSourceId, baseSourceId, repositoryLinkId, suiteDefinitionId,
      baseDigest, candidateDigest, digest(runId), JSON.stringify({ vcpu: 1, memMiB: 1024, pids: 128, wallMs: 10_000, outputBytes: 16_384, diskMiB: 2048 }),
    ]);

    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = createHash('sha256').update(keyPair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const shutdown = new AbortController();
    const scanner = createCustomerAssessmentRunner();
    const scan = vi.spyOn(scanner, 'run');
    let runnerCalls = 0;
    let gateChecks = 0;
    const worker = createValidationWorker({
      database: validatorDatabase,
      key: { keyId, publicKey, privateKey: keyPair.privateKey },
      scanner,
      concurrency: 2,
      shutdownSignal: shutdown.signal,
      runnerGate: async () => { gateChecks += 1; return { status: 'open' }; },
      runnerJobAdapter: async (job, _options, resolveInput) => {
        const staged = await resolveInput(job.input, { organizationId: job.organizationId, jobId: job.jobId });
        expect(staged.byteLength).toBe(job.input.sizeBytes);
        expect(createHash('sha256').update(staged).digest('hex')).toBe(job.input.sha256);
        runnerCalls += 1;
        return cleanupUncertainResult();
      },
    });
    const claim = await worker.claim();
    expect(claim).toMatchObject({ organizationId, applicationId, runId });
    const activeClaim = claim;
    if (!activeClaim) throw new Error('Expected validator claim');

    const processing = worker.processClaim(activeClaim);
    try {
      await vi.waitFor(async () => {
        const state = await validatorDatabase.tenant(organizationId, tx => tx.query<{ state: string; lease_token: string }>(
          'SELECT state,lease_token FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND id=$3', [organizationId, applicationId, runId],
        ));
        expect(state.rows[0]).toMatchObject({ state: 'quarantined', lease_token: activeClaim.leaseToken });
      });
      expect(runnerCalls).toBe(1);
      expect(gateChecks).toBe(1);
      expect(scan).not.toHaveBeenCalled();

      await pgAdmin.query(`UPDATE gotchu.validation_runs SET state='inconclusive',reason='operator_reconciled',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp()
        WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND state='quarantined' AND lease_token=$4`, [organizationId, applicationId, runId, activeClaim.leaseToken]);
      await processing;
    } finally {
      shutdown.abort();
      await processing.catch(() => undefined);
    }
  }, 30_000);
});
