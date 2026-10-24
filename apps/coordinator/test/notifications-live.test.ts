import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend, createFileNotificationSecretStore, signEventBody, type NotificationSecretStore, type WritableEventCredentials } from '@gotchu/backend';
import { createPublicHttpsDestinationResolver } from '@gotchu/monitoring';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { inspectMonitoringLiveness, recordSchedulerHeartbeat } from '../src/liveness.js';
import { createCoordinatorTransport } from '../src/transport.js';
import { dispatchOutbox, processDurableJob } from '../src/jobs.js';
import { createNotificationDeliveryWorker } from '../src/notification-delivery.js';
import { createNotificationDeliverySender, readSmtpSettings } from '../src/notification-adapters.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
const mailpitUrl = process.env.GOTCHU_TEST_SMTP_URL;
const mailpitApi = process.env.GOTCHU_TEST_MAILPIT_API;

live('notification outbox on live Postgres and Redis, HTTPS receiver, and Mailpit SMTP', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;
  let intake: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let redis: Redis;
  let directory: string;
  let certificate: string;
  let key: string;
  let tlsServer: ReturnType<typeof createServer>;
  let tlsPort: number;
  const eventSecrets = new Map<string, Uint8Array>();
  const eventCredentials: WritableEventCredentials = {
    async getSigningSecret(reference) { const secret = eventSecrets.get(reference); if (!secret) throw new Error('event_secret_missing'); return secret; },
    async putSigningSecret(reference, secret) { eventSecrets.set(reference, secret); },
    async deleteSigningSecret(reference) { eventSecrets.delete(reference); },
  };
  let secretStore: NotificationSecretStore;
  let secretDirectory: string;
  let signingSecret: string | undefined;
  let receiverHits: Array<{ body: string; idempotencyKey: string | null; valid: boolean }> = [];
  let returnFailureOnce = false;
  let returnPermanentFailure = false;
  const transportErrors: string[] = [];
  let fixtureResolver: ReturnType<typeof createPublicHttpsDestinationResolver>;

  beforeAll(async () => {
    f = await fixture({ max: 4 });
    redis = new Redis(present(redisUrl), { maxRetriesPerRequest: 1 });
    expect(await redis.ping()).toBe('PONG');
    directory = await mkdtemp(join(tmpdir(), 'gotchu-notification-live-tls-'));
    secretDirectory = join(directory, 'notification-secrets');
    secretStore = createFileNotificationSecretStore(secretDirectory);
    fixtureResolver = createPublicHttpsDestinationResolver({
      lookup: async hostname => hostname === 'webhook.test' ? [{ address: '127.0.0.1', family: 4 }] : [],
      testFixture: { hostname: 'webhook.test', address: '127.0.0.1' },
    });
    api = createBackend({ database: f.databases.gotchu_api, notificationSecrets: secretStore, eventCredentials,
      webhookValidator: { async validate(url) { await fixtureResolver.resolve(url); } } });
    intake = createBackend({ database: f.databases.gotchu_ingest, credentials: eventCredentials });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=webhook.test', '-addext', 'subjectAltName=DNS:webhook.test'], { stdio: 'ignore', timeout: 10_000 });
    certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
    key = await readFile(join(directory, 'key.pem'), 'utf8');
    tlsServer = createServer({ cert: certificate, key }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const timestamp = request.headers['x-gotchu-timestamp'];
        const supplied = request.headers['x-gotchu-signature'];
        const keyHeader = request.headers['x-gotchu-idempotency-key'];
        const timestampValue = typeof timestamp === 'string' ? Number(timestamp) : Number.NaN;
        let valid = Boolean(signingSecret && typeof supplied === 'string' && Number.isInteger(timestampValue)
          && Math.abs(Math.floor(Date.now() / 1000) - timestampValue) <= 300);
        if (valid && signingSecret && typeof supplied === 'string') {
          const expected = Buffer.from(`sha256=${createHmac('sha256', Buffer.from(signingSecret, 'base64url')).update(`${timestamp}.${body}`).digest('hex')}`);
          const actual = Buffer.from(supplied);
          valid = actual.length === expected.length && timingSafeEqual(actual, expected);
        }
        receiverHits.push({ body, idempotencyKey: typeof keyHeader === 'string' ? keyHeader : null, valid });
        if (!valid) { response.writeHead(401).end(); return; }
        if (returnFailureOnce) { returnFailureOnce = false; response.writeHead(503).end(); return; }
        if (returnPermanentFailure) { response.writeHead(400).end(); return; }
        response.writeHead(204).end();
      });
    });
    await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
    const address = tlsServer.address();
    if (!address || typeof address === 'string') throw new Error('notification_tls_fixture_unavailable');
    tlsPort = address.port;
    if (mailpitApi) {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try { ready = (await fetch(`${mailpitApi}/api/v1/messages`)).ok; } catch { ready = false; }
        if (ready) break;
        await delay(250);
      }
      if (!ready) throw new Error('mailpit_http_fixture_unavailable');
    }
  }, 30_000);

  afterAll(async () => {
    tlsServer?.closeAllConnections();
    if (tlsServer?.listening) await new Promise<void>(resolve => tlsServer.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    eventSecrets.clear();
    await redis?.quit();
    await f?.close();
  });

  async function customer() {
    const identity = { userId: `notifications:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: `Notifications ${randomUUID().slice(0, 8)}` });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Scheduled application' });
    return { identity, workspaceId: workspace.id, applicationId: application.applicationId };
  }

  async function createTransport(organizationId: string, sender: ReturnType<typeof createNotificationDeliverySender>) {
    const worker = createNotificationDeliveryWorker({ backend: coordinator, sender });
    const transport = createCoordinatorTransport({ redisUrl: present(redisUrl), organizationIds: [organizationId],
      dependencies: { database: f.databases.gotchu_coordinator, backend: coordinator, notificationEventWorker: worker },
      report: (event, error) => transportErrors.push(`${event}:${error instanceof Error ? error.message : 'unknown'}`),
      prefix: `notification-live-${randomUUID()}` });
    await transport.waitUntilReady();
    return transport;
  }

  async function waitForDelivery(organizationId: string, eventId: string, state: 'sent' | 'dead_letter') {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await f.admin.query<{ state: string; attempts: number; last_error: string | null }>(`SELECT state,attempts,last_error FROM gotchu.notification_deliveries
        WHERE organization_id=$1 AND event_id=$2`, [organizationId, eventId]);
      if (rows.rows[0]?.state === state) return rows.rows[0];
      await delay(250);
    }
    const detail = await f.admin.query(`SELECT d.state,d.attempts,d.last_error,j.state AS job_state,j.result,o.delivered_at
      FROM gotchu.notification_deliveries d JOIN gotchu.notification_events e ON e.organization_id=d.organization_id AND e.id=d.event_id
      LEFT JOIN gotchu.jobs j ON j.organization_id=e.organization_id AND j.kind='notification' AND j.payload->>'kind'='alert_delivery' AND j.payload->>'eventId'=e.id::text
      LEFT JOIN gotchu.outbox o ON o.organization_id=j.organization_id AND o.job_id=j.id WHERE d.organization_id=$1 AND d.event_id=$2`, [organizationId, eventId]);
    throw new Error(`notification_delivery_timeout:${JSON.stringify({ eventId, rows:detail.rows, reports:transportErrors, receiverHits:receiverHits.length })}`);
  }

  it('isolates channel management by tenant and Owner/Admin and never returns the signing secret twice', async () => {
    const c = await customer();
    const channel = await api.notifications.createEmail(c.identity, { organizationId: c.workspaceId, label: 'Primary', email: 'alerts@example.com', minimumSeverity: 'medium' });
    expect(channel).not.toHaveProperty('secretRef');
    expect(channel).not.toHaveProperty('signingSecret');
    expect(await api.notifications.listChannels(c.identity, { organizationId: c.workspaceId })).toEqual([channel]);
    await expect(api.notifications.listChannels({ userId: f.b.userId }, { organizationId: c.workspaceId })).rejects.toMatchObject({ status: 403 });
    await expect(api.notifications.listChannels(c.identity, { organizationId: f.b.organizationId })).rejects.toMatchObject({ status: 403 });
    const viewerId = `notification-viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [c.workspaceId, viewerId]);
    const viewer = { userId: viewerId };
    expect(await api.notifications.listChannels(viewer, { organizationId: c.workspaceId })).toEqual([channel]);
    await expect(api.notifications.createEmail(viewer, { organizationId: c.workspaceId, label: 'Forbidden', email: 'blocked@example.com' })).rejects.toMatchObject({ status: 403 });
    await expect(api.notifications.sendTest(viewer, { organizationId: c.workspaceId, channelId: channel.id })).rejects.toMatchObject({ status: 403 });
    await expect(api.notifications.disable(viewer, { organizationId: c.workspaceId, channelId: channel.id })).rejects.toMatchObject({ status: 403 });
    const operatorId = `notification-operator:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'operator')", [c.workspaceId, operatorId]);
    const operatorChannel = await api.notifications.createEmail({ userId: operatorId }, { organizationId: c.workspaceId, label: 'Operator channel', email: 'operator@example.com' });
    await api.notifications.disable({ userId: operatorId }, { organizationId: c.workspaceId, channelId: operatorChannel.id });
    expect(await api.notifications.listChannels(c.identity, { organizationId: c.workspaceId })).toContainEqual(expect.objectContaining({ id: operatorChannel.id, state: 'disabled' }));
    await expect(f.databases.gotchu_api.tenant(c.workspaceId, tx => tx.query('SELECT secret_ref FROM gotchu.notification_channels WHERE id=$1', [channel.id])))
      .rejects.toThrow(/permission denied/);
  });

  it('delivers a signed HTTPS webhook through Redis/Postgres retries using the stable alert idempotency key', async () => {
    const c = await customer();
    const created = await api.notifications.createWebhook(c.identity, { organizationId: c.workspaceId, label: 'Receiver', url: 'https://webhook.test/alerts', minimumSeverity: 'info' });
    signingSecret = created.signingSecret;
    receiverHits = [];
    returnFailureOnce = true;
    expect(await api.notifications.listChannels(c.identity, { organizationId: c.workspaceId })).toMatchObject([{ id: created.channel.id }]);
    expect(await api.notifications.listChannels(c.identity, { organizationId: c.workspaceId })).not.toHaveProperty('signingSecret');
    const queued = await api.notifications.sendTest(c.identity, { organizationId: c.workspaceId, channelId: created.channel.id });
    const sender = createNotificationDeliverySender({ secrets: createFileNotificationSecretStore(secretDirectory), lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testWebhookTls: { hostname: 'webhook.test', address: '127.0.0.1', port: tlsPort, ca: certificate } });
    const transport = await createTransport(c.workspaceId, sender);
    try {
      expect(await dispatchOutbox(coordinator, c.workspaceId, transport.publish)).toBeGreaterThan(0);
      const delivery = await waitForDelivery(c.workspaceId, queued.eventId, 'sent');
      expect(delivery).toMatchObject({ attempts: 2, last_error: null });
      expect(receiverHits).toHaveLength(2);
      expect(receiverHits.every(hit => hit.valid)).toBe(true);
      expect(receiverHits[0]?.body).toBe(receiverHits[1]?.body);
      expect(receiverHits[0]?.idempotencyKey).toBe(receiverHits[1]?.idempotencyKey);
      expect(receiverHits[0]?.idempotencyKey).toBe(`notification:${queued.eventId}`);
      const job = await f.admin.query<{ state: string }>("SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND payload->>'kind'='alert_delivery' AND payload->>'eventId'=$2", [c.workspaceId, queued.eventId]);
      expect(job.rows[0]?.state).toBe('succeeded');
    } finally { await transport.close(); }
  }, 30_000);

  it('notifies active channels from authenticated runtime detector alerts', async () => {
    const c = await customer();
    await api.notifications.createEmail(c.identity, { organizationId: c.workspaceId, label: 'Runtime alerts', email: 'runtime@example.com', minimumSeverity: 'high' });
    const integration = await api.telemetry.connect(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId });
    const occurredAt = new Date().toISOString();
    const rawBody = Buffer.from(JSON.stringify({ applicationId: c.applicationId, events: Array.from({ length: 20 }, () => ({
      id: randomUUID(), type: 'http.request', source: 'application', occurredAt, outcome: 'failure',
      attributes: { statusCode: 503, durationMs: 1300, service: 'checkout', route: '/checkout' },
    })) }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const accepted = await intake.events.ingest({ integrationId: integration.integration.id, timestamp, rawBody,
      signature: signEventBody(Buffer.from(integration.signingKey, 'base64'), integration.integration.id, timestamp, rawBody) });
    expect(accepted.accepted).toBe(20);
    if (!accepted.jobId) throw new Error('runtime_detector_job_missing');
    await processDurableJob({ database: f.databases.gotchu_coordinator, backend: coordinator },
      { version: 1, id: accepted.jobId, organizationId: c.workspaceId, applicationId: c.applicationId, kind: 'events.aggregate' });
    const notifications = await f.admin.query<{ event_kind: string; severity: string; count: number }>(`SELECT event_kind,severity,count(*)::int AS count
      FROM gotchu.notification_events WHERE organization_id=$1 AND application_id=$2 GROUP BY event_kind,severity`, [c.workspaceId, c.applicationId]);
    expect(notifications.rows).toEqual([{ event_kind: 'runtime_alert', severity: 'high', count: 2 }]);
    const runtimeEvents = await f.admin.query<{ id: string }>(`SELECT id FROM gotchu.notification_events
      WHERE organization_id=$1 AND application_id=$2 AND event_kind='runtime_alert' ORDER BY event_key`, [c.workspaceId, c.applicationId]);
    const deliveries = await f.admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM gotchu.notification_deliveries d
      JOIN gotchu.notification_events e ON e.organization_id=d.organization_id AND e.id=d.event_id
      WHERE d.organization_id=$1 AND e.application_id=$2 AND e.event_kind='runtime_alert'`, [c.workspaceId, c.applicationId]);
    expect(deliveries.rows[0]?.count).toBe(2);
    if (mailpitUrl && mailpitApi) {
      const smtp = readSmtpSettings({ ...process.env, NODE_ENV: 'test', GOTCHU_SMTP_URL: mailpitUrl,
        GOTCHU_SMTP_TLS_MODE: 'none', GOTCHU_SMTP_FROM: 'gotchu@example.com' });
      const transport = await createTransport(c.workspaceId, createNotificationDeliverySender({ smtp }));
      try {
        expect(await dispatchOutbox(coordinator, c.workspaceId, transport.publish)).toBeGreaterThan(0);
        for (const event of runtimeEvents.rows) await waitForDelivery(c.workspaceId, event.id, 'sent');
        const response = await fetch(`${mailpitApi}/api/v1/messages`);
        expect(response.status).toBe(200);
        const messages: unknown = await response.json();
        expect(JSON.stringify(messages)).toContain('runtime@example.com');
        expect(JSON.stringify(messages)).toContain('Alerta del detector en tiempo de ejecución');
      } finally { await transport.close(); }
    }
  }, 30_000);

  it('sends SMTP mail through the disposable Mailpit container', async () => {
    if (!mailpitUrl || !mailpitApi) return;
    const c = await customer();
    const email = `alerts+${randomUUID().slice(0, 8)}@example.com`;
    const channel = await api.notifications.createEmail(c.identity, { organizationId: c.workspaceId, label: 'Mailpit', email, minimumSeverity: 'info' });
    const queued = await api.notifications.sendTest(c.identity, { organizationId: c.workspaceId, channelId: channel.id });
    const smtp = readSmtpSettings({ ...process.env, NODE_ENV: 'test', GOTCHU_SMTP_URL: mailpitUrl, GOTCHU_SMTP_TLS_MODE: 'none', GOTCHU_SMTP_FROM: 'gotchu@example.com' });
    const transport = await createTransport(c.workspaceId, createNotificationDeliverySender({ smtp }));
    try {
      await dispatchOutbox(coordinator, c.workspaceId, transport.publish);
      expect(await waitForDelivery(c.workspaceId, queued.eventId, 'sent')).toMatchObject({ attempts: 1, last_error: null });
      const response = await fetch(`${mailpitApi}/api/v1/messages`);
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      expect(JSON.stringify(payload)).toContain(email);
    } finally { await transport.close(); }
  }, 30_000);

  it('marks permanent webhook rejection as a visible dead letter', async () => {
    const c = await customer();
    const created = await api.notifications.createWebhook(c.identity, { organizationId: c.workspaceId, label: 'Rejecting receiver', url: 'https://webhook.test/reject', minimumSeverity: 'info' });
    signingSecret = created.signingSecret;
    receiverHits = [];
    returnPermanentFailure = true;
    const queued = await api.notifications.sendTest(c.identity, { organizationId: c.workspaceId, channelId: created.channel.id });
    const sender = createNotificationDeliverySender({ secrets: createFileNotificationSecretStore(secretDirectory), lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      testWebhookTls: { hostname: 'webhook.test', address: '127.0.0.1', port: tlsPort, ca: certificate } });
    const transport = await createTransport(c.workspaceId, sender);
    try {
      await dispatchOutbox(coordinator, c.workspaceId, transport.publish);
      expect(await waitForDelivery(c.workspaceId, queued.eventId, 'dead_letter')).toMatchObject({ attempts: 1, last_error: 'webhook_http_400' });
      expect(receiverHits).toHaveLength(1);
    } finally { returnPermanentFailure = false; await transport.close(); }
  }, 30_000);

  it('persists stopped and recovered liveness and queues each transition on Postgres', async () => {
    const c = await customer();
    await api.notifications.createEmail(c.identity, { organizationId: c.workspaceId, label: 'Liveness', email: 'ops@example.com', minimumSeverity: 'info' });
    await api.operations.configure(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId,
      enabled: true, intervalSeconds: 3600, providers: ['cloudflare'], repositoryKey: null, sourceSnapshotId: null });
    const coordinatorId = `liveness-test-${randomUUID()}`;
    await recordSchedulerHeartbeat(f.databases.gotchu_coordinator, coordinatorId);

    async function nextRun() {
      await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at='1970-01-01' WHERE organization_id=$1 AND application_id=$2", [c.workspaceId, c.applicationId]);
      const work = (await coordinator.operations.claimDue({ limit: 1 }))[0];
      if (!work || work.organizationId !== c.workspaceId || work.applicationId !== c.applicationId) throw new Error('liveness_test_run_missing');
      return work;
    }
    const failedRuns = [];
    for (let count = 0; count < 3; count += 1) {
      const work = await nextRun();
      failedRuns.push(work.runId);
      await coordinator.operations.finishRun({ organizationId: c.workspaceId, applicationId: c.applicationId, runId: work.runId,
        leaseToken: work.leaseToken, status: 'degraded', reason: 'synthetic_adapter_failure' });
    }
    expect(failedRuns).toHaveLength(3);
    await inspectMonitoringLiveness(f.databases.gotchu_coordinator, [c.workspaceId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'stopped', liveness: { state: 'stopped', consecutiveFailures: 3 } });

    const recovered = await nextRun();
    const observedAt = new Date().toISOString();
    await coordinator.operations.recordObservation({ organizationId: c.workspaceId, applicationId: c.applicationId,
      basis: { kind: 'monitor', runId: recovered.runId, leaseToken: recovered.leaseToken }, idempotencyKey: randomUUID(),
      kind: 'coverage_check', summary: 'Synthetic successful scheduled check', severity: 'info', confidence: 'high', observedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), evidence: [{ source: 'provider_status', reference: 'cloudflare:live-test',
        checksum: 'a'.repeat(64), collectedAt: observedAt, adapter: 'live-test', adapterVersion: '1' }], upstreamImpact: 'not_applicable' });
    await coordinator.operations.finishRun({ organizationId: c.workspaceId, applicationId: c.applicationId, runId: recovered.runId,
      leaseToken: recovered.leaseToken, status: 'completed' });
    await inspectMonitoringLiveness(f.databases.gotchu_coordinator, [c.workspaceId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'active', liveness: { state: 'healthy', consecutiveFailures: 0 } });
    const events = await f.admin.query<{ event_kind: string; count: number }>(`SELECT event_kind,count(*)::int AS count FROM gotchu.notification_events
      WHERE organization_id=$1 AND application_id=$2 GROUP BY event_kind`, [c.workspaceId, c.applicationId]);
    expect(events.rows).toEqual(expect.arrayContaining([{ event_kind: 'monitoring_stopped', count: 1 }, { event_kind: 'monitoring_recovered', count: 1 }]));
    const deliveries = await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.notification_deliveries WHERE organization_id=$1', [c.workspaceId]);
    expect(deliveries.rows[0]?.count).toBe(2);

    await f.admin.query(`UPDATE gotchu.monitoring_liveness SET last_scheduler_heartbeat_at=clock_timestamp()-interval '1 minute'
      WHERE organization_id=$1 AND application_id=$2`, [c.workspaceId, c.applicationId]);
    await f.admin.query(`UPDATE gotchu.operation_runs SET finished_at=clock_timestamp()-interval '2 minutes'
      WHERE organization_id=$1 AND application_id=$2 AND status='completed'
      AND id=(SELECT id FROM gotchu.operation_runs WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1)`, [c.workspaceId, c.applicationId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'stopped', liveness: { state: 'stopped', reason: 'El coordinador dejó de enviar latidos de planificación.' } });
    await recordSchedulerHeartbeat(f.databases.gotchu_coordinator, coordinatorId);
    await inspectMonitoringLiveness(f.databases.gotchu_coordinator, [c.workspaceId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'stopped', liveness: { state: 'stopped' } });

    const secondRecovery = await nextRun();
    const secondObservedAt = new Date().toISOString();
    await coordinator.operations.recordObservation({ organizationId: c.workspaceId, applicationId: c.applicationId,
      basis: { kind: 'monitor', runId: secondRecovery.runId, leaseToken: secondRecovery.leaseToken }, idempotencyKey: randomUUID(),
      kind: 'coverage_check', summary: 'Synthetic successful post-outage check', severity: 'info', confidence: 'high', observedAt: secondObservedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), evidence: [{ source: 'provider_status', reference: 'cloudflare:live-test',
        checksum: 'b'.repeat(64), collectedAt: secondObservedAt, adapter: 'live-test', adapterVersion: '1' }], upstreamImpact: 'not_applicable' });
    await coordinator.operations.finishRun({ organizationId: c.workspaceId, applicationId: c.applicationId, runId: secondRecovery.runId,
      leaseToken: secondRecovery.leaseToken, status: 'completed' });
    await inspectMonitoringLiveness(f.databases.gotchu_coordinator, [c.workspaceId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'active', liveness: { state: 'healthy' } });
    const finalEvents = await f.admin.query<{ event_kind: string; count: number }>(`SELECT event_kind,count(*)::int AS count FROM gotchu.notification_events
      WHERE organization_id=$1 AND application_id=$2 GROUP BY event_kind`, [c.workspaceId, c.applicationId]);
    expect(finalEvents.rows).toEqual(expect.arrayContaining([{ event_kind: 'monitoring_stopped', count: 2 }, { event_kind: 'monitoring_recovered', count: 2 }]));
    const finalDeliveries = await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.notification_deliveries WHERE organization_id=$1', [c.workspaceId]);
    expect(finalDeliveries.rows[0]?.count).toBe(4);
  }, 30_000);

  it('creates durable stopped state when the coordinator never records a first target heartbeat', async () => {
    const c = await customer();
    await api.notifications.createEmail(c.identity, { organizationId: c.workspaceId, label: 'First heartbeat', email: 'ops@example.com', minimumSeverity: 'info' });
    await api.operations.configure(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId,
      enabled: true, intervalSeconds: 3600, providers: ['cloudflare'], repositoryKey: null, sourceSnapshotId: null });
    await f.admin.query("UPDATE gotchu.operation_monitors SET next_due_at=clock_timestamp()-interval '4 hours' WHERE organization_id=$1 AND application_id=$2", [c.workspaceId, c.applicationId]);
    expect(await api.operations.getCoverage(c.identity, { organizationId: c.workspaceId, applicationId: c.applicationId }))
      .toMatchObject({ status: 'stopped', liveness: { state: 'stopped', reason: 'El coordinador dejó de enviar latidos de planificación.' } });
    const persisted = await f.admin.query<{ state: string; since: Date }>('SELECT state,since FROM gotchu.monitoring_liveness WHERE organization_id=$1 AND application_id=$2', [c.workspaceId, c.applicationId]);
    expect(persisted.rows[0]?.state).toBe('stopped');
    const events = await f.admin.query<{ event_kind: string; count: number }>('SELECT event_kind,count(*)::int AS count FROM gotchu.notification_events WHERE organization_id=$1 GROUP BY event_kind', [c.workspaceId]);
    expect(events.rows).toEqual([{ event_kind: 'monitoring_stopped', count: 1 }]);
    const deliveries = await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.notification_deliveries WHERE organization_id=$1', [c.workspaceId]);
    expect(deliveries.rows[0]?.count).toBe(1);
  });

  it('blocks webhook destinations that resolve to private addresses', async () => {
    const resolver = createPublicHttpsDestinationResolver({ lookup: async () => [
      { address: '203.0.113.10', family: 4 }, { address: '169.254.169.254', family: 4 },
    ] });
    await expect(resolver.resolve('https://attacker.example/hook')).rejects.toThrow('webhook_nonpublic_dns');
  });
});
