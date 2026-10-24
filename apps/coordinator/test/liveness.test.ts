import { describe, expect, it } from 'vitest';
import { deriveMonitoringLiveness } from '../src/liveness.js';

const now = new Date('2026-10-24T12:00:00.000Z');
const previous = { state: 'healthy', reason: null, since: null, consecutiveFailures: 0 };

function input(overrides: Partial<Parameters<typeof deriveMonitoringLiveness>[0]> = {}) {
  return {
    now,
    schedulerHeartbeatAt: new Date(now.getTime() - 5_000),
    monitorUpdatedAt: new Date(now.getTime() - 60_000),
    nextDueAt: new Date(now.getTime() + 60 * 60_000),
    intervalSeconds: 3_600,
    runStatus: 'completed',
    runReason: null,
    runCreatedAt: new Date(now.getTime() - 10_000),
    runFinishedAt: new Date(now.getTime() - 1_000),
    runLeaseUntil: null,
    recentStatuses: ['completed'],
    failureSince: null,
    previous,
    ...overrides,
  };
}

describe('deriveMonitoringLiveness', () => {
  it('stops after three consecutive degraded scheduled checks and keeps the first failure time', () => {
    const since = new Date(now.getTime() - 20_000);
    expect(deriveMonitoringLiveness(input({
      runStatus: 'degraded',
      runReason: 'repository_unavailable',
      recentStatuses: ['degraded', 'degraded', 'degraded'],
      failureSince: since,
    }))).toMatchObject({ state: 'stopped', reason: expect.stringContaining('repository_unavailable'), since, consecutiveFailures: 3 });
  });

  it('marks an expired scheduler heartbeat stopped and preserves its original since time', () => {
    const since = new Date(now.getTime() - 40_000);
    expect(deriveMonitoringLiveness(input({
      schedulerHeartbeatAt: new Date(now.getTime() - 70_000),
      previous: { state: 'stopped', reason: 'old', since, consecutiveFailures: 0 },
    }))).toMatchObject({ state: 'stopped', since });
  });

  it('clears stopped state only after a successful scheduled check', () => {
    expect(deriveMonitoringLiveness(input({
      recentStatuses: ['completed', 'degraded', 'degraded'],
      previous: { state: 'stopped', reason: 'missed schedule', since: new Date(now.getTime() - 60_000), consecutiveFailures: 0 },
    }))).toMatchObject({ state: 'healthy', reason: null, since: null, consecutiveFailures: 0 });
  });

  it('does not clear a stopped state on scheduler recovery or another failed run', () => {
    const stoppedSince = new Date(now.getTime() - 60_000);
    expect(deriveMonitoringLiveness(input({
      runStatus: 'degraded',
      runReason: 'still_unavailable',
      runFinishedAt: new Date(now.getTime() - 1_000),
      recentStatuses: ['degraded', 'completed'],
      previous: { state: 'stopped', reason: 'coordinator_stopped', since: stoppedSince, consecutiveFailures: 0 },
    }))).toMatchObject({ state: 'stopped', reason: 'coordinator_stopped', since: stoppedSince });
  });
});
