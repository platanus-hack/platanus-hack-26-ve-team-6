import { describe, expect, it } from 'vitest';
import { eventBatchSchema, jobEnvelopeSchema } from '../src/index.js';

const event = {
  id: '437d7331-bd6f-4619-b2bb-a2c649727e55',
  type: 'auth.login_failed',
  source: 'application',
  occurredAt: '2026-10-24T00:00:00.000Z',
  outcome: 'failure',
};
const batch = { applicationId: 'c8aabfb6-5e7d-41ab-9b21-eb5054e2a04b', events: [event] };

describe('external event contract', () => {
  it('rejects a caller-supplied organization rather than trusting tenant identity', () => {
    expect(eventBatchSchema.safeParse({ ...batch, organizationId: batch.applicationId }).success).toBe(false);
  });

  it('rejects sensitive and unbounded attributes', () => {
    for (const attributes of [{ authorization: 'redacted' }, { session_cookie: 'redacted' }, { note: 'x'.repeat(513) }]) {
      expect(eventBatchSchema.safeParse({ ...batch, events: [{ ...event, attributes }] }).success).toBe(false);
    }
  });

  it('bounds batches and accepts stable event identities', () => {
    expect(eventBatchSchema.parse(batch).events[0]?.id).toBe(event.id);
    expect(eventBatchSchema.safeParse({ ...batch, events: Array.from({ length: 101 }, () => event) }).success).toBe(false);
  });

  it('canonicalizes durable job UUIDs without rewriting signed event data', () => {
    const upper = batch.applicationId.toUpperCase();
    const job = jobEnvelopeSchema.parse({ version: 1, id: event.id.toUpperCase(), organizationId: upper, applicationId: upper, kind: 'audit' });
    expect(job.applicationId).toBe(batch.applicationId);
    expect(job.id).toBe(event.id);
    expect(eventBatchSchema.parse({ ...batch, applicationId: upper }).applicationId).toBe(upper);
  });

  it('rejects year zero before an event reaches PostgreSQL time-window processing', () => {
    expect(eventBatchSchema.safeParse({ ...batch, events: [{ ...event, occurredAt: '0000-01-01T00:00:00Z' }] }).success).toBe(false);
    expect(eventBatchSchema.safeParse({ ...batch, events: [{ ...event, occurredAt: '0001-01-01T00:00:00Z' }] }).success).toBe(true);
  });
});
