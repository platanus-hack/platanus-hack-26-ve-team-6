import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { eventBatchSchema, type SecurityEvent } from '@gotchu/contracts';
import { z } from 'zod';
import { audit, BackendError, canonicalJson, parse, sha256, systemClock, type BaseDependencies, type CredentialStore } from './core.js';
import { enqueue } from './jobs.js';

export const MAX_EVENT_BODY_BYTES = 256 * 1024;
export const EVENT_SIGNATURE_WINDOW_SECONDS = 300;
export interface EventIntakeInput { integrationId: string; timestamp: string; signature: string; rawBody: Buffer }
const envelopeSchema = z.object({ integrationId: z.uuid(), timestamp: z.string().regex(/^[1-9][0-9]{9,11}$/), signature: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export function signEventBody(secret: Uint8Array, integrationId: string, timestamp: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(`gotchu-events-v1\n${integrationId}\n${timestamp}\n`).update(rawBody).digest('hex');
}
export function verifyEventSignature(input: EventIntakeInput, secret: Uint8Array, now: Date): void {
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.byteLength > MAX_EVENT_BODY_BYTES || input.rawBody.byteLength === 0) throw new BackendError('body_limit', 'Event body is empty or exceeds the intake limit', 413);
  const envelope = envelopeSchema.safeParse({ integrationId: input.integrationId, timestamp: input.timestamp, signature: input.signature });
  if (!envelope.success || Math.abs(now.getTime() / 1000 - Number(input.timestamp)) > EVENT_SIGNATURE_WINDOW_SECONDS) throw new BackendError('invalid_signature', 'Event authentication failed', 401);
  if (secret.byteLength < 32) throw new BackendError('credential_unavailable', 'Integration signing credential is unavailable', 503);
  const expected = Buffer.from(signEventBody(secret, input.integrationId, input.timestamp, input.rawBody), 'hex');
  const actual = Buffer.from(input.signature, 'hex');
  if (!timingSafeEqual(expected, actual)) throw new BackendError('invalid_signature', 'Event authentication failed', 401);
}
export function createEventService(deps: BaseDependencies & { credentials?: CredentialStore }) {
  const clock = deps.clock ?? systemClock;
  return {
    async ingest(input: EventIntakeInput): Promise<{ accepted: number; duplicates: number; jobId: string | null }> {
      if (!Buffer.isBuffer(input.rawBody) || !input.rawBody.byteLength || input.rawBody.byteLength > MAX_EVENT_BODY_BYTES) throw new BackendError('body_limit', 'Event body is empty or exceeds the intake limit', 413);
      if (!envelopeSchema.safeParse({ integrationId: input.integrationId, timestamp: input.timestamp, signature: input.signature }).success || Math.abs(clock.now().getTime() / 1000 - Number(input.timestamp)) > EVENT_SIGNATURE_WINDOW_SECONDS) throw new BackendError('invalid_signature', 'Event authentication failed', 401);
      const credentials = deps.credentials;
      if (!credentials) throw new BackendError('credential_unavailable', 'No signing credential store is configured', 503);
      return deps.database.integration(input.integrationId, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.integrationId.toLowerCase()]);
        const context = await tx.query<{ organization_id: string; application_id: string; credential_ref: string }>(`SELECT i.organization_id, i.application_id, c.credential_ref
          FROM gotchu.integrations i JOIN gotchu.integration_credentials c ON c.organization_id=i.organization_id AND c.integration_id=i.id
          WHERE i.id=$1 AND i.status='active' AND i.kind='signed_events'`, [input.integrationId]);
        let integration = context.rows[0];
        if (!integration) throw new BackendError('invalid_signature', 'Event authentication failed', 401);
        await tx.query("SELECT set_config('gotchu.organization_id', $1, true)", [integration.organization_id]);
        const locked = await tx.query<{ organization_id: string; application_id: string; credential_ref: string }>(`SELECT i.organization_id, i.application_id, c.credential_ref
          FROM gotchu.integrations i JOIN gotchu.integration_credentials c ON c.organization_id=i.organization_id AND c.integration_id=i.id
          WHERE i.id=$1 AND i.status='active' AND i.kind='signed_events' FOR SHARE OF i`, [input.integrationId]);
        integration = locked.rows[0];
        if (!integration) throw new BackendError('invalid_signature', 'Event authentication failed', 401);
        const secret = await credentials.getSigningSecret(integration.credential_ref);
        verifyEventSignature(input, secret, clock.now());
        let decoded: unknown;
        try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody)); }
        catch { throw new BackendError('invalid_input', 'Event body must be valid UTF-8 JSON'); }
        const batch = parse(eventBatchSchema, decoded);
        if (batch.events.some(event => event.source !== 'application')) throw new BackendError('source_mismatch', 'Signed application integrations cannot assert provider telemetry', 403);
        if (batch.applicationId.toLowerCase() !== integration.application_id) throw new BackendError('application_mismatch', 'Integration does not authorize this application', 403);
        const organizationId = integration.organization_id;
        await tx.query("SELECT set_config('gotchu.organization_id', $1, true)", [organizationId]);
        const unique = new Map<string, { event: SecurityEvent; hash: string }>();
        for (const inputEvent of batch.events) {
          const event = { ...inputEvent, id: inputEvent.id.toLowerCase() };
          const hash = sha256(canonicalJson(event));
          const prior = unique.get(event.id);
          if (prior && prior.hash !== hash) throw new BackendError('replay_conflict', 'An event ID was reused with changed content', 409);
          unique.set(event.id, { event, hash });
        }
        const existing = await tx.query<{ id: string; payload_hash: string }>('SELECT id, payload_hash FROM gotchu.events WHERE organization_id=$1 AND integration_id=$2 AND id=ANY($3::uuid[])', [organizationId, input.integrationId, [...unique.keys()]]);
        for (const row of existing.rows) {
          const received = unique.get(row.id);
          if (!received || received.hash !== row.payload_hash) throw new BackendError('replay_conflict', 'An event ID was reused with changed content', 409);
          unique.delete(row.id);
        }
        if (unique.size === 0) return { accepted: 0, duplicates: batch.events.length, jobId: null };
        const jobId = randomUUID();
        await enqueue(tx, { organizationId, applicationId: integration.application_id, id: jobId, kind: 'events.aggregate', idempotencyKey: jobId, payload: { integrationId: input.integrationId, eventIds: [...unique.keys()] } });
        for (const { event, hash } of unique.values()) await tx.query('INSERT INTO gotchu.events(organization_id,application_id,integration_id,id,payload,payload_hash,job_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)', [organizationId, integration.application_id, input.integrationId, event.id, JSON.stringify(event), hash, jobId]);
        await tx.query('UPDATE gotchu.integrations SET last_event_at=$1 WHERE organization_id=$2 AND id=$3', [clock.now(), organizationId, input.integrationId]);
        await audit(tx, organizationId, `integration:${input.integrationId}`, 'events.accepted', jobId, { accepted: unique.size });
        return { accepted: unique.size, duplicates: batch.events.length - unique.size, jobId };
      });
    },
  };
}
