import { randomUUID } from 'node:crypto';
import { assessmentReportSchema, assessmentRunInputSchema, type AssessmentReport, type AssessmentRunInput } from '@gotchu/contracts';
import { compareAnalyses } from './comparison.js';
import { assessExternal } from './external.js';
import { controlledTargetKey, controlledTransportOptionsSchema } from './profile.js';
import type { ControlledRepositoryPort } from './repository.js';

export { controlledTargetKey, controlledSourceFileSchema, controlledTransportOptionsSchema } from './profile.js';
export type { ControlledSourceFile } from './profile.js';
export type { ControlledRepositoryPort } from './repository.js';

export interface ControlledAssessmentOptions {
  /** Trusted operator origin, never a request field. */
  origin?: string;
  repository?: ControlledRepositoryPort;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export function createControlledAssessmentRunner(options: ControlledAssessmentOptions = {}) {
  const { repository, ...transport } = options;
  const checkedOptions = controlledTransportOptionsSchema.parse(transport);
  return {
    async run(input: AssessmentRunInput): Promise<AssessmentReport> {
      const checked = assessmentRunInputSchema.parse(input);
      if (checked.targetKey !== controlledTargetKey) throw new Error('Target is not in the controlled assessment registry');
      const startedAt = new Date().toISOString();
      // Keep all fixture/advisory/compiler imports behind the internal branch. HTTP-only deployments
      // need neither the repository files nor the demo target package in this process.
      const internalPromise = checked.mode === 'external' ? Promise.resolve(null) : (async () => {
        const { assessInternal } = await import('./internal.js');
        const source = repository ?? (await import('./repository.js')).createBundledRepository();
        return assessInternal(checked.revision, source);
      })();
      const externalPromise = checked.mode === 'internal' ? Promise.resolve(null) : assessExternal(checked.revision, checkedOptions);
      const [internal, external] = await Promise.all([internalPromise, externalPromise]);
      return assessmentReportSchema.parse({
        version: 1, id: randomUUID(), organizationId: checked.organizationId, applicationId: checked.applicationId, jobId: checked.jobId,
        applicationName: 'Paper Moon Store (controlled fictional demo)', mode: checked.mode, revision: checked.revision,
        startedAt, finishedAt: new Date().toISOString(), internal, external, comparison: compareAnalyses(internal, external),
        responseMode: 'observation', actionsPerformed: [],
        limitations: [
          'This is a deterministic, bounded controlled-fixture assessment, not a comprehensive audit or proof of safety. Completed means only the listed profile probes completed.',
          'Source and HTTP are observed independently. Correlation is by fixed rule and selected revision, not proof that the live deployment contains the exact source bytes.',
          'Corrected means improvement on the seeded checks. Missing headers and dependency/advisory matches are observations or hardening indicators, not proof of compromise.',
          'Unknown and unsupported coverage must not be interpreted as clean. No provider/model/cloud service, paid API, customer-code execution, remediation or response action is used.',
        ],
      });
    },
  };
}
