import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { hypothesisKindSchema, hypothesisStatusSchema, impactObservationSchema, confidenceSchema } from '@gotchu/triage';

const providerSchema = z.object({
  name: z.enum(['cloudflare', 'railway']),
  component: z.string().min(1),
  region: z.string().min(1),
  scope: z.enum(['component', 'regional']),
  state: z.enum(['degraded', 'partial_outage', 'major_outage']),
  dependentRouteFails: z.boolean().default(false),
  dependencyLatencyMs: z.number().int().positive().optional(),
}).strict();

const faultSchema = z.enum([
  'bad_release', 'provider_outage', 'dependency_latency', 'cpu_pressure', 'memory_pressure',
  'event_loop_pressure', 'traffic_spike', 'credential_stuffing', 'sql_injection', 'path_traversal',
  'stale_telemetry', 'missing_telemetry',
]);

const hypothesisTruthSchema = z.object({
  kind: hypothesisKindSchema,
  status: hypothesisStatusSchema,
  confidence: confidenceSchema,
}).strict();

const scenarioCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['tuning', 'holdout']),
  scenario: z.string().min(1),
  faults: z.array(faultSchema).min(1),
  requestRoute: z.enum(['checkout', 'dependent', 'healthz', 'work']),
  requestCount: z.number().int().nonnegative(),
  authFailures: z.number().int().nonnegative().default(0),
  attack: z.enum(['sql', 'path']).nullable().default(null),
  deployment: z.boolean().default(false),
  truth: z.object({
    impact: impactObservationSchema,
    alertRules: z.array(z.string()),
    incidentRules: z.array(z.string()),
    hypotheses: z.array(hypothesisTruthSchema),
  }).strict(),
  provider: providerSchema.optional(),
  alertConfidence: z.record(z.string(), confidenceSchema).default({}),
}).strict();

const scenarioMatrixSchema = z.object({
  version: z.string().min(1),
  rulesVersion: z.string().min(1),
  repetitions: z.number().int().positive(),
  protocol: z.object({
    metricWindowMs: z.number().int().positive(),
    triageWindowMs: z.number().int().positive(),
    signalFreshnessMs: z.number().int().positive(),
    requestMinimum: z.number().int().positive(),
    errorMinimum: z.number().int().positive(),
    errorRateMinimum: z.number().gt(0).lte(1),
    pressureP95Ms: z.number().positive(),
    resourceUtilizationMinimum: z.number().gt(0).lte(1),
    passwordSprayMinimumFailures: z.number().int().positive(),
    passwordSprayMinimumAccounts: z.number().int().positive(),
    healthyTrafficMultiple: z.number().positive(),
  }).strict(),
  acceptanceTargets: z.object({
    minimumCasesPerSplit: z.number().int().positive(),
    minimumRepetitionsPerCase: z.number().int().positive(),
    negativeControlFalseAlarmsPerAppWindow: z.number().int().nonnegative(),
    supportedScenarioRecall: z.number().gt(0).lte(1),
    maximumConfidenceErrorRate: z.number().min(0).lte(1),
    triageDecisionP95Ms: z.number().positive(),
  }).strict(),
  cases: z.array(scenarioCaseSchema),
}).strict();

export type ScenarioCase = z.infer<typeof scenarioCaseSchema>;
export type ScenarioMatrix = z.infer<typeof scenarioMatrixSchema>;

export async function loadTriageMatrix() {
  const url = new URL('./triage-scenarios.v1.json', import.meta.url);
  const source = await readFile(url, 'utf8');
  const matrix = scenarioMatrixSchema.parse(JSON.parse(source));
  const tuning = matrix.cases.filter(item => item.split === 'tuning');
  const holdout = matrix.cases.filter(item => item.split === 'holdout');
  if (tuning.length < matrix.acceptanceTargets.minimumCasesPerSplit || holdout.length < matrix.acceptanceTargets.minimumCasesPerSplit
    || matrix.repetitions < matrix.acceptanceTargets.minimumRepetitionsPerCase
    || new Set(matrix.cases.map(item => item.id)).size !== matrix.cases.length) {
    throw new Error('triage_evaluation_matrix_incomplete');
  }
  const tuningScenarios = new Set(tuning.map(item => item.scenario));
  const holdoutScenarios = new Set(holdout.map(item => item.scenario));
  if ([...tuningScenarios].some(scenario => !holdoutScenarios.has(scenario))
    || [...holdoutScenarios].some(scenario => !tuningScenarios.has(scenario))) {
    throw new Error('triage_evaluation_split_scenario_mismatch');
  }
  return { matrix, matrixSha256: createHash('sha256').update(source).digest('hex') };
}
