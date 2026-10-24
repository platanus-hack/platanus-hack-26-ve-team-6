import { correlate, type HypothesisKind } from './correlate.js';
import { holdoutCases, tuningCases, evaluationNow, type LabeledCase } from '../corpus/cases.js';

export interface ScenarioMetrics {
  readonly scenario: string;
  readonly cases: number;
  readonly truePositives: number;
  readonly predictedPositives: number;
  readonly actualPositives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly falseAlarms: number;
  readonly abstained: number;
  readonly abstentionRate: number;
  readonly confidenceErrors: number;
  readonly confidenceDenominator: number;
}
export interface EvaluationReport {
  readonly corpusVersion: '1.0.0';
  readonly rulesVersion: string;
  readonly split: 'tuning' | 'holdout';
  readonly caseCount: number;
  readonly scenarios: readonly ScenarioMetrics[];
}
const allKinds: readonly HypothesisKind[] = ['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown'];
function metricsFor(scenario: string, cases: readonly LabeledCase[], rulesVersion: string): ScenarioMetrics {
  let truePositives = 0;
  let predictedPositives = 0;
  let actualPositives = 0;
  let falseAlarms = 0;
  let abstained = 0;
  let confidenceErrors = 0;
  let confidenceDenominator = 0;
  for (const labeled of cases) {
    const result = correlate(labeled.input, { now: evaluationNow, rulesVersion });
    const predicted = new Set(result.hypotheses.filter(item => item.status === 'supported').map(item => item.kind));
    const expected = new Set(labeled.truth.causes);
    for (const kind of allKinds) {
      const expectedPositive = expected.has(kind);
      const predictedPositive = predicted.has(kind);
      if (expectedPositive) actualPositives++;
      if (predictedPositive) predictedPositives++;
      if (expectedPositive && predictedPositive) truePositives++;
      if (!expectedPositive && predictedPositive) falseAlarms++;
    }
    if (predicted.size === 0) abstained++;
    if (labeled.expectedConfidence !== undefined) {
      confidenceDenominator++;
      const actualConfidence = result.hypotheses.find(item => expected.has(item.kind) && item.status === 'supported')?.confidence;
      if (actualConfidence !== labeled.expectedConfidence) confidenceErrors++;
    }
  }
  return { scenario, cases: cases.length, truePositives, predictedPositives, actualPositives,
    precision: predictedPositives === 0 ? null : truePositives / predictedPositives,
    recall: actualPositives === 0 ? null : truePositives / actualPositives,
    falseAlarms, abstained, abstentionRate: cases.length === 0 ? 0 : abstained / cases.length,
    confidenceErrors, confidenceDenominator };
}
export function evaluateSplit(split: 'tuning' | 'holdout', rulesVersion = '1.0.0'): EvaluationReport {
  const cases = split === 'tuning' ? tuningCases : holdoutCases;
  const scenarios = [...new Set(cases.map(item => item.scenario))].sort();
  return { corpusVersion: '1.0.0', rulesVersion, split, caseCount: cases.length,
    scenarios: scenarios.map(scenario => metricsFor(scenario, cases.filter(item => item.scenario === scenario), rulesVersion)) };
}
export function evaluateCorpus(rulesVersion = '1.0.0'): readonly EvaluationReport[] {
  return [evaluateSplit('tuning', rulesVersion), evaluateSplit('holdout', rulesVersion)];
}
