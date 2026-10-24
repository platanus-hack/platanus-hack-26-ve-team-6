import { describe, expect, it } from 'vitest';
import { buildCorrelationInput } from '../src/triage.js';

const now = new Date('2026-10-24T12:00:00.000Z');
const at = (secondsAgo = 0) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

function providerStatus(input: { component: string | null; state?: 'operational' | 'degraded' | 'partial_outage'; observedAt?: string }) {
  return { provider: 'cloudflare', component: input.component, region: null, state: input.state ?? 'partial_outage',
    observedAt: input.observedAt ?? at(), scope: input.component === null ? 'global' : 'component', fixture: false };
}

describe('bounded triage structured inputs', () => {
  it('keeps a bounded recent selection and records when 101 distinct provider statuses exceed the cap', () => {
    const statuses = [providerStatus({ component: null }), ...Array.from({ length: 100 }, (_, index) => providerStatus({ component: `component-${index}` }))];
    const input = buildCorrelationInput({ now, observations: [], providerStatuses: statuses });

    expect(input.providerStatuses).toHaveLength(100);
    expect(input.providerStatuses.some(status => status.scope === 'global')).toBe(true);
    expect(input.anomalies).toContain('Provider status coverage is incomplete: 1 distinct recent inputs omitted at the 100-record limit.');
  });

  it('collapses repeated feed history to each identity’s latest timestamp while preserving global scope', () => {
    const timestamps = [at(120), at(60), at(10)];
    const statuses = timestamps.flatMap((observedAt, index) => {
      const state = index === 0 ? 'partial_outage' : index === 1 ? 'degraded' : 'operational';
      return [
        providerStatus({ component: null, observedAt, state }),
        ...Array.from({ length: 100 }, (_, componentIndex) => providerStatus({ component: `component-${componentIndex}`, observedAt, state })),
      ];
    });
    const input = buildCorrelationInput({ now, observations: [], providerStatuses: statuses });

    expect(statuses).toHaveLength(303);
    expect(input.providerStatuses).toHaveLength(100);
    expect(input.providerStatuses.find(status => status.scope === 'global')?.observedAt).toBe(timestamps[2]);
    expect(input.providerStatuses.every(status => status.observedAt === timestamps[2])).toBe(true);
    expect(input.providerStatuses.every(status => status.state === 'operational')).toBe(true);
    expect(input.anomalies.some(anomaly => anomaly.includes('coverage is incomplete'))).toBe(true);
  });

  it('caps probes by recency and reports omitted route coverage', () => {
    const probes = Array.from({ length: 205 }, (_, index) => ({ route: `/route-${index}`, service: 'web', dependsOnProvider: null,
      role: 'application', outcome: 'healthy', at: at(index) }));
    const input = buildCorrelationInput({ now, observations: [], probes });

    expect(input.probes).toHaveLength(200);
    expect(input.probes[0]?.route).toBe('/route-0');
    expect(input.probes.some(probe => probe.route === '/route-204')).toBe(false);
    expect(input.anomalies).toContain('HTTPS probe coverage is incomplete: 5 distinct recent inputs omitted at the 200-record limit.');
  });

  it('keeps only the newest outcome for a repeatedly probed route', () => {
    const probes = Array.from({ length: 250 }, (_, index) => ({ route: '/', service: 'web', dependsOnProvider: null,
      role: 'application', outcome: index % 2 === 0 ? 'healthy' : 'unavailable', at: at(250 - index) }));
    const input = buildCorrelationInput({ now, observations: [], probes });

    expect(input.probes).toEqual([expect.objectContaining({ outcome: 'unavailable', at: at(1) })]);
    expect(input.anomalies).toEqual([]);
  });
});
