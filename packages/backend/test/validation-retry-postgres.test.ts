import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, createBackend, enqueueValidation, sha256 } from '../src/index.js';
import { fixture, liveUrl, present } from '../../database/test/support.js';

const live = liveUrl ? describe : describe.skip;
// Synthetic candidate/evidence fixtures, real PostgreSQL transactions and roles. No customer execution.
live('dependency validation retry history on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture({ max: 6 }); api = createBackend({ database: f.databases.gotchu_api }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function candidate() {
    const identity = { userId: `validation-retry:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Validation retry' });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Retry fixture' });
    const scope = { organizationId: workspace.id, applicationId: application.applicationId };
    const repositoryLinkId = randomUUID(); const installationId = randomUUID().replaceAll(/\D/g, '').slice(0, 20);
    const revision = 'a'.repeat(40); const findingId = randomUUID(); const reportId = randomUUID(); const jobId = randomUUID();
    const snapshot = (version: string) => ({ revision, files: [
      { path: 'package.json', content: JSON.stringify({ dependencies: { example: version } }) },
      { path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version } } }) },
      { path: 'index.js', content: 'export const value = 1;' },
    ] });
    const baseSnapshot = snapshot('1.0.0'); const candidateSnapshot = snapshot('1.0.1');
    const base = await api.customers.uploadSource(identity, { ...scope, snapshot: baseSnapshot, authorized: true });
    const source = await api.customers.uploadSource(identity, { ...scope, snapshot: candidateSnapshot, authorized: true });
    const patchDigest = sha256(canonicalJson(['package.json', 'package-lock.json'].map(path => ({ path,
      before: sha256(present(baseSnapshot.files.find(file => file.path === path)).content),
      after: sha256(present(candidateSnapshot.files.find(file => file.path === path)).content),
    }))));
    await f.admin.query(`INSERT INTO gotchu.github_installations(organization_id,installation_id,account_login,connected_by,state)
      VALUES($1,$2,'retry-fixture',$3,'active')`, [scope.organizationId, installationId, identity.userId]);
    await f.admin.query(`INSERT INTO gotchu.application_repository_links(organization_id,application_id,id,repository_key,default_branch,read_access,state,installation_id)
      VALUES($1,$2,$3,'gh-12345','main','granted','verified',$4)`, [scope.organizationId, scope.applicationId, repositoryLinkId, installationId]);
    await f.admin.query(`INSERT INTO gotchu.customer_source_repository_bindings(organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest)
      VALUES($1,$2,$3,$4,$5,$6)`, [scope.organizationId, scope.applicationId, base.id, repositoryLinkId, revision, base.digest]);
    const requestInput = { version: 2, ...scope, jobId, applicationName: 'Retry fixture', mode: 'internal',
      source: { id: base.id, digest: base.digest, revision }, target: null };
    await f.admin.query(`INSERT INTO gotchu.jobs(organization_id,application_id,id,kind,idempotency_key,payload)
      VALUES($1,$2,$3,'audit','retry-fixture',$4::jsonb)`, [scope.organizationId, scope.applicationId, jobId, JSON.stringify(requestInput)]);
    await f.admin.query(`INSERT INTO gotchu.customer_requests(organization_id,application_id,job_id,source_id,target_id,input)
      VALUES($1,$2,$3,$4,NULL,$5::jsonb)`, [scope.organizationId, scope.applicationId, jobId, base.id, JSON.stringify(requestInput)]);
    await f.admin.query(`INSERT INTO gotchu.customer_reports(organization_id,application_id,id,job_id,body)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [scope.organizationId, scope.applicationId, reportId, jobId, JSON.stringify({
      version: 2, ...scope, id: reportId, jobId, mode: 'internal', applicationName: 'Retry fixture', responseMode: 'observation', actionsPerformed: [],
      subject: { sourceSnapshotId: base.id, sourceDigest: base.digest, targetId: null, targetVersion: null, origin: null,
        containerImageId: null, containerImageDigest: null, containerImageReference: null },
    })]);
    const suiteInput = { ...scope, repositoryLinkId, scriptName: 'test', suiteName: 'retry fixture', requiredCount: 1 };
    await api.validations.configureSuite(identity, suiteInput);
    const enqueueInput = { ...scope, candidateSourceId: source.id, baseSourceId: base.id, targetFindingId: findingId, targetFindingIds: [findingId],
      baseDigest: base.digest, candidateDigest: source.digest, patchDigest, repositoryLinkId, mode: 'dependency' as const,
      dependencyAllowlist: [{ name: 'example', section: 'dependencies' as const, version: '1.0.1' }] };
    const runId = await f.databases.gotchu_api.tenant(scope.organizationId, tx => enqueueValidation(tx, enqueueInput));
    await finish(runId, 'failed');
    await f.admin.query(`INSERT INTO gotchu.dependency_fix_candidates(organization_id,application_id,candidate_source_id,report_id,finding_id,finding_ids,base_source_id,repository_link_id,base_commit,
      package_name,dependency_section,from_version,to_version,advisory_ids,package_json_path,package_lock_path,base_digest,candidate_digest,lockfile_sha256,patch_sha256,validation_run_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'example','dependencies','1.0.0','1.0.1','["GHSA-test-1234-5678"]',
        'package.json','package-lock.json',$10,$11,$12,$13,$14,$15)`, [scope.organizationId, scope.applicationId, source.id, reportId, findingId, JSON.stringify([findingId]),
      base.id, repositoryLinkId, revision, base.digest, source.digest, sha256(present(candidateSnapshot.files[1]).content), patchDigest, runId, identity.userId]);
    return { identity, scope, request: { ...scope, candidateSourceId: source.id }, base, source, candidateSnapshot, runId, suiteInput, enqueueInput, repositoryLinkId };
  }
  async function finish(id: string, state: 'failed' | 'inconclusive' | 'passed' | 'expired') {
    await f.admin.query(`UPDATE gotchu.validation_runs SET state=$2,reason='synthetic_fixture',finished_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1`, [id, state]);
  }
  async function runs(c: Awaited<ReturnType<typeof candidate>>) {
    return (await f.admin.query('SELECT * FROM gotchu.validation_runs WHERE organization_id=$1 AND application_id=$2 AND candidate_source_id=$3 ORDER BY queued_at,id',
      [c.scope.organizationId, c.scope.applicationId, c.source.id])).rows;
  }

  it('serializes duplicate requests, selects the latest suite, and preserves signed history without reusing its facts', async () => {
    const c = await candidate();
    const pair = generateKeyPairSync('ed25519');
    const keyId = sha256(pair.publicKey.export({ type: 'spki', format: 'der' }));
    const payload = { id: randomUUID(), ...c.scope, runId: c.runId, actionRef: c.source.id,
      evidence: { kind: 'candidate_regression', result: 'unavailable', exitCode: null, durationMs: 0 },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), pair.privateKey).toString('base64url');
    await f.admin.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2)', [keyId, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()]);
    await f.admin.query(`INSERT INTO gotchu.validation_attestations(organization_id,application_id,run_id,id,kind,body,key_id,signature,expires_at)
      VALUES($1,$2,$3,$4,'candidate_regression',$5::jsonb,$6,$7,$8)`, [c.scope.organizationId, c.scope.applicationId, c.runId, payload.id, JSON.stringify(payload), keyId, signature, payload.expiresAt]);
    const oldRun = present((await runs(c))[0]);
    const suite = await api.validations.configureSuite(c.identity, { ...c.suiteInput, profile: 'node24-tsx-selected-v1', testSelection: { files: ['test/unit.test.ts'] } });
    const retries = await Promise.all(Array.from({ length: 3 }, () => api.corrections.retryDependencyValidation(c.identity, c.request)));
    const retry = present(retries[0]);
    expect(retries).toEqual([retry, retry, retry]); expect(retry.validationRunId).not.toBe(c.runId);
    const history = await runs(c);
    expect(history).toHaveLength(2); expect(history.find(row => row.id === c.runId)).toEqual(oldRun);
    expect(history.find(row => row.id === retry.validationRunId)).toMatchObject({ state: 'queued', suite_definition_id: suite.id, suite_version: suite.version,
      runner_profile: 'node24-tsx-selected-v1', patch_digest: c.enqueueInput.patchDigest, dependency_allowlist: c.enqueueInput.dependencyAllowlist });
    expect((await api.corrections.validationStatus(c.identity, c.request))?.run.id).toBe(retry.validationRunId);
    expect(await api.validations.getValidationFacts({ organizationId: c.scope.organizationId, actionRef: c.source.id }))
      .toMatchObject({ runId: retry.validationRunId, state: 'queued', attestations: [], keys: [] });
    expect((await f.admin.query('SELECT body,signature FROM gotchu.validation_attestations WHERE run_id=$1', [c.runId])).rows).toEqual([{ body: payload, signature }]);
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => enqueueValidation(tx, c.enqueueInput))).rejects.toThrow();
    await f.admin.query("UPDATE gotchu.validation_runs SET state='running',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1", [retry.validationRunId, randomUUID()]);
    expect(await api.corrections.retryDependencyValidation(c.identity, c.request)).toEqual(retry);
    await finish(retry.validationRunId, 'inconclusive');
    // A newer unreferenced terminal row must never override the candidate's pointer.
    const unrelated = await f.databases.gotchu_api.tenant(c.scope.organizationId, tx => enqueueValidation(tx, c.enqueueInput));
    await finish(unrelated, 'passed');
    expect((await api.corrections.validationStatus(c.identity, c.request))?.run).toMatchObject({ id: retry.validationRunId, state: 'inconclusive' });
    expect(await api.validations.getValidationFacts({ organizationId: c.scope.organizationId, actionRef: c.source.id }))
      .toMatchObject({ runId: retry.validationRunId, state: 'inconclusive', attestations: [] });
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'UPDATE gotchu.dependency_fix_candidates SET validation_run_id=$2 WHERE candidate_source_id=$1', [c.source.id, unrelated]))).rejects.toThrow('dependency_fix_candidate_immutable');
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query(
      'DELETE FROM gotchu.validation_attestations WHERE run_id=$1', [c.runId]))).rejects.toThrow();
  });

  it('enforces role, tenant and application scope without adding attempts', async () => {
    const c = await candidate(); const viewer = { userId: `viewer:${randomUUID()}` }; const operator = { userId: `operator:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer'),($1,$3,'operator')", [c.scope.organizationId, viewer.userId, operator.userId]);
    await expect(api.corrections.retryDependencyValidation(viewer, c.request)).rejects.toMatchObject({ status: 403 });
    await expect(api.corrections.retryDependencyValidation({ userId: f.b.userId }, c.request)).rejects.toMatchObject({ status: 403 });
    await expect(api.corrections.retryDependencyValidation({ userId: f.b.userId }, { ...c.request, organizationId: f.b.organizationId, applicationId: f.b.applicationId })).rejects.toMatchObject({ status: 404 });
    const other = await api.customers.createApplication(c.identity, { organizationId: c.scope.organizationId, name: 'Other application' });
    await expect(api.corrections.retryDependencyValidation(c.identity, { ...c.request, applicationId: other.applicationId })).rejects.toMatchObject({ status: 404 });
    expect(await runs(c)).toHaveLength(1);
    expect(await api.corrections.retryDependencyValidation(operator, c.request)).toMatchObject({ candidateSourceId: c.source.id });
  });

  it.each(['passed', 'expired', 'quarantined'] as const)('rejects the %s state and grants no run-status or candidate-content update authority', async state => {
    const c = await candidate();
    if (state === 'quarantined') await f.admin.query("UPDATE gotchu.validation_runs SET state='quarantined',finished_at=NULL,lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1", [c.runId, randomUUID()]);
    else await finish(c.runId, state);
    await expect(api.corrections.retryDependencyValidation(c.identity, c.request)).rejects.toMatchObject({ code: 'validation_retry_unavailable' });
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query("UPDATE gotchu.validation_runs SET state='failed' WHERE id=$1", [c.runId]))).rejects.toThrow();
    await expect(f.databases.gotchu_api.tenant(c.scope.organizationId, tx => tx.query("UPDATE gotchu.dependency_fix_candidates SET to_version='1.0.2' WHERE candidate_source_id=$1", [c.source.id]))).rejects.toThrow();
    expect(await runs(c)).toHaveLength(1);
  });

  it('counts the original attempt toward five attempts per rolling day', async () => {
    const c = await candidate();
    for (let i = 1; i < 5; i++) {
      const retry = await api.corrections.retryDependencyValidation(c.identity, c.request);
      await finish(retry.validationRunId, 'inconclusive');
    }
    await expect(api.corrections.retryDependencyValidation(c.identity, c.request)).rejects.toMatchObject({ code: 'validation_retry_limit', status: 429 });
    expect(await runs(c)).toHaveLength(5);
    await f.admin.query("UPDATE gotchu.validation_runs SET queued_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [c.runId]);
    expect((await api.corrections.retryDependencyValidation(c.identity, c.request)).validationRunId).not.toBe(c.runId);
  });

  it.each(['deleted', 'changed', 'revoked', 'disconnected'] as const)('refuses an unavailable or changed candidate context: %s', async change => {
    const c = await candidate();
    if (change === 'deleted') await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: c.source.id });
    if (change === 'changed') await f.admin.query("UPDATE gotchu.customer_sources SET body=jsonb_set(body,'{files,2,content}','\"changed\"'::jsonb) WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.source.id]);
    if (change === 'revoked') await f.admin.query('UPDATE gotchu.application_repository_links SET revoked=true WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.repositoryLinkId]);
    if (change === 'disconnected') await f.admin.query("UPDATE gotchu.github_installations SET state='revoked' WHERE organization_id=$1", [c.scope.organizationId]);
    await expect(api.corrections.retryDependencyValidation(c.identity, c.request)).rejects.toMatchObject({ status: 409 });
    expect(await runs(c)).toHaveLength(1);
  });
});
