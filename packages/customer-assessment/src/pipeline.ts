import { randomUUID } from 'node:crypto';
import {
  customerAssessmentReportSchema,
  customerRunInputSchema,
  type AssessmentAnalysis,
  type AssessmentMode,
  type CustomerAssessmentReport,
  type CustomerRunInput,
} from '@gotchu/contracts';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { compare, isScannerCleanupError, sha256 } from './common.js';
import { assessExternal } from './external.js';
import type { HttpsOptions } from './https.js';
import { assessInternal } from './internal.js';
import { assessContainerImage } from './container-image.js';
import type { AdvisoryAdapter } from './advisory.js';
import type { LicenseAdapter } from './licenses.js';
import { assessPublicSurface, publicSurfaceTargetSchema } from './public-surface.js';
import type { ScannerAdapter } from './docker.js';

export interface CustomerAssessmentPipelineOptions {
  scanners: ScannerAdapter;
  advisory?: AdvisoryAdapter;
  licenses?: LicenseAdapter;
  https?: HttpsOptions;
  deadlineMs: number;
}

export function sourceDigest(source: Pick<NonNullable<CustomerRunInput['source']>, 'revision' | 'files'>) {
  return sha256(JSON.stringify({ files: source.files.map(file => ({ content: file.content, path: file.path })), revision: source.revision }));
}

export function reportSubject(input: CustomerRunInput) {
  const image = input.containerImage ?? null;
  return {
    sourceSnapshotId: input.source?.id ?? null,
    sourceDigest: input.source?.digest ?? null,
    targetId: input.target?.id ?? null,
    targetVersion: input.target?.version ?? null,
    origin: input.target?.origin ?? null,
    containerImageId: image?.kind === 'archive' ? image.id : null,
    containerImageDigest: image?.digest ?? null,
    containerImageReference: image?.kind === 'registry' ? image.reference : null,
  };
}

export function assertReportBinding(input: CustomerRunInput, report: CustomerAssessmentReport) {
  const expected = reportSubject(input);
  const subject = report.subject;
  const sameSubject = subject.sourceSnapshotId === expected.sourceSnapshotId
    && subject.sourceDigest === expected.sourceDigest
    && subject.targetId === expected.targetId
    && subject.targetVersion === expected.targetVersion
    && subject.origin === expected.origin
    && (subject.containerImageId ?? null) === expected.containerImageId
    && (subject.containerImageDigest ?? null) === expected.containerImageDigest
    && (subject.containerImageReference ?? null) === expected.containerImageReference;
  const source = input.source;
  const image = input.containerImage ?? null;
  const expectedInternalSnapshot = image
    ? `container-image:sha256:${image.digest}`
    : source ? `source:${source.id}:sha256:${source.digest}` : null;
  const sameInternalSnapshot = report.internal === null || report.internal.snapshotRef === expectedInternalSnapshot;
  const target = input.target;
  const expectedExternalSnapshotRef = target
    ? `target:${target.id}:${target.version}:${sha256(target.origin)}${target.scanProfile === 'public_surface' ? ':public_surface' : ''}`
    : null;
  const sameExternalSnapshot = report.external === null || report.external.snapshotRef === expectedExternalSnapshotRef;
  const evidenceMatchesAnalysis = [report.internal, report.external]
    .filter((analysis): analysis is AssessmentAnalysis => analysis !== null)
    .every(analysis => analysis.evidence.every(item => item.snapshotRef === analysis.snapshotRef));
  if (report.organizationId !== input.organizationId || report.applicationId !== input.applicationId
    || report.jobId !== input.jobId || report.applicationName !== input.applicationName || report.mode !== input.mode
    || !sameSubject || !sameInternalSnapshot || !sameExternalSnapshot || !evidenceMatchesAnalysis) {
    throw new Error('report_subject_mismatch');
  }
}

export async function settleAnalyses(
  mode: AssessmentMode,
  runInternal: () => Promise<AssessmentAnalysis>,
  runExternal: () => Promise<AssessmentAnalysis>,
): Promise<[AssessmentAnalysis | null, AssessmentAnalysis | null]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => mode === 'external' ? null : runInternal()),
    Promise.resolve().then(() => mode === 'internal' ? null : runExternal()),
  ]);
  const cleanupFailure = results.find(result => result.status === 'rejected' && isScannerCleanupError(result.reason));
  if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason;
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const internal = results[0];
  const external = results[1];
  if (!internal || !external || internal.status !== 'fulfilled' || external.status !== 'fulfilled') {
    throw new Error('assessment_pipeline_incomplete');
  }
  return [internal.value, external.value];
}

const PipelineState = Annotation.Root({
  validated: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  analyzed: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  compared: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  finalized: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
});

interface Invocation {
  raw: unknown;
  options: CustomerAssessmentPipelineOptions;
  input?: CustomerRunInput;
  signal?: AbortSignal;
  startedAt?: string;
  internal?: AssessmentAnalysis | null;
  external?: AssessmentAnalysis | null;
  comparison?: ReturnType<typeof compare>;
  report?: CustomerAssessmentReport;
}

const telemetryEnvironmentVariables = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
] as const;

export function assertLangChainTelemetryDisabled() {
  // Core 1.3.0 injects env-driven callbacks outside RunnableConfig; fail before input or adapter work.
  const tracingEnabled = telemetryEnvironmentVariables.some(name => process.env[name] === 'true')
    // LangChain Core 1.3.0 checks LANGCHAIN_TRACING by truthiness after its v2 setting.
    || Boolean(process.env.LANGCHAIN_TRACING);
  if (tracingEnabled || process.env.LANGCHAIN_VERBOSE === 'true') {
    throw new Error('customer_assessment_langchain_telemetry_enabled');
  }
}

export async function runCustomerAssessmentPipeline(
  raw: unknown,
  options: CustomerAssessmentPipelineOptions,
) {
  assertLangChainTelemetryDisabled();
  const invocation: Invocation = { raw, options };
  const graph = new StateGraph(PipelineState)
    .addNode('validate', () => {
      const input = customerRunInputSchema.parse(invocation.raw);
      if (input.source && sourceDigest(input.source) !== input.source.digest) throw new Error('source_digest_mismatch');
      if (input.inputKind === 'container_image' && input.containerImage?.kind === 'archive') {
        const archive = Buffer.from(input.containerImage.archiveBase64, 'base64');
        if (archive.byteLength !== input.containerImage.size || sha256(archive) !== input.containerImage.digest) throw new Error('container_image_digest_mismatch');
      }
      invocation.input = input;
      invocation.startedAt = new Date().toISOString();
      invocation.signal = AbortSignal.timeout(options.deadlineMs);
      return { validated: 1 };
    })
    .addNode('analyze', async () => {
      const input = invocation.input;
      const signal = invocation.signal;
      if (!input || !signal) throw new Error('assessment_pipeline_not_validated');
      const [internal, external] = await settleAnalyses(
        input.mode,
        () => input.inputKind === 'container_image'
          ? assessContainerImage(input, signal, options.scanners)
          : assessInternal(input, signal, options.scanners, options.advisory, options.licenses),
        () => {
          const target = input.target;
          if (!target) throw new Error('missing_target');
          return target.scanProfile === 'public_surface'
            ? assessPublicSurface(publicSurfaceTargetSchema.parse(target), signal, options.https)
            : assessExternal(input, signal, options.https);
        },
      );
      invocation.internal = internal;
      invocation.external = external;
      return { analyzed: 1 };
    })
    .addNode('compare', () => {
      if (invocation.internal === undefined || invocation.external === undefined) throw new Error('assessment_pipeline_not_analyzed');
      invocation.comparison = compare(invocation.internal, invocation.external);
      return { compared: 1 };
    })
    .addNode('finalize', () => {
      const input = invocation.input;
      const startedAt = invocation.startedAt;
      const internal = invocation.internal;
      const external = invocation.external;
      const comparison = invocation.comparison;
      if (!input || !startedAt || internal === undefined || external === undefined || !comparison) {
        throw new Error('assessment_pipeline_not_compared');
      }
      const report = customerAssessmentReportSchema.parse({
        version: 2,
        id: randomUUID(),
        organizationId: input.organizationId,
        applicationId: input.applicationId,
        jobId: input.jobId,
        applicationName: input.applicationName,
        mode: input.mode,
        subject: reportSubject(input),
        startedAt,
        finishedAt: new Date().toISOString(),
        internal,
        external,
        comparison,
        responseMode: 'observation',
        actionsPerformed: [],
        limitations: [
          input.inputKind === 'container_image'
            ? 'The report scans an immutable image archive or digest-pinned public image. It does not prove the image is deployed or running; unsupported OS and language package coverage remains unknown.'
            : input.target?.scanProfile === 'public_surface'
            ? 'Bounded static and independent public-surface HTTPS observations within the explicitly consented origin, not a comprehensive audit or company asset inventory. Unknown coverage remains unknown.'
            : 'Bounded static and independent root HTTPS observations, not a comprehensive audit or proof of safety. Unknown coverage remains unknown.',
          'Uploaded source is not proven to match deployment. Version matches and banners never establish exploitation.',
          'No customer-code execution, provider writes, remediation, monitoring or cloud deployment.',
        ],
      });
      assertReportBinding(input, report);
      invocation.report = report;
      return { finalized: 1 };
    })
    .addEdge(START, 'validate')
    .addEdge('validate', 'analyze')
    .addEdge('analyze', 'compare')
    .addEdge('compare', 'finalize')
    .addEdge('finalize', END)
    .compile();

  const stages = await graph.invoke({}, { callbacks: [] });
  if (!invocation.report) throw new Error('assessment_report_missing');
  return { report: invocation.report, stages };
}
