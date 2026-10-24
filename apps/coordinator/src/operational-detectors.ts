import { createHash } from 'node:crypto';
import type { SecurityEvent, OperationMetrics } from '@gotchu/contracts';

export interface OperationalSignal {
  rule: string;
  key: string;
  kind: 'traffic_pressure' | 'application_error' | 'security_finding';
  summary: string;
  severity: 'info' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  eventIds: string[];
  metrics: OperationMetrics | null;
}
const number = (value: unknown, maximum: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
function percentile(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? null;
}

/** Versioned pilot rules on authenticated observations, never proof of attack or a write authorization. */
export function detectOperationalSignals(input: readonly SecurityEvent[], windowStartedAt: string, windowEndedAt: string): OperationalSignal[] {
  const start = Date.parse(windowStartedAt); const end = Date.parse(windowEndedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 600_000) throw new Error('invalid_operational_window');
  const unique = new Map<string, SecurityEvent>();
  for (const event of input) {
    const time = Date.parse(event.occurredAt);
    if (time >= start && time < end) unique.set(event.id.toLowerCase(), event);
  }
  const events = [...unique.values()]; const signals: OperationalSignal[] = [];
  function add(rule: string, context: string, kind: OperationalSignal['kind'], summary: string, selected: SecurityEvent[], severity: OperationalSignal['severity'] = 'medium', metrics: OperationMetrics | null = null, confidence: OperationalSignal['confidence'] = 'medium') {
    if (signals.length >= 30 || !selected.length) return;
    const key = createHash('sha256').update(`${rule}\0${context}\0${windowStartedAt}`).digest('hex');
    signals.push({ rule, key, kind, summary, severity, confidence, eventIds: selected.slice(0, 20).map(e => e.id), metrics });
  }
  const requests = events.filter(e => e.type === 'http.request');
  const measured = requests.filter(e => Number.isInteger(e.attributes.statusCode) && (number(e.attributes.statusCode, 599) ?? 0) >= 100);
  const errors = measured.filter(e => Number(e.attributes.statusCode) >= 500);
  const duration = measured.flatMap(e => { const value = number(e.attributes.durationMs, 3_600_000); return value === null ? [] : [value]; });
  const capacity = measured.flatMap(e => { const value = number(e.attributes.capacityUtilization, 1); return value === null ? [] : [value]; });
  if (measured.length >= 20) {
    const metrics: OperationMetrics = { windowStartedAt, windowEndedAt, requestCount: measured.length, errorCount: errors.length,
      latencyP95Ms: duration.length >= 20 ? percentile(duration) : null, capacityUtilization: capacity.length >= 20 ? percentile(capacity) : null };
    const failing = errors.length >= 5 && errors.length / measured.length >= .2;
    const slow = metrics.latencyP95Ms !== null && metrics.latencyP95Ms > 1000;
    const saturated = metrics.capacityUtilization !== null && metrics.capacityUtilization > .8;
    if (failing) add('http.errors.v1', 'application', 'application_error', `${errors.length}/${measured.length} observed signed requests returned 5xx. Investigate the failure cause; customer impact and an attack are not established.`, measured, 'high', metrics);
    if (slow || saturated || failing && measured.length >= 100) add('runtime.pressure.v1', 'application', 'traffic_pressure', `Observed service pressure: ${measured.length} requests, ${errors.length} 5xx, p95 ${metrics.latencyP95Ms ?? 'unknown'} ms. Check code, database, queues and capacity before choosing rate limits, replicas or a load balancer.`, measured, 'high', metrics);
  }
  const applicationErrors = new Map<string, SecurityEvent[]>();
  const routes = new Map<string, SecurityEvent[]>();
  const failures = new Map<string, SecurityEvent[]>();
  const privilege: SecurityEvent[] = []; const waf: SecurityEvent[] = []; const resources: SecurityEvent[] = [];
  const categories = new Set(['exception', 'database', 'upstream', 'memory', 'timeout', 'configuration', 'unknown']);
  for (const event of events) {
    if (event.type === 'app.error' && event.outcome === 'failure') {
      const category = typeof event.attributes.category === 'string' && categories.has(event.attributes.category) ? event.attributes.category : 'unknown';
      const group = applicationErrors.get(category) ?? []; group.push(event); applicationErrors.set(category, group);
    }
    if (event.type === 'runtime.resource' && ['cpuUtilization', 'memoryUtilization', 'poolUtilization'].some(key => (number(event.attributes[key], 1) ?? 0) > .9)) resources.push(event);
    if (event.actor?.ip && event.type === 'http.request' && event.attributes.statusCode === 404) {
      const group = routes.get(event.actor.ip) ?? []; group.push(event); routes.set(event.actor.ip, group);
    }
    if (event.actor?.ip && event.actor.accountId && event.type === 'auth.login_failed' && event.outcome === 'failure') {
      const group = failures.get(event.actor.ip) ?? []; group.push(event); failures.set(event.actor.ip, group);
    }
    if (event.type === 'auth.privilege_changed' && event.outcome === 'success' && event.attributes.expected !== true) privilege.push(event);
    if (event.type === 'waf.match') waf.push(event);
  }
  for (const [category, group] of applicationErrors) if (group.length >= 3) add(`app.error.${category}.v1`, category, 'application_error', `${group.length} authenticated ${category} error observations. Inspect the affected service and recent changes; root cause is unverified.`, group, 'high');
  if (resources.length >= 5) add('runtime.resources.v1', 'application', 'application_error', `${resources.length} signed resource observations exceeded 90% utilization. Inspect memory, CPU or connection pools; scaling is one option, not a verified correction.`, resources, 'high');
  for (const [ip, group] of failures) if (group.length >= 10 && new Set(group.map(e => e.actor?.accountId)).size >= 5) add('auth.password_spray.v1', ip, 'security_finding', 'Repeated failed authentication across multiple accounts from one observed IP. Possible password spraying; blocked attempts and compromise remain distinct.', group, 'high');
  for (const [ip, group] of routes) if (group.length >= 20 && new Set(group.flatMap(e => e.resource?.id ? [e.resource.id] : [])).size >= 10) add('http.route_enumeration.v1', ip, 'security_finding', 'Many distinct missing routes from one observed IP. Possible enumeration or a broken client; validate proxy attribution and legitimate traffic first.', group);
  if (privilege.length) add('auth.privilege_change.v1', 'application', 'security_finding', `${privilege.length} privilege changes without a declared expected-change marker. Confirm the actor and business authorization; compromise is unverified.`, privilege, 'medium', null, 'low');
  if (waf.length >= 5) {
    const blocked = waf.filter(e => e.outcome === 'blocked').length;
    add('waf.matches.v1', 'application', 'security_finding', `${waf.length} application-reported WAF matches, ${blocked} blocked. Provider attribution, exploitation and compromise are unverified.`, waf, blocked === waf.length ? 'info' : 'medium', null, 'low');
  }
  return signals;
}
