import type { CorrelationWindowInput } from '../src/inputs.js';
import type { HypothesisKind, ImpactObservation } from '../src/correlate.js';

export interface LabeledCase {
  readonly id: string;
  readonly scenario: string;
  readonly input: CorrelationWindowInput;
  readonly truth: { readonly impact: ImpactObservation; readonly causes: readonly HypothesisKind[] };
  readonly expectedConfidence?: 'low' | 'medium' | 'high';
}
const start = '2026-10-24T11:00:00.000Z';
const end = '2026-10-24T11:05:00.000Z';
const now = '2026-10-24T11:06:00.000Z';
const base = { service: 'checkout', environment: 'production', errorRate: 0.01, latencyMs: 100, requestRate: 100, resourceUtilization: 0.4, authFailures: 2 };
function input(overrides: Partial<CorrelationWindowInput> = {}): CorrelationWindowInput {
  return {
    window: { startedAt: start, endedAt: end }, context: { environment: 'production', service: 'checkout', deployments: [], dependencies: [] },
    signals: [], providerStatuses: [], probes: [], baselines: [base], anomalies: [], ...overrides,
  };
}
function series(metric: CorrelationWindowInput['signals'][number]['metric'], value: number, service = 'checkout', freshnessMs = 600_000) {
  return { id: `${metric}-${service}`, metric, service, environment: 'production', sampling: 1,
    freshnessMs, samples: [{ eventAt: '2026-10-24T11:04:00.000Z', acceptedAt: '2026-10-24T11:04:02.000Z', value }] };
}
const providerContext = { environment: 'production', service: 'checkout', deployments: [], dependencies: [{ service: 'checkout', provider: 'railway', component: 'database', region: 'us-east', state: 'verified' as const }] };
const providerDown = { provider: 'railway', component: 'database', region: 'us-east', state: 'partial_outage' as const, observedAt: '2026-10-24T11:03:00.000Z', scope: 'component' as const, fixture: true };
const downImpactInput = input({ context: providerContext, providerStatuses: [providerDown], probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: 'railway', outcome: 'unavailable', at: '2026-10-24T11:04:30.000Z' }] });
const releaseInput = input({ context: { ...providerContext, deployments: [{ service: 'checkout', releaseId: 'r42', commit: 'abc', deployedAt: '2026-10-24T11:01:00.000Z', state: 'verified' }] },
  signals: [series('error_rate', 0.35)], providerStatuses: [{ ...providerDown, state: 'operational' }], probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: 'railway', outcome: 'degraded', at: '2026-10-24T11:04:30.000Z' }] });
const trafficInput = input({ probes: [{ route: '/health', service: 'checkout', dependsOnProvider: null, outcome: 'healthy', at: '2026-10-24T11:04:30.000Z' }],
  signals: [series('request_rate', 260), series('error_rate', 0.01), series('latency_ms', 100)] });
const staleInput = input({ signals: [{ ...series('error_rate', 0.4, 'checkout', 60_000), samples: [{ eventAt: '2026-10-24T10:00:00.000Z', acceptedAt: '2026-10-24T10:01:00.000Z', value: 0.4 }] }],
  probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: null, outcome: 'unavailable', at: '2026-10-24T11:04:30.000Z' }] });
const authInput = input({ signals: [series('auth_failures', 24)] });
const healthyProviderInput = input({ context: providerContext, providerStatuses: [{ ...providerDown, state: 'operational' }], probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: 'railway', outcome: 'healthy', at: '2026-10-24T11:04:30.000Z' }] });
const regionalUnknownInput = input({ context: { ...providerContext, dependencies: [{ ...providerContext.dependencies[0]!, region: 'eu-west' }] }, providerStatuses: [{ ...providerDown, scope: 'regional', region: 'us-east' }] });

export const tuningCases: readonly LabeledCase[] = [
  { id: 'tuning-provider-down-app-healthy', scenario: 'provider-down-app-healthy', input: input({ ...healthyProviderInput, providerStatuses: [providerDown] }), truth: { impact: 'none_observed_at_checked_points', causes: [] } },
  { id: 'tuning-release-error', scenario: 'release-regression', input: releaseInput, truth: { impact: 'degraded', causes: ['application_regression'] }, expectedConfidence: 'medium' },
  { id: 'tuning-provider-compatible-impact', scenario: 'provider-compatible-failure', input: downImpactInput, truth: { impact: 'unavailable', causes: ['provider_dependency'] }, expectedConfidence: 'high' },
  { id: 'tuning-stale', scenario: 'stale-telemetry', input: staleInput, truth: { impact: 'unknown', causes: [] } },
  { id: 'tuning-two-causes', scenario: 'simultaneous-causes', input: input({ context: releaseInput.context, signals: [series('error_rate', 0.35), series('auth_failures', 24)], probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: null, outcome: 'degraded', at: '2026-10-24T11:04:30.000Z' }] }), truth: { impact: 'degraded', causes: ['application_regression', 'abuse'] } },
  { id: 'tuning-incomplete-regional-feed', scenario: 'incomplete-regional-feed', input: regionalUnknownInput, truth: { impact: 'unknown', causes: [] } },
  { id: 'tuning-legitimate-increase', scenario: 'legitimate-traffic-increase', input: trafficInput, truth: { impact: 'none_observed_at_checked_points', causes: ['legitimate_load'] }, expectedConfidence: 'medium' },
  { id: 'tuning-abstain-unrelated-feed', scenario: 'abstention-control', input: input({ providerStatuses: [{ ...providerDown, provider: 'unrelated' }] }), truth: { impact: 'unknown', causes: [] } },
];
export const holdoutCases: readonly LabeledCase[] = [
  { id: 'holdout-provider-down-app-healthy', scenario: 'provider-down-app-healthy', input: input({ context: providerContext, providerStatuses: [providerDown], probes: [{ route: '/health', service: 'checkout', dependsOnProvider: null, outcome: 'healthy', at: '2026-10-24T11:04:30.000Z' }] }), truth: { impact: 'none_observed_at_checked_points', causes: [] } },
  { id: 'holdout-provider-healthy-release-error', scenario: 'release-regression', input: releaseInput, truth: { impact: 'degraded', causes: ['application_regression'] }, expectedConfidence: 'medium' },
  { id: 'holdout-provider-and-dependency-failure', scenario: 'provider-compatible-failure', input: downImpactInput, truth: { impact: 'unavailable', causes: ['provider_dependency'] }, expectedConfidence: 'high' },
  { id: 'holdout-stale-telemetry', scenario: 'stale-telemetry', input: staleInput, truth: { impact: 'unknown', causes: [] } },
  { id: 'holdout-two-causes', scenario: 'simultaneous-causes', input: input({ signals: [series('error_rate', 0.35), series('auth_failures', 24)], context: releaseInput.context, probes: [{ route: '/checkout', service: 'checkout', dependsOnProvider: null, outcome: 'degraded', at: '2026-10-24T11:04:30.000Z' }] }), truth: { impact: 'degraded', causes: ['application_regression', 'abuse'] } },
  { id: 'holdout-incomplete-regional-feed', scenario: 'incomplete-regional-feed', input: regionalUnknownInput, truth: { impact: 'unknown', causes: [] } },
  { id: 'holdout-legitimate-increase', scenario: 'legitimate-traffic-increase', input: trafficInput, truth: { impact: 'none_observed_at_checked_points', causes: ['legitimate_load'] }, expectedConfidence: 'medium' },
  { id: 'holdout-abstain-app-without-signals', scenario: 'abstention-control', input: input({ anomalies: ['unmapped latency anomaly'] }), truth: { impact: 'unknown', causes: [] } },
];
export const evaluationNow = now;
