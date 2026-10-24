import { z } from 'zod';

export const assessmentModeSchema = z.enum(['internal', 'external', 'both']);
export const demoRevisionSchema = z.enum(['vulnerable', 'corrected']);
export const responseModeSchema = z.enum(['observation', 'approval', 'automatic_limited']);
export const assessmentOriginSchema = z.enum(['internal', 'external']);
export const findingSeveritySchema = z.enum(['unknown', 'informational', 'low', 'medium', 'high', 'critical']);
export const findingConfidenceSchema = z.enum(['observed', 'inferred', 'uncertain']);
const timestamp = z.iso.datetime().refine((value) => !value.startsWith('0000-'), 'Year zero is unsupported');
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const explanation = z.string().min(1).max(4_000);
const tool = z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict();

export const assessmentEvidenceSchema = z.object({
  id: z.uuid(),
  origin: assessmentOriginSchema,
  kind: z.enum(['source', 'dependency', 'configuration', 'http_response', 'advisory']),
  locator: z.string().min(1).max(1_024),
  collectedAt: timestamp,
  snapshotRef: z.string().min(1).max(512),
  tool,
  checksum,
  excerpt: z.string().max(4_096),
}).strict();

export const assessmentFindingSchema = z.object({
  id: z.uuid(),
  ruleId: z.string().min(1).max(128),
  correlationKey: z.string().min(1).max(512),
  origin: assessmentOriginSchema,
  title: z.string().min(1).max(256),
  location: z.string().min(1).max(1_024),
  description: explanation,
  severity: findingSeveritySchema,
  confidence: findingConfidenceSchema,
  exploitability: z.enum(['unknown', 'not_demonstrated', 'demonstrated_in_fixture']),
  impact: explanation,
  recommendation: explanation,
  limitations: z.array(explanation).max(20),
  evidenceIds: z.array(z.uuid()).min(1).max(20),
}).strict();

export const assessmentAnalysisSchema = z.object({
  origin: assessmentOriginSchema,
  status: z.enum(['completed', 'partial', 'unavailable']),
  startedAt: timestamp,
  finishedAt: timestamp,
  snapshotRef: z.string().min(1).max(512),
  tool,
  findings: z.array(assessmentFindingSchema).max(100),
  evidence: z.array(assessmentEvidenceSchema).max(200),
  coverage: z.array(z.object({
    capability: z.string().min(1).max(128),
    state: z.enum(['inspected', 'not_requested', 'unsupported', 'unavailable']),
    detail: explanation,
  }).strict()).max(40),
  limitations: z.array(explanation).max(40),
}).strict().superRefine((analysis, context) => {
  const evidenceIds = new Set(analysis.evidence.map((item) => item.id));
  if (evidenceIds.size !== analysis.evidence.length) context.addIssue({ code: 'custom', message: 'Evidence IDs must be unique' });
  for (const finding of analysis.findings) {
    if (finding.origin !== analysis.origin || finding.evidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({ code: 'custom', message: 'Findings require evidence from the same analysis' });
    }
  }
  if (analysis.evidence.some((item) => item.origin !== analysis.origin)) context.addIssue({ code: 'custom', message: 'Evidence origin must match its analysis' });
  if (analysis.status === 'unavailable' && (analysis.findings.length > 0 || analysis.coverage.some((item) => item.state === 'inspected'))) {
    context.addIssue({ code: 'custom', message: 'An unavailable analysis cannot claim inspection or findings' });
  }
  if (Date.parse(analysis.finishedAt) < Date.parse(analysis.startedAt)) context.addIssue({ code: 'custom', message: 'Analysis completion precedes its start' });
});

export const assessmentComparisonSchema = z.object({
  key: z.string().min(1).max(512),
  classification: z.enum(['both', 'internal_only', 'external_only', 'unverified']),
  internalFindingIds: z.array(z.uuid()).max(100),
  externalFindingIds: z.array(z.uuid()).max(100),
  explanation,
}).strict();

export const assessmentReportFields = {
  id: z.uuid(),
  organizationId: z.uuid(),
  applicationId: z.uuid(),
  jobId: z.uuid(),
  applicationName: z.string().min(1).max(200),
  mode: assessmentModeSchema,
  startedAt: timestamp,
  finishedAt: timestamp,
  internal: assessmentAnalysisSchema.nullable(),
  external: assessmentAnalysisSchema.nullable(),
  comparison: z.array(assessmentComparisonSchema).max(200),
  limitations: z.array(explanation).max(40),
  responseMode: z.literal('observation'),
  actionsPerformed: z.array(z.string()).max(0),
};

/** Shared semantic checks for every report version; no fixture projection. */
export function refineAssessmentReport(report: z.infer<z.ZodObject<typeof assessmentReportFields>>, context: z.RefinementCtx) {
  if ((report.mode !== 'external') !== (report.internal !== null) || (report.mode !== 'internal') !== (report.external !== null)) {
    context.addIssue({ code: 'custom', message: 'Analysis presence must match the requested mode' });
  }
  if (report.internal && report.internal.origin !== 'internal' || report.external && report.external.origin !== 'external') {
    context.addIssue({ code: 'custom', message: 'Report analysis origins are mismatched' });
  }
  const internal = new Set(report.internal?.findings.map((item) => item.id));
  const external = new Set(report.external?.findings.map((item) => item.id));
  const allFindings = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
  const byId = new Map(allFindings.map((finding) => [finding.id, finding]));
  const mentioned: string[] = [];
  if (byId.size !== allFindings.length) context.addIssue({ code: 'custom', message: 'Finding IDs must be unique across analyses' });
  if (new Set(report.comparison.map((item) => item.key)).size !== report.comparison.length) context.addIssue({ code: 'custom', message: 'Comparison keys must be unique' });
  for (const comparison of report.comparison) {
    const references = [...comparison.internalFindingIds, ...comparison.externalFindingIds];
    mentioned.push(...references);
    if (references.some((id) => byId.get(id)?.correlationKey !== comparison.key)) context.addIssue({ code: 'custom', message: 'Comparison must match finding correlation keys' });
    if (comparison.internalFindingIds.some((id) => !internal.has(id)) || comparison.externalFindingIds.some((id) => !external.has(id))) {
      context.addIssue({ code: 'custom', message: 'Comparison references an unknown finding' });
    }
    const hasInternal = comparison.internalFindingIds.length > 0;
    const hasExternal = comparison.externalFindingIds.length > 0;
    if (comparison.classification === 'both' && !(hasInternal && hasExternal)
      || comparison.classification === 'internal_only' && !(hasInternal && !hasExternal && report.external?.status === 'completed')
      || comparison.classification === 'external_only' && !(!hasInternal && hasExternal && report.internal?.status === 'completed')) {
      context.addIssue({ code: 'custom', message: 'Comparison classification is not supported by inspected analyses' });
    }
  }
  if (mentioned.length !== byId.size || new Set(mentioned).size !== mentioned.length) context.addIssue({ code: 'custom', message: 'Comparison must include each finding exactly once' });
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) context.addIssue({ code: 'custom', message: 'Report completion precedes its start' });
}

export const assessmentReportSchema = z.object({ ...assessmentReportFields, version: z.literal(1), revision: demoRevisionSchema }).strict().superRefine(refineAssessmentReport);

export const assessmentRequestSchema = z.object({ mode: assessmentModeSchema, revision: demoRevisionSchema }).strict();
export const assessmentRunInputSchema = assessmentRequestSchema.extend({
  organizationId: z.uuid(), applicationId: z.uuid(), jobId: z.uuid(), targetKey: z.string().min(1).max(128),
}).strict();
export type AssessmentMode = z.infer<typeof assessmentModeSchema>;
export type DemoRevision = z.infer<typeof demoRevisionSchema>;
export type AssessmentEvidence = z.infer<typeof assessmentEvidenceSchema>;
export type AssessmentFinding = z.infer<typeof assessmentFindingSchema>;
export type AssessmentAnalysis = z.infer<typeof assessmentAnalysisSchema>;
export type AssessmentComparison = z.infer<typeof assessmentComparisonSchema>;
export type AssessmentReport = z.infer<typeof assessmentReportSchema>;
export type AssessmentRequest = z.infer<typeof assessmentRequestSchema>;
export type AssessmentRunInput = z.infer<typeof assessmentRunInputSchema>;
