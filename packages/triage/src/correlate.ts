import { createHash } from 'node:crypto';
import { correlationWindowInputSchema, type CorrelationWindowInput } from './inputs.js';

export type HypothesisKind = 'application_regression' | 'abuse' | 'provider_dependency' | 'legitimate_load' | 'unknown';
export type HypothesisStatus = 'supported' | 'weak' | 'contradicted' | 'withdrawn';
export type Confidence = 'low' | 'medium' | 'high';
export type ImpactObservation = 'none_observed_at_checked_points' | 'degraded' | 'unavailable' | 'unknown';
export interface EvidenceRef { readonly ref: string; readonly detail: string }
export interface Hypothesis {
  readonly kind: HypothesisKind;
  readonly status: HypothesisStatus;
  readonly confidence: Confidence;
  readonly ruleIds: readonly string[];
  readonly evidenceFor: readonly EvidenceRef[];
  readonly evidenceAgainst: readonly EvidenceRef[];
  readonly missingData: readonly string[];
  readonly nextCheck: string;
}
export interface TriageRevision {
  readonly id: string;
  readonly revision: number;
  readonly previousRevisionId: string | null;
  readonly rulesVersion: string;
  readonly inputDigest: string;
  readonly impact: {
    readonly observed: ImpactObservation;
    readonly affectedServices: readonly string[];
    readonly window: CorrelationWindowInput['window'];
    readonly checkedPoints: readonly EvidenceRef[];
  };
  readonly hypotheses: readonly Hypothesis[];
  readonly unknownInvestigable: readonly string[];
}
export interface CorrelationOptions { readonly now: Date | string; readonly rulesVersion: string }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function max(values: readonly number[]): number { return values.reduce((current, value) => Math.max(current, value), 0); }
function stale(input: CorrelationWindowInput, nowMs: number): boolean {
  return input.signals.some(series => {
    const latest = max(series.samples.map(sample => Date.parse(sample.acceptedAt)));
    const latestEvent = max(series.samples.map(sample => Date.parse(sample.eventAt)));
    return nowMs - latest > series.freshnessMs || nowMs - latestEvent > series.freshnessMs;
  });
}
function samplesFor(input: CorrelationWindowInput, metric: CorrelationWindowInput['signals'][number]['metric'], service?: string) {
  return input.signals.filter(series => series.metric === metric && (service === undefined || series.service === service))
    .flatMap(series => series.samples.map(sample => ({ series, sample })));
}
function baselineFor(input: CorrelationWindowInput, service: string, environment: string) {
  return input.baselines.find(item => item.service === service && item.environment === environment);
}
function ref(refValue: string, detail: string): EvidenceRef { return { ref: refValue, detail }; }

export function correlate(inputValue: CorrelationWindowInput | unknown, options: CorrelationOptions): TriageRevision {
  const input = correlationWindowInputSchema.parse(inputValue);
  const nowMs = typeof options.now === 'string' ? Date.parse(options.now) : options.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('invalid_correlation_now');
  if (!options.rulesVersion.trim() || options.rulesVersion.length > 64) throw new Error('invalid_rules_version');
  const isStale = stale(input, nowMs);
  const inWindow = (time: string) => Date.parse(time) >= Date.parse(input.window.startedAt) && Date.parse(time) <= Date.parse(input.window.endedAt);
  const errors = samplesFor(input, 'error_rate').filter(({ sample }) => inWindow(sample.eventAt));
  const latencies = samplesFor(input, 'latency_ms').filter(({ sample }) => inWindow(sample.eventAt));
  const requests = samplesFor(input, 'request_rate').filter(({ sample }) => inWindow(sample.eventAt));
  const authFailures = samplesFor(input, 'auth_failures').filter(({ sample }) => inWindow(sample.eventAt));
  const resources = samplesFor(input, 'resource_utilization').filter(({ sample }) => inWindow(sample.eventAt));
  const probes = input.probes.filter(probe => inWindow(probe.at));
  const checkedPoints: EvidenceRef[] = [
    ...probes.map((probe, index) => ref(`probe:${index}:${probe.route}`, `HTTPS ${probe.outcome} for ${probe.route}`)),
    ...input.signals.flatMap((series, index) => series.samples.filter(sample => inWindow(sample.eventAt)).map((sample, sampleIndex) => ref(`signal:${index}:${sampleIndex}:${series.id}`, `${series.metric} accepted at ${sample.acceptedAt}`))),
  ];
  const unavailable = probes.some(probe => probe.outcome === 'unavailable');
  const degradedProbe = probes.some(probe => probe.outcome === 'degraded');
  const metricsDegraded = [...errors, ...latencies].some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && (series.metric === 'error_rate' ? sample.value >= baseline.errorRate + 0.1 : sample.value >= Math.max(baseline.latencyMs * 1.5, baseline.latencyMs + 100));
  });
  const hasImpactSignals = probes.length > 0 || errors.length > 0 || latencies.length > 0;
  const impact: ImpactObservation = isStale || !hasImpactSignals ? 'unknown'
    : unavailable ? 'unavailable' : degradedProbe || metricsDegraded ? 'degraded' : 'none_observed_at_checked_points';
  const affectedServices = [...new Set([
    ...probes.filter(probe => probe.outcome === 'unavailable' || probe.outcome === 'degraded').map(probe => probe.service),
    ...[...errors, ...latencies].filter(({ series, sample }) => {
      const baseline = baselineFor(input, series.service, series.environment);
      return baseline !== undefined && (series.metric === 'error_rate' ? sample.value >= baseline.errorRate + 0.1 : sample.value >= Math.max(baseline.latencyMs * 1.5, baseline.latencyMs + 100));
    }).map(({ series }) => series.service),
  ])].sort();

  const hypotheses: Hypothesis[] = [];
  const degradedDependencies = input.providerStatuses.filter(status => status.state !== 'operational' && status.state !== 'unknown' && nowMs - Date.parse(status.observedAt) <= 30 * 60_000 && inWindow(status.observedAt))
    .filter(status => input.context?.dependencies.some(dependency => dependency.state === 'verified' && dependency.provider === status.provider
      && (status.scope === 'global' || status.scope === 'regional' && status.region !== null && dependency.region !== null && dependency.region === status.region || status.scope === 'component' && status.component !== null && dependency.component !== null && dependency.component === status.component)) ?? false);
  const releaseEvidence = input.context?.deployments.filter(deployment => deployment.state === 'verified' && inWindow(deployment.deployedAt)) ?? [];
  const releaseServiceError = releaseEvidence.filter(deployment => errors.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return series.service === deployment.service && baseline !== undefined && sample.value >= baseline.errorRate + 0.1;
  }));
  const providerRefs = degradedDependencies.map((status, index) => ref(`provider:${index}:${status.provider}:${status.component ?? 'all'}`, `${status.provider} ${status.state}; ${status.scope} scope${status.fixture ? ' (fixture)' : ''}`));
  const providerImpactProbe = probes.some(probe => probe.outcome === 'unavailable' || probe.outcome === 'degraded'
    ? degradedDependencies.some(status => probe.dependsOnProvider === status.provider) : false);
  const healthyControlRoutes = probes.filter(probe => probe.outcome === 'healthy' && probe.dependsOnProvider === null);
  const providerFor = [...providerRefs, ...probes.filter(probe => providerImpactProbe && probe.dependsOnProvider !== null).map((probe, index) => ref(`probe:${index}:${probe.route}`, `failed route depends on ${probe.dependsOnProvider}`))];
  const providerAgainst = healthyControlRoutes.map((probe, index) => ref(`probe:control:${index}:${probe.route}`, `healthy control route independent of provider ${probe.route}`));
  if (!isStale && (providerFor.length > 0 || input.providerStatuses.length > 0)) {
    const scoped = providerRefs.length > 0;
    const status: HypothesisStatus = providerImpactProbe && scoped && providerAgainst.length === 0 ? 'supported'
      : providerFor.length > 0 ? 'weak' : 'contradicted';
    hypotheses.push({ kind: 'provider_dependency', status, confidence: status === 'supported' && providerFor.length > 1 ? 'high' : status === 'supported' ? 'medium' : 'low',
      ruleIds: ['provider.scope_match.v1', ...(providerImpactProbe ? ['provider.compatible_impact.v1'] : []), ...(providerAgainst.length ? ['provider.healthy_control.v1'] : [])],
      evidenceFor: providerFor, evidenceAgainst: providerAgainst,
      missingData: scoped ? providerImpactProbe ? [] : ['Customer impact probe or metric compatible with the dependency'] : ['Verified dependency with matching region/component status'],
      nextCheck: 'Compare an authorized route that depends on this provider with an independent control route.' });
  }
  if (!isStale && (releaseEvidence.length > 0 || errors.length > 0)) {
    const regressionSupported = releaseServiceError.length > 0 && degradedDependencies.length === 0;
    const regressionConflict = releaseServiceError.length > 0 && degradedDependencies.length > 0;
    hypotheses.push({ kind: 'application_regression', status: regressionSupported ? 'supported' : releaseEvidence.length > 0 && errors.length > 0 ? 'weak' : 'contradicted',
      confidence: regressionSupported ? 'medium' : 'low', ruleIds: ['release.within_window.v1', 'errors.same_service.v1', ...(degradedDependencies.length ? ['dependency.alternative_open.v1'] : [])],
      evidenceFor: releaseEvidence.map((deployment, index) => ref(`deployment:${index}:${deployment.releaseId ?? 'unknown'}`, `${deployment.service} deployed ${deployment.deployedAt}`)),
      evidenceAgainst: regressionConflict ? providerRefs : [],
      missingData: releaseServiceError.length ? [] : ['Verified deployment and error rise on the same service'], nextCheck: 'Compare the affected service against its pre-release baseline and dependency health.' });
  }
  const abuseRaised = authFailures.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && sample.value >= Math.max(baseline.authFailures * 2, baseline.authFailures + 10);
  });
  if (!isStale && (authFailures.length > 0 || input.anomalies.some(anomaly => /auth|enumerat/i.test(anomaly)))) {
    hypotheses.push({ kind: 'abuse', status: abuseRaised ? 'supported' : 'weak', confidence: abuseRaised ? 'medium' : 'low',
      ruleIds: ['auth.failure_increase.v1'], evidenceFor: abuseRaised ? authFailures.map((_, index) => ref(`auth:${index}`, 'Authentication failures exceed service baseline')) : [],
      evidenceAgainst: [], missingData: abuseRaised ? ['Successful access or account impact remains unverified'] : ['Fresh authentication failure series and service baseline'],
      nextCheck: 'Check bounded success/failure outcomes and scoped actor coverage.' });
  }
  const trafficIncrease = requests.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && baseline.requestRate > 0 && sample.value >= baseline.requestRate * 2;
  });
  if (!isStale && trafficIncrease) {
    const noDegradation = !metricsDegraded && !degradedProbe && !unavailable;
    hypotheses.push({ kind: 'legitimate_load', status: noDegradation ? 'supported' : 'weak', confidence: noDegradation ? 'medium' : 'low',
      ruleIds: ['traffic.increase.v1', ...(noDegradation ? ['traffic.no_degradation.v1'] : [])],
      evidenceFor: requests.map((_, index) => ref(`request-rate:${index}`, 'Request rate is at least twice its baseline')),
      evidenceAgainst: noDegradation ? [] : [ref('impact:degraded', 'Error, latency, or probe degradation is also observed')],
      missingData: [], nextCheck: noDegradation ? 'Confirm the increase remains within expected business activity; no capacity change is indicated.' : 'Separate traffic growth from the concurrent service degradation.' });
  }
  const unknownInvestigable = [...input.anomalies.filter(anomaly => !/auth|enumerat/i.test(anomaly)), ...(input.anomalies.length === 0 && hypotheses.length === 0 ? ['No catalog scenario is supported by the available evidence.'] : [])].sort();
  if (isStale || unknownInvestigable.length > 0 || hypotheses.length === 0) {
    hypotheses.push({ kind: 'unknown', status: isStale || unknownInvestigable.length > 0 ? 'weak' : 'withdrawn', confidence: 'low',
      ruleIds: [isStale ? 'telemetry.stale.abstain.v1' : 'scenario.unknown.investigable.v1'], evidenceFor: [], evidenceAgainst: [],
      missingData: isStale ? ['Fresh telemetry is required; impact is unknown until then.'] : ['Catalog-matched signals and baseline'],
      nextCheck: 'Collect fresh, scoped signals for the affected service and environment.' });
  }
  if (isStale) {
    for (const hypothesis of hypotheses) {
      if (hypothesis.kind !== 'unknown') hypotheses[hypotheses.indexOf(hypothesis)] = { ...hypothesis, status: 'weak', confidence: 'low', ruleIds: [...hypothesis.ruleIds, 'telemetry.stale.abstain.v1'] };
    }
  }
  const orderedKinds: readonly HypothesisKind[] = ['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown'];
  hypotheses.sort((a, b) => orderedKinds.indexOf(a.kind) - orderedKinds.indexOf(b.kind));
  const inputDigest = digest(input);
  const id = digest({ rulesVersion: options.rulesVersion, inputDigest });
  return { id, revision: 1, previousRevisionId: null, rulesVersion: options.rulesVersion, inputDigest,
    impact: { observed: impact, affectedServices, window: input.window, checkedPoints }, hypotheses, unknownInvestigable };
}

export function revise(previous: TriageRevision, newInput: CorrelationWindowInput | unknown, options: CorrelationOptions): TriageRevision {
  const next = correlate(newInput, options);
  return { ...next, id: digest({ previous: previous.id, next: next.id }), revision: previous.revision + 1, previousRevisionId: previous.id };
}

export function canonicalTriageJson(revision: TriageRevision): string { return canonical(revision); }
