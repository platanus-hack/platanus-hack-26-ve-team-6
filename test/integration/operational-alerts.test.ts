import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, type WritableEventCredentials } from '@gotchu/backend';
import type { EventBatchInput } from '@gotchu/contracts';
import { createCoordinatorTransport, dispatchOutbox, processDurableJob } from '@gotchu/coordinator';
import { httpRequestEvent, applicationErrorEvent, signEventBatch } from '@gotchu/sdk';
import { createCustomerAssessmentRunner, type ScannerAdapter } from '@gotchu/customer-assessment';
import { createCustomerApi } from '../../apps/web/src/server/customer-api.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';
import type { Database } from '@gotchu/database';

const live = liveUrl && process.env.GOTCHU_TEST_REDIS_URL ? describe : describe.skip;
live('operational alerts through signed intake, Postgres and actual BullMQ delivery', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>; let coordinator: ReturnType<typeof createBackend>; let intake: ReturnType<typeof createBackend>;
  const keys = new Map<string, Uint8Array>();
  const credentials: WritableEventCredentials = {
    async putSigningSecret(reference, key) { keys.set(reference, key); }, async deleteSigningSecret(reference) { keys.delete(reference); },
    async getSigningSecret(reference) { const key = keys.get(reference); if (!key) throw new Error('fixture_key_missing'); return key; },
  };
  beforeAll(async () => {
    f = await fixture({ max: 6 }); api = createBackend({ database: f.databases.gotchu_api, eventCredentials: credentials });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator }); intake = createBackend({ database: f.databases.gotchu_ingest, credentials });
  });
  afterAll(async () => { keys.clear(); await f?.close(); });
  async function application() {
    const identity = { userId: `credentials:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Operational evidence' });
    const app = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Actual runtime signal' });
    const scope = { organizationId: workspace.id, applicationId: app.applicationId };
    const connection = await api.telemetry.connect(identity, scope);
    return { identity, scope, connection };
  }
  function recentPastWindow(offset = 0) {
    const start = Math.floor(Date.now() / 600_000) * 600_000 - (offset + 1) * 600_000;
    return { start: new Date(start).toISOString(), occurredAt: new Date(start + 60_000).toISOString() };
  }
  async function ingestEvents(app: Awaited<ReturnType<typeof application>>, events: EventBatchInput['events']) {
    const batch = { applicationId: app.scope.applicationId, events };
    const signed = signEventBatch({ integrationId: app.connection.integration.id, secret: Buffer.from(app.connection.signingKey, 'base64'), batch });
    const result = await intake.events.ingest({ integrationId: app.connection.integration.id, rawBody: Buffer.from(signed.body), timestamp: signed.headers['X-Gotchu-Timestamp'], signature: signed.headers['X-Gotchu-Signature'] });
    return { result, batch };
  }
  async function ingest(app: Awaited<ReturnType<typeof application>>, bad = true, occurredAt = new Date().toISOString()) {
    const events = Array.from({ length: 30 }, () => ({ ...httpRequestEvent({ route: '/api/orders/:id', statusCode: bad ? 503 : 200, durationMs: bad ? 1800 : 20 }), occurredAt }));
    return ingestEvents(app, events);
  }
  function envelope(app: Awaited<ReturnType<typeof application>>, id: string) { return { version: 1 as const, id, ...app.scope, kind: 'events.aggregate' as const }; }
  const dependencies = () => ({ database: f.databases.gotchu_coordinator, backend: coordinator });
  async function metricSnapshot(app: Awaited<ReturnType<typeof application>>, window: ReturnType<typeof recentPastWindow>) {
    const bucket = Date.parse(window.start);
    return f.admin.query<{ organization_id: string; application_id: string; id: string; idempotency_key: string; content_hash: string; body: unknown; basis: unknown; expires_at: Date; created_at: Date }>(
      'SELECT * FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND idempotency_key=$3',
      [app.scope.organizationId, app.scope.applicationId, `signal:metrics:${bucket}`]);
  }
  async function projectionState(app: Awaited<ReturnType<typeof application>>) {
    return f.admin.query<{ observations: number; alerts: number; notification_jobs: number; notification_outbox: number }>(`SELECT
      (SELECT count(*)::int FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2) AS observations,
      (SELECT count(*)::int FROM gotchu.operation_alerts WHERE organization_id=$1 AND application_id=$2) AS alerts,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='notification') AS notification_jobs,
      (SELECT count(*)::int FROM gotchu.outbox o JOIN gotchu.jobs j ON j.organization_id=o.organization_id AND j.id=o.job_id
        WHERE j.organization_id=$1 AND j.application_id=$2 AND j.kind='notification') AS notification_outbox`, [app.scope.organizationId, app.scope.applicationId]);
  }
  async function terminal(app: Awaited<ReturnType<typeof application>>, id: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId: id });
      if (state.state === 'succeeded') return;
      if (state.state === 'failed') throw new Error(`operational_job_failed:${state.reasonCode ?? 'unknown'}`);
      await delay(25);
    }
    throw new Error('operational_delivery_timeout');
  }
  it('creates scoped error/pressure alerts, suppresses repeated-window noise and binds advisory plans', async () => {
    const app = await application(); const window = recentPastWindow(); const first = await ingest(app, true, window.occurredAt);
    expect(await coordinator.customers.pendingOrganizations()).toContain(app.scope.organizationId);
    const failures: unknown[] = [];
    const transport = createCoordinatorTransport({ redisUrl: present(process.env.GOTCHU_TEST_REDIS_URL), organizationIds: [app.scope.organizationId], dependencies: dependencies(), prefix: `ops-${randomUUID()}`, report: (_event, error) => failures.push(error) });
    try {
      await transport.waitUntilReady(); await dispatchOutbox(coordinator, app.scope.organizationId, transport.publish);
      await terminal(app, present(first.result.jobId));
      const alerts = await api.operations.listAlerts(app.identity, app.scope);
      expect(alerts.map(a => a.observation.kind).sort()).toEqual(['application_error', 'traffic_pressure']);
      const firstMetrics = await metricSnapshot(app, window);
      expect(firstMetrics.rows).toHaveLength(1);
      expect(firstMetrics.rows[0]?.body).toMatchObject({ metrics: { requestCount: 30, errorCount: 30, latencyP95Ms: 1800 } });
      const pressure = present(alerts.find(a => a.observation.kind === 'traffic_pressure'));
      expect(pressure.observation.metrics).toMatchObject({ requestCount: 30, errorCount: 30, latencyP95Ms: 1800 });
      const origin = 'http://localhost:3000';
      const http = createCustomerApi({ origin, registrationEnabled: false, providers: [], auth: { enabled: true, handle: async () => new Response(), identity: async () => ({ ...app.identity, cookies: ['session=renewed; HttpOnly'] }), accountEmail: async () => null },
        services: { ...api.customers, operations: api.operations, job: (identity, value) => api.web.getJob(identity, value) } });
      for (const state of ['acknowledged', 'resolved']) {
        const response = await http(new Request(`${origin}/api/customer/workspaces/${app.scope.organizationId}/applications/${app.scope.applicationId}/alerts/${pressure.id}`, {
          method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ state }),
        }));
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ id: pressure.id, state });
        expect(response.headers.get('set-cookie')).toContain('session=renewed');
      }
      const alertsBeforeRepeat = await api.operations.listAlerts(app.identity, app.scope);
      const second = await ingest(app, true, window.occurredAt);
      await dispatchOutbox(coordinator, app.scope.organizationId, transport.publish); await terminal(app, present(second.result.jobId));
      expect(await api.operations.listAlerts(app.identity, app.scope)).toEqual(alertsBeforeRepeat);
      expect((await metricSnapshot(app, window)).rows).toEqual(firstMetrics.rows);
      const nextWindow = recentPastWindow(1);
      const third = await ingest(app, true, nextWindow.occurredAt);
      await dispatchOutbox(coordinator, app.scope.organizationId, transport.publish); await terminal(app, present(third.result.jobId));
      const secondMetrics = await metricSnapshot(app, nextWindow);
      expect(secondMetrics.rows).toHaveLength(1);
      expect(secondMetrics.rows[0]?.id).not.toBe(firstMetrics.rows[0]?.id);
      expect(secondMetrics.rows[0]?.body).toMatchObject({ metrics: { windowStartedAt: nextWindow.start, requestCount: 30, errorCount: 30 } });
      const alertsAfterNextWindow = await api.operations.listAlerts(app.identity, app.scope);
      const nextWindowAlerts = alertsAfterNextWindow.filter(alert => alert.observation.metrics?.windowStartedAt === nextWindow.start);
      expect(nextWindowAlerts.map(alert => alert.observation.kind).sort()).toEqual(['application_error', 'traffic_pressure']);
      expect(new Set([...alertsBeforeRepeat.map(alert => alert.id), ...nextWindowAlerts.map(alert => alert.id)]).size).toBe(4);
      const plan = await api.operations.createPlan(app.identity, { ...app.scope, kind: 'investigate_capacity', observationIds: [pressure.observation.id] });
      const binding = { ...app.scope, planId: plan.id, revision: plan.revision, actionHash: plan.actionHash };
      expect(await api.operations.checkReadiness(app.identity, binding)).toMatchObject({ ready: false, execution: 'disabled' });
      await expect(api.operations.requestExecution(app.identity, binding)).rejects.toMatchObject({ code: 'operation_execution_unavailable' });
      await expect(api.operations.listAlerts({ userId: f.b.userId }, app.scope)).rejects.toMatchObject({ code: 'forbidden' });
      expect(failures).toEqual([]);
    } finally { await transport.close(); }
  }, 25_000);
  it('detects new thresholds from the full window after a healthy first metrics snapshot', async () => {
    const app = await application(); const window = recentPastWindow();
    const healthy = await ingest(app, false, window.occurredAt);
    await processDurableJob(dependencies(), envelope(app, present(healthy.result.jobId)));
    expect(await api.operations.listAlerts(app.identity, app.scope)).toEqual([]);
    const firstMetrics = await metricSnapshot(app, window);
    expect(firstMetrics.rows[0]?.body).toMatchObject({ metrics: { requestCount: 30, errorCount: 0, latencyP95Ms: 20 } });
    const failing = await ingest(app, true, window.occurredAt);
    await processDurableJob(dependencies(), envelope(app, present(failing.result.jobId)));
    const alerts = await api.operations.listAlerts(app.identity, app.scope);
    expect(alerts.map(alert => alert.observation.kind).sort()).toEqual(['application_error', 'traffic_pressure']);
    expect(alerts.map(alert => alert.observation.metrics)).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestCount: 60, errorCount: 30, latencyP95Ms: 1800 }),
    ]));
    expect((await metricSnapshot(app, window)).rows).toEqual(firstMetrics.rows);
  });
  it('commits auth incidents when a same-window auth-only batch follows runtime metrics', async () => {
    const app = await application(); const window = recentPastWindow();
    const first = await ingest(app, true, window.occurredAt);
    await processDurableJob(dependencies(), envelope(app, present(first.result.jobId)));
    const events: EventBatchInput['events'] = Array.from({ length: 10 }, (_, index) => ({
      id: randomUUID(), type: 'auth.login_failed', source: 'application', occurredAt: window.occurredAt,
      outcome: 'failure', actor: { accountId: `auth-${index}`, ip: '192.0.2.44' }, attributes: {},
    }));
    const second = await ingestEvents(app, events);
    await processDurableJob(dependencies(), envelope(app, present(second.result.jobId)));
    expect(await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId: present(second.result.jobId) })).toMatchObject({ state: 'succeeded' });
    const incidents = await f.admin.query('SELECT id FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2', [app.scope.organizationId, app.scope.applicationId]);
    expect(incidents.rowCount).toBeGreaterThan(0);
    expect((await metricSnapshot(app, window)).rows).toHaveLength(1);
  });
  it('keeps accepted authentication detection running when alert storage is full', async () => {
    const app = await application(); const window = recentPastWindow(); const first = await ingest(app, true, window.occurredAt);
    await processDurableJob(dependencies(), envelope(app, present(first.result.jobId)));
    // Explicit operator fixture fills admission without manufacturing verified security findings.
    const count = await f.admin.query<{ total: number }>('SELECT count(*)::int AS total FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2', [app.scope.organizationId, app.scope.applicationId]);
    const fillerCount = 100 - present(count.rows[0]).total;
    expect(fillerCount).toBeGreaterThan(0);
    await f.admin.query(`INSERT INTO gotchu.operation_observations(organization_id,application_id,id,idempotency_key,content_hash,body,basis,expires_at)
      SELECT $1,$2,n.id,'quota-fixture:'||n.id,o.content_hash,jsonb_set(o.body,'{id}',to_jsonb(n.id::text)),o.basis,o.expires_at
      FROM (SELECT * FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 LIMIT 1) o
      CROSS JOIN (SELECT gen_random_uuid() AS id FROM generate_series(1,$3)) n`, [app.scope.organizationId, app.scope.applicationId, fillerCount]);
    const fullCount = await f.admin.query<{ total: number }>('SELECT count(*)::int AS total FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2', [app.scope.organizationId, app.scope.applicationId]);
    expect(present(fullCount.rows[0]).total).toBe(100);
    const events = [...Array.from({ length: 3 }, () => ({ ...applicationErrorEvent('database'), occurredAt: window.occurredAt })), ...Array.from({ length: 10 }, () => ({ id: randomUUID(), type: 'auth.login_failed' as const, source: 'application' as const, occurredAt: window.occurredAt, outcome: 'failure' as const, actor: { accountId: 'quota-regression' }, attributes: {} }))];
    const signed = signEventBatch({ integrationId: app.connection.integration.id, secret: Buffer.from(app.connection.signingKey, 'base64'), batch: { applicationId: app.scope.applicationId, events } });
    const accepted = await intake.events.ingest({ integrationId: app.connection.integration.id, rawBody: Buffer.from(signed.body), timestamp: signed.headers['X-Gotchu-Timestamp'], signature: signed.headers['X-Gotchu-Signature'] });
    await processDurableJob(dependencies(), envelope(app, present(accepted.jobId)));
    const job = await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId: present(accepted.jobId) });
    expect(job.state).toBe('succeeded');
    const incidents = await f.admin.query('SELECT id FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2', [app.scope.organizationId, app.scope.applicationId]);
    expect(incidents.rowCount).toBeGreaterThan(0);
    const coverage = await f.admin.query("SELECT state FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2 AND capability='operational_detection'", [app.scope.organizationId, app.scope.applicationId]);
    expect(coverage.rows[0]?.state).toBe('degraded');
    expect((await api.operations.getCoverage(app.identity, app.scope)).limitations.some(reason => reason.includes('operational_detection'))).toBe(true);
  });
  it.each(['expired', 'archived'] as const)('settles %s assessment projections with a durable visible reason', async state => {
    const app = await application();
    const source = await api.customers.uploadSource(app.identity, { ...app.scope, authorized: true, snapshot: { revision: 'projection', files: [{ path: 'index.ts', content: 'export const fixture = 1;' }] } });
    const queued = await api.customers.queue(app.identity, { ...app.scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID() });
    const claim = present(await coordinator.jobs.claim({ organizationId: app.scope.organizationId, jobId: queued.jobId }));
    const input = await coordinator.customers.getRequest({ ...app.scope, jobId: queued.jobId, leaseToken: claim.leaseToken });
    const unavailable: ScannerAdapter = { async readiness() { return { ready: false, tools: [] }; }, async run() { throw new Error('unavailable_profile_fixture'); } };
    const report = await createCustomerAssessmentRunner({ scanners: unavailable }).run(input);
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await coordinator.customers.recordResult({ input, leaseToken: claim.leaseToken, report: state === 'expired' ? { ...report, startedAt: old, finishedAt: old } : report });
    if (state === 'archived') await api.customers.updateApplication(app.identity, { ...app.scope, archived: true });
    const pending = await f.admin.query<{ id: string }>("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='notification'", [app.scope.organizationId, app.scope.applicationId]);
    const id = present(pending.rows[0]).id;
    const delivery = { ...envelope(app, id), kind: 'notification' as const };
    await processDurableJob(dependencies(), delivery);
    expect(await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId: id })).toMatchObject({ state: 'failed', reasonCode: state === 'expired' ? 'assessment_projection_evidence_stale' : 'assessment_projection_application_archived' });
    expect(await processDurableJob(dependencies(), delivery)).toEqual({ status: 'already_terminal' });
    expect((await api.operations.getCoverage(app.identity, app.scope)).limitations.some(reason => reason.includes('assessment_alert_projection'))).toBe(true);
  });
  it('does not alert on legitimate volume and rolls back observation and projection effects on failure', async () => {
    const healthy = await application();
    const healthyWindow = recentPastWindow();
    for (let i = 0; i < 4; i++) { const batch = await ingest(healthy, false, healthyWindow.occurredAt); await processDurableJob(dependencies(), envelope(healthy, present(batch.result.jobId))); }
    expect(await api.operations.listAlerts(healthy.identity, healthy.scope)).toEqual([]);
    const app = await application(); const window = recentPastWindow(); const batch = await ingest(app, true, window.occurredAt); const delivery = envelope(app, present(batch.result.jobId));
    expect(await projectionState(app)).toMatchObject({ rows: [{ observations: 0, alerts: 0, notification_jobs: 0, notification_outbox: 0 }] });
    const database = f.databases.gotchu_coordinator;
    const failingDatabase: Database = { ...database, tenant: (tenant, work) => database.tenant(tenant, tx => work({ query: (sql, values) => {
      if (sql.startsWith('INSERT INTO gotchu.operation_alerts')) throw new Error('injected_alert_write_failure');
      return tx.query(sql, values);
    } })) };
    await expect(processDurableJob({ database: failingDatabase, backend: createBackend({ database: failingDatabase }) }, delivery)).rejects.toThrow('injected_alert_write_failure');
    expect(await api.operations.listAlerts(app.identity, app.scope)).toEqual([]);
    expect(await projectionState(app)).toMatchObject({ rows: [{ observations: 0, alerts: 0, notification_jobs: 0, notification_outbox: 0 }] });
    expect((await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId: delivery.id })).state).toBe('queued');
    await processDurableJob(dependencies(), delivery);
    expect(await api.operations.listAlerts(app.identity, app.scope)).toHaveLength(2);
    const retriedProjection = present((await projectionState(app)).rows[0]);
    expect(retriedProjection).toMatchObject({ observations: 3, alerts: 2 });
    expect(retriedProjection.notification_jobs).toBeGreaterThan(0);
    expect(retriedProjection.notification_outbox).toBeGreaterThan(0);
  }, 25_000);
  it('projects persisted coverage independently while notification delivery cannot occupy the event slot', async () => {
    const app = await application();
    const source = await api.customers.uploadSource(app.identity, { ...app.scope, authorized: true, snapshot: { revision: 'current', files: [{ path: 'src/app.ts', content: 'export const value = 1;' }] } });
    const queued = await api.customers.queue(app.identity, { ...app.scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID() });
    const claim = present(await coordinator.jobs.claim({ organizationId: app.scope.organizationId, jobId: queued.jobId }));
    const input = await coordinator.customers.getRequest({ ...app.scope, jobId: queued.jobId, leaseToken: claim.leaseToken });
    const unavailable: ScannerAdapter = { async readiness() { return { ready: false, tools: [] }; }, async run() { throw new Error('unavailable_profile_fixture'); } };
    const report = await createCustomerAssessmentRunner({ scanners: unavailable }).run(input);
    await coordinator.customers.recordResult({ input, leaseToken: claim.leaseToken, report });
    const pending = await f.admin.query<{ id: string }>("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='notification'", [app.scope.organizationId, app.scope.applicationId]);
    const jobId = present(pending.rows[0]).id;
    expect(await coordinator.customers.pendingOrganizations()).toContain(app.scope.organizationId);
    await f.admin.query('BEGIN');
    await f.admin.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND id=$2 FOR UPDATE', [app.scope.organizationId, jobId]);
    const transport = createCoordinatorTransport({ redisUrl: present(process.env.GOTCHU_TEST_REDIS_URL), organizationIds: [app.scope.organizationId], dependencies: dependencies(), prefix: `ops-isolation-${randomUUID()}`, report: () => {} });
    let released = false;
    try {
      await transport.waitUntilReady(); await dispatchOutbox(coordinator, app.scope.organizationId, transport.publish);
      await expect.poll(() => transport.queues.notification.getActiveCount()).toBe(1);
      const runtime = await ingest(app, false);
      await dispatchOutbox(coordinator, app.scope.organizationId, transport.publish);
      await terminal(app, present(runtime.result.jobId));
      expect((await api.web.getJob(app.identity, { organizationId: app.scope.organizationId, jobId })).state).toBe('queued');
      await f.admin.query('ROLLBACK'); released = true;
      await terminal(app, jobId);
      const alerts = await api.operations.listAlerts(app.identity, app.scope);
      expect(alerts).toHaveLength(1); expect(alerts[0]?.observation.kind).toBe('coverage_gap');
      await processDurableJob(dependencies(), { ...envelope(app, jobId), kind: 'notification' });
      expect(await api.operations.listAlerts(app.identity, app.scope)).toHaveLength(1);
    } finally { if (!released) await f.admin.query('ROLLBACK'); await transport.close(); }
  }, 20_000);
});
