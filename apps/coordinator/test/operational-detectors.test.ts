import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { securityEventSchema, type SecurityEvent } from '@gotchu/contracts';
import { detectOperationalSignals } from '../src/operational-detectors.js';
const from = '2026-10-24T12:00:00Z'; const until = '2026-10-24T12:10:00Z';
function event(type: SecurityEvent['type'], overrides: Partial<SecurityEvent> = {}) {
  return securityEventSchema.parse({ id: randomUUID(), type, source: 'application', occurredAt: '2026-10-24T12:01:00Z', outcome: 'success', attributes: {}, ...overrides });
}
describe('contextual operational detectors', () => {
  it('does not call a legitimate traffic increase an attack or a capacity problem', () => {
    const requests = Array.from({ length: 500 }, () => event('http.request', { attributes: { statusCode: 200, durationMs: 20 } }));
    expect(detectOperationalSignals(requests, from, until)).toEqual([]);
  });
  it('detects high errors and measured latency independently of traffic volume and deduplicates delivery', () => {
    const requests = Array.from({ length: 20 }, () => event('http.request', { attributes: { statusCode: 503, durationMs: 1300, capacityUtilization: .9 } }));
    const signals = detectOperationalSignals([...requests, ...requests], from, until);
    expect(signals.map(x => x.rule)).toEqual(['http.errors.v1', 'runtime.pressure.v1']);
    expect(signals[1]?.metrics).toMatchObject({ requestCount: 20, errorCount: 20, latencyP95Ms: 1300, capacityUtilization: .9 });
    expect(detectOperationalSignals(requests.slice(0, 19), from, until)).toEqual([]);
  });
  it('detects common authentication and route patterns without treating blocked WAF matches as compromise', () => {
    const spray = Array.from({ length: 10 }, (_, i) => event('auth.login_failed', { actor: { ip: '203.0.113.1', accountId: `account-${i % 5}` }, outcome: 'failure' }));
    const routes = Array.from({ length: 20 }, (_, i) => event('http.request', { actor: { ip: '203.0.113.1' }, resource: { type: 'route', id: `/missing-${i}` }, attributes: { statusCode: 404 } }));
    const waf = Array.from({ length: 5 }, () => event('waf.match', { outcome: 'blocked' }));
    const signals = detectOperationalSignals([...spray, ...routes, ...waf], from, until);
    expect(signals.map(x => x.rule)).toEqual(['auth.password_spray.v1', 'http.route_enumeration.v1', 'waf.matches.v1']);
    expect(signals.at(-1)).toMatchObject({ severity: 'info', confidence: 'low' });
    expect(detectOperationalSignals(spray.map(e => ({ ...e, outcome: 'blocked' })), from, until)).toEqual([]);
  });
  it('handles categorical runtime faults and preserves expected privilege changes', () => {
    const errors = Array.from({ length: 3 }, () => event('app.error', { outcome: 'failure', attributes: { category: 'database' } }));
    const resources = Array.from({ length: 5 }, () => event('runtime.resource', { attributes: { memoryUtilization: .95 } }));
    const expected = event('auth.privilege_changed', { attributes: { expected: true } });
    expect(detectOperationalSignals([...errors, ...resources, expected], from, until).map(x => x.rule)).toEqual(['app.error.database.v1', 'runtime.resources.v1']);
    expect(detectOperationalSignals([event('auth.privilege_changed')], from, until)[0]?.confidence).toBe('low');
  });
  it('turns runtime protection attempts into indications and retains blocked outcomes separately', () => {
    const attempts = [
      event('runtime.attack_detected', { outcome: 'unknown', attributes: { attackKind: 'sql_injection', sink: 'sql', route: '/login', evidence: 'sql_boolean_tautology' } }),
      event('runtime.attack_detected', { outcome: 'blocked', attributes: { attackKind: 'sql_injection', sink: 'sql', route: '/login', evidence: 'sql_boolean_tautology' } }),
    ];
    const [signal] = detectOperationalSignals(attempts, from, until);
    expect(signal).toMatchObject({ rule: 'runtime.attack.sql_injection.v1', kind: 'security_finding', severity: 'medium', confidence: 'medium', eventIds: attempts.map(item => item.id) });
    expect(signal?.summary).toContain('2 runtime indications');
    expect(signal?.summary).toContain('1 attempts were blocked');
    expect(signal?.summary).toContain('does not establish exploitation or compromise');
  });
  it('does not count invalid numeric measurements, stale windows or cross-IP routes as observed pressure', () => {
    const invalid = Array.from({ length: 50 }, () => event('http.request', { attributes: { statusCode: 200, durationMs: -1, capacityUtilization: 50 } }));
    expect(detectOperationalSignals(invalid, from, until)).toEqual([]);
    const old = Array.from({ length: 30 }, () => event('app.error', { occurredAt: '2026-10-23T12:01:00Z', outcome: 'failure' }));
    expect(detectOperationalSignals(old, from, until)).toEqual([]);
  });
});
