import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, importSPKI } from 'jose';
import { z } from 'zod';
import { safeCheckpointSchema, type RunCapabilityClaims, type RunScope } from '@gotchu/agent';
import { createBackend, enqueue, signEventBody } from '@gotchu/backend';
import { createDatabase, provisionRuntimeLogin, type Database } from '@gotchu/database';
import { createGatewayHttpAdapters, createInvestigationWorkerService, createWorkerHttpServer, listenWorkerServer } from '@gotchu/worker';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';
import { migrateGateway } from '../src/migrate.js';
import { createGatewayService, requiredEvidenceCallId, revokeRunCapability } from '../src/service.js';
import { startGatewayServer } from '../src/http.js';
import { startGateway } from '../src/runtime.js';

const live = liveUrl ? describe : describe.skip;
const keys = generateKeyPairSync('ed25519');
const publicKey = await importSPKI(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
const sensitiveText = 'private-value-must-never-leave-gateway';
type Run = { scope: RunScope; jobId: string; incidentId: string; evidenceIds: string[]; token: string; jti: string; deadline: Date };

live('gateway with real signed intake, Postgres, HTTP worker and LangGraph', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let database: Database;
  let coordinator: ReturnType<typeof createBackend>;
  let gateway: Awaited<ReturnType<typeof startGatewayServer>>;
  let origin: string;
  let username: string;
  let runtimeUrl: string;
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    await migrateGateway({ connectionString: present(liveUrl) });
    await migrateGateway({ connectionString: present(liveUrl) });
    username = `gateway_test_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString: present(liveUrl), username, password, role: 'gotchu_coordinator' });
    const url = new URL(present(liveUrl)); url.username = username; url.password = password;
    runtimeUrl = url.toString();
    database = createDatabase({ connectionString: runtimeUrl, role: 'gotchu_coordinator', max: 4 });
    await database.checkHealth();
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    await openGateway();
  }, 30_000);
  afterAll(async () => {
    await gateway?.close();
    await database?.close();
    if (f) {
      if (username) await f.admin.query(`DROP ROLE ${username}`);
      await f.close();
    }
  });
  async function openGateway() {
    gateway = await startGatewayServer({
      service: createGatewayService({ database, capabilityPublicKey: publicKey }),
      host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' },
    });
    origin = `http://127.0.0.1:${gateway.port}`;
  }
  async function sign(run: Omit<Run, 'token'>, overrides: Partial<RunCapabilityClaims> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ...run.scope, sub: run.scope.runId, jti: run.jti,
      iss: 'gotchu-run-capability-issuer', aud: 'gotchu-investigation-worker',
      iat: now, exp: Math.floor(run.deadline.getTime() / 1000),
      allowedReadTools: ['evidence.read', 'auth.events.read'], evidenceIds: run.evidenceIds, ...overrides,
    }).setProtectedHeader({ alg: 'EdDSA' }).sign(keys.privateKey);
  }
  async function newRun(tenant = f.a): Promise<Run> {
    const evidenceIds = Array.from({ length: 5 }, () => randomUUID());
    const secret = randomBytes(32);
    const intake = createBackend({ database: f.databases.gotchu_ingest, credentials: { getSigningSecret: async () => secret } });
    const rawBody = Buffer.from(JSON.stringify({ applicationId: tenant.applicationId, events: evidenceIds.map(id => ({
      id, type: 'auth.login_failed', source: 'application', occurredAt: new Date().toISOString(),
      outcome: 'failure', actor: { accountId: sensitiveText, ip: '192.0.2.1' },
      resource: { type: 'user', id: sensitiveText }, attributes: { detail: sensitiveText },
    })) }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    await intake.events.ingest({ integrationId: tenant.integrationId, timestamp, rawBody, signature: signEventBody(secret, tenant.integrationId, timestamp, rawBody) });
    const jobId = randomUUID(); const incidentId = randomUUID();
    await f.databases.gotchu_coordinator.tenant(tenant.organizationId, async tx => {
      await tx.query("INSERT INTO gotchu.incidents(organization_id,application_id,id,rule_id,dedupe_key,summary,severity,evidence) VALUES ($1,$2,$3,'auth.login_failures.v1.account',$4,$5,'medium',$6::jsonb)", [tenant.organizationId, tenant.applicationId, incidentId, randomUUID(), sensitiveText, JSON.stringify(evidenceIds)]);
      await enqueue(tx, { ...tenant, id: jobId, kind: 'investigation', idempotencyKey: randomUUID(), payload: { incidentId, evidenceIds } });
    });
    const claim = present(await coordinator.jobs.claim({ organizationId: tenant.organizationId, jobId, leaseMs: 300_000 }));
    const started = await coordinator.runs.start({ organizationId: tenant.organizationId, applicationId: tenant.applicationId, jobId, leaseToken: claim.leaseToken });
    const run = { scope: { organizationId: tenant.organizationId, applicationId: tenant.applicationId, runId: started.runId }, jobId, incidentId, evidenceIds, deadline: started.deadline, jti: randomUUID() };
    return { ...run, token: await sign(run) };
  }
  async function call(run: Run, endpoint: string, method = 'POST', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/internal/v1/agent-runs/${run.scope.runId}/${endpoint}`, {
      method, headers: { authorization: `RunCapability ${run.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload, response };
  }
  const scopeBody = (run: Run) => ({ organizationId: run.scope.organizationId, applicationId: run.scope.applicationId });
  function readBody(run: Run, callType: 'additional' | 'required_evidence' = 'additional') {
    const evidenceId = present(run.evidenceIds[0]);
    return { ...scopeBody(run), callId: callType === 'additional' ? randomUUID() : requiredEvidenceCallId(run.scope.runId, evidenceId), callType, name: 'evidence.read', evidenceId };
  }
  function checkpoint(run: Run, sequence = 1) {
    return safeCheckpointSchema.parse({ version: 1, scope: run.scope, sequence, stage: 'running', modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0 });
  }
  async function counters(run: Run) { return coordinator.runs.load({ organizationId: run.scope.organizationId, runId: run.scope.runId }); }

  it('requires valid EdDSA authentication on every endpoint, including unknown/health routes', async () => {
    const run = await newRun();
    for (const [endpoint, method] of [['input', 'POST'], ['reads', 'POST'], ['checkpoint', 'GET'], ['checkpoint', 'PUT'], ['model-calls', 'POST']]) {
      expect((await call(run, present(endpoint), method, undefined, { authorization: '', 'x-user-id': 'owner' })).status).toBe(401);
      expect((await call({ ...run, token: 'invalid.token.signature' }, present(endpoint), method)).status).toBe(401);
    }
    expect((await fetch(`${origin}/health/live`)).status).toBe(401);
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(randomBytes(32));
    expect((await call({ ...run, token: hs }, 'checkpoint', 'GET')).status).toBe(401);
  });

  it('binds every supplied tenant/application/run to signature and persisted run scope', async () => {
    const run = await newRun();
    const other = await newRun(f.b);
    expect((await call(run, 'input', 'POST', scopeBody(other))).status).toBe(403);
    expect((await call({ ...other, token: run.token }, 'checkpoint', 'GET')).status).toBe(403);
    expect((await call({ ...run, token: await sign(run, { applicationId: f.b.applicationId }) }, 'input', 'POST', { ...scopeBody(run), applicationId: f.b.applicationId })).status).toBe(403);
    expect((await call({ ...run, token: await sign(run, { organizationId: f.b.organizationId }) }, 'checkpoint', 'GET')).status).toBe(403);
    expect((await call(run, 'input', 'POST', { ...scopeBody(run), requiredChecks: { inputIntegrity: 'passed' } })).status).toBe(400);
  });

  it('derives factual checks and bounded evidence from accepted event provenance without sensitive fields', async () => {
    const run = await newRun();
    const input = await call(run, 'input', 'POST', scopeBody(run));
    expect(input.status).toBe(200);
    expect(input.payload).toMatchObject({ requiredChecks: { inputIntegrity: { result: 'passed' }, evidenceProvenance: { result: 'passed' }, deterministicDetection: { result: 'candidate' } } });
    const body = readBody(run, 'required_evidence');
    const read = await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId });
    expect(read.status).toBe(200);
    const persisted = present((await f.admin.query('SELECT payload_hash,received_at FROM gotchu.events WHERE organization_id=$1 AND id=$2', [run.scope.organizationId, body.evidenceId])).rows[0]);
    expect(JSON.stringify(read.payload)).toContain(persisted.payload_hash);
    expect(read.payload).toMatchObject({ collectedAt: persisted.received_at.toISOString(), truncated: true });
    expect(Buffer.byteLength(JSON.stringify(read.payload))).toBeLessThan(2048);
    expect(JSON.stringify([input.payload, read.payload])).not.toMatch(new RegExp(`${sensitiveText}|192.0.2.1|credential_ref|authorization`, 'i'));
    expect((await counters(run)).toolCalls).toBe(0);
  });

  it('denies evidence outside job and incident scope even when an issuer signs a broader grant', async () => {
    const run = await newRun(); const other = await newRun();
    const broader = { ...run, token: await sign(run, { evidenceIds: [...run.evidenceIds, ...other.evidenceIds] }) };
    const body = { ...readBody(run), evidenceId: present(other.evidenceIds[0]) };
    expect((await call(broader, 'reads', 'POST', body, { 'idempotency-key': body.callId })).status).toBe(403);
    await f.admin.query('UPDATE gotchu.incidents SET evidence=$2::jsonb WHERE id=$1', [run.incidentId, JSON.stringify(other.evidenceIds)]);
    expect((await call(run, 'input', 'POST', scopeBody(run))).payload).toEqual({ error: { code: 'evidence_unavailable' } });
  });

  it('enforces read-tool permissions and narrow evidence grants without consuming budget', async () => {
    const run = await newRun(); const read = { ...readBody(run), name: 'auth.events.read' };
    const restricted = { ...run, token: await sign(run, { allowedReadTools: ['evidence.read'] }) };
    expect((await call(restricted, 'reads', 'POST', read, { 'idempotency-key': read.callId })).status).toBe(403);
    expect((await counters(run)).toolCalls).toBe(0);
    expect((await call(run, 'reads', 'POST', read, { 'idempotency-key': read.callId })).status).toBe(200);
    const narrow = { ...run, token: await sign(run, { evidenceIds: [present(run.evidenceIds[0])] }) };
    expect((await call(narrow, 'input', 'POST', scopeBody(run))).status).toBe(403);
    const wrongKey = readBody(run);
    expect((await call(run, 'reads', 'POST', wrongKey, { 'idempotency-key': randomUUID() })).status).toBe(400);
    expect((await counters(run)).toolCalls).toBe(1);
  });

  it('requires real persisted provenance and rejects ambiguous event IDs across integrations', async () => {
    const run = await newRun();
    const integrationId = randomUUID();
    await f.admin.query("INSERT INTO gotchu.integrations(organization_id,application_id,id,kind) VALUES ($1,$2,$3,'signed_events')", [run.scope.organizationId, run.scope.applicationId, integrationId]);
    await f.admin.query('INSERT INTO gotchu.events SELECT organization_id,application_id,$3,id,payload,payload_hash,received_at,job_id FROM gotchu.events WHERE organization_id=$1 AND id=$2', [run.scope.organizationId, run.evidenceIds[0], integrationId]);
    expect((await call(run, 'input', 'POST', scopeBody(run))).payload).toEqual({ error: { code: 'evidence_unavailable' } });
  });

  it('replays identical reads durably, rejects changed requests, and charges concurrent retries once', async () => {
    const run = await newRun(); const body = readBody(run);
    const invoke = () => call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId });
    const replies = await Promise.all([invoke(), invoke(), invoke()]);
    expect(replies.map(r => r.status)).toEqual([200, 200, 200]);
    expect(replies[0]?.payload).toEqual(replies[1]?.payload);
    expect((await counters(run)).toolCalls).toBe(1);
    expect((await call(run, 'reads', 'POST', { ...body, name: 'auth.events.read' }, { 'idempotency-key': body.callId })).status).toBe(409);
    await gateway.close(); await openGateway();
    expect((await invoke()).payload).toEqual(replies[0]?.payload);
    expect((await counters(run)).toolCalls).toBe(1);
  });

  it('enforces backend read budgets independently of checkpoint counters and required-read labels', async () => {
    const run = await newRun();
    const arbitraryRequired = { ...readBody(run), callType: 'required_evidence' };
    expect((await call(run, 'reads', 'POST', arbitraryRequired, { 'idempotency-key': arbitraryRequired.callId })).status).toBe(403);
    for (let i = 0; i < 8; i++) {
      const body = readBody(run);
      expect((await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId })).status).toBe(200);
    }
    expect((await call(run, 'checkpoint', 'PUT', { organizationId: run.scope.organizationId, expectedVersion: 0, checkpoint: checkpoint(run) })).status).toBe(200);
    const loaded = await call(run, 'checkpoint', 'GET');
    expect(loaded.payload).toMatchObject({ checkpoint: { additionalReadToolCalls: 8 } });
    const ninth = readBody(run);
    expect((await call(run, 'reads', 'POST', ninth, { 'idempotency-key': ninth.callId })).status).toBe(429);
    expect((await counters(run)).toolCalls).toBe(8);
  });

  it('rolls back the backend budget reservation if the durable read ledger cannot commit', async () => {
    const run = await newRun(); const body = readBody(run);
    await f.admin.query(`ALTER TABLE gotchu.gateway_read_calls ADD CONSTRAINT gateway_test_failure CHECK (call_id <> '${body.callId}'::uuid)`);
    try {
      const response = await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId });
      expect(response).toMatchObject({ status: 500, payload: { error: { code: 'internal_error' } } });
      expect((await counters(run)).toolCalls).toBe(0);
    } finally { await f.admin.query('ALTER TABLE gotchu.gateway_read_calls DROP CONSTRAINT gateway_test_failure'); }
    expect((await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId })).status).toBe(200);
    expect((await counters(run)).toolCalls).toBe(1);
  });

  it('saves sanitized checkpoints with optimistic concurrency and no free text or credentials', async () => {
    const run = await newRun();
    const safe = { ...checkpoint(run), result: { status: 'inconclusive', assessment: 'inconclusive', summary: `${sensitiveText} ${run.token}`,
      citedEvidenceIds: [present(run.evidenceIds[0])], reasonCode: 'model_unavailable',
      counters: { modelCalls: 4, additionalReadToolCalls: 8, tokensUsed: 999999, spendMicroUsd: 999999, activeMs: 12 }, independentVerification: 'not_verified' } };
    const body = { organizationId: run.scope.organizationId, expectedVersion: 0, checkpoint: safe };
    const saves = await Promise.all([call(run, 'checkpoint', 'PUT', body), call(run, 'checkpoint', 'PUT', body)]);
    expect(saves.map(r => r.status).sort()).toEqual([200, 409]);
    const stored = await counters(run);
    expect(stored.checkpointVersion).toBe(1);
    expect(JSON.stringify(stored.checkpoint)).not.toContain(sensitiveText);
    expect(JSON.stringify(stored.checkpoint)).not.toContain(run.token);
    expect(stored.checkpoint).toMatchObject({ modelCalls: 0, result: { counters: { modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0 } } });
    expect((await call(run, 'checkpoint', 'PUT', { ...body, checkpoint: { ...safe, rawEvidence: sensitiveText } })).status).toBe(400);
    expect((await call(run, 'checkpoint', 'PUT', { ...body, checkpoint: { ...safe, scope: { ...run.scope, applicationId: f.b.applicationId } } })).status).toBe(403);
    expect((await call(run, 'checkpoint', 'PUT', { ...body, checkpoint: { ...safe, result: { ...safe.result, citedEvidenceIds: [randomUUID()] } } })).status).toBe(403);
    await gateway.close(); await openGateway();
    expect((await call(run, 'checkpoint', 'GET')).payload).toMatchObject({ version: 1, checkpoint: { sequence: 1 } });
  });

  it('rejects expired, oversized-lifetime, wrong-audience and revoked grants on all operations', async () => {
    const run = await newRun(); const now = Math.floor(Date.now() / 1000);
    for (const overrides of [{ iat: now - 100, exp: now - 1 }, { exp: now + 601 }, { aud: 'wrong-audience' }]) {
      const token = await new SignJWT({ ...run.scope, sub: run.scope.runId, jti: run.jti, iss: 'gotchu-run-capability-issuer', aud: 'gotchu-investigation-worker', iat: now, exp: now + 60, evidenceIds: run.evidenceIds, allowedReadTools: ['evidence.read'], ...overrides }).setProtectedHeader({ alg: 'EdDSA' }).sign(keys.privateKey);
      expect((await call({ ...run, token }, 'checkpoint', 'GET')).status).toBe(401);
    }
    expect((await call({ ...run, token: await sign(run, { exp: now + 500 }) }, 'checkpoint', 'GET')).status).toBe(403);
    await revokeRunCapability(database, { organizationId: run.scope.organizationId, runId: run.scope.runId, jti: run.jti });
    for (const [endpoint, method] of [['input', 'POST'], ['reads', 'POST'], ['checkpoint', 'GET'], ['checkpoint', 'PUT'], ['model-calls', 'POST']]) {
      expect((await call(run, present(endpoint), method, method === 'GET' ? undefined : {})).payload).toEqual({ error: { code: 'capability_revoked' } });
    }
  });

  it('rejects writes on terminal runs and failed jobs but permits scoped terminal checkpoint reads', async () => {
    const run = await newRun();
    await call(run, 'checkpoint', 'PUT', { organizationId: run.scope.organizationId, expectedVersion: 0, checkpoint: checkpoint(run) });
    await coordinator.runs.finish({ organizationId: run.scope.organizationId, runId: run.scope.runId, outcome: 'unavailable' });
    expect((await call(run, 'checkpoint', 'GET')).status).toBe(200);
    expect((await call(run, 'checkpoint', 'PUT', { organizationId: run.scope.organizationId, expectedVersion: 1, checkpoint: checkpoint(run, 2) })).status).toBe(403);
    expect((await call(run, 'input', 'POST', scopeBody(run))).status).toBe(403);
    const failed = await newRun();
    // Simulates the coordinator's uncertain-worker outcome with the run still active.
    await f.admin.query("UPDATE gotchu.jobs SET state='failed' WHERE organization_id=$1 AND id=$2", [failed.scope.organizationId, failed.jobId]);
    expect((await call(failed, 'input', 'POST', scopeBody(failed))).status).toBe(403);
    expect((await call(failed, 'checkpoint', 'GET')).status).toBe(403);
    expect((await call(failed, 'checkpoint', 'PUT', { organizationId: failed.scope.organizationId, expectedVersion: 0, checkpoint: checkpoint(failed) })).status).toBe(403);
  });

  it('checks persisted deadlines and job leases rather than relying only on token validity', async () => {
    const run = await newRun();
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [run.jobId]);
    expect((await call(run, 'input', 'POST', scopeBody(run))).status).toBe(403);
    await f.admin.query("UPDATE gotchu.agent_runs SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [run.scope.runId]);
    expect((await call(run, 'checkpoint', 'GET')).status).toBe(403);
  });

  it('does not extend capability lifetime while waiting for a run lock', async () => {
    const run = await newRun();
    const exp = Math.floor(Date.now() / 1000) + 2;
    const short = { ...run, token: await sign(run, { exp }) };
    await f.admin.query('BEGIN');
    await f.admin.query('SELECT id FROM gotchu.agent_runs WHERE id=$1 FOR UPDATE', [run.scope.runId]);
    const pending = call(short, 'input', 'POST', scopeBody(run));
    try { await delay(2_100); } finally { await f.admin.query('COMMIT'); }
    expect((await pending).status).toBe(401);
  });

  it('explicitly disables model work with zero durable reservations or spend', async () => {
    const run = await newRun(); const reservationId = randomUUID();
    const body = { ...scopeBody(run), reservationId, systemInstruction: sensitiveText, userContext: sensitiveText, maxOutputTokens: 128, remainingTokens: 20_000, remainingSpendMicroUsd: 250_000 };
    for (let i = 0; i < 2; i++) expect((await call(run, 'model-calls', 'POST', body, { 'idempotency-key': reservationId })).payload).toEqual({ error: { code: 'model_not_configured' } });
    expect((await counters(run)).modelCalls).toBe(0);
    expect((await f.admin.query('SELECT 1 FROM gotchu.model_reservations WHERE organization_id=$1 AND run_id=$2', [run.scope.organizationId, run.scope.runId])).rowCount).toBe(0);
    expect(JSON.stringify((await counters(run)).checkpoint)).not.toContain(sensitiveText);
  });

  it('runs the actual HTTP worker and LangGraph against this gateway and Postgres', async () => {
    const run = await newRun();
    const config = { host: '127.0.0.1', port: 0, nodeEnv: 'test' as const, capabilityPublicKey: publicKey, gatewayBaseUrl: new URL(origin) };
    const worker = createWorkerHttpServer({ config, service: createInvestigationWorkerService(config) });
    await listenWorkerServer(worker, config);
    try {
      const address = worker.address();
      if (!address || typeof address === 'string') throw new Error('Worker address missing');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/investigations`, { method: 'POST', headers: { authorization: `RunCapability ${run.token}` }, signal: AbortSignal.timeout(15_000) });
      expect(response.status).toBe(200);
      const output: unknown = await response.json();
      expect(output).toMatchObject({ result: { status: 'delayed', reasonCode: 'model_unavailable', independentVerification: 'not_verified' } });
      expect((await counters(run)).checkpointVersion).toBeGreaterThan(0);
      expect((await counters(run)).modelCalls).toBe(0);
      const adapters = createGatewayHttpAdapters(new URL(origin));
      const loaded = await adapters.persistence.loadCheckpoint(run.scope, run.token, AbortSignal.timeout(2_000));
      expect(safeCheckpointSchema.parse(loaded)).toMatchObject({ stage: 'delayed', modelCalls: 0 });
    } finally { await new Promise<void>((resolve, reject) => { worker.close(error => error ? reject(error) : resolve()); worker.closeAllConnections(); }); }
  }, 20_000);

  it('bounds bodies, forbids browser origins, and rejects unsupported tools explicitly', async () => {
    const run = await newRun();
    expect((await call(run, 'input', 'POST', scopeBody(run), { origin: 'https://attacker.test' })).status).toBe(403);
    expect((await call(run, 'input', 'POST', { padding: 'x'.repeat(33_000) })).status).toBe(413);
    expect((await call(run, 'input', 'POST', {}, { 'content-encoding': 'gzip' })).status).toBe(415);
    const body = { ...readBody(run), name: 'repository.excerpt.read' };
    expect((await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId })).payload).toEqual({ error: { code: 'tool_unavailable' } });
  });

  it('uses a restricted coordinator login, denies runtime owners, and preserves ledger RLS', async () => {
    const run = await newRun(); const body = readBody(run);
    await call(run, 'reads', 'POST', body, { 'idempotency-key': body.callId });
    expect(await database.tenant(f.b.organizationId, async tx => (await tx.query('SELECT 1 FROM gotchu.gateway_read_calls WHERE run_id=$1', [run.scope.runId])).rowCount)).toBe(0);
    await expect(f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.gateway_read_calls'))).rejects.toMatchObject({ code: '42501' });
    await expect(database.tenant(f.a.organizationId, tx => tx.query('SELECT * FROM gotchu.integration_credentials'))).rejects.toMatchObject({ code: '42501' });
    await expect(startGateway({ databaseUrl: present(liveUrl), capabilityPublicKey: publicKey, host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' } })).rejects.toThrow('non-owner');
    await f.admin.query(`GRANT gotchu_owner TO ${username}`);
    try {
      await expect(startGateway({ databaseUrl: runtimeUrl, capabilityPublicKey: publicKey, host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' } })).rejects.toThrow('non-owner');
    } finally { await f.admin.query(`REVOKE gotchu_owner FROM ${username}`); }
    const owner = z.object({ owner: z.literal('gotchu_owner') }).parse(present((await f.admin.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='gotchu.gateway_read_calls'::regclass")).rows[0]));
    expect(owner.owner).toBe('gotchu_owner');
  });
});
