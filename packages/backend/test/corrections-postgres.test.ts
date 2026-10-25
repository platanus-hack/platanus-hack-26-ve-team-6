import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerAssessmentReportSchema, defaultLicensePolicy, type CustomerRunInput } from '@gotchu/contracts';
import { prepareCandidatePatch } from '@gotchu/scenarios/server';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { canonicalJson, createBackend, DEMO_ASSESSMENT_SCOPE, sha256 } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
const originalBytes = 'const client = { rejectUnauthorized: false };\n';
// Synthetic scanner evidence exercises real persistence/RLS, not scanner accuracy or live HTTPS.
function reportFor(input: CustomerRunInput, ruleId = 'gotchu.javascript.tls-disabled') {
  const external = input.mode === 'external';
  const origin = external ? 'external' : 'internal';
  const timestamp = new Date().toISOString();
  const snapshotRef = input.source ? `source:${input.source.id}:sha256:${input.source.digest}`
    : `target:${present(input.target).id}:${present(input.target).version}:${sha256(present(input.target).origin)}${input.target?.scanProfile === 'public_surface' ? ':public_surface' : ''}`;
  const evidenceId = randomUUID(); const findingId = randomUUID();
  const location = external ? 'https://app.example.com/' : 'src/client.ts:1';
  const finding = { id: findingId, ruleId: external ? 'https.missing-content-security-policy' : ruleId, correlationKey: 'test-finding', origin,
    title: 'Synthetic finding', location, description: 'Synthetic boundary observation', severity: 'medium', confidence: 'observed', exploitability: 'unknown',
    impact: 'Unknown', recommendation: 'Review', limitations: ['Synthetic evidence'], evidenceIds: [evidenceId] };
  const analysis = { origin, status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef, tool: { name: 'synthetic-test', version: '1' }, findings: [finding],
    evidence: [{ id: evidenceId, origin, kind: external ? 'http_response' : 'configuration', locator: location, collectedAt: timestamp, snapshotRef,
      tool: { name: 'synthetic-test', version: '1' }, checksum: sha256(originalBytes), excerpt: '[redacted]' }],
    coverage: [{ capability: external ? 'root_headers' : 'semgrep', state: 'inspected', detail: 'Synthetic coverage' }], limitations: ['Synthetic evidence'],
    ...(external ? {} : { dependencyInventory: { components: [], lockfiles: [], policy: input.licensePolicy ?? defaultLicensePolicy, complete: false, graphComplete: false, unknownCount: 0 } }) };
  return customerAssessmentReportSchema.parse({ version: 2, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId,
    applicationName: input.applicationName, mode: input.mode, startedAt: timestamp, finishedAt: timestamp, internal: external ? null : analysis, external: external ? analysis : null,
    comparison: [{ key: 'test-finding', classification: 'unverified', internalFindingIds: external ? [] : [findingId], externalFindingIds: external ? [findingId] : [], explanation: 'Single profile' }],
    limitations: ['Synthetic report'], responseMode: 'observation', actionsPerformed: [],
    subject: { sourceSnapshotId: input.source?.id ?? null, sourceDigest: input.source?.digest ?? null, targetId: input.target?.id ?? null, targetVersion: input.target?.version ?? null, origin: input.target?.origin ?? null,
      containerImageId: input.containerImage?.kind === 'archive' ? input.containerImage.id : null,
      containerImageDigest: input.containerImage?.digest ?? null,
      containerImageReference: input.containerImage?.kind === 'registry' ? input.containerImage.reference : null } });
}

live('private corrections on real PostgreSQL with synthetic scanner evidence', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 10 });
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function customer(ruleId?: string, external = false) {
    const identity = { userId: `corrections:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Corrections' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Customer app' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    const snapshot = { revision: 'customer-revision', files: [{ path: 'src/client.ts', content: originalBytes }] };
    const source = external ? null : await api.customers.uploadSource(identity, { ...scope, snapshot, authorized: true });
    let targetId = null;
    if (external) {
      const target = await api.customers.enrollTarget(identity, { ...scope, origin: 'https://app.example.com', scanProfile: 'public_surface' });
      // Trusted test setup only; no claim of real DNS verification.
      await f.admin.query("UPDATE gotchu.customer_targets SET status='authorized',authorized_at=clock_timestamp(),expires_at=clock_timestamp()+interval '1 day' WHERE organization_id=$1", [scope.organizationId]);
      targetId = target.target.id;
    }
    const queued = await api.customers.queue(identity, { ...scope, mode: external ? 'external' : 'internal', sourceSnapshotId: source?.id ?? null, targetId, idempotencyKey: randomUUID() });
    const claim = present(await coordinator.jobs.claim({ organizationId: scope.organizationId, jobId: queued.jobId }));
    const input = await coordinator.customers.getRequest({ ...scope, jobId: queued.jobId, leaseToken: claim.leaseToken });
    const report = reportFor(input, ruleId);
    await coordinator.customers.recordResult({ input, report, leaseToken: claim.leaseToken });
    const reportScope = { ...scope, reportId: report.id };
    const selection = { ...reportScope, recipeId: 'tls-certificate-verification', findingId: present((report.internal ?? report.external)?.findings[0]).id, expectedSourceDigest: source?.digest ?? '0'.repeat(64) };
    return { identity, scope, source, snapshot, input, report, reportScope, selection };
  }
  async function counts(organizationId: string) {
    const result = await f.admin.query(`SELECT
      (SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1) AS sources,
      (SELECT count(*)::int FROM gotchu.customer_requests WHERE organization_id=$1) AS requests,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1) AS jobs,
      (SELECT count(*)::int FROM gotchu.outbox WHERE organization_id=$1) AS outbox,
      (SELECT count(*)::int FROM gotchu.validation_runs WHERE organization_id=$1) AS validations,
      (SELECT count(*)::int FROM gotchu.audit_records WHERE organization_id=$1) AS audits`, [organizationId]);
    return result.rows[0];
  }

  it('stores exactly the prepared candidate with canonical internal intent/outbox and no raw source in responses/audits/jobs', async () => {
    const c = await customer();
    expect((await api.corrections.recommendations(c.identity, c.reportScope)).recommendations[0]?.availability).toBe('candidate_patch');
    const preparation = prepareCandidatePatch(c.input, c.report, { recipeId: c.selection.recipeId, findingId: c.selection.findingId, expectedSourceDigest: c.selection.expectedSourceDigest });
    if (preparation.status !== 'prepared') throw new Error('Expected fixture candidate');
    const prepared = await api.corrections.prepare(c.identity, c.selection);
    expect(prepared.patchHash).toBe(preparation.patchHash);
    expect(Object.keys(prepared).sort()).toEqual(['changes', 'jobId', 'patchHash', 'sourceId']);
    expect((await api.corrections.validationStatus(c.identity, { ...c.scope, candidateSourceId: prepared.sourceId }))?.run).toMatchObject({ state: 'inconclusive', reason: 'suite_not_configured', patchDigest: prepared.patchHash });
    const sources = await f.admin.query('SELECT id,body,digest FROM gotchu.customer_sources WHERE organization_id=$1 ORDER BY created_at', [c.scope.organizationId]);
    expect(sources.rows).toHaveLength(2);
    expect(sources.rows.find(row => row.id === c.source?.id)?.body).toEqual(c.snapshot);
    const candidate = sources.rows.find(row => row.id === prepared.sourceId);
    expect(candidate?.body).toEqual(preparation.candidateSourceSnapshot);
    expect(candidate?.digest).toBe(sha256(canonicalJson(preparation.candidateSourceSnapshot)));
    const job = present(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId: prepared.jobId }));
    expect(job.payload).toMatchObject({ mode: 'internal', target: null, source: { id: prepared.sourceId, digest: preparation.candidateSourceDigest } });
    expect(JSON.stringify(job.payload)).not.toContain('rejectUnauthorized');
    const hydrated = await coordinator.customers.getRequest({ ...c.scope, jobId: prepared.jobId, leaseToken: job.leaseToken });
    expect(hydrated.source?.files).toEqual(preparation.candidateSourceSnapshot.files);
    const outbox = await f.admin.query('SELECT envelope FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2', [c.scope.organizationId, prepared.jobId]);
    expect(outbox.rows).toEqual([{ envelope: job.envelope }]);
    const audit = await f.admin.query("SELECT detail FROM gotchu.audit_records WHERE organization_id=$1 AND action='correction.prepared'", [c.scope.organizationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail).toMatchObject({ patchHash: prepared.patchHash, reportId: c.report.id, sourceId: prepared.sourceId, originalSourceId: c.source?.id, path: 'src/client.ts', originalFileSha256: sha256(originalBytes) });
    expect(JSON.stringify(audit.rows)).not.toContain('rejectUnauthorized');
  });

  it('serializes concurrent exact retries and replays before full source/job quotas', async () => {
    const c = await customer();
    const results = await Promise.all(Array.from({ length: 3 }, () => api.corrections.prepare(c.identity, c.selection)));
    expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
    for (let i = 0; i < 8; i++) await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: { ...c.snapshot, revision: `extra-${i}` }, authorized: true });
    for (let i = 0; i < 2; i++) await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: present(c.source).id, targetId: null, idempotencyKey: `fill-${i}` });
    const before = await counts(c.scope.organizationId);
    expect(await api.corrections.prepare(c.identity, c.selection)).toEqual(results[0]);
    expect(await counts(c.scope.organizationId)).toEqual(before);
  });

  it('keeps completed replay identity after candidate deletion without resurrecting source', async () => {
    const c = await customer();
    const prepared = await api.corrections.prepare(c.identity, c.selection);
    const claim = present(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId: prepared.jobId }));
    const input = await coordinator.customers.getRequest({ ...c.scope, jobId: prepared.jobId, leaseToken: claim.leaseToken });
    await coordinator.customers.recordResult({ input, report: reportFor(input), leaseToken: claim.leaseToken });
    await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: prepared.sourceId });
    const before = await counts(c.scope.organizationId);
    expect(await api.corrections.prepare(c.identity, c.selection)).toEqual(prepared);
    expect(await counts(c.scope.organizationId)).toEqual(before);
    expect(await api.customers.listSources(c.identity, c.scope)).toHaveLength(1);
    await expect(api.corrections.prepare(c.identity, { ...c.selection, expectedSourceDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'expected_source_digest_mismatch' });
  });

  it('honors the existing source admission limit without queueing a scan', async () => {
    const c = await customer();
    for (let i = 0; i < 9; i++) await api.customers.uploadSource(c.identity, { ...c.scope, snapshot: { ...c.snapshot, revision: `extra-${i}` }, authorized: true });
    const before = await counts(c.scope.organizationId);
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'source_limit', status: 429 });
    expect(await counts(c.scope.organizationId)).toEqual(before);
  });

  it('rolls candidate, audit, job and outbox back when the existing queue admission fails', async () => {
    const c = await customer();
    for (let i = 0; i < 3; i++) await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: present(c.source).id, targetId: null, idempotencyKey: `full-${i}` });
    const before = await counts(c.scope.organizationId);
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'assessment_capacity_exceeded', status: 429 });
    expect(await counts(c.scope.organizationId)).toEqual(before);
  });

  it('enforces membership, application/tenant scope, reserved demo and viewer read-only access', async () => {
    const c = await customer();
    const viewer = { userId: `viewer:${randomUUID()}` }; const operator = { userId: `operator:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'viewer'),($1,$3,'operator')", [c.scope.organizationId, viewer.userId, operator.userId]);
    expect((await api.corrections.recommendations(viewer, c.reportScope)).scope.reportId).toBe(c.report.id);
    await expect(api.corrections.prepare(viewer, c.selection)).rejects.toMatchObject({ status: 403 });
    for (const identity of [{ userId: f.b.userId }, { userId: DEMO_ASSESSMENT_SCOPE.userId }]) {
      await expect(api.corrections.recommendations(identity, c.reportScope)).rejects.toMatchObject({ status: 403 });
      await expect(api.corrections.prepare(identity, c.selection)).rejects.toMatchObject({ status: 403 });
    }
    const other = await api.customers.createApplication(c.identity, { organizationId: c.scope.organizationId, name: 'Other' });
    for (const applicationId of [other.applicationId, f.b.applicationId]) {
      await expect(api.corrections.recommendations(c.identity, { ...c.reportScope, applicationId })).rejects.toMatchObject({ status: 404 });
      await expect(api.corrections.prepare(c.identity, { ...c.selection, applicationId })).rejects.toMatchObject({ status: 404 });
    }
    await expect(api.corrections.prepare(operator, c.selection)).resolves.toHaveProperty('jobId');
  });

  it('rejects stale digest and archive, while retained reports stay readable after source deletion', async () => {
    const c = await customer();
    await expect(api.corrections.prepare(c.identity, { ...c.selection, expectedSourceDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'expected_source_digest_mismatch', status: 409 });
    await api.customers.updateApplication(c.identity, { ...c.scope, archived: true });
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'application_archived' });
    await expect(api.corrections.recommendations(c.identity, c.reportScope)).rejects.toMatchObject({ code: 'application_archived' });
    await api.customers.updateApplication(c.identity, { ...c.scope, archived: false });
    await api.customers.deleteSource(c.identity, { ...c.scope, sourceSnapshotId: present(c.source).id });
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(api.corrections.recommendations(c.identity, c.reportScope)).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(await api.customers.getReport(c.identity, c.reportScope)).toEqual(c.report);
  });

  it('rejects persisted source corruption, canonical job drift and mismatched evidence refs', async () => {
    const c = await customer();
    // Admin corruption fixtures exercise validation beyond the normal immutable runtime role.
    await f.admin.query("UPDATE gotchu.customer_sources SET body=jsonb_set(body,'{files,0,content}','\"changed\"') WHERE organization_id=$1", [c.scope.organizationId]);
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    await f.admin.query('UPDATE gotchu.customer_sources SET body=$2::jsonb WHERE organization_id=$1', [c.scope.organizationId, JSON.stringify(c.snapshot)]);
    await f.admin.query("UPDATE gotchu.jobs SET payload=jsonb_set(payload,'{applicationName}','\"wrong\"') WHERE organization_id=$1 AND id=$2", [c.scope.organizationId, c.input.jobId]);
    await expect(api.corrections.recommendations(c.identity, c.reportScope)).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
    const { files: _, ...source } = present(c.input.source);
    await f.admin.query('UPDATE gotchu.jobs SET payload=$3::jsonb WHERE organization_id=$1 AND id=$2', [c.scope.organizationId, c.input.jobId, JSON.stringify({ ...c.input, source })]);
    await f.admin.query("UPDATE gotchu.customer_reports SET body=jsonb_set(body,'{internal,evidence,0,snapshotRef}','\"wrong\"') WHERE organization_id=$1", [c.scope.organizationId]);
    await expect(api.corrections.prepare(c.identity, c.selection)).rejects.toMatchObject({ code: 'assessment_scope_mismatch' });
  });

  it('provides public-surface external-only recommendations without source or a live lease', async () => {
    const c = await customer(undefined, true);
    const result = await api.corrections.recommendations(c.identity, c.reportScope);
    expect(result.scope.sourceSnapshotId).toBeNull();
    expect(result.repositoryContext.manifestState).toBe('not_requested');
    expect(result.recommendations[0]?.recipeId).toBe('https-security-headers');
    expect((await counts(c.scope.organizationId)).sources).toBe(0);
  });

  it('blocks integration-required and mismatched findings without writing', async () => {
    const c = await customer('generic-api-key');
    const before = await counts(c.scope.organizationId);
    await expect(api.corrections.prepare(c.identity, { ...c.selection, recipeId: 'credential-exposure' })).rejects.toMatchObject({ code: 'recipe_requires_integration', status: 409 });
    await expect(api.corrections.prepare(c.identity, { ...c.selection, findingId: randomUUID() })).rejects.toMatchObject({ code: 'finding_not_found', status: 409 });
    expect(await counts(c.scope.organizationId)).toEqual(before);
  });
});
