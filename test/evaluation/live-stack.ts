import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackend, type WritableEventCredentials } from '@gotchu/backend';
import { runtimeAttackKindSchema } from '@gotchu/contracts';
import { createApi } from '../../apps/web/src/server/api.js';
import { createCoordinatorTransport, dispatchOutbox } from '../../apps/coordinator/src/index.js';
import { persistHttpsProbeInput, persistProviderTriageInputs } from '../../apps/coordinator/src/monitoring.js';
import { createCloudflareStatusAdapter, createAuthorizedHttpsHealthAdapter } from '@gotchu/monitoring';
import type { MonitorClaim } from '@gotchu/contracts';
import type { TrustedCustomerTarget } from '@gotchu/monitoring';
import { fixture, present } from '../../packages/database/test/support.js';
import type { ScenarioCase } from './triage-matrix.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function toRequest(request: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (typeof value === 'string') headers.set(key, value);
  }
  const chunks: Buffer[] = [];
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const method = request.method ?? 'GET';
  return new Request(new URL(request.url ?? '/', origin), body.length ? { method, headers, body: new Uint8Array(body) } : { method, headers });
}

function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  return result.arrayBuffer().then(bytes => { response.end(Buffer.from(bytes)); });
}

export interface EvaluationApplication {
  readonly identity: { userId: string };
  readonly organizationId: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly environmentId: string;
  readonly integrationId: string;
  readonly signingKey: string;
  readonly providerDependencyId: string | null;
  readonly monitorClaim: MonitorClaim | null;
  readonly trustedTarget: TrustedCustomerTarget | null;
}

export async function createLiveTriageStack() {
  const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
  if (!redisUrl) throw new Error('GOTCHU_TEST_REDIS_URL_required');
  const f = await fixture({ max: 6 });
  const signingSecrets = new Map<string, Uint8Array>();
  const credentials: WritableEventCredentials = {
    async getSigningSecret(reference) {
      const secret = signingSecrets.get(reference);
      if (!secret) throw new Error('evaluation_signing_key_missing');
      return secret;
    },
    async putSigningSecret(reference, secret) {
      if (signingSecrets.has(reference)) throw new Error('evaluation_signing_key_conflict');
      signingSecrets.set(reference, secret);
    },
    async deleteSigningSecret(reference) { signingSecrets.delete(reference); },
  };
  let dnsChallenge = '';
  const api = createBackend({ database: f.databases.gotchu_api, eventCredentials: credentials,
    customerDnsVerifier: { resolveTxt: async () => [[dnsChallenge]] } });
  const intake = createBackend({ database: f.databases.gotchu_ingest, credentials });
  const coordinator = createBackend({ database: f.databases.gotchu_coordinator });
  let apiOrigin = '';
  let apiHandler: ReturnType<typeof createApi>;
  const dispatch = createServer((incoming, outgoing) => {
    void toRequest(incoming, apiOrigin)
      .then(request => apiHandler(request))
      .then(response => writeResponse(outgoing, response))
      .catch(() => { outgoing.statusCode = 500; outgoing.end(); });
  });
  apiHandler = createApi({
    origin: 'http://127.0.0.1',
    auth: { enabled: false, handle: async () => new Response(), identity: async () => null, accountEmail: async () => null },
    ingest: input => intake.events.ingest(input),
    signedPolicy: input => intake.protection.signedPolicy(input),
    execute: async () => null,
  });
  await new Promise<void>((resolve, reject) => {
    dispatch.once('error', reject);
    dispatch.listen(0, '127.0.0.1', () => { dispatch.off('error', reject); resolve(); });
  });
  const apiAddress = dispatch.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('evaluation_web_listener_missing');
  apiOrigin = `http://127.0.0.1:${apiAddress.port}`;

  const transportErrors: string[] = [];
  const transport = createCoordinatorTransport({
    redisUrl,
    organizationIds: [],
    dependencies: { database: f.databases.gotchu_coordinator, backend: coordinator },
    report: (event, error) => { transportErrors.push(`${event}:${error instanceof Error ? error.message : String(error)}`); },
    prefix: `triage-eval-${randomUUID()}`,
  });
  await transport.waitUntilReady();

  async function createApplication(scenario: ScenarioCase, repetition: number): Promise<EvaluationApplication> {
    const identity = { userId: `triage-evaluation:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: `Evaluation ${randomUUID().slice(0, 8)}` });
    transport.setOrganizationIds([workspace.id]);
    const applicationName = `${scenario.id}-${repetition}`;
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: applicationName });
    const scope = { organizationId: workspace.id, applicationId: application.applicationId };
    const environment = await api.context.createEnvironment(identity, { ...scope, name: 'evaluation-production', kind: 'production' });
    if (!environment) throw new Error('evaluation_environment_missing');
    const serviceName = `eval-${scenario.id.slice(0, 42)}`;
    const service = await api.context.createService(identity, { ...scope, environmentId: environment.id, name: serviceName, kind: 'web' });
    if (!service) throw new Error('evaluation_service_missing');
    const connection = await api.telemetry.connect(identity, scope);
    await api.protection.update(identity, { ...scope, mode: 'block', enabledDetectors: [...runtimeAttackKindSchema.options] });

    let dependencyId: string | null = null;
    if (scenario.provider) {
      const dependency = await api.context.createDependency(identity, { ...scope, environmentId: environment.id, serviceId: service.id,
        kind: 'provider_component', provider: scenario.provider.name, component: scenario.provider.component, region: scenario.provider.region });
      if (!dependency) throw new Error('evaluation_dependency_missing');
      dependencyId = dependency.id;
      await f.admin.query(`UPDATE gotchu.application_dependencies SET state='verified',source='operator'
        WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, dependency.id]);
    }

    const releaseId = `${scenario.id}-release`;
    if (scenario.deployment) {
      const deployment = await api.context.createDeployment(identity, { ...scope, environmentId: environment.id, serviceId: service.id,
        releaseId, deployedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      if (!deployment) throw new Error('evaluation_deployment_missing');
      await f.admin.query(`UPDATE gotchu.application_deployments SET state='verified',source='operator'
        WHERE organization_id=$1 AND application_id=$2 AND id=$3`, [scope.organizationId, scope.applicationId, deployment.id]);
    }

    let monitorClaim: MonitorClaim | null = null;
    let trustedTarget: TrustedCustomerTarget | null = null;
    if (scenario.provider || scenario.faults.includes('missing_telemetry')) {
      const enrollment = await api.customers.enrollTarget(identity, { ...scope, origin: 'https://customer.org', authorized: true, scanProfile: 'public_surface' });
      dnsChallenge = enrollment.challenge.value;
      const verified = await api.customers.verifyTarget(identity, { ...scope, targetId: enrollment.target.id });
      trustedTarget = { id: verified.id, origin: verified.origin, version: verified.version, scanProfile: verified.scanProfile,
        verifiedAt: present(verified.verifiedAt), expiresAt: present(verified.expiresAt) };
      await api.operations.configure(identity, { ...scope, enabled: true, intervalSeconds: 3600,
        providers: scenario.provider ? [scenario.provider.name] : [], targetId: verified.id, sourceSnapshotId: null, repositoryKey: null });
      await api.triage.declareProbeRoute(identity, { ...scope, route: '/', serviceId: service.id, dependencyId, role: 'application' });
      await api.triage.declareProbeRoute(identity, { ...scope, route: '/.well-known/security.txt', serviceId: service.id, dependencyId: null, role: 'control' });
      const work = (await coordinator.operations.claimDue({ limit: 50 })).find(item => item.applicationId === scope.applicationId);
      if (!work) throw new Error('evaluation_monitor_claim_missing');
      monitorClaim = { organizationId: work.organizationId, applicationId: work.applicationId, runId: work.runId, leaseToken: work.leaseToken };
    }
    return { identity, organizationId: scope.organizationId, applicationId: scope.applicationId, applicationName,
      serviceId: service.id, serviceName, environmentId: environment.id, integrationId: connection.integration.id,
      signingKey: connection.signingKey, providerDependencyId: dependencyId, monitorClaim, trustedTarget };
  }

  async function recordProviderStatus(app: EvaluationApplication, scenario: ScenarioCase) {
    if (!scenario.provider || !app.monitorClaim) throw new Error('evaluation_provider_claim_missing');
    const now = new Date().toISOString();
    const degraded = scenario.provider.state !== 'major_outage';
    const componentStatus = scenario.provider.state === 'degraded' ? 'degraded_performance' : scenario.provider.state;
    const body = {
      page: { updated_at: now },
      status: { indicator: degraded ? 'minor' : 'critical', description: 'Evaluation provider status fixture' },
      components: [{ name: scenario.provider.component, status: componentStatus, updated_at: now }],
      incidents: [{ id: `evaluation-${scenario.id}`, name: 'Evaluation incident', status: 'investigating', updated_at: now }],
    };
    const adapter = createCloudflareStatusAdapter({ fixture: true, now: () => new Date(),
      fetchImplementation: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const observation = await adapter.read();
    if (!observation.fixture) throw new Error('evaluation_provider_fixture_not_marked');
    await persistProviderTriageInputs(f.databases.gotchu_coordinator, app.monitorClaim, observation);
  }

  async function recordProbes(app: EvaluationApplication, scenario: ScenarioCase, input: {
    certificate: string; port: number; unknownOnly?: boolean;
  }) {
    if (!app.monitorClaim || !app.trustedTarget) throw new Error('evaluation_probe_claim_missing');
    if (input.unknownOnly) {
      await persistHttpsProbeInput(f.databases.gotchu_coordinator, app.monitorClaim, {
        route: '/', service: app.serviceName, dependsOnProvider: null, role: 'application', outcome: 'unknown', at: new Date().toISOString(),
      });
      return;
    }
    const adapter = createAuthorizedHttpsHealthAdapter({ https: {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testFixture: { hostname: 'customer.org', port: input.port, ca: input.certificate },
    } });
    for (const route of ['/', '/.well-known/security.txt']) {
      const startedAt = performance.now();
      const result = await adapter.read(app.trustedTarget, AbortSignal.timeout(4_000), route);
      const elapsedMs = performance.now() - startedAt;
      const outcome = result.incomplete ? 'unknown'
        : result.status >= 500 ? 'unavailable'
          : result.status >= 400 || route === '/' && elapsedMs >= 1_000 ? 'degraded' : 'healthy';
      const probe = { route, service: app.serviceName,
        dependsOnProvider: route === '/' && scenario.provider ? scenario.provider.name : null,
        role: route === '/' ? 'application' as const : 'control' as const, outcome, at: result.observedAt };
      await persistHttpsProbeInput(f.databases.gotchu_coordinator, app.monitorClaim, probe);
    }
  }

  async function drain(organizationId: string, applicationId: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      await dispatchOutbox(coordinator, organizationId, transport.publish);
      const pending = await f.admin.query<{ id: string }>(`SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2
        AND state IN ('queued','running') AND (kind='events.aggregate' OR kind='notification' AND payload->>'kind'='triage_evaluation')`,
      [organizationId, applicationId]);
      if (pending.rowCount === 0) {
        if (transportErrors.length > 0) throw new Error(`evaluation_coordinator_transport_error:${transportErrors.join('|')}`);
        return;
      }
      await delay(20);
    }
    throw new Error(`evaluation_coordinator_drain_timeout:${applicationId}`);
  }

  async function readResults(organizationId: string, applicationId: string) {
    const observations = await f.admin.query<{ idempotency_key: string; body: unknown; created_at: Date }>(
      `SELECT idempotency_key,body,created_at FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2`,
      [organizationId, applicationId]);
    const incidents = await f.admin.query<{ rule_id: string; severity: string; created_at: Date }>(
      `SELECT rule_id,severity,created_at FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2`, [organizationId, applicationId]);
    const revision = await f.admin.query<{ body: unknown; created_at: Date }>(
      `SELECT body,created_at FROM gotchu.triage_revisions WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [organizationId, applicationId]);
    const coverage = await f.admin.query<{ state: string; reason: string }>(
      `SELECT state,reason FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2 AND capability='operational_detection'`,
      [organizationId, applicationId]);
    return { observations: observations.rows, incidents: incidents.rows, revision: revision.rows[0], coverage: coverage.rows[0] };
  }

  async function checkPermission(app: EvaluationApplication, observationId: string) {
    const scope = { organizationId: app.organizationId, applicationId: app.applicationId };
    const plan = await api.operations.createPlan(app.identity, { ...scope, kind: 'investigate_capacity', observationIds: [observationId] });
    const readiness = await api.operations.checkReadiness(app.identity, { ...scope,
      planId: plan.id, revision: plan.revision, actionHash: plan.actionHash });
    return { ready: readiness.ready, execution: readiness.execution };
  }

  async function close() {
    await transport.close();
    if (dispatch.listening) await new Promise<void>((resolve, reject) => {
      dispatch.close(error => error ? reject(error) : resolve());
      dispatch.closeAllConnections();
    });
    signingSecrets.clear();
    await f.close();
  }

  return { apiOrigin, createApplication, recordProviderStatus,
    recordProbes, drain, readResults, checkPermission, close };
}
