import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aggregateAuthFailures, type AuthFailureEvent } from '../src/auth-failure-aggregation.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';

function loginFailure(index: number, outcome: 'failure' | 'blocked' = 'failure', actor: AuthFailureEvent['actor'] = { accountId: 'Alice' }): AuthFailureEvent {
  return {
    eventId: randomUUID(),
    organizationId,
    applicationId,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
    type: 'auth.login_failed',
    outcome,
    actor,
  };
}

describe('aggregateAuthFailures', () => {
  it('groups repeated failures into one suspicious incident by account', () => {
    const events = Array.from({ length: 6 }, (_, index) => loginFailure(index));
    const aggregation = aggregateAuthFailures(events);

    expect(aggregation.incidents).toHaveLength(1);
    expect(aggregation.incidents[0]).toMatchObject({
      grouping: 'actor_account',
      groupKey: 'Alice',
      failedAttempts: 6,
      classification: 'suspicious_auth_activity',
      confirmedCompromise: false,
    });
  });

  it('keeps IP grouping separate from account grouping and deduplicates event IDs', () => {
    const events = Array.from({ length: 5 }, (_, index) => loginFailure(index, 'failure', { ip: '203.0.113.7' }));
    const firstEvent = events.at(0);
    if (!firstEvent) throw new Error('test fixture did not create an event');
    const aggregation = aggregateAuthFailures([...events, firstEvent]);

    expect(aggregation.incidents).toHaveLength(1);
    expect(aggregation.incidents[0]?.grouping).toBe('ip');
    expect(aggregation.incidents[0]?.groupKey).toBe('203.0.113.7');
    expect(aggregation.deduplicatedEvents).toBe(1);
  });

  it('keeps an incident ID stable as late events update the same fixed ten minute window', () => {
    const events = Array.from({ length: 5 }, (_, index) => loginFailure(index));
    const first = aggregateAuthFailures(events).incidents.at(0);
    const updated = aggregateAuthFailures([...events, loginFailure(9)]).incidents.at(0);
    if (!first || !updated) throw new Error('test fixtures did not reach the incident threshold');

    expect(updated.incidentId).toBe(first.incidentId);
    expect(updated.failedAttempts).toBe(6);
    expect(updated.eventIds).toHaveLength(6);
  });

  it('does not treat blocked attempts as confirmed compromise', () => {
    const aggregation = aggregateAuthFailures(Array.from({ length: 8 }, (_, index) => loginFailure(index, 'blocked')));

    expect(aggregation.incidents).toEqual([]);
    expect(aggregation.blockedAttempts).toBe(8);
    expect(aggregation.confirmedCompromise).toBe(false);
  });
});
