import { isScannerCleanupError } from './common.js';
import { createDockerScanners, type ScannerAdapter } from './docker.js';
import type { CustomerRunInput, CustomerAssessmentReport } from '@gotchu/contracts';
import type { HttpsOptions } from './https.js';
import type { AdvisoryAdapter } from './advisory.js';
import { assertLangChainTelemetryDisabled, runCustomerAssessmentPipeline } from './pipeline.js';
export { assertReportBinding, reportSubject, sourceDigest } from './pipeline.js';
export { isScannerCleanupError } from './common.js';
export { createDockerScanners, profiles } from './docker.js';
export type { ScannerAdapter, ScannerName, ToolResult } from './docker.js';
export { createOsvAdapter, parseLockfile } from './advisory.js';
export type { AdvisoryAdapter, AdvisoryMatch, LockedPackage } from './advisory.js';
export { isPublicAddress, createHttpsProbe } from './https.js';
export { createHttpsPageProbe } from './https.js';
export type { HttpsOptions, HttpsObservation, HttpsPageObservation } from './https.js';
export { assessPublicSurface, createPublicSurfaceProbe, publicSurfaceTargetSchema } from './public-surface.js';
export type { PublicSurfaceTarget, PublicSurfaceInventory, PublicSurfaceEntrypoint, PublicSurfaceDiscoverySource, PublicSurfaceStopReason, PublicSurfaceCoverageGap } from './public-surface.js';
export interface CustomerAssessmentOptions { scanners?: ScannerAdapter; advisory?: AdvisoryAdapter; https?: HttpsOptions; deadlineMs?: number }
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
      assertLangChainTelemetryDisabled();
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
      try {
        const { report } = await runCustomerAssessmentPipeline(raw, {
          scanners,
          ...(options.advisory ? { advisory: options.advisory } : {}),
          ...(options.https ? { https: options.https } : {}),
          deadlineMs,
        });
        return report;
      } catch (error) {
        if (isScannerCleanupError(error)) {
          fault = error;
          readinessCache = undefined;
        }
        throw error;
      }
    },
  };
}
