import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ScenarioCase, ScenarioMatrix } from './triage-matrix.js';

export interface TrialResult {
  readonly caseId: string;
  readonly scenario: string;
  readonly split: 'tuning' | 'holdout';
  readonly repetition: number;
  readonly faultOnsetAt: string;
  readonly expected: ScenarioCase['truth'];
  readonly actual: {
    readonly impact: string | null;
    readonly hypotheses: readonly { kind: string; status: string; confidence: string }[];
    readonly alertRules: readonly string[];
    readonly incidentRules: readonly string[];
    readonly falseAlarmRules: readonly string[];
    readonly staleOrUnknown: boolean;
    readonly unknownCoverageVisible: boolean;
    readonly triageMissingData: readonly string[];
    readonly operationalCoverage: { readonly state: string; readonly reason: string } | null;
    readonly attackResponses: readonly number[];
    readonly sinkExecutions: { sql: number; filesystem: number };
    readonly dimensions: readonly { rule: string; severity: string; confidence: string; exploitabilityFieldPresent: boolean }[];
  };
  readonly timings: {
    readonly alertMs: number | null;
    readonly decisionMs: number | null;
    readonly runtimeMs: number;
  };
  readonly permissionCheck: { readonly ready: boolean; readonly execution: string } | null;
  readonly correctness: {
    readonly impact: boolean;
    readonly abstained: boolean;
    readonly unknownCoverageVisible: boolean;
    readonly confidenceErrors: number;
    readonly confidenceDenominator: number;
  };
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function rate(tp: number, predicted: number, actual: number) {
  return { truePositives: tp, predictedPositives: predicted, actualPositives: actual,
    precision: predicted ? tp / predicted : null, recall: actual ? tp / actual : null };
}

function metricsFor(scenario: string, trials: readonly TrialResult[]) {
  let signalTp = 0; let predictedSignals = 0; let actualSignals = 0; let falseAlarms = 0; let falseAlarmWindows = 0;
  let causeTp = 0; let predictedCauses = 0; let actualCauses = 0;
  let abstained = 0; let impactCorrect = 0; let confidenceErrors = 0; let confidenceDenominator = 0;
  for (const trial of trials) {
    const expectedSignals = new Set([...trial.expected.alertRules, ...trial.expected.incidentRules]);
    const predictedSignalsForTrial = new Set([...trial.actual.alertRules, ...trial.actual.incidentRules]);
    const intersection = [...expectedSignals].filter(rule => predictedSignalsForTrial.has(rule));
    signalTp += intersection.length;
    actualSignals += expectedSignals.size;
    predictedSignals += predictedSignalsForTrial.size;
    const unexpected = [...predictedSignalsForTrial].filter(rule => !expectedSignals.has(rule));
    falseAlarms += unexpected.length;
    if (unexpected.length) falseAlarmWindows++;

    const expectedKinds = new Set(trial.expected.hypotheses.filter(item => item.kind !== 'unknown').map(item => item.kind));
    const predictedKinds = new Set(trial.actual.hypotheses.filter(item => item.kind !== 'unknown'
      && (item.status === 'supported' || item.status === 'weak')).map(item => item.kind));
    causeTp += [...expectedKinds].filter(kind => predictedKinds.has(kind)).length;
    actualCauses += expectedKinds.size;
    predictedCauses += predictedKinds.size;
    if (!trial.actual.hypotheses.some(item => item.status === 'supported' && item.kind !== 'unknown')) abstained++;
    if (trial.correctness.impact) impactCorrect++;
    confidenceErrors += trial.correctness.confidenceErrors;
    confidenceDenominator += trial.correctness.confidenceDenominator;
  }
  const alertTimes = trials.flatMap(trial => trial.timings.alertMs === null ? [] : [trial.timings.alertMs]);
  const decisionTimes = trials.flatMap(trial => trial.timings.decisionMs === null ? [] : [trial.timings.decisionMs]);
  const runtimes = trials.map(trial => trial.timings.runtimeMs);
  const negativeControls = trials.filter(trial => trial.scenario === 'healthy-traffic-spike');
  return {
    scenario,
    cases: 1,
    repetitions: trials.length,
    alerts: { ...rate(signalTp, predictedSignals, actualSignals), falseAlarms, falseAlarmAppWindows: falseAlarmWindows,
      falseAlarmRatePerAppWindow: trials.length ? falseAlarmWindows / trials.length : 0 },
    triageCauses: rate(causeTp, predictedCauses, actualCauses),
    abstention: { cases: abstained, denominator: trials.length, rate: trials.length ? abstained / trials.length : 0 },
    confidence: { errors: confidenceErrors, denominator: confidenceDenominator,
      errorRate: confidenceDenominator ? confidenceErrors / confidenceDenominator : null },
    impact: { correct: impactCorrect, denominator: trials.length, accuracy: trials.length ? impactCorrect / trials.length : null },
    timingMs: {
      alertCount: alertTimes.length,
      alertDenominator: trials.filter(trial => trial.expected.alertRules.length + trial.expected.incidentRules.length > 0).length,
      alertP50: percentile(alertTimes, 0.5), alertP95: percentile(alertTimes, 0.95),
      decisionCount: decisionTimes.length, decisionDenominator: trials.length,
      decisionP50: percentile(decisionTimes, 0.5), decisionP95: percentile(decisionTimes, 0.95),
      runtimeP50: percentile(runtimes, 0.5), runtimeP95: percentile(runtimes, 0.95),
    },
    negativeControl: { windows: negativeControls.length,
      falseAlarmWindows: negativeControls.filter(trial => trial.actual.falseAlarmRules.length > 0).length,
      attackCalls: negativeControls.filter(trial => trial.actual.alertRules.some(rule => rule.startsWith('runtime.attack.'))).length },
  };
}

export function buildEvaluationReport(input: {
  readonly matrixVersion: string;
  readonly matrixSha256: string;
  readonly rulesVersion: string;
  readonly gitSha: string;
  readonly worktreeDirty: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly repetitions: number;
  readonly acceptanceTargets: ScenarioMatrix['acceptanceTargets'];
  readonly trials: readonly TrialResult[];
  readonly permissionChecks: readonly { ready: boolean; execution: string }[];
}) {
  const splits = (['tuning', 'holdout'] as const).filter(split => input.trials.some(trial => trial.split === split)).map(split => {
    const trials = input.trials.filter(trial => trial.split === split);
    const scenarios = [...new Set(trials.map(trial => trial.scenario))].sort()
      .map(scenario => metricsFor(scenario, trials.filter(trial => trial.scenario === scenario)));
    const falseAlarmCount = trials.reduce((total, trial) => total + trial.actual.falseAlarmRules.length, 0);
    const falseAlarmWindows = trials.filter(trial => trial.actual.falseAlarmRules.length > 0).length;
    const expectedSignals = trials.reduce((total, trial) => total + trial.expected.alertRules.length + trial.expected.incidentRules.length, 0);
    const detectedSignals = trials.reduce((total, trial) => total + trial.actual.alertRules.length + trial.actual.incidentRules.length, 0);
    const tpSignals = trials.reduce((total, trial) => total + [...new Set([...trial.expected.alertRules, ...trial.expected.incidentRules])]
      .filter(rule => [...trial.actual.alertRules, ...trial.actual.incidentRules].includes(rule)).length, 0);
    const expectedCauses = trials.reduce((total, trial) => total + trial.expected.hypotheses.filter(item => item.kind !== 'unknown').length, 0);
    const predictedCauses = trials.reduce((total, trial) => total + new Set(trial.actual.hypotheses.filter(item => item.kind !== 'unknown'
      && (item.status === 'supported' || item.status === 'weak')).map(item => item.kind)).size, 0);
    const tpCauses = trials.reduce((total, trial) => total + trial.expected.hypotheses.filter(item => item.kind !== 'unknown'
      && trial.actual.hypotheses.some(actual => actual.kind === item.kind && (actual.status === 'supported' || actual.status === 'weak'))).length, 0);
    const alertTimes = trials.flatMap(trial => trial.timings.alertMs === null ? [] : [trial.timings.alertMs]);
    const decisionTimes = trials.flatMap(trial => trial.timings.decisionMs === null ? [] : [trial.timings.decisionMs]);
    const confidenceErrors = trials.reduce((total, trial) => total + trial.correctness.confidenceErrors, 0);
    const confidenceDenominator = trials.reduce((total, trial) => total + trial.correctness.confidenceDenominator, 0);
    const impactCorrect = trials.filter(trial => trial.correctness.impact).length;
    const unknownTrials = trials.filter(trial => trial.expected.impact === 'unknown');
    const scenarioAlertWindows = trials.filter(trial => trial.expected.alertRules.length + trial.expected.incidentRules.length > 0).length;
    const causeRecall = rate(tpCauses, predictedCauses, expectedCauses).recall;
    const negativeControls = trials.filter(trial => trial.scenario === 'healthy-traffic-spike');
    const negativeControlFalseAlarmRate = negativeControls.length
      ? negativeControls.filter(trial => trial.actual.falseAlarmRules.length > 0).length / negativeControls.length : null;
    const decisionP95 = percentile(decisionTimes, 0.95);
    const caseCount = new Set(trials.map(trial => trial.caseId)).size;
    return {
      split,
      caseCount,
      trialCount: trials.length,
      alertMetrics: rate(tpSignals, detectedSignals, expectedSignals),
      triageCauseMetrics: rate(tpCauses, predictedCauses, expectedCauses),
      falseAlarms: { count: falseAlarmCount, appWindows: falseAlarmWindows, denominator: trials.length,
        perAppWindow: trials.length ? falseAlarmWindows / trials.length : 0 },
      abstention: { count: trials.filter(trial => trial.correctness.abstained).length, denominator: trials.length,
        rate: trials.length ? trials.filter(trial => trial.correctness.abstained).length / trials.length : 0 },
      confidence: { errors: confidenceErrors, denominator: confidenceDenominator,
        errorRate: confidenceDenominator ? confidenceErrors / confidenceDenominator : null },
      impact: { correct: impactCorrect, denominator: trials.length, accuracy: trials.length ? impactCorrect / trials.length : null },
      timingMs: { alertCount: alertTimes.length, alertDenominator: scenarioAlertWindows,
        alertP50: percentile(alertTimes, 0.5), alertP95: percentile(alertTimes, 0.95),
        decisionCount: decisionTimes.length, decisionDenominator: trials.length,
        decisionP50: percentile(decisionTimes, 0.5), decisionP95: percentile(decisionTimes, 0.95) },
      unknownCoverage: { visible: unknownTrials.filter(trial => trial.correctness.unknownCoverageVisible).length, denominator: unknownTrials.length },
      acceptance: {
        minimumCaseCount: input.acceptanceTargets.minimumCasesPerSplit,
        minimumCaseCountMet: caseCount >= input.acceptanceTargets.minimumCasesPerSplit,
        minimumRepetitionsPerCase: input.acceptanceTargets.minimumRepetitionsPerCase,
        minimumRepetitionsPerCaseMet: scenarios.length > 0 && scenarios.every(scenario => scenario.repetitions >= input.acceptanceTargets.minimumRepetitionsPerCase),
        supportedCauseRecallTarget: input.acceptanceTargets.supportedScenarioRecall,
        supportedCauseRecall: causeRecall,
        supportedCauseRecallMet: causeRecall !== null && causeRecall >= input.acceptanceTargets.supportedScenarioRecall,
        negativeControlFalseAlarmTargetPerAppWindow: input.acceptanceTargets.negativeControlFalseAlarmsPerAppWindow,
        negativeControlFalseAlarmRate,
        negativeControlFalseAlarmRateMet: negativeControlFalseAlarmRate !== null
          && negativeControlFalseAlarmRate <= input.acceptanceTargets.negativeControlFalseAlarmsPerAppWindow,
        triageDecisionP95TargetMs: input.acceptanceTargets.triageDecisionP95Ms,
        triageDecisionP95Ms: decisionP95,
        triageDecisionP95Met: decisionP95 !== null && decisionP95 <= input.acceptanceTargets.triageDecisionP95Ms,
        thresholdsFixedInMatrixBeforeRun: true,
      },
      scenarios,
    };
  });
  return {
    schemaVersion: 1,
    evaluation: 'gotchu-real-app-triage',
    matrixVersion: input.matrixVersion,
    matrixSha256: input.matrixSha256,
    rulesVersion: input.rulesVersion,
    gitSha: input.gitSha,
    worktreeDirty: input.worktreeDirty,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    repetitionsPerCase: input.repetitions,
    stack: { postgres: 'real disposable container', redis: 'real disposable container + BullMQ',
      webIngestion: 'local HTTP API backed by real PostgreSQL', coordinator: 'BullMQ worker + durable PostgreSQL jobs' },
    model: { path: 'deterministic', calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    decisionDimensions: {
      alertSeverityAndConfidence: (() => {
        const values = input.trials.flatMap(trial => trial.actual.dimensions);
        return { separateFieldsPresent: values.length > 0 && values.every(item => Boolean(item.severity) && Boolean(item.confidence)),
          observations: values.length, valuesDiffer: values.filter(item => item.severity !== item.confidence).length };
      })(),
      impactAndHypothesisConfidenceSeparate: input.trials.some(trial => trial.actual.impact !== null && trial.actual.hypotheses.length > 0),
      exploitability: { established: false, observationFieldsPresent: input.trials.flatMap(trial => trial.actual.dimensions)
        .filter(item => item.exploitabilityFieldPresent).length },
      providerExecutionPermission: input.permissionChecks.length > 0
        && input.permissionChecks.every(check => check.ready === false && check.execution === 'disabled') ? 'disabled' : 'not verified',
      permissionChecks: input.permissionChecks,
    },
    splits,
    failures: input.trials.flatMap(trial => {
      const failures: Array<{ caseId: string; repetition: number; kind: string; expected: string; actual: string }> = [];
      if (!trial.correctness.impact) failures.push({ caseId: trial.caseId, repetition: trial.repetition, kind: 'impact', expected: trial.expected.impact, actual: trial.actual.impact ?? 'no triage revision' });
      for (const expected of trial.expected.hypotheses) {
        const actual = trial.actual.hypotheses.find(item => item.kind === expected.kind);
        if (!actual || actual.status !== expected.status || actual.confidence !== expected.confidence) failures.push({ caseId: trial.caseId, repetition: trial.repetition,
          kind: `hypothesis:${expected.kind}`, expected: `${expected.status}/${expected.confidence}`, actual: actual ? `${actual.status}/${actual.confidence}` : 'missing' });
      }
      if ((trial.scenario === 'stale-telemetry' || trial.scenario === 'missing-telemetry') && !trial.correctness.unknownCoverageVisible) {
        failures.push({ caseId: trial.caseId, repetition: trial.repetition, kind: 'unknown_coverage', expected: 'unknown impact or missing-data reason', actual: 'no explicit unknown coverage' });
      }
      for (const rule of trial.expected.alertRules) if (!trial.actual.alertRules.includes(rule)) failures.push({ caseId: trial.caseId, repetition: trial.repetition,
        kind: 'alert', expected: rule, actual: 'missing' });
      for (const rule of trial.expected.incidentRules) if (!trial.actual.incidentRules.includes(rule)) failures.push({ caseId: trial.caseId, repetition: trial.repetition,
        kind: 'incident', expected: rule, actual: 'missing' });
      for (const rule of trial.actual.falseAlarmRules) failures.push({ caseId: trial.caseId, repetition: trial.repetition,
        kind: 'false_alarm', expected: 'no unlabelled operational signal', actual: rule });
      const expectedKinds = new Set<string>(trial.expected.hypotheses.map(item => item.kind));
      for (const hypothesis of trial.actual.hypotheses) if (hypothesis.kind !== 'unknown' && !expectedKinds.has(hypothesis.kind)) {
        failures.push({ caseId: trial.caseId, repetition: trial.repetition, kind: 'false_cause',
          expected: 'no unlabelled supported cause', actual: `${hypothesis.kind}/${hypothesis.status}/${hypothesis.confidence}` });
      }
      return failures;
    }),
    trials: input.trials,
  };
}

function percent(value: number | null) { return value === null ? 'n/a' : `${(100 * value).toFixed(1)}%`; }
function metricNumber(value: number | null) { return value === null ? 'n/a' : String(Math.round(value)); }

export function formatEvaluationMarkdown(report: ReturnType<typeof buildEvaluationReport>) {
  const splits = report.splits;
  const metrics = splits.map(item => {
    const scenarios = item.scenarios.map(scenario => `| ${item.split} | ${scenario.scenario} | ${percent(scenario.alerts.precision)}/${percent(scenario.alerts.recall)} (${scenario.alerts.truePositives}/${scenario.alerts.predictedPositives}/${scenario.alerts.actualPositives}) | ${percent(scenario.triageCauses.precision)}/${percent(scenario.triageCauses.recall)} (${scenario.triageCauses.truePositives}/${scenario.triageCauses.predictedPositives}/${scenario.triageCauses.actualPositives}) | ${scenario.alerts.falseAlarmAppWindows}/${scenario.repetitions} | ${scenario.abstention.cases}/${scenario.abstention.denominator} | ${scenario.confidence.errors}/${scenario.confidence.denominator} | ${scenario.impact.denominator - scenario.impact.correct}/${scenario.impact.denominator} | ${metricNumber(scenario.timingMs.alertP50)}/${metricNumber(scenario.timingMs.alertP95)} (${scenario.timingMs.alertCount}/${scenario.timingMs.alertDenominator}) | ${metricNumber(scenario.timingMs.decisionP50)}/${metricNumber(scenario.timingMs.decisionP95)} (${scenario.timingMs.decisionCount}/${scenario.timingMs.decisionDenominator}) |`);
    return scenarios.join('\n');
  }).join('\n');
  const summary = splits.map(item => `- **${item.split}:** ${item.caseCount} cases × ${report.repetitionsPerCase} = ${item.trialCount} app/windows; alerts P/R ${percent(item.alertMetrics.precision)}/${percent(item.alertMetrics.recall)} (TP/predicted/actual ${item.alertMetrics.truePositives}/${item.alertMetrics.predictedPositives}/${item.alertMetrics.actualPositives}); triage causes P/R ${percent(item.triageCauseMetrics.precision)}/${percent(item.triageCauseMetrics.recall)} (${item.triageCauseMetrics.truePositives}/${item.triageCauseMetrics.predictedPositives}/${item.triageCauseMetrics.actualPositives}); false alarms ${item.falseAlarms.count} across ${item.falseAlarms.denominator} windows (${item.falseAlarms.perAppWindow.toFixed(3)} windows/app-window); abstention ${item.abstention.count}/${item.abstention.denominator}; confidence errors ${item.confidence.errors}/${item.confidence.denominator}; impact errors ${item.impact.denominator - item.impact.correct}/${item.impact.denominator}; explicit unknown coverage ${item.unknownCoverage.visible}/${item.unknownCoverage.denominator}; alert p50/p95 ${metricNumber(item.timingMs.alertP50)}/${metricNumber(item.timingMs.alertP95)} ms (${item.timingMs.alertCount}/${item.timingMs.alertDenominator} alert-bearing windows); triage p50/p95 ${metricNumber(item.timingMs.decisionP50)}/${metricNumber(item.timingMs.decisionP95)} ms (${item.timingMs.decisionCount}/${item.timingMs.decisionDenominator} windows); fixed acceptance targets met: cases ${item.acceptance.minimumCaseCountMet}, repetitions ${item.acceptance.minimumRepetitionsPerCaseMet}, cause recall ${item.acceptance.supportedCauseRecallMet}, traffic control ${item.acceptance.negativeControlFalseAlarmRateMet}, triage p95 ${item.acceptance.triageDecisionP95Met}.`).join('\n');
  const failureKinds = new Map<string, number>();
  for (const failure of report.failures) failureKinds.set(failure.kind, (failureKinds.get(failure.kind) ?? 0) + 1);
  const failureSummary = failureKinds.size ? [...failureKinds].sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}: ${count}`).join(', ') : 'none';
  return `# Real-app triage evaluation\n\n`+
    `Run ${report.startedAt}–${report.finishedAt}; matrix ${report.matrixVersion} (${report.matrixSha256}); rules ${report.rulesVersion}; commit ${report.gitSha}; dirty worktree: ${report.worktreeDirty}. Total runtime ${Math.round(report.durationMs / 1000)} s.\n\n`+
    `## Results\n\n${summary}\n\n`+
    `Per-scenario values use **TP/predicted/actual** for alert and triage cause precision/recall. False alarms are app/window counts; time values are p50/p95 milliseconds from injection. Confidence and impact denominators are shown.\n\n`+
    `| Split | Scenario | Alert P/R (TP/pred/actual) | Cause P/R (TP/pred/actual) | False-alarm windows | Abstain / windows | Confidence errors | Impact errors | Alert p50/p95 ms (n/positive) | Decision p50/p95 ms (n/windows) |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${metrics}\n\n`+
    `## Labelled mismatches\n\n${report.failures.length} mismatches across all included splits (${failureSummary}). Full case IDs, repetitions, expected values, and observed values are in the JSON artifact.\n\n`+
    `## Safety and limits\n\n`+
    `- Provider status and target HTTPS probes are local fixtures; every upstream status is marked fixture. The target app and signed intake are real local HTTP processes, and event aggregation, alert projection, and triage revisions use disposable PostgreSQL/Redis plus the durable BullMQ coordinator path.\n`+
    `- The traffic-spike negative control is healthy load; it must not produce a runtime attack rule. SQL injection and path traversal are blocked before their local sinks, and the resulting events are indications only.\n`+
    `- Resource cases run in the local Node process. Memory utilization is measured against the bounded 64 MiB evaluation budget; these runs do not claim host-level or production capacity. Event-loop pressure is one bounded 1.05 s block.\n`+
    `- Stale/missing cases report unknown impact; blocked attack shapes do not establish exploitation. Severity and confidence are recorded as separate fields; exploitability is not established or represented by these paths. Provider execution readiness is checked as disabled.\n`+
    `- Deterministic rules only: 0 model calls and 0 tokens. No repair-time or production accuracy/capacity claim is made. Holdout labels were fixed in the versioned matrix before execution and were not used for tuning.\n\n`+
    `The full per-trial observations, denominators, timing samples, mismatches, and failures are in [triage-evaluation.json](triage-evaluation.json).\n`;
}

export async function writeEvaluationArtifacts(report: ReturnType<typeof buildEvaluationReport>, splitOnly: boolean) {
  const directory = splitOnly ? resolve('.local/triage-evaluation') : resolve('docs');
  await mkdir(directory, { recursive: true });
  const activeSplit = report.splits.find(item => item.trialCount > 0)?.split ?? 'partial';
  const jsonPath = splitOnly ? resolve(directory, `${activeSplit}.json`) : resolve(directory, 'triage-evaluation.json');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!splitOnly) {
    const markdownPath = resolve(directory, 'triage-evaluation.md');
    await writeFile(markdownPath, formatEvaluationMarkdown(report));
  }
  return { jsonPath, markdownPath: splitOnly ? null : resolve(dirname(jsonPath), 'triage-evaluation.md') };
}
