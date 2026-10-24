import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { z } from 'zod';
import { createCustomerAssessmentRunner, createOsvAdapter, type ScannerAdapter } from '@gotchu/customer-assessment';
import { computeGitTreeSha } from '@gotchu/git-adapters';
import { createBackend, createNpmRegistryAdapter } from '@gotchu/backend';
import { customerSourceSnapshotSchema } from '@gotchu/contracts';
import { createDatabase, migrate, provisionRuntimeLogin, type Database, type RuntimeRole } from '@gotchu/database';
import { createValidationWorker } from '../src/validator.js';

const liveUrl = process.env.GOTCHU_TEST_DATABASE_URL;
const live = liveUrl && process.env.GOTCHU_TEST_NPM_DEPENDENCY_LIVE === '1' && process.env.GOTCHU_TEST_VM === '1' ? describe : describe.skip;
const registryReleaseSchema = z.object({ version: z.string(), dist: z.object({ tarball: z.string(), integrity: z.string() }).passthrough() }).passthrough();
const packumentSchema = z.object({ versions: z.record(z.string(), registryReleaseSchema) }).passthrough();
const scanner: ScannerAdapter = {
  async readiness() { return { ready: true, tools: [] }; },
  async run(name, source) {
    const output: unknown = name === 'semgrep'
      ? { version: 'test-only', results: [], errors: [], paths: { scanned: source.files.filter(file => /\.[cm]?[jt]sx?$/i.test(file.path)).map(file => file.path) } }
      : name === 'gitleaks' ? [] : { SchemaVersion: 2, Results: source.files.filter(file => /\.(?:ya?ml|json)$/i.test(file.path)).map(file => ({ Target: file.path, Misconfigurations: [] })) };
    return { output, image: 'test-only', version: 'test-only', profileChecksum: '0'.repeat(64) };
  },
};

async function liveFixture() {
  const connectionString = present(liveUrl);
  const parsed = new URL(connectionString);
  if (!/^gotchu_test_[a-zA-Z0-9_]+$/.test(parsed.pathname.slice(1))) throw new Error('Live tests require a dedicated database named gotchu_test_*');
  await migrate({ connectionString });
  await migrate({ connectionString });
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const logins: string[] = [];
  async function database(role: RuntimeRole): Promise<Database> {
    const username = `${role}_${suffix}`;
    const password = createHash('sha256').update(randomUUID()).digest('hex');
    await provisionRuntimeLogin({ connectionString, username, password, role });
    logins.push(username);
    const url = new URL(connectionString);
    url.username = username;
    url.password = password;
    return createDatabase({ connectionString: url.toString(), role, max: 4 });
  }
  const databases: Record<RuntimeRole, Database> = {
    gotchu_api: await database('gotchu_api'), gotchu_ingest: await database('gotchu_ingest'),
    gotchu_coordinator: await database('gotchu_coordinator'), gotchu_executor: await database('gotchu_executor'),
    gotchu_validator: await database('gotchu_validator'),
  };
  const tenant = () => ({ organizationId: randomUUID(), applicationId: randomUUID(), userId: `dependency-live:${randomUUID()}` });
  const a = tenant();
  const b = tenant();
  for (const item of [a, b]) {
    await admin.query("INSERT INTO gotchu.organizations(id,name,model_budget_micros) VALUES($1,'Dependency live test',1000)", [item.organizationId]);
    await admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [item.organizationId, item.userId]);
    await admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Dependency live test')", [item.organizationId, item.applicationId]);
  }
  return {
    admin, databases, a, b,
    async close() {
      await Promise.all(Object.values(databases).map(database => database.close()));
      for (const username of logins) await admin.query(`DROP ROLE "${username}"`);
      await admin.end();
    },
  };
}

type LiveFixture = Awaited<ReturnType<typeof liveFixture>>;

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required live test value is missing');
  return value;
}

live('live npm dependency resolution and Firecracker validation (real registry, OSV, PostgreSQL and VM; non-SCA scanners are fixtures)', () => {
  let f: LiveFixture;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  let candidateSnapshot: z.infer<typeof customerSourceSnapshotSchema> | undefined;
  const shutdown = new AbortController();

  beforeAll(async () => {
    f = await liveFixture();
    const registry = createNpmRegistryAdapter();
    api = createBackend({
      database: f.databases.gotchu_api,
      npmRegistry: registry,
      actionVerifier: {
        async verify() { return { eligible: false, blockingReasons: ['live test does not authorize provider writes'] }; },
        async prepareArtifact() {
          if (!candidateSnapshot) throw new Error('live_test_candidate_missing');
          const treeSha = await computeGitTreeSha(candidateSnapshot.files.map(file => ({ path: file.path, content: file.content, mode: '100644' as const })));
          return { treeSha, unsupportedReason: null };
        },
      },
    });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    executor = createBackend({ database: f.databases.gotchu_executor });
  }, 30_000);

  afterAll(async () => {
    shutdown.abort();
    await f?.close();
  });

  it('prepares lodash 4.17.20 from live OSV/npm data, rescans it in the VM, and stores a tenant-private v2 proposal artifact', async () => {
    const pgAdmin = f.admin;
    const apiBackend = api;
    const coordinatorBackend = coordinator;
    const executorBackend = executor;
    if (!pgAdmin || !apiBackend || !coordinatorBackend || !executorBackend) throw new Error('live_test_setup_incomplete');
    const queuedElsewhere = await pgAdmin.query("SELECT id FROM gotchu.validation_runs WHERE state IN ('queued','running','quarantined') LIMIT 1");
    if (queuedElsewhere.rowCount) throw new Error('live test requires an otherwise idle GOTCHU_TEST_DATABASE_URL');

    const tenant = f.a;
    const identity = { userId: tenant.userId };
    const scope = { organizationId: tenant.organizationId, applicationId: tenant.applicationId };
    const linkId = randomUUID();
    const installationId = randomUUID().replaceAll(/\D/g, '').slice(0, 20);
    const baseCommit = 'a'.repeat(40);
    const idempotencyKey = randomUUID();
    const packument = packumentSchema.parse(await createNpmRegistryAdapter().getPackument('lodash', AbortSignal.timeout(8_500)));
    const oldRelease = packument.versions['4.17.20'];
    if (!oldRelease) throw new Error('lodash_4_17_20_not_in_registry');
    const lockedPackage: Record<string, unknown> = { name: 'lodash', version: oldRelease.version, resolved: oldRelease.dist.tarball, integrity: oldRelease.dist.integrity };
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'bin', 'license', 'hasInstallScript']) {
      if (Object.hasOwn(oldRelease, key)) lockedPackage[key] = oldRelease[key];
    }
    const manifest = {
      name: 'gotchu-lodash-live-check', version: '1.0.0', private: true,
      scripts: { test: 'node test/run.js' }, dependencies: { lodash: '^4.17.20' },
    };
    const lockfile = {
      name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
      packages: {
        '': { name: manifest.name, version: manifest.version, dependencies: { lodash: '^4.17.20' } },
        'node_modules/lodash': lockedPackage,
      },
    };
    const snapshot = customerSourceSnapshotSchema.parse({ revision: baseCommit, files: [
      { path: 'package.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      { path: 'package-lock.json', content: JSON.stringify(lockfile, null, 2) + '\n' },
      { path: 'test/run.js', content: "const fs=require('node:fs');const _=require('lodash');if(!_.isEqual({ok:true},{ok:true}))process.exitCode=1;fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/evidence.json',JSON.stringify({passed:1,failed:0,skipped:0}));\n" },
    ] });
    const uploaded = await apiBackend.customers.uploadSource(identity, { ...scope, snapshot, authorized: true });
    await pgAdmin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state)
      VALUES($1,$2,'dependency-live-test',$3,'active')`, [scope.organizationId, installationId, identity.userId]);
    await pgAdmin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,state,installation_id)
      VALUES($1,$2,$3,'gh-12345','main','granted','verified',$4)`, [scope.organizationId, scope.applicationId, linkId, installationId]);
    await pgAdmin.query(`INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest)
      VALUES($1,$2,$3,$4,$5,$6)`, [scope.organizationId, scope.applicationId, uploaded.id, linkId, baseCommit, uploaded.digest]);
    await apiBackend.validations.configureSuite(identity, { ...scope, repositoryLinkId: linkId, scriptName: 'test', suiteName: 'lodash live smoke', requiredCount: 1 });

    const request = await apiBackend.customers.queue(identity, { ...scope, mode: 'internal', sourceSnapshotId: uploaded.id, targetId: null, idempotencyKey });
    const claim = present(await coordinatorBackend.jobs.claim({ organizationId: scope.organizationId, jobId: request.jobId }));
    const input = await coordinatorBackend.customers.getRequest({ ...scope, jobId: request.jobId, leaseToken: claim.leaseToken });
    const report = await createCustomerAssessmentRunner({ scanners: scanner, advisory: createOsvAdapter() }).run(input);
    await coordinatorBackend.customers.recordResult({ input, report, leaseToken: claim.leaseToken });
    const reportContext = { ...scope, reportId: report.id };
    const recommendations = await apiBackend.corrections.reportRecommendations(identity, reportContext);
    const lodash = recommendations.dependencyFixes.find(item => item.packageName === 'lodash' && item.fromVersion === '4.17.20');
    expect(lodash?.status, JSON.stringify(lodash)).toBe('eligible');
    expect(lodash?.advisoryIds.length).toBeGreaterThan(0);
    const findingId = present(lodash?.findingIds[0]);
    const preparation = await apiBackend.corrections.prepareDependencyFix(identity, { ...reportContext, findingId, expectedSourceDigest: uploaded.digest });
    expect(preparation.fromVersion).toBe('4.17.20');
    expect(preparation.toVersion).not.toBe('4.17.20');

    const validatorKey = generateKeyPairSync('ed25519');
    const publicKey = validatorKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = createHash('sha256').update(validatorKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const worker = createValidationWorker({ database: f.databases.gotchu_validator, key: { keyId, publicKey, privateKey: validatorKey.privateKey },
      scanner: createCustomerAssessmentRunner({ scanners: scanner, advisory: createOsvAdapter() }), shutdownSignal: shutdown.signal });
    const validationClaim = await worker.claim();
    if (!validationClaim || validationClaim.runId !== preparation.validationRunId) throw new Error('live_validation_claim_mismatch');
    await worker.processClaim(validationClaim);
    const validation = await apiBackend.validations.getStatus(identity, { ...scope, candidateSourceId: preparation.candidateSourceId });
    expect(validation?.run.state, JSON.stringify(validation)).toBe('passed');
    expect(validation?.attestations.map(item => item.evidence.kind)).toEqual(expect.arrayContaining(['independent_rescan', 'functional_suite']));
    const rescan = validation?.attestations.find(item => item.evidence.kind === 'independent_rescan')?.evidence;
    expect(rescan?.kind === 'independent_rescan' ? rescan.after.identities : []).not.toContain(`npm:lodash:${lodash?.advisoryIds[0]}`);

    const candidateRow = await pgAdmin.query<{ body: unknown }>('SELECT body FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, preparation.candidateSourceId]);
    candidateSnapshot = customerSourceSnapshotSchema.parse(candidateRow.rows[0]?.body);
    const proposed = await apiBackend.actions.propose(identity, { ...scope, kind: 'dependency_pull_request', sourceRef: { type: 'dependency_candidate', candidateId: preparation.candidateSourceId } });
    const artifact = await executorBackend.executionArtifacts.readForExecutor({ ...scope, proposalId: proposed.proposalId });
    expect(artifact).toMatchObject({ baseCommit, treeComplete: true, commitMessage: expect.stringContaining('lodash 4.17.20 -> ') });
    expect(artifact.files.map(file => file.path).sort()).toEqual(['package-lock.json', 'package.json']);

    const hiddenCandidate = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT candidate_source_id FROM gotchu.dependency_fix_candidates WHERE candidate_source_id=$1', [preparation.candidateSourceId]));
    const hiddenProposal = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT id FROM gotchu.proposals WHERE id=$1', [proposed.proposalId]));
    const hiddenArtifact = await f.databases.gotchu_executor.tenant(f.b.organizationId, tx => tx.query('SELECT proposal_id FROM gotchu.execution_artifacts WHERE proposal_id=$1', [proposed.proposalId]));
    expect(hiddenCandidate.rowCount).toBe(0);
    expect(hiddenProposal.rowCount).toBe(0);
    expect(hiddenArtifact.rowCount).toBe(0);
  }, 600_000);
});
