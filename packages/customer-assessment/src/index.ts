import { randomUUID } from 'node:crypto';
import { customerRunInputSchema, customerAssessmentReportSchema, type CustomerRunInput, type CustomerAssessmentReport } from '@gotchu/contracts';
import { compare, sha256 } from './common.js';
import { createDockerScanners, type ScannerAdapter } from './docker.js';
import { assessExternal } from './external.js';
import { assessInternal } from './internal.js';
import type { HttpsOptions } from './https.js';
import type { AdvisoryAdapter } from './advisory.js';
export { createDockerScanners, profiles } from './docker.js';
export type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
export { createOsvAdapter, parseLockfile } from './advisory.js';
export type { AdvisoryAdapter, AdvisoryMatch, LockedPackage } from './advisory.js';
export { isPublicAddress, createHttpsProbe } from './https.js';
export type { HttpsOptions } from './https.js';
export interface CustomerAssessmentOptions { scanners?: ScannerAdapter; advisory?: AdvisoryAdapter; https?: HttpsOptions; deadlineMs?: number }
export function sourceDigest(source: Pick<NonNullable<CustomerRunInput['source']>,'revision'|'files'>) { return sha256(JSON.stringify({files:source.files.map(file=>({content:file.content,path:file.path})),revision:source.revision})); }
export function reportSubject(input: CustomerRunInput) { return {sourceSnapshotId:input.source?.id??null,sourceDigest:input.source?.digest??null,targetId:input.target?.id??null,targetVersion:input.target?.version??null,origin:input.target?.origin??null}; }
export function assertReportBinding(input: CustomerRunInput, report: CustomerAssessmentReport) {
  const expected=reportSubject(input);
  const subject=report.subject;
  const sameSubject=subject.sourceSnapshotId===expected.sourceSnapshotId && subject.sourceDigest===expected.sourceDigest && subject.targetId===expected.targetId && subject.targetVersion===expected.targetVersion && subject.origin===expected.origin;
  if (report.organizationId !== input.organizationId || report.applicationId !== input.applicationId || report.jobId !== input.jobId || report.applicationName !== input.applicationName || report.mode !== input.mode || !sameSubject) throw new Error('report_subject_mismatch');
}
export function createCustomerAssessmentRunner(options: CustomerAssessmentOptions = {}) {
  const scanners = options.scanners ?? createDockerScanners();
  const deadlineMs = options.deadlineMs ?? 55000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 55000) throw new Error('invalid_engine_deadline');
  return {
    async readiness() {
      const [state, advisoryReady] = await Promise.all([scanners.readiness(), options.advisory?.readiness?.() ?? false]);
      return {ready:state.ready && advisoryReady,tools:[...state.tools,{name:'npm_advisories',available:advisoryReady}]};
    },
    async run(raw: CustomerRunInput): Promise<CustomerAssessmentReport> {
      const input = customerRunInputSchema.parse(raw);
      if (input.source && sourceDigest(input.source) !== input.source.digest) throw new Error('source_digest_mismatch');
      const startedAt = new Date().toISOString();
      const signal = AbortSignal.timeout(deadlineMs);
      const [internal,external] = await Promise.all([
        input.mode === 'external' ? null : assessInternal(input,signal,scanners,options.advisory),
        input.mode === 'internal' ? null : assessExternal(input,signal,options.https),
      ]);
      const report = customerAssessmentReportSchema.parse({version:2,id:randomUUID(),organizationId:input.organizationId,applicationId:input.applicationId,jobId:input.jobId,applicationName:input.applicationName,mode:input.mode,subject:reportSubject(input),startedAt,finishedAt:new Date().toISOString(),internal,external,comparison:compare(internal,external),responseMode:'observation',actionsPerformed:[],limitations:['Bounded static and independent root HTTPS observations, not a comprehensive audit or proof of safety. Unknown coverage remains unknown.', 'Uploaded source is not proven to match deployment. Version matches and banners never establish exploitation.', 'No customer-code execution, provider writes, remediation, monitoring or cloud deployment.']});
      assertReportBinding(input,report); return report;
    },
  };
}
