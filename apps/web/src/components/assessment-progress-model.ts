import type { CustomerAssessmentReport, CustomerJobProgress } from '@gotchu/contracts';
import type { CustomerJob } from './customer-client';

/**
 * Phase graph of a customer assessment. Live state comes from the job (state + coordinator-recorded
 * progress); the scanner call is opaque, so both analysis branches share one start and one end.
 */
export const PHASES = ['queue', 'validation', 'internal', 'external', 'correlation', 'report'] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseState = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'not_requested';
export type PhaseStates = Record<Phase, PhaseState>;

export const PHASE_RANK: Record<Phase, number> = { queue: 0, validation: 1, internal: 2, external: 2, correlation: 3, report: 4 };
export const PHASE_EDGES: readonly (readonly [Phase, Phase])[] = [
  ['queue', 'validation'], ['validation', 'internal'], ['validation', 'external'],
  ['internal', 'correlation'], ['external', 'correlation'], ['correlation', 'report'],
];
const TERMINAL: readonly PhaseState[] = ['done', 'failed', 'skipped', 'not_requested'];

type Mode = NonNullable<CustomerJob['mode']>;
const requested = (mode: Mode) => ({ internal: mode !== 'external', external: mode !== 'internal' });
const reached = (progress: CustomerJobProgress, phase: CustomerJobProgress[number]['phase']) => progress.some(entry => entry.phase === phase);

export function jobPhaseStates(job: Pick<CustomerJob, 'state' | 'mode' | 'progress'>): PhaseStates {
  const lanes = requested(job.mode ?? 'both');
  const lane = (requestedState: PhaseState, side: 'internal' | 'external'): PhaseState => lanes[side] ? requestedState : 'not_requested';
  const states = (queue: PhaseState, validation: PhaseState, analysis: PhaseState, correlation: PhaseState, report: PhaseState): PhaseStates =>
    ({ queue, validation, internal: lane(analysis, 'internal'), external: lane(analysis, 'external'), correlation, report });
  const analyzing = reached(job.progress, 'analyzing');
  switch (job.state) {
    case 'queued': return states('running', 'pending', 'pending', 'pending', 'pending');
    case 'running': return analyzing ? states('done', 'done', 'running', 'pending', 'pending') : states('done', 'running', 'pending', 'pending', 'pending');
    case 'succeeded': return states('done', 'done', 'done', 'done', 'done');
    // The scanner call fails as a whole, so a failure after admission cannot be pinned to one branch.
    case 'failed': return analyzing ? states('done', 'done', 'failed', 'skipped', 'skipped') : states('done', 'failed', 'skipped', 'skipped', 'skipped');
  }
}

/** Server timestamps (ms) for the start and end of each phase that has them. */
export type PhaseTimes = Partial<Record<Phase, { start: number; end: number | null }>>;
export function jobPhaseTimes(job: Pick<CustomerJob, 'createdAt' | 'completedAt' | 'progress'>): PhaseTimes {
  const at = (phase: CustomerJobProgress[number]['phase']) => {
    const entry = job.progress.find(item => item.phase === phase);
    return entry ? Date.parse(entry.at) : null;
  };
  const created = Date.parse(job.createdAt), validating = at('validating'), analyzing = at('analyzing');
  const completed = job.completedAt ? Date.parse(job.completedAt) : null;
  const times: PhaseTimes = { queue: { start: created, end: validating ?? analyzing ?? completed } };
  if (validating !== null) times.validation = { start: validating, end: analyzing ?? completed };
  if (analyzing !== null) times.internal = times.external = { start: analyzing, end: completed };
  return times;
}

/** Report-side truth: each analysis records its own start, end and coverage. */
type AnalysisStatus = { status: NonNullable<CustomerAssessmentReport['internal']>['status'] } | null;
export function reportPhaseStates(report: { internal: AnalysisStatus; external: AnalysisStatus }): PhaseStates {
  const lane = (analysis: AnalysisStatus): PhaseState =>
    analysis === null ? 'not_requested' : analysis.status === 'unavailable' ? 'skipped' : 'done';
  return { queue: 'done', validation: 'done', internal: lane(report.internal), external: lane(report.external), correlation: 'done', report: 'done' };
}
export function reportPhaseTimes(report: Pick<CustomerAssessmentReport, 'internal' | 'external' | 'startedAt' | 'finishedAt'>, job?: Pick<CustomerJob, 'createdAt' | 'completedAt' | 'progress'>): PhaseTimes {
  const span = (analysis: CustomerAssessmentReport['internal']) => analysis ? { start: Date.parse(analysis.startedAt), end: Date.parse(analysis.finishedAt) } : undefined;
  const times: PhaseTimes = job ? jobPhaseTimes(job) : {};
  const internal = span(report.internal), external = span(report.external);
  if (internal) times.internal = internal;
  if (external) times.external = external;
  const analysesEnd = Math.max(internal?.end ?? 0, external?.end ?? 0);
  if (analysesEnd > 0) times.correlation = { start: analysesEnd, end: Date.parse(report.finishedAt) };
  return times;
}
export function coverageCount(analysis: CustomerAssessmentReport['internal']) {
  if (!analysis) return null;
  return { inspected: analysis.coverage.filter(item => item.state === 'inspected').length, total: analysis.coverage.length };
}

/** One visible step: every phase in it changes to the same state at once (parallel branches move together). */
export interface PhaseStep { phases: Phase[]; state: PhaseState }

/**
 * Transitions needed to move the shown graph to the latest server state in order. A phase that
 * finished between two polls still passes through "running", so every line and node is drawn.
 */
export function phaseSteps(from: PhaseStates, to: PhaseStates): PhaseStep[] {
  const steps: PhaseStep[] = [];
  for (const rank of new Set(Object.values(PHASE_RANK))) {
    const changed = PHASES.filter(phase => PHASE_RANK[phase] === rank && from[phase] !== to[phase]);
    const passing = changed.filter(phase => to[phase] === 'done' && from[phase] !== 'running');
    if (passing.length > 0) steps.push({ phases: passing, state: 'running' });
    for (const state of new Set(changed.map(phase => to[phase]))) steps.push({ phases: changed.filter(phase => to[phase] === state), state });
  }
  return steps;
}
export function applyStep(states: PhaseStates, step: PhaseStep): PhaseStates {
  const next = { ...states };
  for (const phase of step.phases) next[phase] = step.state;
  return next;
}
export const isSettled = (states: PhaseStates) => PHASES.every(phase => TERMINAL.includes(states[phase]));

/** Earliest phase that has not finished; the heading describes it. */
export function frontier(states: PhaseStates): Phase | null {
  return PHASES.find(phase => !TERMINAL.includes(states[phase])) ?? null;
}
