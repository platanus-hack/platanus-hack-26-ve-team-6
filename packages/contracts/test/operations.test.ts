import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { monitorConfigInputSchema, operationMetricsSchema, recordOperationObservationSchema } from '../src/operations.js';
describe('monitoring input contracts', () => {
 const scope = { organizationId: randomUUID(), applicationId: randomUUID() };
 it('requires explicitly selected work and bounds schedule and provider keys', () => {
  expect(monitorConfigInputSchema.safeParse({ ...scope, enabled: true, intervalSeconds: 3600 }).success).toBe(false);
  expect(monitorConfigInputSchema.parse({ ...scope, enabled: true, intervalSeconds: 86400, providers: ['cloudflare'] }).providers).toEqual(['cloudflare']);
  expect(monitorConfigInputSchema.safeParse({ ...scope, enabled: true, intervalSeconds: 3599, repositoryKey: 'https://arbitrary.example' }).success).toBe(false);
 });
 it('compares timestamps numerically and rejects impossible metric windows', () => {
  const metrics = { windowStartedAt: '2026-01-01T00:00:00.100Z', windowEndedAt: '2026-01-01T00:00:00Z', requestCount: 100, errorCount: 1, latencyP95Ms: null, capacityUtilization: null };
  expect(operationMetricsSchema.safeParse(metrics).success).toBe(false);
  expect(operationMetricsSchema.safeParse({ ...metrics, windowStartedAt: '0000-01-01T00:00:00Z' }).success).toBe(false);
 });
 it('does not treat an upstream outage as verified application impact', () => {
  const input = { ...scope, idempotencyKey:'x', basis:{kind:'monitor',runId:randomUUID(),leaseToken:randomUUID()},kind:'upstream_outage',summary:'status',severity:'high',confidence:'medium',observedAt:'2026-01-01T00:00:00Z',expiresAt:'2026-01-01T01:00:00Z',evidence:[{source:'provider_status',reference:'cloudflare',checksum:'a'.repeat(64),collectedAt:'2026-01-01T00:00:00Z',adapter:'test',adapterVersion:'1'}],upstreamImpact:'observed' };
  expect(recordOperationObservationSchema.safeParse(input).success).toBe(false);
  expect(recordOperationObservationSchema.safeParse({...input,upstreamImpact:'unverified'}).success).toBe(true);
 });
});
