import { describe, expect, it } from 'vitest';
import { correlationWindowInputSchema } from '../src/inputs.js';
import { canonicalTriageJson, correlate, revise, type HypothesisKind } from '../src/correlate.js';
import { scenarioCatalog, supportMatrix } from '../src/catalog.js';
import { evaluationNow, holdoutCases, tuningCases } from '../corpus/cases.js';

function result(input: unknown) { return correlate(input, { now: evaluationNow, rulesVersion: 'test-1' }); }
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
    const value = result(labeled.input);
    expect(value.impact.observed).toBe(labeled.truth.impact);
    for (const kind of labeled.truth.causes) expect(value.hypotheses.find(h => h.kind === kind)?.status).toBe('supported');
  });

  it('does not confirm a global feed for a regional dependency', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-incomplete-regional-feed');
    if (!labeled) throw new Error('missing_test_case');
    const value = result({ ...labeled.input, providerStatuses: [{ provider: 'railway', component: null, region: null, state: 'major_outage', observedAt: '2026-10-24T11:03:00.000Z', scope: 'global', fixture: true }] });
    expect(value.hypotheses.find(item => item.kind === 'provider_dependency')?.status).toBe('weak');
  });

  it('keeps both release and provider hypotheses open when dependency degradation coincides', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-two-causes');
    if (!labeled) throw new Error('missing_test_case');
    const base = tuningCases.find(item => item.id === 'tuning-provider-compatible-impact');
    if (!base) throw new Error('missing_test_case');
    const value = result({ ...labeled.input, context: { ...labeled.input.context!, deployments: labeled.input.context!.deployments, dependencies: base.input.context!.dependencies }, providerStatuses: base.input.providerStatuses, probes: base.input.probes });
    expect(value.hypotheses.find(item => item.kind === 'application_regression')?.status).toBe('weak');
    expect(value.hypotheses.find(item => item.kind === 'provider_dependency')?.status).toBe('supported');
    expect(supportedKinds(value)).toContain('abuse');
  });

  it('uses independent healthy control routes as evidence against provider impact', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-provider-compatible-impact');
    if (!labeled) throw new Error('missing_test_case');
    const value = result({ ...labeled.input, probes: [...labeled.input.probes, { route: '/health', service: 'checkout', dependsOnProvider: null, outcome: 'healthy', at: '2026-10-24T11:04:40.000Z' }] });
    expect(value.hypotheses.find(item => item.kind === 'provider_dependency')?.evidenceAgainst).toHaveLength(1);
  });

  it('does not recommend capacity changes for traffic growth without degradation', () => {
    const labeled = tuningCases.find(item => item.id === 'tuning-legitimate-increase');
    if (!labeled) throw new Error('missing_test_case');
    const value = result(labeled.input);
    expect(value.hypotheses.find(item => item.kind === 'legitimate_load')).toMatchObject({ status: 'supported', confidence: 'medium' });
    expect(value.hypotheses.find(item => item.kind === 'legitimate_load')?.nextCheck).toContain('no capacity change');
  });

  it('is deterministic and exposes exhaustive hypothesis kinds', () => {
    const labeled = holdoutCases[0];
    if (!labeled) throw new Error('missing_test_case');
    expect(canonicalTriageJson(result(labeled.input))).toBe(canonicalTriageJson(result(labeled.input)));
    expect((['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown'] as const).map(exhaustive)).toHaveLength(5);
  });

  it('creates immutable, linked revisions', () => {
    const before = result(tuningCases[0]?.input);
    const snapshot = canonicalTriageJson(before);
    const after = revise(before, tuningCases[1]?.input, { now: evaluationNow, rulesVersion: 'test-2' });
    expect(canonicalTriageJson(before)).toBe(snapshot);
    expect(after).toMatchObject({ revision: 2, previousRevisionId: before.id, rulesVersion: 'test-2' });
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
