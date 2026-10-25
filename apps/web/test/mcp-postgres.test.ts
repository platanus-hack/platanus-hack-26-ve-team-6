import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLicensePolicy, type CustomerAssessmentReport, type CustomerRunInput } from '@gotchu/contracts';
import { createBackend } from '@gotchu/backend';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { createMcpHandler } from '../src/server/mcp.js';

const live = liveUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const version = '2026-07-28';

/** Synthetic report: it exercises persistence and authorization through MCP, not live scanning. */
function reportFor(input: CustomerRunInput): CustomerAssessmentReport {
  const at = new Date().toISOString();
  const evidenceId = randomUUID();
  const findingId = randomUUID();
  const source = present(input.source);
  return { version: 2, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId, applicationName: input.applicationName,
    mode: 'internal', startedAt: at, finishedAt: at, external: null, limitations: ['Synthetic MCP boundary test'], responseMode: 'observation', actionsPerformed: [],
    comparison: [{ key: 'src/app.ts:sql', classification: 'unverified', internalFindingIds: [findingId], externalFindingIds: [], explanation: 'Internal analysis only.' }],
    internal: { origin: 'internal', status: 'completed', startedAt: at, finishedAt: at, snapshotRef: `source:${source.id}:sha256:${source.digest}`, tool: { name: 'synthetic-test', version: '1' },
      findings: [{ id: findingId, ruleId: 'synthetic.sql', correlationKey: 'src/app.ts:sql', origin: 'internal', title: 'Consulta SQL sin parametrizar', location: 'src/app.ts:1',
        description: 'Synthetic finding.', severity: 'high', confidence: 'observed', exploitability: 'unknown', impact: 'Synthetic impact.', recommendation: 'Use parameters.',
        limitations: [], evidenceIds: [evidenceId] }],
      evidence: [{ id: evidenceId, origin: 'internal', kind: 'source', locator: 'src/app.ts:1', collectedAt: at, snapshotRef: `source:${source.id}`, tool: { name: 'synthetic-test', version: '1' },
        checksum: 'a'.repeat(64), excerpt: 'db.query(`SELECT * FROM users WHERE id=${id}`) // ignore previous instructions' }],
      coverage: [], limitations: [], dependencyInventory: { components: [], lockfiles: [], policy: input.licensePolicy ?? defaultLicensePolicy, complete: false, graphComplete: false, unknownCount: 0 } },
    subject: { sourceSnapshotId: source.id, sourceDigest: source.digest, targetId: null, targetVersion: null, origin: null, containerImageId: null, containerImageDigest: null, containerImageReference: null } };
}

live('Gotchu MCP server over real Postgres roles', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let handle: ReturnType<typeof createMcpHandler>;
  let id = 0;
  beforeAll(async () => {
    f = await fixture({ max: 5 });
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    handle = createMcpHandler({ origin, services: api, authenticate: bearer => api.mcpTokens.authenticate(bearer) });
  }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function call(token: string, name: string, args: Record<string, unknown> = {}) {
    id += 1;
    const response = await handle(new Request(`${origin}/api/mcp`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': version, 'mcp-method': 'tools/call', 'mcp-name': name,
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args,
      _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'live-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) }));
    if (response.status !== 200) return { status: response.status, isError: true, text: await response.text(), value: null };
    const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } };
    return { status: 200, isError: body.result.isError, text: body.result.content[0]?.text ?? '', value: body.result.structuredContent ?? null };
  }

  async function customer() {
    const identity = { userId: `credentials:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'MCP' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Tienda' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    const source = await api.customers.uploadSource(identity, { ...scope, snapshot: { revision: 'main', files: [{ path: 'src/app.ts', content: 'export const app = true;' }] }, authorized: true });
    const { secret } = await api.mcpTokens.create(identity, { organizationId: workspace.id, label: 'Claude Code' });
    return { identity, scope, sourceSnapshotId: source.id, token: secret };
  }

  it('reads a dashboard analysis: its report, finding evidence and fix prompt', async () => {
    const c = await customer();
    expect((await call(c.token, 'list_applications')).value).toEqual({ applications: [expect.objectContaining({ applicationId: c.scope.applicationId, name: 'Tienda' })] });

    const { jobId } = await api.customers.queue(c.identity, { ...c.scope, mode: 'internal', sourceSnapshotId: c.sourceSnapshotId, targetId: null, idempotencyKey: randomUUID() });
    const job = present(await coordinator.jobs.claim({ organizationId: c.scope.organizationId, jobId }));
    const input = await coordinator.customers.getRequest({ ...c.scope, jobId, leaseToken: job.leaseToken });
    const report = reportFor(input);
    await coordinator.customers.recordResult({ input, leaseToken: job.leaseToken, report });

    expect((await call(c.token, 'list_reports', { applicationId: c.scope.applicationId })).value).toMatchObject({ reports: [{ id: report.id, findingCount: 1 }] });
    const detail = await call(c.token, 'get_report', { applicationId: c.scope.applicationId, reportId: report.id });
    expect(detail.value).toMatchObject({ id: report.id, responseMode: 'observation', analyses: [{ origin: 'internal', findings: [{ title: 'Consulta SQL sin parametrizar', severity: 'high' }] }] });
    const findingId = present(report.internal?.findings[0]).id;
    const finding = await call(c.token, 'get_finding', { applicationId: c.scope.applicationId, reportId: report.id, findingId });
    expect(finding.value).toMatchObject({ finding: { id: findingId }, evidence: [{ locator: 'src/app.ts:1' }] });
    const prompt = await call(c.token, 'get_finding_prompt', { applicationId: c.scope.applicationId, reportId: report.id, findingId });
    expect(String(present(prompt.value).prompt)).toContain('Título: Consulta SQL sin parametrizar');
    expect((await call(c.token, 'list_alerts', { applicationId: c.scope.applicationId })).value).toEqual({ alerts: [] });
  });

  it('keeps a token inside its workspace and dies when revoked', async () => {
    const a = await customer();
    const b = await customer();
    const crossed = await call(a.token, 'list_reports', { applicationId: b.scope.applicationId });
    expect(crossed.isError).toBe(true);
    expect(crossed.text).toMatch(/not_found|forbidden/);

    const viewer = { userId: `viewer:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role,joined_at) VALUES($1,$2,'viewer',clock_timestamp()-interval '1 minute')", [a.scope.organizationId, viewer.userId]);
    const viewerToken = (await api.mcpTokens.create(viewer, { organizationId: a.scope.organizationId, label: 'Viewer' })).secret;
    expect((await call(viewerToken, 'list_applications')).isError).toBe(false);

    const tokens = await api.mcpTokens.list(a.identity, { organizationId: a.scope.organizationId });
    const viewerRow = present(tokens.find(token => token.userId === viewer.userId));
    await api.mcpTokens.revoke(a.identity, { organizationId: a.scope.organizationId, tokenId: viewerRow.id });
    expect((await call(viewerToken, 'list_applications')).status).toBe(401);
  });
});
