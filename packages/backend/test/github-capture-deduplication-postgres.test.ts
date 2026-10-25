import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { canonicalJson, sha256 } from '../src/core.js';
import { createCustomerService } from '../src/customers.js';
import { createGitHubConnectionService } from '../src/github-connections.js';

const live = liveUrl ? describe : describe.skip;
const appId = '12345';
const providerId = () => String(Math.floor(Math.random() * 1_000_000_000) + 1);

// Regression sources for real PostgreSQL; no provider calls or customer execution.
live('captured-source deduplication across GitHub authority changes', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let customers: ReturnType<typeof createCustomerService>;
  let github: ReturnType<typeof createGitHubConnectionService>;
  let executor: ReturnType<typeof createGitHubConnectionService>;
  let scope: { organizationId: string; applicationId: string };
  const actor = () => ({ userId: f.a.userId });
  const snapshot = { revision: 'a'.repeat(40), files: [{ path: 'src/index.ts', content: 'export const value = 1;\n' }] };
  const upload = () => ({ ...scope, authorized: true as const, snapshot });
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    customers = createCustomerService({ database: f.databases.gotchu_api });
    github = createGitHubConnectionService({ database: f.databases.gotchu_api });
    executor = createGitHubConnectionService({ database: f.databases.gotchu_executor });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    scope = { organizationId: randomUUID(), applicationId: randomUUID() };
    await f.admin.query("INSERT INTO gotchu.organizations(id,name) VALUES($1,'Capture regression')", [scope.organizationId]);
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [scope.organizationId, f.a.userId]);
    await f.admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Capture regression')", [scope.organizationId, scope.applicationId]);
  });
  async function connect(installationId = providerId(), repositoryId = Number(providerId()), expectedApp = appId, legacy = false) {
    const binding = { organizationId: scope.organizationId, installationId, accountLogin: 'fixture',
      githubUserId: '99', githubAccountId: '100', state: 's'.repeat(43), userId: f.a.userId };
    if (legacy) await github.bind(actor(), binding);
    else await executor.bindSingleApp(actor(), { ...binding, appId: expectedApp });
    const link = await github.createRepositoryLink(actor(), { ...scope, installationId, repositoryId,
      fullName: 'fixture/repository', defaultBranch: 'main' });
    return { ...scope, repositoryLinkId: link.id, installationId, repositoryId, appId: expectedApp,
      commitSha: snapshot.revision, treeSha: 'b'.repeat(40), digest: sha256(canonicalJson(snapshot)) };
  }
  async function bindings() {
    return (await f.admin.query(`SELECT * FROM gotchu.customer_source_repository_bindings
      WHERE organization_id=$1 AND application_id=$2 ORDER BY source_id`, [scope.organizationId, scope.applicationId])).rows;
  }
  async function importCapture(capture: Awaited<ReturnType<typeof connect>>) {
    const source = await customers.uploadCapturedSource(actor(), upload(), capture);
    await github.importCapturedSource(actor(), { ...capture, sourceSnapshotId: source.id });
    return source;
  }

  it.each(['legacy', 'single_app'])('preserves %s history while capturing identical bytes after an App change', async mode => {
    const oldCapture = await connect(undefined, undefined, appId, mode === 'legacy');
    // Pre-063 records have the ordinary empty capture key.
    const oldSource = await customers.uploadSource(actor(), upload());
    if (mode === 'legacy') {
      await f.admin.query(`INSERT INTO gotchu.customer_source_repository_bindings
        (organization_id,application_id,source_id,repository_link_id,commit_sha,source_digest) VALUES($1,$2,$3,$4,$5,$6)`,
      [scope.organizationId, scope.applicationId, oldSource.id, oldCapture.repositoryLinkId, oldCapture.commitSha, oldCapture.digest]);
    } else await github.importCapturedSource(actor(), { ...oldCapture, sourceSnapshotId: oldSource.id });
    const history = await bindings();
    await github.revoke(actor(), scope.organizationId, oldCapture.installationId);
    const capture = await connect(oldCapture.installationId, oldCapture.repositoryId, '54321');
    const source = await importCapture(capture);
    expect(source.id).not.toBe(oldSource.id);
    expect(source.digest).toBe(oldSource.digest);
    expect(await bindings()).toEqual(expect.arrayContaining(history));
    expect(await bindings()).toHaveLength(2);
    await expect(importCapture(capture)).resolves.toEqual(source);
    await expect(github.importCapturedSource(actor(), { ...capture, sourceSnapshotId: oldSource.id }))
      .rejects.toMatchObject({ code: 'github_source_binding_conflict' });
    // An ordinary upload still deduplicates by digest, without new admission.
    await expect(customers.uploadSource(actor(), upload())).resolves.toEqual(oldSource);
  });

  it('captures identical bytes under a reinstalled App without changing the original binding', async () => {
    const previous = await connect();
    const original = await importCapture(previous);
    const history = await bindings();
    await github.revoke(actor(), scope.organizationId, previous.installationId);
    const capture = await connect(providerId(), previous.repositoryId);
    const source = await importCapture(capture);
    expect(source.id).not.toBe(original.id);
    expect(await bindings()).toEqual(expect.arrayContaining(history));
    await expect(importCapture(capture)).resolves.toEqual(source);
  });

  it('reuses matching pre-063 bindings and atomically binds concurrent captures by full provenance', async () => {
    const capture = await connect();
    const original = await customers.uploadSource(actor(), upload());
    await github.importCapturedSource(actor(), { ...capture, sourceSnapshotId: original.id });
    await expect(importCapture(capture)).resolves.toEqual(original);
    const changed = { ...capture, treeSha: 'c'.repeat(40) };
    const different = { ...capture, treeSha: 'd'.repeat(40) };
    const [first, retry, other] = await Promise.all([
      customers.uploadCapturedSource(actor(), upload(), changed),
      customers.uploadCapturedSource(actor(), upload(), changed),
      customers.uploadCapturedSource(actor(), upload(), different),
    ]);
    expect(await bindings()).toHaveLength(3);
    expect(first.id).toBe(retry.id);
    expect(first.id).not.toBe(original.id);
    expect(other.id).not.toBe(first.id);
    await github.importCapturedSource(actor(), { ...changed, sourceSnapshotId: first.id });
    await github.importCapturedSource(actor(), { ...different, sourceSnapshotId: other.id });
    await expect(importCapture(changed)).resolves.toEqual(first);
    expect(await bindings()).toHaveLength(3);
  });

  it('checks tenant, active authority, digest and upload schema before reusing or admitting a capture', async () => {
    const capture = await connect();
    const source = await importCapture(capture);
    await expect(customers.uploadCapturedSource({ userId: f.b.userId }, upload(), capture)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(customers.uploadCapturedSource(actor(), upload(), { ...capture, applicationId: f.b.applicationId }))
      .rejects.toMatchObject({ code: 'github_source_digest_mismatch' });
    await expect(customers.uploadCapturedSource(actor(), upload(), { ...capture, digest: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'github_source_digest_mismatch' });
    await expect(customers.uploadCapturedSource(actor(), upload(), { ...capture, installationId: providerId() }))
      .rejects.toMatchObject({ code: 'github_source_scope_mismatch' });
    const injected = { ...upload(), capture, capture_key: 'f'.repeat(64) };
    await expect(customers.uploadSource(actor(), injected)).rejects.toMatchObject({ code: 'invalid_input' });
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]);
    await expect(customers.uploadCapturedSource(actor(), upload(), capture)).rejects.toMatchObject({ code: 'application_archived' });
    await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [scope.organizationId, scope.applicationId]);
    await github.revoke(actor(), scope.organizationId, capture.installationId);
    await expect(customers.uploadCapturedSource(actor(), upload(), capture)).rejects.toMatchObject({ code: 'github_repository_not_authorized' });
    expect((await customers.listSources(actor(), scope)).map(item => item.id)).toEqual([source.id]);
  });

  it('retains deleted capture history and allocates a fresh capture on retry', async () => {
    const capture = await connect();
    const source = await importCapture(capture);
    const history = await bindings();
    await customers.deleteSource(actor(), { ...scope, sourceSnapshotId: source.id });
    const replacement = await importCapture(capture);
    expect(replacement.id).not.toBe(source.id);
    expect(await bindings()).toEqual(expect.arrayContaining(history));
    expect((await f.admin.query('SELECT body,deleted_at FROM gotchu.customer_sources WHERE id=$1', [source.id])).rows)
      .toEqual([{ body: null, deleted_at: expect.any(Date) }]);
    await expect(customers.uploadSource(actor(), upload())).resolves.toEqual(replacement);
  });

  it('counts distinct capture identities against active source capacity, while exact retries remain reusable', async () => {
    const capture = await connect();
    const original = await importCapture(capture);
    for (let index = 0; index < 9; index++) {
      await customers.uploadSource(actor(), { ...upload(), snapshot: { ...snapshot, revision: `other-${index}` } });
    }
    await expect(importCapture({ ...capture, treeSha: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'source_limit' });
    await expect(importCapture(capture)).resolves.toEqual(original);
    await expect(customers.uploadSource(actor(), upload())).resolves.toEqual(original);
  });

  it('counts deleted sources toward daily admission for captures, without charging exact retries', async () => {
    const capture = await connect();
    const original = await importCapture(capture);
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,deleted_at,consent_actor)
      SELECT $1,$2,gen_random_uuid(),$3,NULL,clock_timestamp(),$4 FROM generate_series(1,99)`,
    [scope.organizationId, scope.applicationId, capture.digest, f.a.userId]);
    await expect(importCapture({ ...capture, treeSha: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'source_daily_limit' });
    await expect(importCapture(capture)).resolves.toEqual(original);
    await expect(customers.uploadSource(actor(), upload())).resolves.toEqual(original);
  });
});
