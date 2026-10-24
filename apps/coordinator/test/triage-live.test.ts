import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, signEventBody, type WritableEventCredentials } from '@gotchu/backend';
import { triageRevisionSchema } from '@gotchu/triage';
import { createCloudflareStatusAdapter, createAuthorizedHttpsHealthAdapter } from '@gotchu/monitoring';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { evaluateTriage } from '../src/triage.js';
import { persistHttpsProbeInput, persistProviderTriageInputs } from '../src/monitoring.js';
import { processDurableJob } from '../src/jobs.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
const component = 'Workers API';

live('D03 telemetry/provider/HTTPS end-to-end on live Postgres and Redis', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let intake: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let directory: string;
  let certificate: string;
  let key: string;
  let tlsPort: number;
  let tlsServer: ReturnType<typeof createServer>;
  let redis: Redis;
  let dependentStatus = 200;
  const secrets = new Map<string, Uint8Array>();
  const credentials: WritableEventCredentials = {
    async getSigningSecret(reference) { const secret = secrets.get(reference); if (!secret) throw new Error('missing_key'); return secret; },
    async putSigningSecret(reference, secret) { if (secrets.has(reference)) throw new Error('duplicate_key'); secrets.set(reference, secret); },
    async deleteSigningSecret(reference) { secrets.delete(reference); },
  };
  const scopeOf = (organizationId: string, applicationId: string) => ({ organizationId, applicationId });

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    redis = new Redis(present(redisUrl), { maxRetriesPerRequest: 1 });
    expect(await redis.ping()).toBe('PONG');
    api = createBackend({ database: f.databases.gotchu_api, eventCredentials: credentials,
      customerDnsVerifier: { resolveTxt: async () => [[challenge]] } });
    intake = createBackend({ database: f.databases.gotchu_ingest, credentials });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    directory = await mkdtemp(join(tmpdir(), 'gotchu-triage-live-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'], { stdio: 'ignore', timeout: 10_000 });
    certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
    key = await readFile(join(directory, 'key.pem'), 'utf8');
    tlsServer = createServer({ cert: certificate, key }, ((request, response) => {
      const status = request.url === '/' ? dependentStatus : 200;
      response.writeHead(status).end('local TLS fixture');
    }) satisfies RequestListener);
    await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
    const address = tlsServer.address();
    if (!address || typeof address === 'string') throw new Error('tls_fixture_unavailable');
    tlsPort = address.port;
  }, 30_000);

  afterAll(async () => {
    tlsServer?.closeAllConnections();
    if (tlsServer?.listening) await new Promise<void>(resolve => tlsServer.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    secrets.clear();
    await redis?.quit();
    await f?.close();
  });

  let challenge = '';
  async function setup(options: { target?: boolean; routes?: boolean; provider?: boolean } = {}) {
    const identity = { userId: `d03:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: `D03 ${randomUUID().slice(0, 8)}` });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Checked application' });
    const scope = scopeOf(workspace.id, application.applicationId);
    const environment = present(await api.context.createEnvironment(identity, { ...scope, name: 'production', kind: 'production' }));
    const service = present(await api.context.createService(identity, { ...scope, environmentId: environment.id, name: 'checkout', kind: 'web' }));
    const dependency = present(await api.context.createDependency(identity, { ...scope, environmentId: environment.id, serviceId: service.id,
      kind: 'provider_component', provider: 'cloudflare', component, region: null }));
    const connection = await api.telemetry.connect(identity, scope);
    let targetId: string | null = null;
    if (options.target) {
      const enrollment = await api.customers.enrollTarget(identity, { ...scope, origin: 'https://customer.org', authorized: true, scanProfile: 'public_surface' });
      challenge = enrollment.challenge.value;
      await api.customers.verifyTarget(identity, { ...scope, targetId: enrollment.target.id });
      targetId = enrollment.target.id;
    }
    let monitorClaim: { organizationId: string; applicationId: string; runId: string; leaseToken: string } | null = null;
    if (options.provider || targetId) {
      await api.operations.configure(identity, { ...scope, enabled: true, intervalSeconds: 3600,
        providers: options.provider ? ['cloudflare'] : [], targetId, sourceSnapshotId: null, repositoryKey: null });
    }
    if (options.routes) {
      await api.triage.declareProbeRoute(identity, { ...scope, route: '/', serviceId: service.id, dependencyId: dependency.id, role: 'application' });
      await api.triage.declareProbeRoute(identity, { ...scope, route: '/.well-known/security.txt', serviceId: service.id, dependencyId: null, role: 'control' });
    }
    if (options.provider || targetId) {
      const work = present((await coordinator.operations.claimDue({ limit: 10 })).find(item => item.applicationId === scope.applicationId));
      monitorClaim = { organizationId: scope.organizationId, applicationId: scope.applicationId, runId: work.runId, leaseToken: work.leaseToken };
    }
    return { identity, scope, environment, service, dependency, integrationId: connection.integration.id, signingKey: connection.signingKey, targetId, monitorClaim };
  }

  async function recordProvider(test: Awaited<ReturnType<typeof setup>>, healthy: boolean) {
    if (!test.monitorClaim) throw new Error('monitor_claim_missing');
    const now = new Date().toISOString();
    const payload = { page: { updated_at: now }, status: { indicator: healthy ? 'none' : 'critical', description: healthy ? 'All systems operational' : 'Service incident' },
      components: [{ name: component, status: healthy ? 'operational' : 'partial_outage', updated_at: now }],
      incidents: healthy ? [] : [{ id: 'fixture-incident', name: 'Fixture incident', status: 'investigating', updated_at: now }] };
    const adapter = createCloudflareStatusAdapter({ fixture: true, now: () => new Date(), fetchImplementation: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const observation = await adapter.read();
    expect(observation.fixture).toBe(true);
    await persistProviderTriageInputs(f.databases.gotchu_coordinator, test.monitorClaim, observation);
  }

  async function recordProbes(test: Awaited<ReturnType<typeof setup>>) {
    if (!test.targetId || !test.monitorClaim) throw new Error('target_fixture_missing');
    const adapter = createAuthorizedHttpsHealthAdapter({ https: { lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testFixture: { hostname: 'customer.org', port: tlsPort, ca: certificate } } });
    const target = { id: test.targetId, origin: 'https://customer.org', version: 1, scanProfile: 'public_surface' as const,
      verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    for (const route of ['/', '/.well-known/security.txt']) {
      const result = await adapter.read(target, AbortSignal.timeout(2000), route);
      const probe = { route, service: 'checkout', dependsOnProvider: route === '/' ? 'cloudflare' : null,
        role: route === '/' ? 'application' as const : 'control' as const,
        outcome: result.incomplete ? 'unknown' as const : result.status >= 500 ? 'unavailable' as const : result.status >= 400 ? 'degraded' as const : 'healthy' as const,
        at: result.observedAt };
      await persistHttpsProbeInput(f.databases.gotchu_coordinator, test.monitorClaim, probe);
    }
  }

  async function ingest(test: Awaited<ReturnType<typeof setup>>, events: Array<{ occurredAt: string; statusCode: number; release: string }>) {
    const rawBody = Buffer.from(JSON.stringify({ applicationId: test.scope.applicationId, events: events.map(({ occurredAt, statusCode, release }) => ({
      id: randomUUID(), type: 'http.request', source: 'application', occurredAt, outcome: statusCode >= 500 ? 'failure' : 'success',
      attributes: { statusCode, durationMs: 30, capacityUtilization: 0.3, service: 'checkout', release, route: '/checkout' },
    })) }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const accepted = await intake.events.ingest({ integrationId: test.integrationId, timestamp, rawBody,
      signature: signEventBody(Buffer.from(test.signingKey, 'base64'), test.integrationId, timestamp, rawBody) });
    expect(accepted.accepted).toBe(events.length);
    if (!accepted.jobId) throw new Error('signed_event_job_missing');
    const envelope = { version: 1 as const, id: accepted.jobId, ...test.scope, kind: 'events.aggregate' as const };
    await processDurableJob({ database: f.databases.gotchu_coordinator, backend: coordinator }, envelope);
    const projection = await f.admin.query<{ id: string }>(`SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='notification'
      AND idempotency_key=$3`, [test.scope.organizationId, test.scope.applicationId, `triage:${accepted.jobId}`]);
    const projectionId = projection.rows[0]?.id;
    if (!projectionId) throw new Error('triage_projection_job_missing');
    await processDurableJob({ database: f.databases.gotchu_coordinator, backend: coordinator }, { version: 1, id: projectionId, ...test.scope, kind: 'notification' });
    return accepted;
  }

  async function latest(test: Awaited<ReturnType<typeof setup>>) {
    return f.databases.gotchu_api.tenant(test.scope.organizationId, async tx => {
      const rows = await tx.query<{ body: unknown }>(`SELECT r.body FROM gotchu.triage_revisions r WHERE r.organization_id=$1 AND r.application_id=$2
        ORDER BY r.created_at DESC LIMIT 1`, [test.scope.organizationId, test.scope.applicationId]);
      return rows.rows[0] ? triageRevisionSchema.parse(rows.rows[0].body) : undefined;
    });
  }

  it('keeps a provider incident separate from healthy checked points and avoids scaling suggestions', async () => {
    dependentStatus = 200;
    const test = await setup({ target: true, routes: true, provider: true });
    await recordProvider(test, false);
    await recordProbes(test);
    await ingest(test, Array.from({ length: 20 }, () => ({ occurredAt: new Date().toISOString(), statusCode: 200, release: 'release-healthy' })));
    const revision = present(await latest(test));
    expect(revision.impact.observed).toBe('none_observed_at_checked_points');
    expect(revision.hypotheses.find(item => item.kind === 'provider_dependency')?.status).not.toBe('supported');
    expect(revision.hypotheses.some(item => item.kind === 'legitimate_load')).toBe(false);
    expect(revision.hypotheses.some(item => /migration|capacity|replica/i.test(item.nextCheck))).toBe(false);
  }, 30_000);

  it('keeps regression as a supported hypothesis alongside provider alternatives after a verified release', async () => {
    const test = await setup({ provider: true });
    const deployedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await api.context.createDeployment(test.identity, { ...test.scope, environmentId: test.environment.id, serviceId: test.service.id,
      releaseId: 'release-after-baseline', deployedAt });
    await f.admin.query(`UPDATE gotchu.application_deployments SET state='verified',source='operator' WHERE organization_id=$1 AND application_id=$2 AND release_id='release-after-baseline'`, [test.scope.organizationId, test.scope.applicationId]);
    await recordProvider(test, true);
    const now = Date.now();
    const baseline = [-65, -55, -45].flatMap(offset => {
      const bucket = Math.floor((now + offset * 60_000) / 600_000) * 600_000;
      return Array.from({ length: 20 }, () => ({ occurredAt: new Date(bucket + 60_000).toISOString(), statusCode: 200, release: 'release-before' }));
    });
    await ingest(test, baseline);
    await ingest(test, Array.from({ length: 100 }, () => ({ occurredAt: new Date().toISOString(), statusCode: 500, release: 'release-after-baseline' })));
    const revision = present(await latest(test));
    const regression = revision.hypotheses.find(item => item.kind === 'application_regression');
    expect(['supported', 'weak']).toContain(regression?.status);
    expect(revision.hypotheses.find(item => item.kind === 'legitimate_load')?.status).toBe('weak');
  }, 30_000);

  it('supports the provider hypothesis only when a scoped component incident matches a failing dependent route and healthy control', async () => {
    dependentStatus = 503;
    const test = await setup({ target: true, routes: true, provider: true });
    await f.admin.query(`UPDATE gotchu.application_dependencies SET state='verified',source='operator' WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [test.scope.organizationId, test.scope.applicationId, test.dependency.id]);
    await recordProvider(test, false);
    await recordProbes(test);
    await ingest(test, Array.from({ length: 20 }, () => ({ occurredAt: new Date().toISOString(), statusCode: 200, release: 'release-healthy' })));
    const revision = present(await latest(test));
    expect(revision.hypotheses.find(item => item.kind === 'provider_dependency')).toMatchObject({ status: 'supported', confidence: 'high' });
  }, 30_000);

  it('shows stale signed telemetry as unknown impact', async () => {
    const test = await setup();
    const staleAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await ingest(test, Array.from({ length: 20 }, () => ({ occurredAt: staleAt, statusCode: 500, release: 'old-release' })));
    expect((await latest(test))?.impact.observed).toBe('unknown');
  }, 30_000);

  it('accepts authenticated detections when triage incidents and revisions are at their bounds', async () => {
    const test = await setup();
    const window = { startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString() };
    await f.admin.query(`INSERT INTO gotchu.triage_incidents(organization_id,application_id,id,environment,window_started_at,window_ended_at,last_evidence_at)
      SELECT $1,$2,gen_random_uuid(),'production',$3,$4,clock_timestamp()-interval '1 second' FROM generate_series(1,499)`, [test.scope.organizationId, test.scope.applicationId, window.startedAt, window.endedAt]);
    const incidentId = randomUUID();
    const inputDigest = (revision: number) => revision.toString(16).padStart(64, '0');
    const revisionBody = (revision: number) => ({ id: `bound-${revision}`, revision, previousRevisionId: revision === 1 ? null : `bound-${revision - 1}`,
        rulesVersion: 'triage.rules.v1', inputDigest: inputDigest(revision), impact: { observed: 'unknown', affectedServices: [], window,
          checkedPoints: [], missingData: ['Bounded fixture'] }, hypotheses: [{ kind: 'unknown', status: 'weak', confidence: 'low', ruleIds: ['scenario.unknown.investigable.v1'],
          evidenceFor: [], evidenceAgainst: [], missingData: ['Fresh signals'], nextCheck: 'Collect fresh scoped signals.' }], unknownInvestigable: ['Fixture'] });
    await f.databases.gotchu_coordinator.tenant(test.scope.organizationId, tx => tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',
      [test.scope.organizationId, test.scope.applicationId, incidentId, randomUUID(), 'production', window.startedAt, window.endedAt, JSON.stringify(revisionBody(1)), JSON.stringify([])]));
    for (let revision = 2; revision <= 200; revision++) {
      await f.databases.gotchu_coordinator.tenant(test.scope.organizationId, tx => tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)',
        [test.scope.organizationId, test.scope.applicationId, incidentId, randomUUID(), 'production', window.startedAt, window.endedAt, JSON.stringify(revisionBody(revision)), JSON.stringify([])]));
    }
    const accepted = await ingest(test, Array.from({ length: 20 }, () => ({ occurredAt: new Date().toISOString(), statusCode: 500, release: 'bounded-release' })));
    const detections = await f.admin.query(`SELECT id FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND basis->>'kind'='events'`, [test.scope.organizationId, test.scope.applicationId]);
    expect(detections.rowCount).toBeGreaterThan(0);
    const coverage = await f.admin.query<{ state: string }>(`SELECT state FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2 AND capability='triage_projection'`, [test.scope.organizationId, test.scope.applicationId]);
    expect(coverage.rows[0]?.state).toBe('degraded');
    expect(accepted.accepted).toBe(20);
  }, 60_000);
});
