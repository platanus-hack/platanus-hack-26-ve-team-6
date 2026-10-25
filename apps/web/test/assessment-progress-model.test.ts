import { describe, expect, it } from 'vitest';
import type { CustomerJob } from '../src/components/customer-client';
import {
  PHASES, applyStep, isSettled, jobPhaseStates, jobPhaseTimes, phaseSteps, reportPhaseStates, type PhaseStates,
} from '../src/components/assessment-progress-model';

type JobView = Pick<CustomerJob, 'state' | 'mode' | 'progress' | 'createdAt' | 'completedAt'>;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, seconds)).toISOString();
const job = (state: CustomerJob['state'], phases: ('validating' | 'analyzing')[], mode: CustomerJob['mode'] = 'both', completedAt: string | null = null): JobView =>
  ({ state, mode, progress: phases.map((phase, index) => ({ phase, at: at(10 + index * 5) })), createdAt: at(0), completedAt });

/** The job states the dashboard actually polls, in order, for one successful and one failed run. */
const successRun = [job('queued', []), job('running', []), job('running', ['validating']), job('running', ['validating', 'analyzing']), job('succeeded', ['validating', 'analyzing'], 'both', at(40))];
const failedRun = [job('queued', []), job('running', ['validating', 'analyzing']), job('failed', ['validating', 'analyzing'], 'both', at(30))];
const ORDER = { pending: 0, not_requested: 0, running: 1, done: 2, failed: 2, skipped: 2 } as const;

function replay(from: PhaseStates, to: PhaseStates) {
  const seen: PhaseStates[] = [from];
  for (const step of phaseSteps(from, to)) seen.push(applyStep(seen.at(-1) ?? from, step));
  return seen;
}

describe('assessment phase graph', () => {
  it('maps coordinator progress onto the phases it proves', () => {
    expect(jobPhaseStates(job('queued', []))).toMatchObject({ queue: 'running', validation: 'pending', internal: 'pending' });
    expect(jobPhaseStates(job('running', ['validating']))).toMatchObject({ queue: 'done', validation: 'running', internal: 'pending', external: 'pending' });
    expect(jobPhaseStates(job('running', ['validating', 'analyzing']))).toMatchObject({ validation: 'done', internal: 'running', external: 'running', correlation: 'pending' });
    expect(jobPhaseStates(job('running', ['validating', 'analyzing'], 'external'))).toMatchObject({ internal: 'not_requested', external: 'running' });
    expect(jobPhaseStates(job('succeeded', ['validating', 'analyzing'], 'internal'))).toMatchObject({ internal: 'done', external: 'not_requested', report: 'done' });
  });

  it('places a failure where the job stopped without blaming one opaque scanner branch', () => {
    expect(jobPhaseStates(job('failed', ['validating']))).toMatchObject({ validation: 'failed', internal: 'skipped', correlation: 'skipped', report: 'skipped' });
    expect(jobPhaseStates(job('failed', ['validating', 'analyzing']))).toMatchObject({ validation: 'done', internal: 'failed', external: 'failed', correlation: 'skipped' });
  });

  it('replays every missed transition in order, without regressions, and ends on the server state', () => {
    for (const run of [successRun, failedRun]) {
      // Every pair of polls, including ones that skip intermediate states.
      for (let from = 0; from < run.length; from++) for (let to = from; to < run.length; to++) {
        const start = jobPhaseStates(present(run[from])), target = jobPhaseStates(present(run[to]));
        const seen = replay(start, target);
        expect(seen.at(-1)).toEqual(target);
        for (let index = 1; index < seen.length; index++) for (const phase of PHASES) {
          expect(ORDER[present(seen[index])[phase]]).toBeGreaterThanOrEqual(ORDER[present(seen[index - 1])[phase]]);
        }
        for (const shown of seen) for (const phase of PHASES) {
          // A phase is never shown finished before the phase that feeds it.
          if (shown[phase] === 'done' && phase !== 'queue') expect(shown.queue).toBe('done');
          if (shown.correlation !== 'pending' && shown.correlation !== 'skipped') expect(['done', 'not_requested']).toContain(shown.internal);
        }
      }
    }
  });

  it('draws a phase that finished between two polls as running first, and moves parallel branches together', () => {
    const steps = phaseSteps(jobPhaseStates(job('queued', [])), jobPhaseStates(present(successRun.at(-1))));
    expect(steps).toEqual([
      { phases: ['queue'], state: 'done' },
      { phases: ['validation'], state: 'running' }, { phases: ['validation'], state: 'done' },
      { phases: ['internal', 'external'], state: 'running' }, { phases: ['internal', 'external'], state: 'done' },
      { phases: ['correlation'], state: 'running' }, { phases: ['correlation'], state: 'done' },
      { phases: ['report'], state: 'running' }, { phases: ['report'], state: 'done' },
    ]);
    expect(isSettled(jobPhaseStates(present(successRun.at(-1))))).toBe(true);
    expect(isSettled(jobPhaseStates(present(failedRun.at(-1))))).toBe(true);
    expect(isSettled(jobPhaseStates(job('running', ['validating', 'analyzing'])))).toBe(false);
  });

  it('times each phase from server timestamps', () => {
    const times = jobPhaseTimes(job('succeeded', ['validating', 'analyzing'], 'both', at(40)));
    expect(times.queue).toEqual({ start: Date.parse(at(0)), end: Date.parse(at(10)) });
    expect(times.validation).toEqual({ start: Date.parse(at(10)), end: Date.parse(at(15)) });
    expect(times.internal).toEqual({ start: Date.parse(at(15)), end: Date.parse(at(40)) });
  });

  it('shows an unavailable report analysis as not run rather than finished', () => {
    expect(reportPhaseStates({ internal: null, external: { status: 'unavailable' } })).toMatchObject({ internal: 'not_requested', external: 'skipped' });
    expect(reportPhaseStates({ internal: { status: 'partial' }, external: null })).toMatchObject({ internal: 'done', external: 'not_requested' });
  });
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture');
  return value;
}
