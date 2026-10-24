import type { AssessmentReport, AssessmentRunInput, CustomerRunInput, CustomerAssessmentReport } from '@gotchu/contracts';
import { BackendError } from '@gotchu/backend';

/** Trusted read-only adapter. All I/O must settle within the coordinator time bound. */
export interface AssessmentRunner {
  run(input: AssessmentRunInput): Promise<AssessmentReport>;
}

export const ASSESSMENT_TIMEOUT_MS = 60_000;
// An adapter that ignores its own I/O timeouts cannot accumulate orphaned work.
// Its slot remains held until it settles, even after the durable job has timed out.
const activeRunners = new WeakSet<object>();

async function boundedRun<Input, Report>(runner: { run(input: Input): Promise<Report> }, input: Input): Promise<Report> {
  if (activeRunners.has(runner)) throw new BackendError('assessment_runner_busy', 'The assessment adapter still has an active operation', 503);
  activeRunners.add(runner);
  const result = Promise.resolve().then(() => runner.run(input)).finally(() => { activeRunners.delete(runner); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([result, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BackendError('assessment_timeout', 'Assessment adapter exceeded its time bound', 504)), ASSESSMENT_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface CustomerAssessmentRunner { run(input: CustomerRunInput): Promise<CustomerAssessmentReport> }
export const runAssessment = (runner: AssessmentRunner, input: AssessmentRunInput) => boundedRun(runner, input);
export const runCustomerAssessment = (runner: CustomerAssessmentRunner, input: CustomerRunInput) => boundedRun(runner, input);
