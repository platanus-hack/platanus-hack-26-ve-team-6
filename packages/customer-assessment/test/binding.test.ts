import { expect, it } from 'vitest';
import { customerAssessmentReportSchema } from '@gotchu/contracts';
import { assertReportBinding, createCustomerAssessmentRunner } from '../src/index.js';
import { input, absentScanners } from './fixtures.js';

it('rejects internal snapshot and evidence provenance mismatches while accepting the original report', async () => {
  const request = input();
  const scanners = {
    ...absentScanners,
    async run(name: string) {
      if (name !== 'semgrep') throw new Error('fixture_unavailable');
      return {
        image: 'fixture-semgrep', version: '1.90.0', profileChecksum: '0'.repeat(64),
        output: { version: '1.90.0', results: [], errors: [], paths: { scanned: ['app.ts'] } },
      };
    },
  };
  const report = await createCustomerAssessmentRunner({ scanners }).run(request);
  expect(customerAssessmentReportSchema.safeParse(report).success).toBe(true);
  expect(report.internal?.evidence).toHaveLength(1);
  expect(() => assertReportBinding(request, report)).not.toThrow();

  const wrongInternal = {
    ...report,
    internal: report.internal ? { ...report.internal, snapshotRef: 'source:wrong:sha256:wrong' } : null,
  };
  const wrongEvidence = {
    ...report,
    internal: report.internal ? {
      ...report.internal,
      evidence: report.internal.evidence.map((item, index) => index === 0 ? { ...item, snapshotRef: 'source:wrong:sha256:wrong' } : item),
    } : null,
  };

  expect(() => assertReportBinding(request, wrongInternal)).toThrow('report_subject_mismatch');
  expect(() => assertReportBinding(request, wrongEvidence)).toThrow('report_subject_mismatch');
});
