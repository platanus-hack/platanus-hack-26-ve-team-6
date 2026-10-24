import type { RequestListener } from 'node:http';
import { performance } from 'node:perf_hooks';
import { operationObservationSchema } from '@gotchu/contracts';
import { triageRevisionSchema } from '@gotchu/triage';
import { startTriageEvaluationTarget, type EvaluationFault } from '../../apps/demo-target/src/index.js';
import type { createLiveTriageStack } from './live-stack.js';
import type { ScenarioCase } from './triage-matrix.js';
import type { TrialResult } from './triage-report.js';

const ruleFromKey = (key: string) => /^signal:([^:]+):/.exec(key)?.[1];

async function request(origin: string, path: string) {
  const response = await fetch(new URL(path, origin));
  await response.arrayBuffer();
  return response.status;
}

async function hitRoute(origin: string, route: string, count: number) {
  const path = route === 'checkout' ? '/checkout' : route === 'dependent' ? '/dependent' : route === 'work' ? '/work' : '/healthz';
  for (let offset = 0; offset < count; offset += 20) {
    const batch = Math.min(20, count - offset);
    await Promise.all(Array.from({ length: batch }, () => request(origin, path)));
  }
}

async function createBaseline(target: Awaited<ReturnType<typeof startTriageEvaluationTarget>>, origin: string, caseId: string) {
  const metricWindowMs = 600_000;
  const currentWindow = Math.floor(Date.now() / metricWindowMs) * metricWindowMs;
  target.setRelease(`baseline-${caseId}`);
  for (const offsetMs of [60, 50, 40].map(minutes => minutes * 60_000)) {
    target.setTelemetryTime(new Date(currentWindow - offsetMs + 60_000).toISOString());
    await hitRoute(origin, 'healthz', 20);
  }
  target.setTelemetryTime(undefined);
  await target.flush();
}

export async function runTriageCase(input: {
  stack: Awaited<ReturnType<typeof createLiveTriageStack>>;
  scenario: ScenarioCase;
  repetition: number;
  setProbeHandler(handler: RequestListener | null): void;
  probeCertificate: string;
  probePort: number;
}): Promise<TrialResult> {
  const { stack, scenario, repetition } = input;
  const app = await stack.createApplication(scenario, repetition);
  const currentRelease = `${scenario.id}-release`;
  const target = await startTriageEvaluationTarget({ integrationId: app.integrationId, applicationId: app.applicationId,
    secret: Buffer.from(app.signingKey, 'base64'), telemetryUrl: stack.apiOrigin, service: app.serviceName, release: currentRelease });
  let started = 0;
  let attackResponses: number[] = [];
  let permissionCheck: TrialResult['permissionCheck'] = null;
  try {
    await target.refreshPolicy();
    await createBaseline(target, target.origin, scenario.id);
    target.setRelease(currentRelease);
    started = performance.now();
    const faultOnsetMs = Date.now();
    const faultOnsetAt = new Date(faultOnsetMs).toISOString();
    target.inject(scenario.faults satisfies readonly EvaluationFault[], {
      dependentRouteFails: scenario.provider?.dependentRouteFails ?? false,
      dependencyLatencyMs: scenario.provider?.dependencyLatencyMs ?? 0,
      authIp: `198.51.100.${10 + repetition}`,
    });

    if (scenario.provider) await stack.recordProviderStatus(app, scenario);
    if (scenario.faults.includes('stale_telemetry')) {
      target.setTelemetryTime(new Date(Date.now() - 20 * 60_000).toISOString());
    }
    await hitRoute(target.origin, scenario.requestRoute, scenario.requestCount);

    if (scenario.faults.includes('cpu_pressure')) await target.emitResourcePressure('cpu');
    if (scenario.faults.includes('memory_pressure')) await target.emitResourcePressure('memory');
    if (scenario.faults.includes('event_loop_pressure')) await target.emitResourcePressure('event_loop');

    if (scenario.authFailures > 0) {
      await Promise.all(Array.from({ length: scenario.authFailures }, () => request(target.origin, '/login')));
    }
    if (scenario.attack === 'sql') attackResponses.push(await request(target.origin, `/attack/sql?value=${encodeURIComponent("' OR 1=1 --")}`));
    if (scenario.attack === 'path') attackResponses.push(await request(target.origin, `/attack/path?path=${encodeURIComponent('../../etc/passwd')}`));

    if (scenario.provider) {
      input.setProbeHandler(target.handler);
      await stack.recordProbes(app, scenario, { certificate: input.probeCertificate, port: input.probePort });
    } else if (scenario.faults.includes('missing_telemetry')) {
      input.setProbeHandler(target.handler);
      await target.emitHeartbeat();
      await stack.recordProbes(app, scenario, { certificate: input.probeCertificate, port: input.probePort, unknownOnly: true });
    }
    target.setTelemetryTime(undefined);
    await target.flush();
    await stack.drain(app.applicationId);
    const measured = await stack.readResults(app.applicationId);
    const observations = measured.observations.flatMap(row => {
      const rule = ruleFromKey(row.idempotency_key);
      if (!rule || rule === 'metrics') return [];
      const body = operationObservationSchema.parse(row.body);
      return [{ rule, id: body.id, severity: body.severity, confidence: body.confidence,
        exploitabilityFieldPresent: Object.prototype.hasOwnProperty.call(body, 'exploitability'), createdAt: row.created_at.getTime() }];
    });
    const alertRules = [...new Set(observations.map(item => item.rule))].sort();
    const incidentRules = [...new Set(measured.incidents.map(item => item.rule_id))].sort();
    const expected = new Set([...scenario.truth.alertRules, ...scenario.truth.incidentRules]);
    const falseAlarmRules = [...new Set([...alertRules, ...incidentRules].filter(rule => !expected.has(rule)))].sort();
    const revision = measured.revision ? triageRevisionSchema.parse(measured.revision.body) : undefined;
    const hypotheses = revision?.hypotheses.map(item => ({ kind: item.kind, status: item.status, confidence: item.confidence })) ?? [];
    const confidenceChecks = [
      ...Object.entries(scenario.alertConfidence).map(([rule, confidence]) => ({ confidence, actual: observations.find(item => item.rule === rule)?.confidence })),
      ...scenario.truth.hypotheses.map(item => ({ confidence: item.confidence, actual: hypotheses.find(actual => actual.kind === item.kind)?.confidence })),
    ];
    const confidenceErrors = confidenceChecks.filter(item => item.actual !== item.confidence).length;
    const alertOnsetRows = observations.filter(item => scenario.truth.alertRules.includes(item.rule)).map(item => item.createdAt);
    const incidentOnsetRows = measured.incidents.filter(item => scenario.truth.incidentRules.includes(item.rule_id)).map(item => item.created_at.getTime());
    const alertCreatedAt = [...alertOnsetRows, ...incidentOnsetRows].sort((a, b) => a - b)[0];
    const decisionCreatedAt = measured.revision?.created_at.getTime();
    const alertMs = alertCreatedAt === undefined ? null : Math.max(0, alertCreatedAt - faultOnsetMs);
    const decisionMs = decisionCreatedAt === undefined || decisionCreatedAt < faultOnsetMs ? null : decisionCreatedAt - faultOnsetMs;

    if (scenario.split === 'tuning' && scenario.scenario === 'dependency-latency' && repetition === 1) {
      const pressure = observations.find(item => item.rule === 'runtime.pressure.v1');
      if (pressure) {
        permissionCheck = await stack.checkPermission(app, pressure.id);
      }
    }

    const triageMissingData = [...(revision?.impact.missingData ?? []), ...(revision?.hypotheses.flatMap(item => item.missingData) ?? [])];
    const unknownCoverageVisible = revision?.impact.observed === 'unknown' || triageMissingData.length > 0;
    const actual = {
      impact: revision?.impact.observed ?? null,
      hypotheses,
      alertRules,
      incidentRules,
      falseAlarmRules,
      staleOrUnknown: revision?.impact.observed === 'unknown' || hypotheses.some(item => item.kind === 'unknown'),
      unknownCoverageVisible,
      triageMissingData: [...new Set(triageMissingData)],
      operationalCoverage: measured.coverage ? { state: measured.coverage.state, reason: measured.coverage.reason } : null,
      attackResponses,
      sinkExecutions: { ...target.sinkExecutions },
      dimensions: observations.map(item => ({ rule: item.rule, severity: item.severity, confidence: item.confidence,
        exploitabilityFieldPresent: item.exploitabilityFieldPresent })),
    };
    const hasSupportedCause = hypotheses.some(item => item.kind !== 'unknown' && item.status === 'supported');
    return {
      caseId: scenario.id,
      scenario: scenario.scenario,
      split: scenario.split,
      repetition,
      faultOnsetAt,
      expected: scenario.truth,
      actual,
      timings: { alertMs, decisionMs, runtimeMs: performance.now() - started },
      permissionCheck,
      correctness: { impact: actual.impact === scenario.truth.impact, abstained: !hasSupportedCause, unknownCoverageVisible,
        confidenceErrors, confidenceDenominator: confidenceChecks.length },
    };
  } finally {
    input.setProbeHandler(null);
    await target.close();
  }
}
