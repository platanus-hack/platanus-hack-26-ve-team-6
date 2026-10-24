import { describe, expect, it } from 'vitest';
import { correlationWindowInputSchema } from '../src/inputs.js';
import { canonicalTriageJson, correlate, revise, triageRevisionSchema, type HypothesisKind } from '../src/correlate.js';
import { scenarioCatalog, supportMatrix } from '../src/catalog.js';
import { evaluationNow, holdoutCases, tuningCases } from '../corpus/cases.js';

function result(input: unknown, now = evaluationNow) { return correlate(input, { now, rulesVersion: 'test-1' }); }
function forCase(labeled: (typeof tuningCases)[number]) {
  return result(labeled.input, new Date(Date.parse(labeled.input.window.endedAt) + 60_000).toISOString());
}
function supportedKinds(value: ReturnType<typeof result>): HypothesisKind[] {
  return value.hypotheses.filter(item => item.status === 'supported').map(item => item.kind);
}
function exhaustive(kind: HypothesisKind): string {
  switch (kind) {
    case 'application_regression': return 'regression';
    case 'abuse': return 'abuse';
    case 'provider_dependency': return 'provider';
    case 'legitimate_load': return 'load';
    case 'unknown': return 'unknown';
    default: { const neverKind: never = kind; return neverKind; }
  }
}

describe('scenario catalog', () => {
  it('versions all requested scenarios with declared support and guidance', () => {
    expect(scenarioCatalog).toHaveLength(13);
    expect(scenarioCatalog.every(item => item.version && item.preconditions.length && item.requiredSignals.length && item.contraryEvidence.length && item.minimumCoverage.length && item.severityRules.length && item.confidenceRules.length && item.responseOptions.every(option => option.adapter === 'none' || option.adapter.length > 0) && item.stopConditions.length && item.reason)).toBe(true);
    expect(supportMatrix()).toHaveLength(13);
  });
});

describe('correlation acceptance cases', () => {
  it.each([...tuningCases, ...holdoutCases])('evaluates $id using independent impact and cause labels', labeled => {
    const value = forCase(labeled);
    expect(value.impact.observed).toBe(labeled.truth.impact);
    for (const kind of labeled.truth.causes) expect(value.hypotheses.find(h => h.kind === kind)?.status).toBe('supported');
  });

  it('keeps holdout inputs independent from every tuning input', () => {
    expect(tuningCases.length).toBeGreaterThanOrEqual(14);
    expect(holdoutCases.length).toBeGreaterThanOrEqual(14);
    const tuningDigests = new Set(tuningCases.map(item => forCase(item).inputDigest));
    expect(holdoutCases.map(item => forCase(item).inputDigest).some(digest => tuningDigests.has(digest))).toBe(false);
  });

  it('does not confirm a global feed for a regional dependency without a failing dependent route', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-global-with-failing-route');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase({ ...labeled, input: { ...labeled.input, probes: [] } });
    expect(value.hypotheses.find(item => item.kind === 'provider_dependency')).toMatchObject({ status: 'weak', confidence: 'low' });
  });

  it('keeps abuse and legitimate load as simultaneous hypotheses', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-abuse-and-load');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase(labeled);
    expect(supportedKinds(value)).toEqual(expect.arrayContaining(['abuse', 'legitimate_load']));
  });

  it('uses a healthy independent control route to isolate provider impact', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-provider-isolated');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase(labeled);
    expect(value.hypotheses.find(item => item.kind === 'provider_dependency')).toMatchObject({ status: 'supported', confidence: 'high', ruleIds: expect.arrayContaining(['provider.control_isolates.v1']) });
  });

  it('keeps app-wide failures from confirming a provider-specific cause', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-app-wide-control-fails');
    if (!labeled) throw new Error('missing_test_case');
    const provider = result(labeled.input, new Date(Date.parse(labeled.input.window.endedAt) + 60_000).toISOString()).hypotheses.find(item => item.kind === 'provider_dependency');
    expect(provider?.status).toBe('weak');
    expect(provider?.ruleIds).toContain('provider.control_failing.contradicts_specific_cause.v1');
  });

  it('requires a failing dependent route before a global provider feed can support a cause', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-global-with-failing-route');
    if (!labeled) throw new Error('missing_test_case');
    const noRoute = { ...labeled.input, probes: [] };
    const provider = forCase({ ...labeled, input: noRoute }).hypotheses.find(item => item.kind === 'provider_dependency');
    expect(provider).toMatchObject({ status: 'weak', confidence: 'low' });
  });

  it('does not treat high errors without a baseline as healthy impact', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-missing-baseline');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase(labeled);
    expect(value.impact.observed).toBe('unknown');
    expect(value.impact.missingData.join(' ')).toContain('Baseline missing');
  });

  it('keeps fresh probe impact when a metrics series is stale', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-fresh-probe-stale-series');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase(labeled);
    expect(value.impact.observed).toBe('unavailable');
    expect(value.impact.missingData.join(' ')).toContain('Stale telemetry excluded');
    expect(value.hypotheses.find(item => item.kind === 'unknown')?.ruleIds).toContain('telemetry.stale.excluded.v1');
  });

  it('downgrades hypotheses based only on stale samples', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-stale-only');
    if (!labeled) throw new Error('missing_test_case');
    const abuse = forCase(labeled).hypotheses.find(item => item.kind === 'abuse');
    expect(abuse).toMatchObject({ status: 'weak', confidence: 'low', ruleIds: expect.arrayContaining(['telemetry.stale.excluded.v1']) });
  });

  it('uses the latest sample timestamps to determine series freshness', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-release-after-deploy');
    if (!labeled) throw new Error('missing_test_case');
    const input = {
      ...labeled.input,
      window: { startedAt: '2026-10-24T11:00:00.000Z', endedAt: '2026-10-24T13:00:00.000Z' },
      signals: [{
        ...labeled.input.signals[0]!,
        metric: 'error_rate' as const,
        freshnessMs: 600_000,
        samples: [
          { eventAt: '2026-10-24T12:00:00.000Z', acceptedAt: '2026-10-24T12:00:02.000Z', value: 0.3 },
          { eventAt: '2026-10-24T12:59:00.000Z', acceptedAt: '2026-10-24T12:59:02.000Z', value: 0.3 },
        ],
      }],
      context: undefined,
      probes: [],
    };
    const fresh = result(input, '2026-10-24T13:00:00.000Z');
    expect(fresh.impact.observed).toBe('degraded');
    expect(fresh.impact.missingData.join(' ')).not.toContain('Stale telemetry excluded');

    const stale = result({ ...input, signals: [{ ...input.signals[0]!, samples: [
      { eventAt: '2026-10-24T12:00:00.000Z', acceptedAt: '2026-10-24T12:00:02.000Z', value: 0.3 },
      { eventAt: '2026-10-24T12:20:00.000Z', acceptedAt: '2026-10-24T12:20:02.000Z', value: 0.3 },
    ] }] }, '2026-10-24T13:00:00.000Z');
    expect(stale.impact.observed).toBe('unknown');
    expect(stale.impact.missingData.join(' ')).toContain('Stale telemetry excluded');
  });

  it('requires errors after a deployment and asks to verify declared deployments', () => {
    const before = tuningCases.find(item => item.id === 'tuning-errors-before-deploy');
    const declared = tuningCases.find(item => item.id === 'tuning-declared-deploy');
    if (!before || !declared) throw new Error('missing_test_case');
    expect(forCase(before).hypotheses.find(item => item.kind === 'application_regression')?.status).toBe('contradicted');
    expect(forCase(declared).hypotheses.find(item => item.kind === 'application_regression')).toMatchObject({ status: 'weak', confidence: 'low' });
    expect(forCase(declared).hypotheses.find(item => item.kind === 'application_regression')?.missingData.join(' ')).toContain('Verify deployment');
  });

  it('keeps a deployment hypothesis weak when elevated errors predate the same release', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-errors-before-deploy');
    if (!labeled) throw new Error('missing_test_case');
    const input = {
      ...labeled.input,
      signals: labeled.input.signals.map(series => series.metric === 'error_rate'
        ? { ...series, samples: [...series.samples, {
          eventAt: '2026-10-24T11:44:00.000Z', acceptedAt: '2026-10-24T11:44:02.000Z', value: 0.35,
        }] }
        : series),
    };
    const regression = result(input, '2026-10-24T11:46:00.000Z').hypotheses.find(item => item.kind === 'application_regression');
    expect(regression).toMatchObject({ status: 'weak', ruleIds: expect.arrayContaining(['release.errors_precede_deployment.v1']) });
    expect(regression?.evidenceAgainst.some(item => item.ref.startsWith('pre-release-error:'))).toBe(true);
  });

  it('ignores unknown deployment state and reports it as missing evidence', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-unknown-deployment');
    if (!labeled) throw new Error('missing_test_case');
    const revision = forCase(labeled);
    const regression = revision.hypotheses.find(item => item.kind === 'application_regression');
    expect(regression?.status).toBe('contradicted');
    expect(regression?.missingData.join(' ')).toContain('unknown state');
  });

  it('does not recommend capacity changes for traffic growth without degradation', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-traffic-without-impact');
    if (!labeled) throw new Error('missing_test_case');
    const value = forCase(labeled);
    expect(value.hypotheses.find(item => item.kind === 'legitimate_load')).toMatchObject({ status: 'supported', confidence: 'medium' });
    expect(value.hypotheses.find(item => item.kind === 'legitimate_load')?.nextCheck).toContain('no capacity change');
  });

  it('is deterministic and exposes exhaustive hypothesis kinds', () => {
    const labeled = holdoutCases[0];
    if (!labeled) throw new Error('missing_test_case');
    expect(canonicalTriageJson(forCase(labeled))).toBe(canonicalTriageJson(forCase(labeled)));
    expect((['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown'] as const).map(exhaustive)).toHaveLength(5);
  });

  it('creates immutable, linked revisions', () => {
    const beforeCase = tuningCases[0];
    if (!beforeCase) throw new Error('missing_test_case');
    const before = forCase(beforeCase);
    const snapshot = canonicalTriageJson(before);
    const afterCase = tuningCases[1];
    if (!afterCase) throw new Error('missing_test_case');
    const after = revise(before, afterCase.input, { now: new Date(Date.parse(afterCase.input.window.endedAt) + 60_000).toISOString(), rulesVersion: 'test-2' });
    expect(canonicalTriageJson(before)).toBe(snapshot);
    expect(after).toMatchObject({ revision: 2, previousRevisionId: before.id, rulesVersion: 'test-2' });
  });

  it('exports a runtime schema for persisted revisions', () => {
    const labeled = tuningCases[0];
    if (!labeled) throw new Error('missing_test_case');
    expect(triageRevisionSchema.parse(forCase(labeled))).toMatchObject({ revision: 1, impact: { observed: 'degraded' } });
  });
});

describe('input bounds', () => {
  it('rejects overlong signal arrays', () => {
    const base = tuningCases[0]?.input;
    if (!base) throw new Error('missing_test_case');
    expect(() => correlationWindowInputSchema.parse({ ...base, signals: Array.from({ length: 101 }, (_, index) => ({
      id: `s-${index}`, metric: 'error_rate', service: 'checkout', environment: 'production', sampling: 1, freshnessMs: 60_000,
      samples: [{ eventAt: '2026-10-24T11:04:00.000Z', acceptedAt: '2026-10-24T11:04:02.000Z', value: 0.1 }],
    })) })).toThrow();
  });
});
