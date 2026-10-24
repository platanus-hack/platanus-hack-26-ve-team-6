import { createHash } from 'node:crypto';
import { correlationWindowInputSchema, type CorrelationWindowInput } from './inputs.js';
import { triageRevisionSchema, type EvidenceRef, type Hypothesis, type HypothesisKind, type HypothesisStatus, type ImpactObservation, type TriageRevision } from './output.js';
export { confidenceSchema, evidenceRefSchema, hypothesisKindSchema, hypothesisSchema, hypothesisStatusSchema, impactObservationSchema, triageImpactSchema, triageRevisionSchema } from './output.js';
export type { Confidence, EvidenceRef, Hypothesis, HypothesisKind, HypothesisStatus, ImpactObservation, TriageRevision } from './output.js';
export interface CorrelationOptions { readonly now: Date | string; readonly rulesVersion: string }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function ref(refValue: string, detail: string): EvidenceRef { return { ref: refValue, detail }; }
function baselineFor(input: CorrelationWindowInput, service: string, environment: string) {
  return input.baselines.find(item => item.service === service && item.environment === environment);
}
function errorThreshold(input: CorrelationWindowInput, service: string, environment: string, value: number): boolean {
  const baseline = baselineFor(input, service, environment);
  return baseline !== undefined && value >= baseline.errorRate + 0.1;
}
function latencyThreshold(input: CorrelationWindowInput, service: string, environment: string, value: number): boolean {
  const baseline = baselineFor(input, service, environment);
  return baseline !== undefined && value >= Math.max(baseline.latencyMs * 1.5, baseline.latencyMs + 100);
}
function isStale(series: CorrelationWindowInput['signals'][number], nowMs: number): boolean {
  const latestAcceptedAt = Math.max(...series.samples.map(sample => Date.parse(sample.acceptedAt)));
  const latestEventAt = Math.max(...series.samples.map(sample => Date.parse(sample.eventAt)));
  return nowMs - latestAcceptedAt > series.freshnessMs || nowMs - latestEventAt > series.freshnessMs;
}

export function correlate(inputValue: unknown, options: CorrelationOptions): TriageRevision {
  const input = correlationWindowInputSchema.parse(inputValue);
  const nowMs = typeof options.now === 'string' ? Date.parse(options.now) : options.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('invalid_correlation_now');
  if (!options.rulesVersion.trim() || options.rulesVersion.length > 64) throw new Error('invalid_rules_version');
  const inWindow = (time: string) => Date.parse(time) >= Date.parse(input.window.startedAt) && Date.parse(time) <= Date.parse(input.window.endedAt);
  const staleSeries = input.signals.filter(series => isStale(series, nowMs));
  const staleIds = new Set(staleSeries.map(series => series.id));
  const freshSignals = input.signals.filter(series => !staleIds.has(series.id));
  const freshSamples = freshSignals.flatMap((series, seriesIndex) => series.samples
    .filter(sample => inWindow(sample.eventAt))
    .map((sample, sampleIndex) => ({ series, sample, ref: ref(`signal:${seriesIndex}:${sampleIndex}:${series.id}`, `${series.metric} accepted at ${sample.acceptedAt}`) })));
  const probes = input.probes.filter(probe => inWindow(probe.at));
  const impactProbes = probes.filter(probe => probe.outcome !== 'unknown');
  const usableMetrics = freshSamples.filter(({ series }) => series.metric === 'error_rate' || series.metric === 'latency_ms');
  const missingData: string[] = [];
  for (const { series } of usableMetrics) {
    if (baselineFor(input, series.service, series.environment) === undefined) {
      const missing = `Baseline missing for ${series.service}/${series.environment}; metric cannot establish healthy impact.`;
      if (!missingData.includes(missing)) missingData.push(missing);
    }
  }
  if (staleSeries.length > 0) missingData.push(`Stale telemetry excluded: ${staleSeries.map(series => series.id).sort().join(', ')}.`);

  const errors = freshSamples.filter(({ series }) => series.metric === 'error_rate');
  const requests = freshSamples.filter(({ series }) => series.metric === 'request_rate');
  const authFailures = freshSamples.filter(({ series }) => series.metric === 'auth_failures');
  const staleSamples = staleSeries.flatMap((series, seriesIndex) => series.samples
    .filter(sample => inWindow(sample.eventAt))
    .map((sample, sampleIndex) => ({ series, sample, ref: ref(`stale-signal:${seriesIndex}:${sampleIndex}:${series.id}`, `${series.metric} sample excluded because its series is stale`) })));
  const degradedMetricSamples = usableMetrics.filter(({ series, sample }) => series.metric === 'error_rate'
    ? errorThreshold(input, series.service, series.environment, sample.value)
    : latencyThreshold(input, series.service, series.environment, sample.value));
  const unavailable = impactProbes.some(probe => probe.outcome === 'unavailable');
  const degradedProbe = impactProbes.some(probe => probe.outcome === 'degraded');
  const checkedPoints = [...impactProbes.map((probe, index) => ref(`probe:${index}:${probe.route}`, `HTTPS ${probe.outcome} for ${probe.route}`)),
    ...freshSamples.map(({ ref: sampleRef }) => sampleRef)];
  const hasFreshImpactEvidence = impactProbes.length > 0 || usableMetrics.some(({ series, sample }) =>
    baselineFor(input, series.service, series.environment) !== undefined);
  const impact: ImpactObservation = !hasFreshImpactEvidence ? 'unknown'
    : unavailable ? 'unavailable' : degradedProbe || degradedMetricSamples.length > 0 ? 'degraded' : 'none_observed_at_checked_points';
  const affectedServices = [...new Set([
    ...impactProbes.filter(probe => probe.outcome === 'unavailable' || probe.outcome === 'degraded').map(probe => probe.service),
    ...degradedMetricSamples.map(({ series }) => series.service),
  ])].sort();

  const hypotheses: Hypothesis[] = [];
  const providerStatuses = input.providerStatuses.filter(status => status.state !== 'operational' && status.state !== 'unknown'
    && nowMs - Date.parse(status.observedAt) <= 30 * 60_000 && inWindow(status.observedAt));
  const verifiedDependencies = input.context?.dependencies.filter(dependency => dependency.state === 'verified') ?? [];
  const matchingProviderStatuses = providerStatuses.flatMap(status => {
    const dependencies = verifiedDependencies.filter(dependency => dependency.provider === status.provider && (
      status.scope === 'global' || status.scope === 'regional' && status.region !== null && dependency.region === status.region
      || status.scope === 'component' && status.component !== null && dependency.component === status.component));
    return dependencies.map(dependency => ({ status, dependency }));
  });
  const failingDependentProbes = probes.filter(probe => (probe.outcome === 'unavailable' || probe.outcome === 'degraded')
    && matchingProviderStatuses.some(({ status, dependency }) => probe.dependsOnProvider === status.provider && probe.service === dependency.service));
  const healthyDependentProbes = probes.filter(probe => probe.outcome === 'healthy'
    && matchingProviderStatuses.some(({ status, dependency }) => probe.dependsOnProvider === status.provider && probe.service === dependency.service));
  const independentControlProbes = probes.filter(probe => probe.role === 'control' && probe.dependsOnProvider === null);
  const healthyControls = independentControlProbes.filter(probe => probe.outcome === 'healthy');
  const failingControls = independentControlProbes.filter(probe => probe.outcome === 'degraded' || probe.outcome === 'unavailable');
  const providerEvidence = matchingProviderStatuses.map(({ status, dependency }, index) => ({
    status, dependency, evidence: ref(`provider:${index}:${status.provider}:${status.component ?? 'all'}`,
      `${status.provider} ${status.state}; ${status.scope} scope${status.fixture ? ' (fixture)' : ''}`),
  }));
  if (providerStatuses.length > 0) {
    const providerFor = [
      ...providerEvidence.map(item => item.evidence),
      ...failingDependentProbes.map((probe, index) => ref(`probe:dependent:${index}:${probe.route}`, `failing route depends on degraded provider ${probe.dependsOnProvider}`)),
      ...healthyControls.map((probe, index) => ref(`probe:control:${index}:${probe.route}`, `healthy independent control route ${probe.route} isolates the dependent failure`)),
    ];
    const providerAgainst = [
      ...healthyDependentProbes.map((probe, index) => ref(`probe:dependent-healthy:${index}:${probe.route}`, `dependent route ${probe.route} is healthy despite provider degradation`)),
      ...failingControls.map((probe, index) => ref(`probe:control-failing:${index}:${probe.route}`, `independent control route ${probe.route} also fails; cause is not provider-specific`)),
    ];
    const hasCompatibleFailure = failingDependentProbes.length > 0;
    const hasScopedMatch = providerEvidence.some(({ status }) => status.scope !== 'global');
    const hasIsolation = healthyControls.length > 0 && failingControls.length === 0;
    const status: HypothesisStatus = hasCompatibleFailure && providerAgainst.length === 0 ? 'supported'
      : healthyDependentProbes.length > 0 ? 'contradicted'
      : providerEvidence.length > 0 ? 'weak' : 'contradicted';
    const confidence = status !== 'supported' ? 'low' : hasScopedMatch && hasIsolation ? 'high' : 'medium';
    const providerMissing = providerEvidence.length === 0 ? ['Verified dependency with matching region/component status']
      : !hasCompatibleFailure ? ['Failing HTTPS route compatible with the dependency']
      : failingControls.length > 0 ? ['Independent control route health; current control failure points to app-wide impact'] : [];
    hypotheses.push({ kind: 'provider_dependency', status, confidence,
      ruleIds: ['provider.scope_match.v1', ...(hasCompatibleFailure ? ['provider.compatible_impact.v1'] : []),
        ...(hasIsolation ? ['provider.control_isolates.v1'] : []),
        ...(healthyDependentProbes.length ? ['provider.dependent_healthy.contradicts.v1'] : []),
        ...(failingControls.length ? ['provider.control_failing.contradicts_specific_cause.v1'] : [])],
      evidenceFor: providerFor, evidenceAgainst: providerAgainst, missingData: providerMissing,
      nextCheck: 'Compare an authorized route that depends on this provider with an independent control route.' });
  }

  const deployments = input.context?.deployments ?? [];
  const deploymentUnknown = deployments.filter(deployment => deployment.state === 'unknown');
  const declaredDeployments = deployments.filter(deployment => deployment.state === 'declared');
  const releaseCandidates = deployments.filter(deployment => deployment.state === 'verified' || deployment.state === 'declared');
  const releaseMatches = releaseCandidates.flatMap(deployment => {
    const matchingErrors = errors.filter(({ series, sample }) => series.service === deployment.service
      && sample.eventAt > deployment.deployedAt && errorThreshold(input, series.service, series.environment, sample.value));
    const earlierErrors = errors.filter(({ series, sample }) => series.service === deployment.service
      && sample.eventAt <= deployment.deployedAt && errorThreshold(input, series.service, series.environment, sample.value));
    return matchingErrors.length > 0 || earlierErrors.length > 0 ? [{ deployment, matchingErrors, earlierErrors }] : [];
  });
  const declaredReleaseMatches = releaseMatches.filter(item => item.deployment.state === 'declared');
  const verifiedReleaseMatches = releaseMatches.filter(item => item.deployment.state === 'verified');
  const verifiedAfterRelease = verifiedReleaseMatches.filter(item => item.matchingErrors.length > 0);
  const staleReleaseEvidence = staleSamples.filter(({ series, sample }) => series.metric === 'error_rate'
    && errorThreshold(input, series.service, series.environment, sample.value)
    && releaseCandidates.some(deployment => deployment.service === series.service && sample.eventAt > deployment.deployedAt));
  const anyElevatedAfterRelease = releaseMatches.some(item => item.matchingErrors.length > 0);
  const anyElevatedBeforeRelease = releaseMatches.some(item => item.earlierErrors.length > 0);
  if (releaseCandidates.length > 0 || errors.some(({ series, sample }) => errorThreshold(input, series.service, series.environment, sample.value)) || deploymentUnknown.length > 0 || staleReleaseEvidence.length > 0) {
    const supported = verifiedAfterRelease.some(item => item.earlierErrors.length === 0) && failingControls.length === 0;
    const weak = !supported && (declaredDeployments.length > 0 || verifiedAfterRelease.length > 0 || failingControls.length > 0 || staleReleaseEvidence.length > 0);
    const evidenceFor = releaseMatches.flatMap(({ deployment, matchingErrors }, index) => [
      ref(`deployment:${index}:${deployment.releaseId ?? 'unknown'}`, `${deployment.state} deployment of ${deployment.service} at ${deployment.deployedAt}`),
      ...matchingErrors.map(({ sample }) => ref(`release-error:${deployment.service}:${sample.eventAt}`, `error sample after deployment at ${sample.eventAt}`)),
    ]);
    const evidenceAgainst = anyElevatedBeforeRelease ? releaseMatches.flatMap(({ deployment, earlierErrors }, index) => earlierErrors.map(({ sample }) =>
      ref(`pre-release-error:${index}:${sample.eventAt}`, `elevated errors started at ${sample.eventAt}, before deployment at ${deployment.deployedAt}`))) : [];
    hypotheses.push({ kind: 'application_regression', status: supported ? 'supported' : weak ? 'weak' : 'contradicted',
      confidence: supported ? 'medium' : 'low',
      ruleIds: ['release.verified.v1', 'release.errors_after_deployment.v1', ...(anyElevatedBeforeRelease ? ['release.errors_precede_deployment.v1'] : []),
        ...(failingControls.length ? ['release.app_wide_failure.alternative.v1'] : []),
        ...(staleReleaseEvidence.length > 0 && verifiedAfterRelease.length === 0 ? ['telemetry.stale.excluded.v1'] : [])],
      evidenceFor, evidenceAgainst,
      missingData: [
        ...(declaredReleaseMatches.length ? ['Verify deployment identity and deployedAt before attributing a regression.'] : []),
        ...(declaredDeployments.length && declaredReleaseMatches.length === 0 ? ['Verify deployment identity and deployedAt before attributing a regression.'] : []),
        ...(deploymentUnknown.length ? [`Ignored deployments with unknown state: ${deploymentUnknown.map(item => item.service).join(', ')}.`] : []),
        ...(!anyElevatedAfterRelease && !anyElevatedBeforeRelease ? ['Verified deployment and post-deployment error rise on the same service'] : []),
        ...(staleReleaseEvidence.length > 0 && verifiedAfterRelease.length === 0 ? ['Fresh error telemetry is required; stale errors were excluded.'] : []),
      ],
      nextCheck: 'Compare the affected service against its pre-release baseline and dependency health.' });
  }

  const abuseRaised = authFailures.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && sample.value >= Math.max(baseline.authFailures * 2, baseline.authFailures + 10);
  });
  const staleAbuseEvidence = staleSamples.some(({ series, sample }) => {
    if (series.metric !== 'auth_failures') return false;
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && sample.value >= Math.max(baseline.authFailures * 2, baseline.authFailures + 10);
  });
  if (authFailures.length > 0 || staleAbuseEvidence || input.anomalies.some(anomaly => /auth|enumerat/i.test(anomaly))) {
    hypotheses.push({ kind: 'abuse', status: abuseRaised ? 'supported' : 'weak', confidence: abuseRaised ? 'medium' : 'low',
      ruleIds: ['auth.failure_increase.v1', ...(staleAbuseEvidence ? ['telemetry.stale.excluded.v1'] : [])],
      evidenceFor: abuseRaised ? authFailures.map((_, index) => ref(`auth:${index}`, 'Authentication failures exceed service baseline')) : [],
      evidenceAgainst: [], missingData: abuseRaised ? ['Successful access or account impact remains unverified'] : ['Fresh authentication failure series and service baseline'],
      nextCheck: 'Check bounded success/failure outcomes and scoped actor coverage.' });
  }
  const trafficIncrease = requests.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return baseline !== undefined && baseline.requestRate > 0 && sample.value >= baseline.requestRate * 2;
  });
  const staleTrafficIncrease = staleSamples.some(({ series, sample }) => {
    const baseline = baselineFor(input, series.service, series.environment);
    return series.metric === 'request_rate' && baseline !== undefined && baseline.requestRate > 0 && sample.value >= baseline.requestRate * 2;
  });
  if (trafficIncrease || staleTrafficIncrease) {
    const noDegradation = degradedMetricSamples.length === 0 && !degradedProbe && !unavailable;
    const loadSupported = noDegradation && trafficIncrease;
    hypotheses.push({ kind: 'legitimate_load', status: loadSupported ? 'supported' : 'weak', confidence: loadSupported ? 'medium' : 'low',
      ruleIds: ['traffic.increase.v1', ...(loadSupported ? ['traffic.no_degradation.v1'] : []), ...(trafficIncrease ? [] : ['telemetry.stale.excluded.v1'])],
      evidenceFor: trafficIncrease ? requests.map((_, index) => ref(`request-rate:${index}`, 'Request rate is at least twice its baseline')) : [],
      evidenceAgainst: noDegradation ? [] : [ref('impact:degraded', 'Error, latency, or probe degradation is also observed')],
      missingData: trafficIncrease ? [] : ['Fresh request-rate telemetry is required; stale traffic samples were excluded.'],
      nextCheck: noDegradation && trafficIncrease ? 'Confirm the increase remains within expected business activity; no capacity change is indicated.' : 'Separate traffic growth from the concurrent service degradation.' });
  }

  const unknownInvestigable = [...input.anomalies.filter(anomaly => !/auth|enumerat/i.test(anomaly)),
    ...(failingControls.length ? ['Independent control route also fails; investigate app-wide failure.'] : []),
    ...(input.anomalies.length === 0 && hypotheses.length === 0 ? ['No catalog scenario is supported by the available evidence.'] : [])].sort();
  if (unknownInvestigable.length > 0 || hypotheses.length === 0 || staleSeries.length > 0) {
    hypotheses.push({ kind: 'unknown', status: staleSeries.length > 0 || unknownInvestigable.length > 0 ? 'weak' : 'withdrawn', confidence: 'low',
      ruleIds: [staleSeries.length > 0 ? 'telemetry.stale.excluded.v1' : 'scenario.unknown.investigable.v1'], evidenceFor: [], evidenceAgainst: [],
      missingData: staleSeries.length > 0 ? ['Fresh telemetry is required for the excluded signal series.'] : ['Catalog-matched signals and baseline'],
      nextCheck: 'Collect fresh, scoped signals for the affected service and environment.' });
  }
  for (let index = 0; index < hypotheses.length; index++) {
    const hypothesis = hypotheses[index];
    if (hypothesis && hypothesis.kind !== 'unknown' && staleSeries.length > 0) {
      const reliesOnlyOnStale = hypothesis.evidenceFor.length === 0;
      if (reliesOnlyOnStale) hypotheses[index] = { ...hypothesis, status: 'weak', confidence: 'low', ruleIds: [...hypothesis.ruleIds, 'telemetry.stale.excluded.v1'] };
    }
  }
  const orderedKinds: readonly HypothesisKind[] = ['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown'];
  hypotheses.sort((a, b) => orderedKinds.indexOf(a.kind) - orderedKinds.indexOf(b.kind));
  const inputDigest = digest(input);
  const id = digest({ rulesVersion: options.rulesVersion, inputDigest });
  return triageRevisionSchema.parse({ id, revision: 1, previousRevisionId: null, rulesVersion: options.rulesVersion, inputDigest,
    impact: { observed: impact, affectedServices, window: input.window, checkedPoints, missingData }, hypotheses, unknownInvestigable });
}

export function revise(previous: TriageRevision, newInput: unknown, options: CorrelationOptions): TriageRevision {
  const next = correlate(newInput, options);
  return triageRevisionSchema.parse({ ...next, id: digest({ previous: previous.id, next: next.id }), revision: previous.revision + 1, previousRevisionId: previous.id });
}

export function canonicalTriageJson(revision: TriageRevision): string { return canonical(revision); }
