import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend, signEventBody, type WritableEventCredentials } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('customer telemetry onboarding on real PostgreSQL with an injected credential store', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const secrets = new Map<string, Uint8Array>();
  const credentials: WritableEventCredentials = {
    async getSigningSecret(reference) { const secret = secrets.get(reference); if (!secret) throw new Error('missing_key'); return secret; },
    async putSigningSecret(reference, secret) { if (secrets.has(reference)) throw new Error('duplicate'); secrets.set(reference, secret); },
    async deleteSigningSecret(reference) { secrets.delete(reference); },
  };
  let api: ReturnType<typeof createBackend>; let intake: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture(); api = createBackend({ database: f.databases.gotchu_api, eventCredentials: credentials }); intake = createBackend({ database: f.databases.gotchu_ingest, credentials }); });
  afterAll(async () => { secrets.clear(); await f?.close(); });
  const identity = () => ({ userId: f.a.userId });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  async function ingest(id: string, key: string) {
    const rawBody = Buffer.from(JSON.stringify({ applicationId: f.a.applicationId, events: [{ id: randomUUID(), type: 'http.request', source: 'application', occurredAt: new Date().toISOString(), outcome: 'success', attributes: { statusCode: 200, durationMs: 25 } }] }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    return intake.events.ingest({ integrationId: id, timestamp, rawBody, signature: signEventBody(Buffer.from(key, 'base64'), id, timestamp, rawBody) });
  }
  it('accepts actual HMAC intake, rotates without exposing saved keys and disables old admission', async () => {
    const first = await api.telemetry.connect(identity(), scope());
    expect((await ingest(first.integration.id, first.signingKey)).accepted).toBe(1);
    const second = await api.telemetry.connect(identity(), scope());
    await expect(ingest(first.integration.id, first.signingKey)).rejects.toMatchObject({ code: 'invalid_signature' });
    expect((await ingest(second.integration.id, second.signingKey)).accepted).toBe(1);
    const rows = await api.telemetry.list(identity(), scope());
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(first.signingKey);
    await api.telemetry.disable(identity(), { ...scope(), integrationId: second.integration.id });
    await expect(ingest(second.integration.id, second.signingKey)).rejects.toMatchObject({ code: 'invalid_signature' });
  });
  it('enforces membership and exact application binding in service and narrow SQL functions', async () => {
    const actor = { userId: `viewer:${randomUUID()}` };
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'viewer')", [f.a.organizationId, actor.userId]);
    await expect(api.telemetry.connect(actor, scope())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(api.telemetry.list({ userId: f.b.userId }, scope())).rejects.toMatchObject({ code: 'forbidden' });
    const created = await api.telemetry.connect(identity(), scope());
    await expect(api.telemetry.disable(identity(), { ...scope(), applicationId: f.b.applicationId, integrationId: created.integration.id })).rejects.toMatchObject({ code: 'not_found' });
    const id = randomUUID();
    const result = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query<{ allowed: boolean }>('SELECT gotchu.customer_connect_events($1,$2,$3,$4,$5) AS allowed', [f.a.organizationId, f.a.applicationId, 'nonmember', id, `local-event:${id}`]));
    expect(result.rows[0]?.allowed).toBe(false);
  });
  it('rolls back rotation when key storage fails and never removes an uncreated key', async () => {
    const first = await api.telemetry.connect(identity(), scope());
    const remove = vi.fn(async () => {});
    const failing = createBackend({ database: f.databases.gotchu_api, eventCredentials: { ...credentials, putSigningSecret: async () => { throw new Error('injected_store_failure'); }, deleteSigningSecret: remove } });
    await expect(failing.telemetry.connect(identity(), scope())).rejects.toThrow('injected_store_failure');
    expect(remove).not.toHaveBeenCalled();
    expect((await ingest(first.integration.id, first.signingKey)).accepted).toBe(1);
  });
});
