import { randomUUID } from 'node:crypto';
import { customerRunInputSchema, customerAssessmentReportSchema, type CustomerRunInput, type CustomerAssessmentReport } from '@gotchu/contracts';
import { compare, isScannerCleanupError, sha256 } from './common.js';
import { createDockerScanners, type ScannerAdapter } from './docker.js';
import { assessExternal } from './external.js';
import { assessPublicSurface, publicSurfaceTargetSchema } from './public-surface.js';
import { assessInternal } from './internal.js';
import type { HttpsOptions } from './https.js';
import type { AdvisoryAdapter } from './advisory.js';
export { isScannerCleanupError } from './common.js';
export { createDockerScanners, profiles } from './docker.js';
export type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
export { createOsvAdapter, parseLockfile } from './advisory.js';
export type { AdvisoryAdapter, AdvisoryMatch, LockedPackage } from './advisory.js';
export { isPublicAddress, createHttpsProbe } from './https.js';
export type { HttpsOptions, HttpsObservation } from './https.js';
export { assessPublicSurface, createPublicSurfaceProbe, publicSurfaceTargetSchema } from './public-surface.js';
export type { PublicSurfaceTarget, PublicSurfaceInventory, PublicSurfaceEntrypoint, PublicSurfaceDiscoverySource, PublicSurfaceStopReason, PublicSurfaceCoverageGap } from './public-surface.js';
export interface CustomerAssessmentOptions { scanners?: ScannerAdapter; advisory?: AdvisoryAdapter; https?: HttpsOptions; deadlineMs?: number }
export function sourceDigest(source: Pick<NonNullable<CustomerRunInput['source']>,'revision'|'files'>) { return sha256(JSON.stringify({files:source.files.map(file=>({content:file.content,path:file.path})),revision:source.revision})); }
export function reportSubject(input: CustomerRunInput) { return {sourceSnapshotId:input.source?.id??null,sourceDigest:input.source?.digest??null,targetId:input.target?.id??null,targetVersion:input.target?.version??null,origin:input.target?.origin??null}; }
export function assertReportBinding(input: CustomerRunInput, report: CustomerAssessmentReport) {
  const expected=reportSubject(input);
  const subject=report.subject;
  const sameSubject=subject.sourceSnapshotId===expected.sourceSnapshotId && subject.sourceDigest===expected.sourceDigest && subject.targetId===expected.targetId && subject.targetVersion===expected.targetVersion && subject.origin===expected.origin;
  const target=input.target;
  const expectedExternalSnapshotRef=target ? `target:${target.id}:${target.version}:${sha256(target.origin)}${target.scanProfile === 'public_surface' ? ':public_surface' : ''}` : null;
  const sameExternalProfile=report.external === null || report.external.snapshotRef === expectedExternalSnapshotRef;
  if (report.organizationId !== input.organizationId || report.applicationId !== input.applicationId || report.jobId !== input.jobId || report.applicationName !== input.applicationName || report.mode !== input.mode || !sameSubject || !sameExternalProfile) throw new Error('report_subject_mismatch');
}
export function createCustomerAssessmentRunner(options: CustomerAssessmentOptions = {}) {
  const scanners = options.scanners ?? createDockerScanners();
  const deadlineMs = options.deadlineMs ?? 55000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 55000) throw new Error('invalid_engine_deadline');
  let fault: Error | undefined;
  let readinessPending: Promise<{ready:boolean;tools:Array<{name:string;available:boolean}>}> | undefined;
  let readinessCache: {until:number;state:Awaited<NonNullable<typeof readinessPending>>} | undefined;
  return {
    async readiness() {
      if (fault) throw fault;
      if (readinessPending) return readinessPending;
      if (readinessCache && readinessCache.until > Date.now()) return readinessCache.state;
      readinessPending = (async()=>{
        const results = await Promise.allSettled([
          Promise.resolve().then(()=>scanners.readiness()),
          Promise.resolve().then(()=>options.advisory?.readiness?.() ?? false),
        ]);
        for (const result of results) if (result.status === 'rejected' && isScannerCleanupError(result.reason)) { fault=result.reason; throw fault; }
        if (fault) throw fault;
        const state = results[0].status === 'fulfilled' ? results[0].value : {ready:false,tools:[]};
        const advisoryReady = results[1].status === 'fulfilled' && results[1].value;
        const aggregate = {ready:state.ready && advisoryReady,tools:[...state.tools,{name:'npm_advisories',available:advisoryReady}]};
        readinessCache={until:Date.now()+30000,state:aggregate};
        return aggregate;
      })();
      try { return await readinessPending; } finally { readinessPending=undefined; }
    },
    async run(raw: CustomerRunInput): Promise<CustomerAssessmentReport> {
      if (fault) throw fault;
      const input = customerRunInputSchema.parse(raw);
      if (input.source && sourceDigest(input.source) !== input.source.digest) throw new Error('source_digest_mismatch');
      const startedAt = new Date().toISOString();
      const signal = AbortSignal.timeout(deadlineMs);
      const target = input.target;
      const results = await Promise.allSettled([
        input.mode === 'external' ? null : assessInternal(input,signal,scanners,options.advisory),
        input.mode === 'internal' ? null : target?.scanProfile === 'public_surface'
          ? assessPublicSurface(publicSurfaceTargetSchema.parse(target),signal,options.https)
          : assessExternal(input,signal,options.https),
      ]);
      // Neither branch may release the supervisor while the other still owns resources.
      for (const result of results) if (result.status === 'rejected' && isScannerCleanupError(result.reason)) { fault=result.reason; readinessCache=undefined; }
      if (fault) throw fault;
      const [internalResult,externalResult] = results;
      if (internalResult.status === 'rejected') throw internalResult.reason;
      if (externalResult.status === 'rejected') throw externalResult.reason;
      const internal=internalResult.value, external=externalResult.value;
      const report = customerAssessmentReportSchema.parse({version:2,id:randomUUID(),organizationId:input.organizationId,applicationId:input.applicationId,jobId:input.jobId,applicationName:input.applicationName,mode:input.mode,subject:reportSubject(input),startedAt,finishedAt:new Date().toISOString(),internal,external,comparison:compare(internal,external),responseMode:'observation',actionsPerformed:[],limitations:[input.target?.scanProfile === 'public_surface' ? 'Bounded static and independent public-surface HTTPS observations within the explicitly consented origin, not a comprehensive audit or company asset inventory. Unknown coverage remains unknown.' : 'Bounded static and independent root HTTPS observations, not a comprehensive audit or proof of safety. Unknown coverage remains unknown.', 'Uploaded source is not proven to match deployment. Version matches and banners never establish exploitation.', 'No customer-code execution, provider writes, remediation, monitoring or cloud deployment.']});
      assertReportBinding(input,report); return report;
    },
  };
}
