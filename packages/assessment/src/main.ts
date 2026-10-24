import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assessmentRunInputSchema } from '@gotchu/contracts';
import { createControlledAssessmentRunner, controlledTargetKey } from './index.js';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'both' }, revision: { type: 'string', default: 'vulnerable' },
  'organization-id': { type: 'string' }, 'application-id': { type: 'string' }, 'job-id': { type: 'string' },
}, strict: true, allowPositionals: false });
const input = assessmentRunInputSchema.parse({
  organizationId: values['organization-id'] ?? randomUUID(), applicationId: values['application-id'] ?? randomUUID(), jobId: values['job-id'] ?? randomUUID(),
  targetKey: controlledTargetKey, mode: values.mode, revision: values.revision,
});
const runner = createControlledAssessmentRunner(process.env.GOTCHU_DEMO_TARGET_ORIGIN === undefined ? {} : { origin: process.env.GOTCHU_DEMO_TARGET_ORIGIN });
const report = await runner.run(input);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if ([report.internal, report.external].some((analysis) => analysis && analysis.status !== 'completed')) process.exitCode = 2;
