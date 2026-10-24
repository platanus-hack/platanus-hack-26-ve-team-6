import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssessmentReport, AssessmentRunInput } from '@gotchu/contracts';
import { runAssessment, ASSESSMENT_TIMEOUT_MS, type AssessmentRunner } from '../src/assessment.js';
import { assessmentReportFixture } from '../../../packages/backend/test/assessment-fixtures.js';

const input: AssessmentRunInput = { organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(), targetKey: 'controlled-demo-store', mode: 'external', revision: 'corrected' };
describe('bounded read-only assessment adapter', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('times out without accumulating detached adapter operations and releases a settled slot', async () => {
    vi.useFakeTimers();
    let finish: (report: AssessmentReport) => void = () => { throw new Error('Runner was not started'); };
    const runner: AssessmentRunner = { run: vi.fn(() => new Promise<AssessmentReport>(resolve => { finish = resolve; })) };
    const first = expect(runAssessment(runner, input)).rejects.toMatchObject({ code: 'assessment_timeout' });
    await vi.advanceTimersByTimeAsync(ASSESSMENT_TIMEOUT_MS);
    await first;
    await expect(runAssessment(runner, input)).rejects.toMatchObject({ code: 'assessment_runner_busy' });
    expect(runner.run).toHaveBeenCalledTimes(1);
    finish(assessmentReportFixture(input));
    await vi.advanceTimersByTimeAsync(0);
    const next = runAssessment(runner, input);
    await vi.advanceTimersByTimeAsync(0);
    finish(assessmentReportFixture(input));
    await expect(next).resolves.toMatchObject({ jobId: input.jobId });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up after rejection without hiding the adapter failure', async () => {
    const failure = new Error('Synthetic adapter failure');
    const runner: AssessmentRunner = { run: async () => { throw failure; } };
    await expect(runAssessment(runner, input)).rejects.toBe(failure);
    await expect(runAssessment(runner, input)).rejects.toBe(failure);
  });
});
