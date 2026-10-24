import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl, present } from '../../database/test/support.js';
import { createBackend, enqueue, signEventBody, type EventIntakeInput } from '../src/index.js';
const live = liveUrl ? describe : describe.skip;
live('real Postgres signed intake, outbox, and membership', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let intake: ReturnType<typeof createBackend>;
  let coordinator: ReturnType<typeof createBackend>;
  let web: ReturnType<typeof createBackend>;
  const secret = randomBytes(32);
  beforeAll(async () => {
    f = await fixture({ max: 4 });
    intake = createBackend({ database: f.databases.gotchu_ingest, credentials: { getSigningSecret: async () => secret } });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    web = createBackend({ database: f.databases.gotchu_api });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  function event(id: string = randomUUID()) { return { id, type: 'auth.login_failed', source: 'application', occurredAt: new Date().toISOString(), outcome: 'failure', attributes: { route: '/login' } }; }
  function signed(events = [event()], applicationId = f.a.applicationId): EventIntakeInput {
    const rawBody = Buffer.from(JSON.stringify({ applicationId, events }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { integrationId: f.a.integrationId, timestamp, rawBody, signature: signEventBody(secret, f.a.integrationId, timestamp, rawBody) };
  }
  it('commits accepted events, jobs, and outbox atomically; deduplicates concurrent retries', async () => {
    const input = signed();
    const results = await Promise.all([intake.events.ingest(input), intake.events.ingest(input)]);
    expect(results.map(r => r.accepted).sort()).toEqual([0, 1]);
    expect(results.map(r => r.duplicates).sort()).toEqual([0, 1]);
    const accepted = present(results.find(r => r.jobId));
    const persisted = await f.admin.query('SELECT (SELECT count(*)::int FROM gotchu.events WHERE job_id=$1) AS events,(SELECT count(*)::int FROM gotchu.outbox WHERE job_id=$1) AS outbox,(SELECT count(*)::int FROM gotchu.jobs WHERE id=$1) AS jobs', [accepted.jobId]);
    expect(persisted.rows[0]).toEqual({ events: 1, outbox: 1, jobs: 1 });
  });
  it('deduplicates UUID spellings without changing identity', async () => {
    const original = event();
    await intake.events.ingest(signed([original]));
    expect(await intake.events.ingest(signed([{ ...original, id: original.id.toUpperCase() }]))).toMatchObject({ accepted: 0, duplicates: 1 });
  });
  it('rejects forged, expired, wrong-application and changed-content replay batches', async () => {
    const original = event();
    const input = signed([original]);
    await intake.events.ingest(input);
    await expect(intake.events.ingest({ ...input, signature: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(intake.events.ingest({ ...input, timestamp: '1000000000' })).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(intake.events.ingest(signed([{ ...event(), source: 'cloudflare' }]))).rejects.toMatchObject({ code: 'source_mismatch' });
    await expect(intake.events.ingest(signed([event()], f.b.applicationId))).rejects.toMatchObject({ code: 'application_mismatch' });
    const added = event();
    await expect(intake.events.ingest(signed([added, { ...original, outcome: 'success' }]))).rejects.toMatchObject({ code: 'replay_conflict' });
    expect((await f.admin.query('SELECT 1 FROM gotchu.events WHERE id=$1', [added.id])).rowCount).toBe(0);
    await expect(intake.events.ingest(signed([original, { ...original, outcome: 'success' }]))).rejects.toMatchObject({ code: 'replay_conflict' });
  });
  it('rolls back pre-created job/outbox when event persistence fails; never acknowledges', async () => {
    const failed = event();
    const before = (await f.admin.query('SELECT count(*)::int AS count FROM gotchu.jobs WHERE organization_id=$1', [f.a.organizationId])).rows[0].count;
    // Inject a real SQL failure after the job/outbox inserts, rather than mocking a transaction.
    await f.admin.query(`ALTER TABLE gotchu.events ADD CONSTRAINT injected_test_failure CHECK (id <> '${failed.id}'::uuid)`);
    try { await expect(intake.events.ingest(signed([failed]))).rejects.toMatchObject({ code: '23514' }); }
    finally { await f.admin.query('ALTER TABLE gotchu.events DROP CONSTRAINT injected_test_failure'); }
    const after = (await f.admin.query('SELECT count(*)::int AS count FROM gotchu.jobs WHERE organization_id=$1', [f.a.organizationId])).rows[0].count;
    expect(after).toBe(before);
    expect((await f.admin.query('SELECT 1 FROM gotchu.events WHERE id=$1', [failed.id])).rowCount).toBe(0);
    await expect(f.databases.gotchu_coordinator.tenant(f.a.organizationId, async tx => { await enqueue(tx, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, id: randomUUID(), kind: 'audit', idempotencyKey: randomUUID() }); throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await f.admin.query('SELECT count(*)::int AS count FROM gotchu.jobs WHERE organization_id=$1', [f.a.organizationId])).rows[0].count).toBe(before);
  });
  it('leases outbox rows once, fences expired owners, and tolerates repeated job delivery', async () => {
    const accepted = await intake.events.ingest(signed());
    const [a, b] = await Promise.all([coordinator.outbox.claim({ organizationId: f.a.organizationId }), coordinator.outbox.claim({ organizationId: f.a.organizationId })]);
    expect(new Set([...a, ...b].map(r => r.id)).size).toBe(a.length + b.length);
    const claim = present([...a, ...b].find(row => row.envelope.id === accepted.jobId));
    expect(claim).toBeDefined();
    await f.admin.query("UPDATE gotchu.outbox SET lease_until=now()-interval '1 second' WHERE organization_id=$1 AND id=$2", [f.a.organizationId, claim.id]);
    const retry = present((await coordinator.outbox.claim({ organizationId: f.a.organizationId })).find(row => row.id === claim.id));
    expect(retry.leaseToken).not.toBe(claim.leaseToken);
    await expect(coordinator.outbox.delivered({ organizationId: f.a.organizationId, id: claim.id, leaseToken: claim.leaseToken })).rejects.toMatchObject({ code: 'stale_lease' });
    await coordinator.outbox.delivered({ organizationId: f.a.organizationId, id: retry.id, leaseToken: retry.leaseToken });
    const claims = await Promise.all([coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId: present(accepted.jobId) }), coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId: present(accepted.jobId) })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = present(claims.find(Boolean));
    await f.admin.query("UPDATE gotchu.jobs SET lease_until=now()-interval '1 second' WHERE organization_id=$1 AND id=$2", [f.a.organizationId, accepted.jobId]);
    const newer = await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId: present(accepted.jobId) });
    await expect(coordinator.jobs.complete({ organizationId: f.a.organizationId, jobId: present(accepted.jobId), leaseToken: job.leaseToken })).rejects.toMatchObject({ code: 'stale_lease' });
    await coordinator.jobs.complete({ organizationId: f.a.organizationId, jobId: present(accepted.jobId), leaseToken: present(newer).leaseToken });
    expect(await coordinator.jobs.claim({ organizationId: f.a.organizationId, jobId: present(accepted.jobId) })).toBeNull();
  });
  it('authorizes the trusted user on every request and keeps unavailable coverage explicit', async () => {
    const identity = { userId: f.a.userId };
    const queued = await web.web.queueAudit(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, idempotencyKey: 'same-request' });
    expect(await web.web.queueAudit(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, idempotencyKey: 'same-request' })).toEqual(queued);
    expect(await web.web.getJob(identity, { organizationId: f.a.organizationId, jobId: queued.jobId })).toMatchObject({ state: 'queued', id: queued.jobId });
    await expect(web.web.getJob(identity, { organizationId: f.b.organizationId, jobId: queued.jobId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(web.web.queueAudit(identity, { organizationId: f.a.organizationId, applicationId: f.b.applicationId, idempotencyKey: 'wrong-app' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await web.web.getCoverage(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId })).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'customer_code_execution', state: 'unsupported' })]));
    await f.admin.query("UPDATE gotchu.memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [f.a.organizationId, f.a.userId]);
    await expect(web.web.queueAudit(identity, { organizationId: f.a.organizationId, applicationId: f.a.applicationId, idempotencyKey: 'viewer' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
