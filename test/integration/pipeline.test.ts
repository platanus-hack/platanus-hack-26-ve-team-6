import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { encode } from '@auth/core/jwt';
import { exportPKCS8, generateKeyPair } from 'jose';
import { z } from 'zod';
import { createBackend, enqueue, modelConfigurationFingerprint, signEventBody, type JobClaim } from '@gotchu/backend';
import { createDatabase, provisionRuntimeLogin, type Database } from '@gotchu/database';
import { investigationResultSchema, safeCheckpointSchema } from '@gotchu/agent';
import { createCoordinatorTransport, createHttpInvestigator, dispatchOutbox, ensureQueueDelivery, finalizeInvestigation, processDurableJob, reconcileDurableDeliveries, type CoordinatorDependencies } from '@gotchu/coordinator';
import { createGatewayService, startGatewayServer } from '@gotchu/gateway';
import { migrateGateway } from '@gotchu/gateway/migrate';
import { createInvestigationWorkerService, createWorkerHttpServer, listenWorkerServer } from '@gotchu/worker';
import { sendEventBatch } from '@gotchu/sdk';
import type { JobEnvelope, SecurityEvent } from '../../packages/contracts/src/index.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';
import { createAuthService } from '../../apps/web/src/server/auth.js';
import { createBackendApi } from '../../apps/web/src/server/runtime.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const queuedResult = z.object({ accepted: z.number(), duplicates: z.number(), jobId: z.uuid().nullable() }).strict();
const delayedResult = investigationResultSchema.parse({
  status: 'delayed', assessment: 'inconclusive', summary: 'Fixture result for atomic ledger checks.',
  citedEvidenceIds: [], reasonCode: 'model_unavailable', independentVerification: 'not_verified',
  hypotheses: [], candidateSuggestion: null,
  counters: { modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0, activeMs: 0 },
} satisfies z.input<typeof investigationResultSchema>);

async function waitFor(check: () => Promise<boolean>, description: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) { if (await check()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${description}`);
}

live('signed intake through durable delivery and isolated HTTP investigation', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let coordinator: ReturnType<typeof createBackend>;
  let dependencies: CoordinatorDependencies;
  let api: ReturnType<typeof createBackendApi>;
  let secret: Buffer;
  let cookie: string;
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let gatewayDatabase: Database | undefined;
  let gatewayUsername: string | undefined;
  let workerServer: Server | undefined;
  const transportErrors: Error[] = [];
  const resources: Array<{ queue: Queue<JobEnvelope>; clients: Redis[]; workers: Worker[] }> = [];

  beforeEach(async () => {
    f = await fixture({ max: 6 });
    await migrateGateway({ connectionString: present(liveUrl) });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    secret = randomBytes(32);
    const intake = createBackend({ database: f.databases.gotchu_ingest, credentials: { getSigningSecret: async (reference) => {
      if (reference !== `test:${f.a.integrationId}`) throw new Error('Unknown fixture credential');
      return secret;
    } } });
    const authSecret = randomBytes(32).toString('hex');
    const auth = createAuthService({ origin, secret: authSecret, githubClientId: 'fixture-only', githubClientSecret: 'fixture-only' });
    const token = await encode({ secret: authSecret, salt: 'authjs.session-token', token: { sub: f.a.userId } });
    cookie = `authjs.session-token=${token}`;
    api = createBackendApi({ origin, auth, intake, web: createBackend({ database: f.databases.gotchu_api }) });
    const keys = await generateKeyPair('EdDSA', { extractable: true });
    gatewayUsername = `gateway_pipeline_${randomBytes(6).toString('hex')}`;
    const gatewayPassword = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString: present(liveUrl), username: gatewayUsername, password: gatewayPassword, role: 'gotchu_coordinator' });
    const url = new URL(present(liveUrl)); url.username = gatewayUsername; url.password = gatewayPassword;
    gatewayDatabase = createDatabase({ connectionString: url.toString(), role: 'gotchu_coordinator', max: 4 });
    gateway = await startGatewayServer({ service: createGatewayService({ database: gatewayDatabase, capabilityPublicKey: keys.publicKey }), host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' } });
    const config = { host: '127.0.0.1', port: 0, nodeEnv: 'test' as const, capabilityPublicKey: keys.publicKey, gatewayBaseUrl: new URL(`http://127.0.0.1:${gateway.port}`) };
    workerServer = createWorkerHttpServer({ config, service: createInvestigationWorkerService(config) });
    await listenWorkerServer(workerServer, config);
    const address = workerServer.address();
    if (!address || typeof address === 'string') throw new Error('Worker did not bind a loopback port');
    const investigator = await createHttpInvestigator({ workerUrl: `http://127.0.0.1:${address.port}`, privateKeyPem: await exportPKCS8(keys.privateKey), allowLoopbackHttp: true });
    dependencies = { database: f.databases.gotchu_coordinator, backend: coordinator, investigator };
  });

  afterEach(async () => {
    for (const item of resources.splice(0)) {
      await Promise.all(item.workers.map((worker) => worker.close()));
      await item.queue.obliterate({ force: true });
      await item.queue.close();
      await Promise.all(item.clients.map((client) => client.quit()));
    }
    if (workerServer) { const server = workerServer; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); workerServer = undefined; }
    await gateway?.close(); gateway = undefined;
    await gatewayDatabase?.close(); gatewayDatabase = undefined;
    if (f) { if (gatewayUsername) await f.admin.query(`DROP ROLE ${gatewayUsername}`); gatewayUsername = undefined; await f.close(); }
    expect(transportErrors.splice(0)).toEqual([]);
  });

  function events(count: number, accountId = 'CaseSensitiveOperator'): SecurityEvent[] {
    const occurredAt = new Date(Math.floor(Date.now() / 600_000) * 600_000 + 1000).toISOString();
    return Array.from({ length: count }, () => ({ id: randomUUID(), type: 'auth.login_failed', source: 'application', occurredAt, outcome: 'failure', actor: { accountId }, attributes: {} }));
  }

  async function ingest(batch: SecurityEvent[]) {
    return queuedResult.parse(await sendEventBatch({ baseUrl: origin, integrationId: f.a.integrationId, secret, batch: { applicationId: f.a.applicationId, events: batch } }, {
      fetch: async (input, init) => api(new Request(input, init)),
    }));
  }

  async function newQueue() {
    const connection = new Redis(present(redisUrl), { maxRetriesPerRequest: null });
    connection.on('error', (error) => transportErrors.push(error));
    await connection.ping();
    const queue = new Queue<JobEnvelope>(`gotchu-test-${randomUUID()}`, { connection });
    const workers: Worker[] = [];
    const item = { queue, clients: [connection], workers };
    resources.push(item);
    return item;
  }

  async function startConsumer(item: Awaited<ReturnType<typeof newQueue>>, processor: (data: unknown) => Promise<unknown> = (data) => processDurableJob(dependencies, data)) {
    const connection = new Redis(present(redisUrl), { maxRetriesPerRequest: null });
    connection.on('error', (error) => transportErrors.push(error));
    item.clients.push(connection);
    const worker = new Worker(item.queue.name, async (job) => processor(job.data), { connection, concurrency: 2 });
    worker.on('error', (error) => transportErrors.push(error));
    item.workers.push(worker);
    await worker.waitUntilReady();
    return worker;
  }

  async function state(jobId: string) {
    return f.databases.gotchu_coordinator.tenant(f.a.organizationId, async (tx) => {
      const result = await tx.query<{ state: string }>('SELECT state FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [f.a.organizationId, jobId]);
      return result.rows[0]?.state;
    });
  }

  it('groups failures across batches, records deterministic review without a model, and keeps tenant reads isolated', async () => {
    const a = await ingest(events(3)); const b = await ingest(events(2));
    const item = await newQueue(); await startConsumer(item);
    await dispatchOutbox(coordinator, f.a.organizationId, (envelope) => ensureQueueDelivery(item.queue, envelope));
    await waitFor(async () => await state(present(a.jobId)) === 'succeeded' && await state(present(b.jobId)) === 'succeeded', 'durable event processing');
    const incidents = await f.admin.query<{ id: string; evidence: unknown }>('SELECT id,evidence FROM gotchu.incidents WHERE organization_id=$1', [f.a.organizationId]);
    expect(incidents.rowCount).toBe(1);
    await dispatchOutbox(coordinator, f.a.organizationId, (envelope) => ensureQueueDelivery(item.queue, envelope));
    const investigation = present((await f.admin.query<{ id: string }>("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND kind='investigation'", [f.a.organizationId])).rows[0]);
    await waitFor(async () => await state(investigation.id) === 'succeeded', 'HTTP LangGraph investigation completion');
    const jobResponse = await api(new Request(`${origin}/api/v1/organizations/${f.a.organizationId}/jobs/${investigation.id}`, { headers: { cookie } }));
    expect(jobResponse.status).toBe(200);
    expect(await jobResponse.json()).toMatchObject({ outcome: 'inconclusive', reasonCode: 'model_not_configured' });
    const run = present((await f.admin.query<{ state: string; checkpoint: unknown; model_calls: number; spent_micros: string }>('SELECT state,checkpoint,model_calls,spent_micros FROM gotchu.agent_runs WHERE organization_id=$1', [f.a.organizationId])).rows[0]);
    expect(run.state).toBe('succeeded'); expect(run.model_calls).toBe(0); expect(run.spent_micros).toBe('0');
    expect(run.checkpoint).not.toBeNull();
    const denied = await api(new Request(`${origin}/api/v1/organizations/${f.b.organizationId}/applications`, { headers: { cookie, 'x-user-id': f.b.userId } }));
    expect(denied.status).toBe(403);
    const approval = await api(new Request(`${origin}/api/v1/organizations/${f.a.organizationId}/proposals/${randomUUID()}/approvals`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ actionHash: 'a'.repeat(64) }) }));
    // Provider writes stay frozen, so no approval can be recorded for an unknown proposal.
    expect(approval.status).toBe(409);
    expect(await approval.json()).toMatchObject({ error: { code: 'writes_frozen' } });
  });

  it.each(['outbox', 'reconciliation'] as const)('keeps deterministic delivery independent of two blocked investigations via %s', async (delivery) => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0; let started = 0; let finished = 0; let peakActive = 0;
    // Only the slow investigation port/result is a fixture. Postgres, signed intake,
    // outbox, BullMQ workers and durable completion use the production paths.
    const transport = createCoordinatorTransport({
      redisUrl: present(redisUrl), prefix: `gotchu-lanes-${randomUUID()}`, organizationIds: [f.a.organizationId],
      dependencies: { ...dependencies, investigator: { investigate: async () => {
        started++; active++; peakActive = Math.max(peakActive, active);
        try { await blocked; return delayedResult; }
        finally { active--; finished++; }
      } } },
      report: (event, error) => transportErrors.push(new Error(event, { cause: error })),
    });
    try {
      await transport.waitUntilReady();
      // A stopped old coordinator can leave already-delivered intent in its old queue.
      const legacy = delivery === 'reconciliation' ? await newQueue() : undefined;
      async function deliver() {
        await dispatchOutbox(coordinator, f.a.organizationId, legacy
          ? (envelope) => ensureQueueDelivery(legacy.queue, envelope)
          : transport.publish);
        if (legacy) await reconcileDurableDeliveries(f.databases.gotchu_coordinator, f.a.organizationId, transport.publish);
      }
      const investigationIds = [randomUUID(), randomUUID(), randomUUID()];
      await f.databases.gotchu_coordinator.tenant(f.a.organizationId, async (tx) => {
        for (const id of investigationIds) await enqueue(tx, {
          organizationId: f.a.organizationId, applicationId: f.a.applicationId, id, kind: 'investigation',
          idempotencyKey: id, payload: { incidentId: randomUUID(), evidenceIds: [randomUUID()] },
        });
      });
      await deliver();
      await waitFor(async () => active === 2, 'both investigation ports to enter the blocking fixture');

      const accepted = await ingest(events(1, 'monitoring-while-investigating'));
      expect(accepted.accepted).toBe(1);
      const eventId = present(accepted.jobId);
      await deliver();
      await waitFor(async () => await state(eventId) === 'succeeded'
        && await (await transport.queues.deterministic.getJob(eventId))?.getState() === 'completed', 'independent event completion');

      expect({ active, started, finished, peakActive }).toEqual({ active: 2, started: 2, finished: 0, peakActive: 2 });
      expect(await transport.queues.investigation.getActiveCount()).toBe(2);
      expect(await transport.queues.investigation.getWaitingCount()).toBe(1);
      expect((await Promise.all(investigationIds.map(state))).sort()).toEqual(['queued', 'running', 'running']);
      expect(await transport.queues.investigation.getJob(eventId)).toBeUndefined();
      for (const id of investigationIds) expect(await transport.queues.deterministic.getJob(id)).toBeUndefined();
      expect((await f.admin.query('SELECT id FROM gotchu.outbox WHERE organization_id=$1 AND delivered_at IS NOT NULL', [f.a.organizationId])).rowCount).toBe(4);

      release?.();
      await waitFor(async () => (await Promise.all(investigationIds.map(state))).every((value) => value === 'succeeded'), 'released investigations to finish');
      expect({ active, started, finished, peakActive }).toEqual({ active: 0, started: 3, finished: 3, peakActive: 2 });
    } finally {
      release?.();
      await transport.close();
    }
  });

  it.each(['missing', 'completed', 'failed'] as const)('recovers delivered Postgres intent when Redis transport is %s', async (transportState) => {
    const accepted = await ingest(events(1, transportState)); const jobId = present(accepted.jobId);
    const item = await newQueue();
    let fake: Worker | undefined;
    if (transportState !== 'missing') fake = await startConsumer(item, async () => { if (transportState === 'failed') throw new Error('Injected transport failure'); return {}; });
    // A one-attempt fake transport consumer models Redis finishing ahead of restored Postgres.
    await dispatchOutbox(coordinator, f.a.organizationId, async (envelope) => {
      await item.queue.add(envelope.kind, envelope, { jobId: envelope.id, attempts: 1 });
    });
    const delivered = present(await item.queue.getJob(jobId));
    if (transportState === 'missing') await delivered.remove();
    else await waitFor(async () => await delivered.getState() === transportState, 'transport fixture state');
    if (fake) await fake.close();
    expect(await state(jobId)).toBe('queued');
    await reconcileDurableDeliveries(f.databases.gotchu_coordinator, f.a.organizationId, (envelope) => ensureQueueDelivery(item.queue, envelope));
    await startConsumer(item);
    await waitFor(async () => await state(jobId) === 'succeeded', 'recovered delivery');
    expect((await f.admin.query('SELECT delivered_at FROM gotchu.outbox WHERE organization_id=$1 AND job_id=$2 AND delivered_at IS NOT NULL', [f.a.organizationId, jobId])).rowCount).toBe(1);
  });

  it('reserves event reconciliation capacity behind a full investigation backlog', async () => {
    await f.databases.gotchu_coordinator.tenant(f.a.organizationId, async (tx) => {
      for (let index = 0; index < 101; index++) {
        const id = randomUUID();
        await enqueue(tx, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, id, kind: 'investigation', idempotencyKey: id });
      }
    });
    const accepted = await ingest(events(1, 'recovery-behind-backlog'));
    const published: JobEnvelope[] = [];
    await reconcileDurableDeliveries(f.databases.gotchu_coordinator, f.a.organizationId, async (envelope) => { published.push(envelope); });
    expect(published[0]).toMatchObject({ id: accepted.jobId, kind: 'events.aggregate' });
    expect(published.filter((envelope) => envelope.kind === 'investigation')).toHaveLength(100);
  });

  it('accepts canonical UUID-equivalent queue identities and rejects mismatched durable intent', async () => {
    const accepted = await ingest(events(1)); const jobId = present(accepted.jobId);
    await expect(processDurableJob(dependencies, { version: 1, id: jobId.toUpperCase(), organizationId: f.a.organizationId.toUpperCase(), applicationId: f.a.applicationId.toUpperCase(), kind: 'events.aggregate' })).resolves.toMatchObject({ status: 'processed' });
    await expect(processDurableJob(dependencies, { version: 1, id: jobId, organizationId: f.a.organizationId, applicationId: f.b.applicationId, kind: 'events.aggregate' })).rejects.toMatchObject({ code: 'job_scope_mismatch' });
  });

  it('rejects signed year-zero input before persisting either events or job intent', async () => {
    const body = JSON.stringify({ applicationId: f.a.applicationId, events: [{ ...present(events(1)[0]), occurredAt: '0000-01-01T00:00:00Z' }] });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await api(new Request(`${origin}/api/v1/events`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'X-Gotchu-Integration': f.a.integrationId, 'X-Gotchu-Timestamp': timestamp,
        'X-Gotchu-Signature': signEventBody(secret, f.a.integrationId, timestamp, Buffer.from(body)) },
    }));
    expect(response.status).toBe(400);
    expect((await f.admin.query('SELECT id FROM gotchu.events WHERE organization_id=$1', [f.a.organizationId])).rowCount).toBe(0);
    expect((await f.admin.query('SELECT id FROM gotchu.jobs WHERE organization_id=$1', [f.a.organizationId])).rowCount).toBe(0);
  });

  it('quarantines legacy incompatible timestamps while later batches still produce incidents', async () => {
    const legacy = await ingest(events(1, 'legacy'));
    // Fault fixture represents input accepted by the earlier ISO-only contract.
    await f.admin.query(`UPDATE gotchu.events SET payload=jsonb_set(payload,'{occurredAt}','"0000-01-01T00:00:00Z"'::jsonb) WHERE organization_id=$1`, [f.a.organizationId]);
    const envelope = (id: string): JobEnvelope => ({ version: 1, id, organizationId: f.a.organizationId, applicationId: f.a.applicationId, kind: 'events.aggregate' });
    await processDurableJob(dependencies, envelope(present(legacy.jobId)));
    expect(await state(present(legacy.jobId))).toBe('succeeded');
    const fresh = await ingest(events(5));
    await processDurableJob(dependencies, envelope(present(fresh.jobId)));
    expect((await f.admin.query('SELECT id FROM gotchu.incidents WHERE organization_id=$1', [f.a.organizationId])).rowCount).toBe(1);
    expect((await f.admin.query('SELECT id FROM gotchu.events WHERE organization_id=$1', [f.a.organizationId])).rowCount).toBe(6);
    const coverage = await f.admin.query<{ state: string; reason: string }>('SELECT state,reason FROM gotchu.coverage WHERE organization_id=$1 AND capability=\'login_failure_detection\'', [f.a.organizationId]);
    expect(coverage.rows[0]).toMatchObject({ state: 'degraded', reason: expect.stringContaining('quarantined') });
  });

  async function newRun() {
    const jobId = randomUUID();
    await f.databases.gotchu_coordinator.tenant(f.a.organizationId, (tx) => enqueue(tx, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, id: jobId, kind: 'investigation', idempotencyKey: randomUUID(), payload: { incidentId: randomUUID(), evidenceIds: [randomUUID()] } }));
    const claim = present(await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId, leaseMs: 300_000 }));
    const run = await coordinator.runs.start({ organizationId: f.a.organizationId, applicationId: f.a.applicationId, jobId, leaseToken: claim.leaseToken });
    return { claim, run };
  }

  it('rolls back run finalization when job completion fails and fences stale consumers', async () => {
    const { claim, run } = await newRun();
    const database: Database = { ...f.databases.gotchu_coordinator, tenant: (organizationId, work) => f.databases.gotchu_coordinator.tenant(organizationId, (tx) => work({
      query: async <R extends QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) => {
        if (text.startsWith("UPDATE gotchu.jobs SET state='succeeded'")) throw new Error('Injected final job write failure');
        return tx.query<R>(text, values);
      },
    })) };
    await expect(finalizeInvestigation({ ...dependencies, database }, claim, run.runId, { status: 'result', result: delayedResult })).rejects.toThrow('Injected');
    expect((await coordinator.runs.load({ organizationId: f.a.organizationId, runId: run.runId })).state).toBe('running');
    expect(await state(claim.envelope.id)).toBe('running');
    const stale: JobClaim = { ...claim, leaseToken: randomUUID() };
    await expect(finalizeInvestigation(dependencies, stale, run.runId, { status: 'result', result: delayedResult })).rejects.toMatchObject({ code: 'stale_lease' });
    expect((await coordinator.runs.load({ organizationId: f.a.organizationId, runId: run.runId })).state).toBe('running');
    await finalizeInvestigation(dependencies, claim, run.runId, { status: 'result', result: delayedResult });
    expect(await state(claim.envelope.id)).toBe('succeeded');
    expect((await coordinator.runs.load({ organizationId: f.a.organizationId, runId: run.runId })).state).toBe('unavailable');
  });

  it('holds unknown provider reservations for reconciliation instead of redelivering model work', async () => {
    const { claim, run } = await newRun();
    const configuration = { provider: 'openai_compatible' as const, providerPresetId: 'custom_openai_compatible' as const, endpoint: 'http://localhost:11434/v1', modelId: 'fixture-model',
      secretRef: null, consentToExternalProcessing: true, dataScopes: ['runtime_summaries' as const],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0 };
    await f.admin.query('UPDATE gotchu.organizations SET model_opt_in=true,model_budget_micros=100,model_token_budget=1000 WHERE id=$1', [f.a.organizationId]);
    await f.admin.query(`INSERT INTO gotchu.investigation_model_settings(organization_id,provider,endpoint,model_id,consent_to_external_processing,data_scopes,input_price_micro_usd_per_million_tokens,output_price_micro_usd_per_million_tokens,updated_by,provider_preset_id)
      VALUES($1,$2,$3,$4,true,'["runtime_summaries"]'::jsonb,0,0,$5,$6)`, [f.a.organizationId, configuration.provider, configuration.endpoint, configuration.modelId, f.a.userId, configuration.providerPresetId]);
    await coordinator.runs.reserveModel({ organizationId: f.a.organizationId, runId: run.runId, reservationId: randomUUID(), maxCostMicros: 10,
      reserveTokens: 100, requestSha256: 'a'.repeat(64), configSha256: modelConfigurationFingerprint(configuration),
      provider: configuration.provider, modelId: configuration.modelId });
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [f.a.organizationId, claim.envelope.id]);
    const published: JobEnvelope[] = [];
    await reconcileDurableDeliveries(f.databases.gotchu_coordinator, f.a.organizationId, async (envelope) => { published.push(envelope); });
    expect(published).toHaveLength(0); expect(await state(claim.envelope.id)).toBe('failed');
    expect((await f.admin.query<{ amount: string }>('SELECT model_reserved_micros AS amount FROM gotchu.organizations WHERE id=$1', [f.a.organizationId])).rows[0]?.amount).toBe('10');
  });

  it('recovers a saved terminal checkpoint after the coordinator crashes before finalization', async () => {
    const { claim, run } = await newRun();
    const checkpoint = safeCheckpointSchema.parse({ version: 1, scope: { organizationId: f.a.organizationId, applicationId: f.a.applicationId, runId: run.runId },
      sequence: 1, stage: 'delayed', modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0, result: delayedResult });
    await coordinator.runs.checkpoint({ organizationId: f.a.organizationId, runId: run.runId, expectedVersion: 0, checkpoint });
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [f.a.organizationId, claim.envelope.id]);
    await f.admin.query("UPDATE gotchu.agent_runs SET deadline=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND id=$2", [f.a.organizationId, run.runId]);
    let calls = 0;
    await processDurableJob({ ...dependencies, investigator: { investigate: async () => { calls++; throw new Error('Saved terminal work must not execute again'); } } }, claim.envelope);
    expect(calls).toBe(0);
    expect(await state(claim.envelope.id)).toBe('succeeded');
    expect((await coordinator.runs.load({ organizationId: f.a.organizationId, runId: run.runId })).state).toBe('unavailable');
    const job = await createBackend({ database: f.databases.gotchu_api }).web.getJob({ userId: f.a.userId }, { organizationId: f.a.organizationId, jobId: claim.envelope.id });
    expect(job).toMatchObject({ outcome: 'delayed', reasonCode: 'model_unavailable' });
  });

  it('serializes concurrent aggregation so an older five-event snapshot cannot overwrite ten', async () => {
    const first = await ingest(events(5, 'concurrent')); let release: (() => void) | undefined;
    let read: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const hasRead = new Promise<void>((resolve) => { read = resolve; });
    let intercept = true;
    const database: Database = { ...f.databases.gotchu_coordinator, tenant: (organizationId, work) => f.databases.gotchu_coordinator.tenant(organizationId, (tx) => work({
      query: async <R extends QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) => {
        const result = await tx.query<R>(text, values);
        if (intercept && text.includes('ORDER BY received_at,id LIMIT')) { intercept = false; read?.(); await paused; }
        return result;
      },
    })) };
    const envelope = (id: string): JobEnvelope => ({ version: 1, id, organizationId: f.a.organizationId, applicationId: f.a.applicationId, kind: 'events.aggregate' });
    const a = processDurableJob({ ...dependencies, database }, envelope(present(first.jobId)));
    try {
      await hasRead;
      const second = await ingest(events(5, 'concurrent'));
      const b = processDurableJob(dependencies, envelope(present(second.jobId)));
      await Promise.race([b, delay(200)]);
      release?.(); await Promise.all([a, b]);
    } finally { release?.(); }
    const rows = await f.admin.query<{ summary: string }>('SELECT summary FROM gotchu.incidents WHERE organization_id=$1', [f.a.organizationId]);
    expect(rows.rowCount).toBe(1); expect(rows.rows[0]?.summary).toContain('10 failed login attempts');
  });
});
