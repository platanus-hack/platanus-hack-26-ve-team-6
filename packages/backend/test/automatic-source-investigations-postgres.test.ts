import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerAssessmentReportSchema, defaultLicensePolicy, type CustomerRunInput } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('automatic source investigation admission on real PostgreSQL (synthetic scan evidence)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>; let coordinator: ReturnType<typeof createBackend>;
  beforeAll(async () => {
    f = await fixture({ max: 5 });
    api = createBackend({ database: f.databases.gotchu_api, modelSecrets: {
      get: async () => new Uint8Array(), put: async () => undefined, replace: async () => undefined, delete: async () => undefined,
    } });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  async function customer(enabled: boolean) {
    const identity = { userId: `automatic:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Automatic fixture' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Synthetic source' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    await api.investigationModels.configure(identity, { organizationId: workspace.id, providerPresetId: 'codex', modelId: 'gpt-6-luna',
      apiKey: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'synthetic', access_token: 'synthetic', refresh_token: 'synthetic' } }),
      consentToExternalProcessing: true, automaticSourceInvestigations: enabled, dataScopes: ['finding_details'],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0, organizationBudgetCents: 100, organizationTokenBudget: 100_000 });
    const source = await api.customers.uploadSource(identity, { ...scope, authorized: true, snapshot: { revision: 'synthetic-fixture', files: [{ path: 'src/index.ts', content: 'export const fixture = true;\n' }] } });
    const prepare = async () => {
      const queued = await api.customers.queue(identity, { ...scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID() });
      const claim = present(await coordinator.jobs.claim({ organizationId: workspace.id, jobId: queued.jobId, leaseMs: 120_000 }));
      const input = await coordinator.customers.getRequest({ ...scope, jobId: queued.jobId, leaseToken: claim.leaseToken });
      return { input, leaseToken: claim.leaseToken, report: reportFor(input) };
    };
    return { identity, scope, prepare };
  }
  async function jobs(scope: { organizationId: string; applicationId: string }) {
    return (await f.admin.query<{ id: string; payload: { subject: { subjectId: string; reportId: string }; evidenceIds: string[] }; outbox_id: string }>(`SELECT j.id,j.payload,o.id AS outbox_id FROM gotchu.jobs j
      JOIN gotchu.outbox o ON o.organization_id=j.organization_id AND o.job_id=j.id
      WHERE j.organization_id=$1 AND j.application_id=$2 AND j.kind='investigation'`, [scope.organizationId, scope.applicationId])).rows;
  }
  it('requires explicit opt-in and persists that setting', async () => {
    const c = await customer(false); const run = await c.prepare();
    await coordinator.customers.recordResult(run); expect(await jobs(c.scope)).toHaveLength(0);
    expect(await api.investigationModels.get(c.identity, c.scope)).toMatchObject({ automaticSourceInvestigations: false });
  });
  it('queues the three most severe source findings with durable outbox entries and manual deduplication', async () => {
    const c = await customer(true); const run = await c.prepare(); await coordinator.customers.recordResult(run);
    const queued = await jobs(c.scope); expect(queued).toHaveLength(3);
    const expected = present(run.report.internal).findings.filter(finding => finding.severity === 'critical' || finding.severity === 'high').map(finding => finding.id);
    expect(queued.map(job => job.payload.subject.subjectId).sort()).toEqual(expected.sort());
    expect(queued.every(job => job.payload.subject.reportId === run.report.id && job.outbox_id && job.payload.evidenceIds.length === 1)).toBe(true);
    const job = present(queued[0]);
    expect(await api.investigations.request(c.identity, { ...c.scope, subject: { kind: 'finding', subjectId: job.payload.subject.subjectId, reportId: run.report.id } })).toEqual({ status: 'already_active' });
    await expect(api.investigations.list({ userId: f.b.userId }, c.scope)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await api.investigations.list(c.identity, c.scope)).toHaveLength(3);
  });
  it('serializes concurrent report admission and permits work after explicit cancellation', async () => {
    const c = await customer(true); const first = await c.prepare(); const second = await c.prepare();
    await Promise.all([coordinator.customers.recordResult(first), coordinator.customers.recordResult(second)]);
    expect(await jobs(c.scope)).toHaveLength(3);
    for (const job of await jobs(c.scope)) await api.investigations.cancel(c.identity, { ...c.scope, jobId: job.id });
    await coordinator.customers.recordResult(await c.prepare()); expect(await jobs(c.scope)).toHaveLength(6);
  });
  it('does not queue work when the existing token budget is exhausted', async () => {
    const c = await customer(true); const run = await c.prepare();
    await f.admin.query('UPDATE gotchu.organizations SET model_tokens_spent=model_token_budget WHERE id=$1', [c.scope.organizationId]);
    await coordinator.customers.recordResult(run); expect(await jobs(c.scope)).toHaveLength(0);
  });
  it('honors revocation before an assessment finishes', async () => {
    const c = await customer(true); const run = await c.prepare();
    await api.investigationModels.disable(c.identity, c.scope);
    await coordinator.customers.recordResult(run); expect(await jobs(c.scope)).toHaveLength(0);
  });
});

function reportFor(input: CustomerRunInput) {
  const timestamp = new Date().toISOString(); const evidenceId = randomUUID();
  const findings = (['low', 'medium', 'high', 'critical', 'high'] as const).map((severity, index) => ({ id: randomUUID(), origin: 'internal', ruleId: `synthetic.${index}`, correlationKey: `synthetic.${index}`,
    title: 'Synthetic source finding', location: 'src/index.ts:1', description: 'Persistence fixture only', severity, confidence: 'observed', exploitability: 'unknown', impact: 'Unknown', recommendation: 'Review', limitations: ['Synthetic evidence'], evidenceIds: [evidenceId] }));
  return customerAssessmentReportSchema.parse({ version: 2, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId,
    applicationName: input.applicationName, mode: input.mode, startedAt: timestamp, finishedAt: timestamp,
    internal: { origin: 'internal', status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: 'synthetic', tool: { name: 'synthetic', version: '1' }, findings,
      evidence: [{ id: evidenceId, origin: 'internal', kind: 'configuration', locator: 'src/index.ts:1', collectedAt: timestamp, snapshotRef: 'synthetic', tool: { name: 'synthetic', version: '1' }, checksum: 'a'.repeat(64), excerpt: '[redacted]' }], coverage: [], limitations: ['Synthetic evidence'],
      dependencyInventory: { components: [], lockfiles: [], policy: input.licensePolicy ?? defaultLicensePolicy, complete: false, graphComplete: false, unknownCount: 0 } }, external: null, comparison: findings.map(finding => ({ key: finding.correlationKey, classification: 'unverified', internalFindingIds: [finding.id], externalFindingIds: [], explanation: 'Synthetic comparison' })), limitations: ['Synthetic report'], responseMode: 'observation', actionsPerformed: [],
    subject: { sourceSnapshotId: input.source?.id, sourceDigest: input.source?.digest, targetId: null, targetVersion: null, origin: null, containerImageId: null, containerImageDigest: null, containerImageReference: null } });
}
