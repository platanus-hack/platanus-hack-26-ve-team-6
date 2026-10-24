import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeGitTreeSha } from '@gotchu/git-adapters';
import { canonicalJson, createBackend, sha256 } from '../src/index.js';
import { fixture, liveUrl } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;

live('dependency candidate action persistence on real PostgreSQL (synthetic validation facts)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let executor: ReturnType<typeof createBackend>;
  const baseCommit = 'a'.repeat(40);
  const packageName = 'safe-package';
  const advisoryId = 'GHSA-test-1234-5678';
  const fromVersion = '1.0.0';
  const toVersion = '1.0.1';
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    const actionVerifier = {
      async verify() { return { eligible: false, blockingReasons: ['synthetic validation facts'] }; },
      async prepareArtifact(input: { files: readonly { path: string; content: string; mode?: '100644' | '100755' }[] }) {
        return { treeSha: await computeGitTreeSha(input.files), unsupportedReason: null };
      },
    };
    api = createBackend({ database: f.databases.gotchu_api, actionVerifier });
    executor = createBackend({ database: f.databases.gotchu_executor });
  }, 30_000);

  afterAll(async () => { await f?.close(); });

  it('stores the exact v2 proposal and private publication artifact, scoped to one tenant', async () => {
    const organizationId = f.a.organizationId;
    const applicationId = f.a.applicationId;
    const repositoryLinkId = randomUUID();
    const installationId = randomUUID().replaceAll(/\D/g, '').slice(0, 20);
    const baseSourceId = randomUUID();
    const candidateSourceId = randomUUID();
    const reportId = randomUUID();
    const jobId = randomUUID();
    const findingId = randomUUID();
    const validationRunId = randomUUID();
    const advisoryIdentity = `npm:${packageName}:${advisoryId}`;
    const packageManifest = (version: string) => JSON.stringify({ name: 'fixture', private: true, dependencies: { [packageName]: version } }, null, 2) + '\n';
    const packageLock = (version: string) => JSON.stringify({ lockfileVersion: 3, requires: true, packages: {
      '': { dependencies: { [packageName]: version } },
      [`node_modules/${packageName}`]: { name: packageName, version, resolved: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`, integrity },
    } }, null, 2) + '\n';
    const baseSnapshot = { revision: baseCommit, files: [
      { path: 'package.json', content: packageManifest(fromVersion) },
      { path: 'package-lock.json', content: packageLock(fromVersion) },
      { path: 'src/index.js', content: 'module.exports = true;\n' },
    ] };
    const sourceCodeFile = baseSnapshot.files[2];
    if (!sourceCodeFile) throw new Error('base_source_file_missing');
    const candidateSnapshot = { ...baseSnapshot, files: [
      { path: 'package.json', content: packageManifest(toVersion) },
      { path: 'package-lock.json', content: packageLock(toVersion) },
      sourceCodeFile,
    ] };
    const baseDigest = sha256(canonicalJson(baseSnapshot));
    const candidateDigest = sha256(canonicalJson(candidateSnapshot));
    const candidateLockFile = candidateSnapshot.files.find(file => file.path === 'package-lock.json');
    if (!candidateLockFile) throw new Error('candidate_lockfile_missing');
    const lockfileSha256 = sha256(candidateLockFile.content);
    const patchSha256 = sha256(canonicalJson(['package.json', 'package-lock.json'].map(path => {
      const before = baseSnapshot.files.find(file => file.path === path)?.content ?? '';
      const after = candidateSnapshot.files.find(file => file.path === path)?.content ?? '';
      return { path, before: sha256(before), after: sha256(after) };
    })));
    const snapshotBody = (snapshot: typeof baseSnapshot) => JSON.stringify(snapshot);
    await f.admin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state)
      VALUES($1,$2,'dependency-test',$3,'active')`, [organizationId, installationId, f.a.userId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,state,installation_id)
      VALUES($1,$2,$3,'gh-12345','main','granted','verified',$4)`, [organizationId, applicationId, repositoryLinkId, installationId]);
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,consent_actor)
      VALUES($1,$2,$3,$4,$5::jsonb,'dependency postgres test'),($1,$2,$6,$7,$8::jsonb,'dependency postgres test')`, [
      organizationId, applicationId, baseSourceId, baseDigest, snapshotBody(baseSnapshot), candidateSourceId, candidateDigest, snapshotBody(candidateSnapshot),
    ]);
    await f.admin.query(`INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest)
      VALUES($1,$2,$3,$4,$5,$6)`, [organizationId, applicationId, baseSourceId, repositoryLinkId, baseCommit, baseDigest]);
    const requestInput = { version: 2, organizationId, applicationId, jobId, applicationName: 'Test', mode: 'internal',
      source: { id: baseSourceId, digest: baseDigest, revision: baseCommit }, target: null };
    await f.admin.query("INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,payload) VALUES($1,$2,$3,'audit','dependency-proposal-test',$4::jsonb)", [organizationId, applicationId, jobId, JSON.stringify(requestInput)]);
    await f.admin.query('INSERT INTO gotchu.customer_requests(organization_id,application_id,job_id,source_id,target_id,input) VALUES($1,$2,$3,$4,NULL,$5::jsonb)', [organizationId, applicationId, jobId, baseSourceId, JSON.stringify(requestInput)]);
    await f.admin.query(`INSERT INTO gotchu.customer_reports(organization_id,application_id,id,job_id,body) VALUES($1,$2,$3,$4,$5::jsonb)`, [
      organizationId, applicationId, reportId, jobId, JSON.stringify({ version: 2, id: reportId, organizationId, applicationId, jobId, applicationName: 'Test', mode: 'internal', responseMode: 'observation', actionsPerformed: [],
        subject: { sourceSnapshotId: baseSourceId, sourceDigest: baseDigest, targetId: null, targetVersion: null, origin: null } }),
    ]);
    await f.admin.query(`INSERT INTO gotchu.validation_runs(organization_id,application_id,id,action_ref,target_finding_id,target_finding_ids,validation_mode,dependency_allowlist,
      candidate_source_id,base_source_id,base_snapshot_digest,candidate_tree_digest,patch_digest,runner_profile,sandbox_kind,limits,state,finished_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,'dependency',$7::jsonb,$4,$8,$9,$10,$11,'node24-npm-test','bwrap+systemd-scope',$12::jsonb,'passed',clock_timestamp())`, [
      organizationId, applicationId, validationRunId, candidateSourceId, findingId, JSON.stringify([findingId]), JSON.stringify([{ name: packageName, section: 'dependencies', version: toVersion }]),
      baseSourceId, baseDigest, candidateDigest, patchSha256, JSON.stringify({ vcpu: 1, memMiB: 1024, pids: 128, wallMs: 120_000, outputBytes: 262_144, diskMiB: 2048 }),
    ]);
    await f.admin.query(`INSERT INTO gotchu.dependency_fix_candidates(organization_id,application_id,candidate_source_id,report_id,finding_id,finding_ids,base_source_id,repository_link_id,base_commit,
      package_name,dependency_section,from_version,to_version,advisory_ids,package_json_path,package_lock_path,base_digest,candidate_digest,lockfile_sha256,patch_sha256,validation_run_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,'dependencies',$11,$12,$13::jsonb,'package.json','package-lock.json',$14,$15,$16,$17,$18,'dependency postgres test')`, [
      organizationId, applicationId, candidateSourceId, reportId, findingId, JSON.stringify([findingId]), baseSourceId, repositoryLinkId, baseCommit,
      packageName, fromVersion, toVersion, JSON.stringify([advisoryId]), baseDigest, candidateDigest, lockfileSha256, patchSha256, validationRunId,
    ]);
    const keyId = sha256(randomUUID());
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const attestations = [
      { kind: 'independent_rescan', evidence: { kind: 'independent_rescan', result: 'passed', before: { identities: [advisoryIdentity], coverage: 'complete' }, after: { identities: [], coverage: 'complete' }, targetedIdentities: [advisoryIdentity] } },
      { kind: 'functional_suite', evidence: { kind: 'functional_suite', suiteName: 'synthetic', result: 'passed', counts: { passed: 1, failed: 0, skipped: 0 }, requiredCounts: 1 } },
    ] as const;
    await f.admin.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2)', [keyId, 'synthetic test key; signature verification is outside this persistence test']);
    for (const attestation of attestations) {
      const id = randomUUID();
      const body = { id, organizationId, applicationId, runId: validationRunId, actionRef: candidateSourceId, evidence: attestation.evidence, createdAt: now, expiresAt };
      await f.admin.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [organizationId, applicationId, validationRunId, id, attestation.kind, JSON.stringify(body), keyId, 'A'.repeat(86), expiresAt]);
    }

    const proposal = await api.actions.propose({ userId: f.a.userId }, { organizationId, applicationId, kind: 'dependency_pull_request', sourceRef: { type: 'dependency_candidate', candidateId: candidateSourceId } });
    const stored = await f.admin.query<{ body: unknown; version: number; kind: string }>('SELECT body,version,kind FROM gotchu.proposals WHERE organization_id=$1 AND application_id=$2 AND id=$3', [organizationId, applicationId, proposal.proposalId]);
    expect(stored.rows[0]).toMatchObject({ version: 2, kind: 'dependency_pull_request' });
    expect(stored.rows[0]?.body).toMatchObject({ candidateCommit: expect.stringMatching(/^[a-f0-9]{40}$/), advisoryIds: [advisoryId] });
    const artifact = await executor.executionArtifacts.readForExecutor({ organizationId, applicationId, proposalId: proposal.proposalId });
    expect(artifact.files.map(file => file.path).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(artifact.patchSha256).toBe(patchSha256);
    const hiddenCandidate = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT candidate_source_id FROM gotchu.dependency_fix_candidates WHERE candidate_source_id=$1', [candidateSourceId]));
    const hiddenProposal = await f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query('SELECT id FROM gotchu.proposals WHERE id=$1', [proposal.proposalId]));
    const hiddenArtifact = await f.databases.gotchu_executor.tenant(f.b.organizationId, tx => tx.query('SELECT proposal_id FROM gotchu.execution_artifacts WHERE proposal_id=$1', [proposal.proposalId]));
    expect(hiddenCandidate.rowCount).toBe(0);
    expect(hiddenProposal.rowCount).toBe(0);
    expect(hiddenArtifact.rowCount).toBe(0);
  }, 30_000);
});
