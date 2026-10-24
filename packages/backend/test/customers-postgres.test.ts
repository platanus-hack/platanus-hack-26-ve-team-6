import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssessmentAnalysis, CustomerAssessmentReport, CustomerRunInput } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { canonicalJson, createBackend, DEMO_ASSESSMENT_SCOPE, sha256 } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
/** Synthetic report and DNS answers test persistence/authorization, not live HTTPS or DNS. */
function reportFor(input: CustomerRunInput): CustomerAssessmentReport {
  const timestamp = new Date().toISOString();
  const analysis = (origin: 'internal' | 'external'): AssessmentAnalysis => ({ origin, status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: input.source?.digest ?? input.target?.origin ?? 'test', tool: { name: 'synthetic-test', version: '1' }, findings: [], evidence: [], coverage: [], limitations: ['Synthetic boundary test, not live scanning'] });
  return { version: 2, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId, applicationName: input.applicationName,
    mode: input.mode, startedAt: timestamp, finishedAt: timestamp, internal: input.mode === 'external' ? null : analysis('internal'), external: input.mode === 'internal' ? null : analysis('external'),
    comparison: [], limitations: ['Synthetic boundary test'], responseMode: 'observation', actionsPerformed: [], subject: { sourceSnapshotId: input.source?.id ?? null, sourceDigest: input.source?.digest ?? null, targetId: input.target?.id ?? null, targetVersion: input.target?.version ?? null, origin: input.target?.origin ?? null } };
}
live('customer workflow on real Postgres roles/RLS with synthetic DNS and reports', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  const dns = new Map<string, string[][]>();
  beforeAll(async () => {
    f = await fixture({ max: 10 });
    api = createBackend({ database: f.databases.gotchu_api, customerDnsVerifier: { resolveTxt: async name => dns.get(name) ?? [] } });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function customer() {
    const identity = { userId: `credentials:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'My workspace' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Actual customer application' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    const snapshot = { revision: `commit-${randomUUID()}`, files: [{ path: 'src/app.ts', content: 'export const app = true;' }] };
    const source = await api.customers.uploadSource(identity, { ...scope, snapshot, authorized: true });
    return { identity, workspace, app, scope, source, snapshot };
  }
  async function verified(c: Awaited<ReturnType<typeof customer>>) {
    const enrollment = await api.customers.enrollTarget(c.identity, { ...c.scope, origin: `https://app-${randomUUID()}.acme.com`, authorized: true });
    dns.set(enrollment.challenge.name, [[enrollment.challenge.value.slice(0, 25), enrollment.challenge.value.slice(25)]]);
    return api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id });
  }
  async function claim(c: Awaited<ReturnType<typeof customer>>, mode: 'internal' | 'external' | 'both' = 'internal') {
    const target = mode === 'internal' ? null : await verified(c);
    const queued = await api.customers.queue(c.identity, { ...c.scope, mode, sourceSnapshotId: mode === 'external' ? null : c.source.id, targetId: target?.id ?? null, idempotencyKey: randomUUID() });
    const job = present(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId: queued.jobId }));
    const input = await coordinator.customers.getRequest({ ...c.scope, jobId: queued.jobId, leaseToken: job.leaseToken });
    return { input, leaseToken: job.leaseToken, report: reportFor(input) };
  }

  it('bootstraps owner membership atomically, discovers signed identities, and caps concurrent workspace creation', async () => {
    const identity = { userId: `oidc:${randomUUID()}` };
    expect(await api.customers.listWorkspaces(identity)).toEqual([]);
    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => api.customers.createWorkspace(identity, { name: `Workspace ${i}` })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429)).toBe(true);
    const workspaces = await api.customers.listWorkspaces(identity);
    expect(workspaces).toHaveLength(5); expect(workspaces.every(workspace => workspace.role === 'owner')).toBe(true);
    await expect(api.customers.createWorkspace(identity, { name: present(workspaces[0]).name.toUpperCase() })).rejects.toMatchObject({ code: 'workspace_name_conflict' });
    expect(await api.customers.listWorkspaces({ userId: `credentials:${randomUUID()}` })).toEqual([]);
    await expect(api.customers.listWorkspaces({ userId: DEMO_ASSESSMENT_SCOPE.userId })).rejects.toMatchObject({ status: 403 });
    await expect(api.customers.createWorkspace({ userId: DEMO_ASSESSMENT_SCOPE.userId }, { name: 'No demo' })).rejects.toMatchObject({ status: 403 });
  });

  it('enforces tenant roles, application uniqueness, archive and restore', async () => {
    const c = await customer();
    const viewer = { userId: `oidc:${randomUUID()}` }; const operator = { userId: `credentials:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'viewer'),($1,$3,'operator')", [c.workspace.id, viewer.userId, operator.userId]);
    expect(await api.customers.listApplications(viewer, { organizationId: c.workspace.id })).toHaveLength(1);
    await expect(api.customers.createApplication(viewer, { organizationId: c.workspace.id, name: 'Forbidden' })).rejects.toMatchObject({ status: 403 });
    await expect(api.customers.uploadSource(viewer, { ...c.scope, snapshot: c.snapshot, authorized: true })).rejects.toMatchObject({ status: 403 });
    await expect(api.customers.listSources({ userId: f.b.userId }, c.scope)).rejects.toMatchObject({ status: 403 });
    await expect(api.customers.createApplication(operator, { organizationId: c.workspace.id, name: c.app.name.toUpperCase() })).rejects.toMatchObject({ code: 'application_name_conflict' });
    expect((await api.customers.updateApplication(operator, { ...c.scope, archived: true })).archived).toBe(true);
    await expect(api.customers.uploadSource(c.identity, { ...c.scope, snapshot: c.snapshot, authorized: true })).rejects.toMatchObject({ code: 'application_archived' });
    expect((await api.customers.updateApplication(operator, { ...c.scope, archived: false, name: 'Renamed' })).name).toBe('Renamed');
    expect(await api.customers.listSources(viewer, c.scope)).toHaveLength(1);
  });

  it('stores only challenge hashes and binds exact DNS proof, consent, expiry and renewal version', async () => {
    const c = await customer();
    const enrollment = await api.customers.enrollTarget(c.identity, { ...c.scope, origin: 'https://WWW.acme.com:443/', authorized: true });
    expect(enrollment.challenge.name).toBe('_gotchu.www.acme.com');
    expect(enrollment.target).toMatchObject({ origin: 'https://www.acme.com', consentActor: c.identity.userId, status: 'pending', version: 1 });
    const stored = await f.admin.query('SELECT challenge_hash FROM gotchu.customer_targets WHERE organization_id=$1', [c.workspace.id]);
    expect(stored.rows[0]?.challenge_hash).toBe(sha256(enrollment.challenge.value.slice('gotchu-verification='.length)));
    expect(JSON.stringify(await api.customers.listTargets(c.identity, c.scope))).not.toContain(enrollment.challenge.value);
    await expect(api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id })).rejects.toMatchObject({ code: 'dns_verification_failed' });
    dns.set(enrollment.challenge.name, [[`${enrollment.challenge.value}-suffix`]]);
    await expect(api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id })).rejects.toMatchObject({ code: 'dns_verification_failed' });
    dns.set(enrollment.challenge.name, [[enrollment.challenge.value]]);
    expect((await api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id })).status).toBe('verified');
    const renewed = await api.customers.enrollTarget(c.identity, { ...c.scope, origin: enrollment.target.origin, authorized: true });
    expect(renewed.target.version).toBe(2); expect(renewed.target.status).toBe('pending');
    expect(renewed.challenge.value).not.toBe(enrollment.challenge.value);
    await expect(api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id })).rejects.toMatchObject({ code: 'dns_verification_failed' });
    await f.admin.query("UPDATE gotchu.customer_targets SET challenge_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [c.workspace.id]);
    await expect(api.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrollment.target.id })).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('rechecks authorization/version after DNS returns and fails closed without an adapter', async () => {
    const c = await customer();
    const enrolled = await api.customers.enrollTarget(c.identity, { ...c.scope, origin: 'https://race.acme.com', authorized: true });
    const unconfigured = createBackend({ database: f.databases.gotchu_api });
    await expect(unconfigured.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrolled.target.id })).rejects.toMatchObject({ status: 503 });
    const racing = createBackend({ database: f.databases.gotchu_api, customerDnsVerifier: { resolveTxt: async () => {
      await api.customers.revokeTarget(c.identity, { ...c.scope, targetId: enrolled.target.id });
      return [[enrolled.challenge.value]];
    } } });
    await expect(racing.customers.verifyTarget(c.identity, { ...c.scope, targetId: enrolled.target.id })).rejects.toMatchObject({ code: 'challenge_changed' });
    expect((await api.customers.listTargets(c.identity, c.scope))[0]?.status).toBe('revoked');
  });

  it('keeps source immutable and tenant/app bound, hashes canonical data, and limits concurrent uploads', async () => {
    const c = await customer();
    expect(c.source.digest).toBe(sha256(canonicalJson(c.snapshot)));
    expect(await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: c.snapshot, authorized: true })).toEqual(c.source);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => api.customers.uploadSource(c.identity, { ...c.scope, snapshot: { ...c.snapshot, revision: `rev-${i}` }, authorized: true })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(9);
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429)).toBe(true);
    expect(await api.customers.listSources(c.identity, c.scope)).toHaveLength(10);
    expect((await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: c.snapshot, authorized: true })).id).toBe(c.source.id);
    const other = await api.customers.createApplication(c.identity, { organizationId: c.workspace.id, name: 'Other app' });
    await expect(api.customers.queue(c.identity, { organizationId: c.workspace.id, applicationId: other.applicationId, mode: 'internal', sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(f.databases.gotchu_api.tenant(c.workspace.id, tx => tx.query("UPDATE gotchu.customer_sources SET body='{}' WHERE id=$1", [c.source.id]))).rejects.toMatchObject({ code: '42501' });
  });

  it('persists queue, immutable input and outbox exactly once before quota checks, enforcing concurrent outstanding caps', async () => {
    const c = await customer();
    const input = { ...c.scope, mode: 'internal' as const, sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() };
    const same = await Promise.all(Array.from({ length: 5 }, () => api.customers.queue(c.identity, input)));
    expect(new Set(same.map(item => item.jobId)).size).toBe(1);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => api.customers.queue(c.identity, { ...input, idempotencyKey: randomUUID() })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429)).toBe(true);
    expect(await api.customers.queue(c.identity, input)).toEqual(same[0]);
    const count = await f.admin.query(`SELECT (SELECT count(*)::int FROM gotchu.customer_requests WHERE organization_id=$1) AS requests,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1) AS jobs,(SELECT count(*)::int FROM gotchu.outbox WHERE organization_id=$1) AS outbox`, [c.workspace.id]);
    expect(count.rows[0]).toEqual({ requests: 3, jobs: 3, outbox: 3 });
    await expect(api.customers.queue(c.identity, { ...input, sourceSnapshotId: randomUUID() })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rolls back the customer job and outbox if durable intent persistence fails', async () => {
    const c = await customer();
    await f.admin.query(`CREATE FUNCTION gotchu.test_customer_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id='${c.workspace.id}'::uuid THEN RAISE EXCEPTION 'synthetic intent failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_customer_intent_failure BEFORE INSERT ON gotchu.customer_requests FOR EACH ROW EXECUTE FUNCTION gotchu.test_customer_intent_failure()`);
    try {
      await expect(api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() })).rejects.toThrow('synthetic intent failure');
      const counts = await f.admin.query(`SELECT (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1) AS jobs,
        (SELECT count(*)::int FROM gotchu.outbox WHERE organization_id=$1) AS outbox,
        (SELECT count(*)::int FROM gotchu.customer_requests WHERE organization_id=$1) AS requests`, [c.workspace.id]);
      expect(counts.rows[0]).toEqual({ jobs: 0, outbox: 0, requests: 0 });
    } finally { await f.admin.query('DROP TRIGGER test_customer_intent_failure ON gotchu.customer_requests; DROP FUNCTION gotchu.test_customer_intent_failure()'); }
  });

  it('stores compact intents, blocks in-use deletion, and erases canonical raw source while retaining report provenance', async () => {
    const c = await customer();
    const queueInput = { ...c.scope, mode: 'internal' as const, sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() };
    const queued = await api.customers.queue(c.identity, queueInput);
    const stored = await f.admin.query<{ input: { source: unknown }; payload: unknown }>('SELECT r.input,j.payload FROM gotchu.customer_requests r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.id=r.job_id WHERE r.job_id=$1', [queued.jobId]);
    expect(stored.rows[0]?.input.source).toEqual({ id: c.source.id, digest: c.source.digest, revision: c.snapshot.revision });
    expect(JSON.stringify(stored.rows)).not.toContain('export const app');
    expect(JSON.stringify(stored.rows)).not.toContain('src/app.ts');
    await expect(api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: c.source.id })).rejects.toMatchObject({ status: 409, code: 'source_in_use' });
    const job = present(await coordinator.jobs.claim({ organizationId: c.workspace.id, jobId: queued.jobId }));
    await expect(api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: c.source.id })).rejects.toMatchObject({ code: 'source_in_use' });
    const input = await coordinator.customers.getRequest({ ...c.scope, jobId: queued.jobId, leaseToken: job.leaseToken });
    expect(input.source?.files).toEqual(c.snapshot.files);
    const report = reportFor(input);
    await coordinator.customers.recordResult({ input, leaseToken: job.leaseToken, report });
    await api.customers.updateApplication(c.identity, { ...c.scope, archived: true });
    await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: c.source.id });
    await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: c.source.id });
    const tombstone = await f.admin.query('SELECT body,digest,deleted_at IS NOT NULL AS deleted FROM gotchu.customer_sources WHERE id=$1', [c.source.id]);
    expect(tombstone.rows[0]).toEqual({ body: null, digest: c.source.digest, deleted: true });
    expect(await api.customers.listSources(c.identity, c.scope)).toEqual([]);
    expect((await api.customers.getReport(c.identity, { ...c.scope, reportId: report.id })).subject.sourceDigest).toBe(c.source.digest);
    await api.customers.updateApplication(c.identity, { ...c.scope, archived: false });
    await expect(api.customers.queue(c.identity, { ...queueInput, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await api.customers.queue(c.identity, queueInput)).toEqual(queued);
    const replacement = await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: c.snapshot, authorized: true });
    expect(replacement.id).not.toBe(c.source.id); expect(replacement.digest).toBe(c.source.digest);
    await expect(api.customers.deleteSource({ userId: f.b.userId }, { ...c.scope, sourceSnapshotId: replacement.id })).rejects.toMatchObject({ status: 403 });
  });

  it('accepts a normal large lockfile and rejects snapshot digest drift before worker execution', async () => {
    const c = await customer();
    const lockfile = { revision: 'real-lockfile', files: [{ path: 'package-lock.json', content: JSON.stringify({ packages: Array.from({ length: 5000 }, (_, i) => ({ name: `package-${i}`, version: '1.0.0', integrity: 'test' })) }) }] };
    expect(Buffer.byteLength(lockfile.files[0]?.content ?? '')).toBeGreaterThan(65_536);
    const source = await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: lockfile, authorized: true });
    const { jobId } = await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID() });
    const job = present(await coordinator.jobs.claim({ organizationId: c.workspace.id, jobId }));
    expect((await coordinator.customers.getRequest({ ...c.scope, jobId, leaseToken: job.leaseToken })).source?.files).toEqual(lockfile.files);
    await f.admin.query("UPDATE gotchu.customer_sources SET body=jsonb_set(body,'{revision}','\"changed\"') WHERE id=$1", [source.id]);
    await expect(coordinator.customers.getRequest({ ...c.scope, jobId, leaseToken: job.leaseToken })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
  });

  it('discovers pending customer workspaces only for the coordinator in oldest-job order', async () => {
    const old = await customer(); const newer = await customer();
    for (const c of [old, newer]) {
      await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() });
    }
    await f.admin.query("UPDATE gotchu.jobs SET created_at='1990-01-01T00:00:00Z' WHERE organization_id=$1", [old.workspace.id]);
    await f.admin.query("UPDATE gotchu.jobs SET created_at='1990-01-02T00:00:00Z' WHERE organization_id=$1", [newer.workspace.id]);
    expect(await coordinator.customers.pendingOrganizations({ limit: 1 })).toEqual([old.workspace.id]);
    expect((await coordinator.customers.pendingOrganizations({ limit: 2 }))).toEqual([old.workspace.id, newer.workspace.id]);
    await f.admin.query("UPDATE gotchu.jobs SET state='succeeded' WHERE organization_id=$1", [old.workspace.id]);
    expect(await coordinator.customers.pendingOrganizations({ limit: 1 })).toEqual([newer.workspace.id]);
    await expect(api.customers.pendingOrganizations()).rejects.toMatchObject({ status: 403 });
    await expect(coordinator.customers.pendingOrganizations({ limit: 501 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(f.databases.gotchu_api.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query('SELECT * FROM gotchu.customer_pending_organizations(100)'))).rejects.toMatchObject({ code: '42501' });
    await f.databases.gotchu_coordinator.tenant('00000000-0000-0000-0000-000000000000', async tx => {
      await tx.query("SELECT set_config('gotchu.pending_discovery','enabled',true)");
      expect((await tx.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1', [newer.workspace.id])).rows).toEqual([]);
    });
  });

  it('counts deleted uploads toward daily admission so deletion cannot bypass ingestion bounds', async () => {
    const c = await customer();
    await f.admin.query(`INSERT INTO gotchu.customer_sources(organization_id,application_id,id,digest,body,deleted_at,consent_actor)
      SELECT $1,$2,gen_random_uuid(),repeat('a',64),NULL,clock_timestamp(),$3 FROM generate_series(1,99)`, [c.workspace.id, c.app.applicationId, c.identity.userId]);
    await expect(api.customers.uploadSource(c.identity, { ...c.scope, snapshot: { ...c.snapshot, revision: 'next' }, authorized: true })).rejects.toMatchObject({ status: 429, code: 'source_daily_limit' });
    expect((await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: c.snapshot, authorized: true })).id).toBe(c.source.id);
    await f.admin.query("UPDATE gotchu.customer_sources SET created_at=clock_timestamp()-interval '2 days' WHERE organization_id=$1 AND deleted_at IS NOT NULL", [c.workspace.id]);
    await expect(api.customers.uploadSource(c.identity, { ...c.scope, snapshot: { ...c.snapshot, revision: 'next' }, authorized: true })).resolves.toHaveProperty('id');
  });

  it('uses a rolling daily organization cap across applications and preserves exact retries', async () => {
    const c = await customer();
    const input = { ...c.scope, mode: 'internal' as const, sourceSnapshotId: c.source.id, targetId: null, idempotencyKey: randomUUID() };
    const first = await api.customers.queue(c.identity, input);
    for (let i = 1; i < 20; i++) {
      await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1", [c.workspace.id]);
      await api.customers.queue(c.identity, { ...input, idempotencyKey: randomUUID() });
    }
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1", [c.workspace.id]);
    const other = await api.customers.createApplication(c.identity, { organizationId: c.workspace.id, name: 'Second' });
    const scope = { organizationId: c.workspace.id, applicationId: other.applicationId };
    const source = await api.customers.uploadSource(c.identity, { ...scope, snapshot: c.snapshot, authorized: true });
    await expect(api.customers.queue(c.identity, { ...input, ...scope, sourceSnapshotId: source.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 429 });
    expect(await api.customers.queue(c.identity, input)).toEqual(first);
    await f.admin.query("UPDATE gotchu.customer_requests SET created_at=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [c.workspace.id]);
    await expect(api.customers.queue(c.identity, { ...input, idempotencyKey: randomUUID() })).resolves.toHaveProperty('jobId');
  });

  it.each(['internal', 'external', 'both'] as const)('completes %s assessment atomically and reads the exact v2 report only in its workspace', async mode => {
    const c = await customer(); const result = await claim(c, mode);
    expect(result.input.version).toBe(2);
    expect(result.input.source === null).toBe(mode === 'external');
    expect(result.input.target === null).toBe(mode === 'internal');
    const recorded = await coordinator.customers.recordResult(result);
    expect(await api.customers.getReport(c.identity, { ...c.scope, ...recorded })).toEqual(result.report);
    expect(await api.customers.listReports(c.identity, c.scope)).toHaveLength(1);
    for (const role of ['gotchu_api', 'gotchu_coordinator'] as const) {
      expect((await f.databases[role].tenant(f.b.organizationId, tx => tx.query('SELECT id FROM gotchu.customer_reports WHERE id=$1', [recorded.reportId]))).rows).toEqual([]);
      expect((await f.databases[role].tenant(f.b.organizationId, tx => tx.query('SELECT job_id FROM gotchu.customer_requests WHERE job_id=$1', [result.input.jobId]))).rows).toEqual([]);
    }
    await expect(api.customers.getReport({ userId: f.b.userId }, { ...c.scope, ...recorded })).rejects.toMatchObject({ status: 403 });
    const job = await f.admin.query('SELECT state,result FROM gotchu.jobs WHERE id=$1', [result.input.jobId]);
    expect(job.rows[0]).toEqual({ state: 'succeeded', result: { status: 'completed', reportId: result.report.id } });
    await expect(coordinator.customers.recordResult(result)).rejects.toMatchObject({ code: 'stale_lease' });
  });

  it('rejects target revocation, renewed versions, expiry and archived applications at finish', async () => {
    for (const change of ['revoke', 'renew', 'expire', 'archive'] as const) {
      const c = await customer(); const result = await claim(c, 'external'); const target = present(result.input.target);
      if (change === 'revoke') await api.customers.revokeTarget(c.identity, { ...c.scope, targetId: target.id });
      if (change === 'renew') await api.customers.enrollTarget(c.identity, { ...c.scope, origin: target.origin, authorized: true });
      if (change === 'expire') await f.admin.query("UPDATE gotchu.customer_targets SET verified_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE organization_id=$1", [c.workspace.id]);
      if (change === 'archive') await api.customers.updateApplication(c.identity, { ...c.scope, archived: true });
      await expect(coordinator.customers.recordResult(result)).rejects.toMatchObject({ code: change === 'archive' ? 'application_archived' : 'assessment_target_changed' });
      expect(await api.customers.listReports(c.identity, c.scope)).toEqual([]);
    }
  });

  it('rejects stale claims, report subject substitution and mutated durable payloads', async () => {
    const c = await customer(); const result = await claim(c);
    await expect(coordinator.customers.recordResult({ ...result, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'stale_lease' });
    await expect(coordinator.customers.getRequest({ ...c.scope, jobId: result.input.jobId, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'stale_lease' });
    await expect(coordinator.customers.recordResult({ ...result, report: { ...result.report, subject: { ...result.report.subject, sourceDigest: 'a'.repeat(64) } } })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    await expect(coordinator.customers.recordResult({ ...result, input: { ...result.input, applicationName: 'Invented' }, report: { ...result.report, applicationName: 'Invented' } })).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    await f.admin.query("UPDATE gotchu.jobs SET payload=jsonb_set(payload,'{applicationName}','\"Changed\"'::jsonb) WHERE id=$1", [result.input.jobId]);
    await expect(coordinator.customers.recordResult(result)).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    expect(await api.customers.listReports(c.identity, c.scope)).toEqual([]);
  });

  it('rolls back report insertion if the lease is lost before job completion', async () => {
    const c = await customer(); const result = await claim(c);
    await f.admin.query(`CREATE FUNCTION gotchu.test_customer_expire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.job_id='${result.input.jobId}'::uuid THEN UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=NEW.job_id; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_customer_expire AFTER INSERT ON gotchu.customer_reports FOR EACH ROW EXECUTE FUNCTION gotchu.test_customer_expire()`);
    try {
      await expect(coordinator.customers.recordResult(result)).rejects.toMatchObject({ code: 'stale_lease' });
      expect(await api.customers.listReports(c.identity, c.scope)).toEqual([]);
      const job = await f.admin.query('SELECT state FROM gotchu.jobs WHERE id=$1', [result.input.jobId]);
      expect(job.rows[0]?.state).toBe('running');
    } finally { await f.admin.query('DROP TRIGGER test_customer_expire ON gotchu.customer_reports; DROP FUNCTION gotchu.test_customer_expire()'); }
    await expect(coordinator.customers.recordResult(result)).resolves.toEqual({ reportId: result.report.id });
  });
});
