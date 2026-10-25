import type { AssessmentReport, AssessmentRunInput, CustomerRunInput, CustomerAssessmentReport, CustomerScannerPhase } from '@gotchu/contracts';
import { BackendError } from '@gotchu/backend';

/** Trusted read-only adapter. All I/O must settle within the coordinator time bound. */
export interface AssessmentRunner {
  run(input: AssessmentRunInput): Promise<AssessmentReport>;
}

export const ASSESSMENT_TIMEOUT_MS = 60_000;
// An adapter that ignores its own I/O timeouts cannot accumulate orphaned work.
// Its slot remains held until it settles, even after the durable job has timed out.
const activeRunners = new WeakSet<object>();

async function boundedRun<Report>(runner: object, run: () => Promise<Report>): Promise<Report> {
  if (activeRunners.has(runner)) throw new BackendError('assessment_runner_busy', 'The assessment adapter still has an active operation', 503);
  activeRunners.add(runner);
  const result = Promise.resolve().then(run).finally(() => { activeRunners.delete(runner); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([result, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BackendError('assessment_timeout', 'Assessment adapter exceeded its time bound', 504)), ASSESSMENT_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface CustomerRunOptions { onProgress?: (phase: CustomerScannerPhase) => void }
export interface CustomerAssessmentRunner { run(input: CustomerRunInput, options?: CustomerRunOptions): Promise<CustomerAssessmentReport> }
export const runAssessment = (runner: AssessmentRunner, input: AssessmentRunInput) => boundedRun(runner, () => runner.run(input));
export const runCustomerAssessment = (runner: CustomerAssessmentRunner, input: CustomerRunInput, options?: CustomerRunOptions) =>
  boundedRun(runner, () => options ? runner.run(input, options) : runner.run(input));
