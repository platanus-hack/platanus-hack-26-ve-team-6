import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  customerAssessmentReportSchema,
  customerRunInputSchema,
  customerSourceSnapshotSchema,
  type CustomerAssessmentReport,
  type CustomerRunInput,
  type CustomerSourceSnapshot,
} from '@gotchu/contracts';
import { findRecipeForRule, remediationRecipeCatalog } from './catalog.js';
import { deriveRepositoryContext } from './context.js';
import { inspectExactTransform, replaceSourceFile, type TransformBlockReason } from './transforms.js';
import {
  correctionChangeSchema,
  prepareCorrectionRequestSchema as candidatePatchSelectionSchema,
  prepareCorrectionResponseSchema,
  recommendationScopeSchema,
  reportRecommendationsResponseSchema,
} from './contracts.js';
import type {
  PrepareCorrectionRequest,
  PrepareCorrectionResponse,
  RecommendationScope,
  RecipeCoverageStatus,
  RecipeRecommendation,
  ReportRecommendationsResponse,
} from './contracts.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const patchBlockedReasonSchema = z.enum([
  'finding_not_found',
  'source_required',
  'source_limit_exceeded',
  'recipe_requires_integration',
  'guided_review_required',
  'source_file_not_found',
  'location_unbound',
  'syntax_invalid',
  'ambiguous_transform',
  'unsupported_transform',
]);

export const candidatePatchPreparationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('prepared'),
    recipeId: z.string().min(1).max(80),
    recipeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    findingId: z.uuid(),
    scope: recommendationScopeSchema,
    path: z.string().min(1).max(512),
    originalFileSha256: digestSchema,
    beforeBytes: z.string(),
    afterBytes: z.string(),
    changes: z.array(correctionChangeSchema).min(1).max(1),
    patchHash: digestSchema,
    candidateSourceDigest: digestSchema,
    candidateSourceSnapshot: customerSourceSnapshotSchema,
  }).strict(),
  z.object({
    status: z.literal('blocked'),
    recipeId: z.string().min(1).max(80),
    findingId: z.uuid(),
    scope: recommendationScopeSchema,
    reason: patchBlockedReasonSchema,
  }).strict(),
]);

export type CandidatePatchPreparation = z.infer<typeof candidatePatchPreparationSchema>;

export class RecipeBoundaryError extends Error {
  constructor(readonly code: 'source_digest_mismatch' | 'expected_source_digest_mismatch' | 'assessment_scope_mismatch') {
    super(code);
    this.name = 'RecipeBoundaryError';
  }
}

export function calculateSourceDigest(source: Pick<CustomerSourceSnapshot, 'revision' | 'files'>): string {
  const canonical = JSON.stringify({ files: source.files.map((file) => ({ content: file.content, path: file.path })), revision: source.revision });
  return createHash('sha256').update(canonical).digest('hex');
}

interface ValidatedAssessment { input: CustomerRunInput; report: CustomerAssessmentReport; scope: RecommendationScope }

function validateAssessment(rawInput: unknown, rawReport: unknown): ValidatedAssessment {
  const input = customerRunInputSchema.parse(rawInput);
  const report = customerAssessmentReportSchema.parse(rawReport);
  if (input.source && calculateSourceDigest(input.source) !== input.source.digest) throw new RecipeBoundaryError('source_digest_mismatch');

  const subject = report.subject;
  const sourceSnapshotRef = input.source ? `source:${input.source.id}:sha256:${input.source.digest}` : null;
  const targetSnapshotRef = input.target
    ? `target:${input.target.id}:${input.target.version}:${createHash('sha256').update(input.target.origin).digest('hex')}`
    : null;
  const internalEvidenceBound = !report.internal || (report.internal.snapshotRef === sourceSnapshotRef
    && report.internal.evidence.every((item) => item.snapshotRef === sourceSnapshotRef));
  const externalEvidenceBound = !report.external || (report.external.snapshotRef === targetSnapshotRef
    && report.external.evidence.every((item) => item.snapshotRef === targetSnapshotRef));
  const matches = report.organizationId === input.organizationId
    && report.applicationId === input.applicationId
    && report.jobId === input.jobId
    && report.applicationName === input.applicationName
    && report.mode === input.mode
    && subject.sourceSnapshotId === (input.source?.id ?? null)
    && subject.sourceDigest === (input.source?.digest ?? null)
    && subject.targetId === (input.target?.id ?? null)
    && subject.targetVersion === (input.target?.version ?? null)
    && subject.origin === (input.target?.origin ?? null)
    && internalEvidenceBound
    && externalEvidenceBound;
  if (!matches) throw new RecipeBoundaryError('assessment_scope_mismatch');

  return {
    input,
    report,
    scope: recommendationScopeSchema.parse({
      organizationId: input.organizationId,
      applicationId: input.applicationId,
      applicationName: input.applicationName,
      jobId: input.jobId,
      reportId: report.id,
      mode: input.mode,
      sourceSnapshotId: input.source?.id ?? null,
      sourceDigest: input.source?.digest ?? null,
      targetId: input.target?.id ?? null,
      targetVersion: input.target?.version ?? null,
      targetOrigin: input.target?.origin ?? null,
    }),
  };
}

function coverageFor(mode: CustomerRunInput['mode'], recipeId: string, detectorAvailability: 'available' | 'not_implemented', capability: string | null, report: CustomerAssessmentReport): RecipeCoverageStatus['coverage'] {
  if (detectorAvailability === 'not_implemented' || !capability) return 'not_reported';
  const isSource = remediationRecipeCatalog.find((recipe) => recipe.id === recipeId)?.scope === 'source';
  const isHttps = remediationRecipeCatalog.find((recipe) => recipe.id === recipeId)?.scope === 'https';
  const analysis = isSource ? report.internal : isHttps ? report.external : null;
  const requested = isSource ? mode !== 'external' : isHttps ? mode !== 'internal' : false;
  if (!requested) return 'not_requested';
  if (!analysis) return 'unknown';
  const entry = analysis.coverage.find((coverage) => coverage.capability === capability);
  if (!entry) return 'unknown';
  if (entry.state === 'unavailable') return 'unknown';
  return entry.state;
}

function availabilityFor(recipeId: string, source: CustomerRunInput['source'], location: string): { availability: 'candidate_patch' | 'guided_review' | 'integration_required'; reason: string } {
  if (recipeId === 'credential-exposure') return { availability: 'integration_required', reason: 'Credential revocation or rotation needs an authorized issuer integration.' };
  if (recipeId === 'dependency-advisory') return { availability: 'integration_required', reason: 'No verified fixed release or lockfile transformation is available from this evidence.' };
  if (recipeId === 'tls-certificate-verification' || recipeId === 'kubernetes-config-hardening') {
    if (!source) return { availability: 'guided_review', reason: 'A source snapshot is required before an exact candidate can be prepared.' };
    const inspected = inspectExactTransform(recipeId, source, location);
    if (inspected.status === 'ready') return { availability: 'candidate_patch', reason: 'One exact literal is bound to the reported file and line.' };
    return { availability: 'guided_review', reason: reasonForTransform(inspected.reason) };
  }
  return { availability: 'guided_review', reason: 'The evidence supports review guidance but not a bounded source transformation.' };
}

function reasonForTransform(reason: TransformBlockReason): string {
  switch (reason) {
    case 'source_file_not_found': return 'The reported source path is not present in this snapshot.';
    case 'location_unbound': return 'The finding location does not identify one exact source line.';
    case 'syntax_invalid': return 'The source parser reported syntax errors, so no edit is prepared.';
    case 'ambiguous_transform': return 'More than one exact candidate matches the finding location.';
    case 'unsupported_transform': return 'No supported exact literal is bound to the finding location.';
  }
}

function relevantConfigurationPaths(recipeId: string, context: ReturnType<typeof deriveRepositoryContext>): string[] {
  const relevant = recipeId === 'kubernetes-config-hardening'
    ? context.configurationPaths.filter((path) => /(?:^|\/)(?:k8s|kubernetes|helm|charts)\//i.test(path) || /(?:^|\/)Chart\.yaml$/i.test(path))
    : recipeId === 'https-security-headers'
      ? context.configurationPaths.filter((path) => /(?:next\.config\.|(?:^|\/)(?:Caddyfile|nginx\.conf)$|(?:^|\/)(?:Dockerfile|docker-compose\.|compose\.))/i.test(path))
      : [];
  return relevant.slice(0, 20);
}

function makeCoverage(input: CustomerRunInput, report: CustomerAssessmentReport): RecipeCoverageStatus[] {
  return remediationRecipeCatalog.map((recipe) => ({
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    detectorAvailability: recipe.detectorAvailability,
    coverage: coverageFor(input.mode, recipe.id, recipe.detectorAvailability, recipe.detectorCapability, report),
  }));
}

/** Selects only versioned recipes that match findings in a validated, exact-scope report. */
export function buildRecipeRecommendations(rawInput: CustomerRunInput, rawReport: CustomerAssessmentReport): ReportRecommendationsResponse {
  const { input, report, scope } = validateAssessment(rawInput, rawReport);
  const context = deriveRepositoryContext(input);
  const recommendations: RecipeRecommendation[] = [];
  for (const finding of [...report.internal?.findings ?? [], ...report.external?.findings ?? []]) {
    const recipe = findRecipeForRule(finding.ruleId);
    if (!recipe) continue;
    const result = availabilityFor(recipe.id, input.source, finding.location);
    recommendations.push({
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      title: recipe.title,
      risk: { severity: finding.severity, confidence: finding.confidence, exploitability: finding.exploitability, summary: recipe.riskSummary },
      options: recipe.options,
      requirements: recipe.requirements,
      evidenceFindingIds: [finding.id],
      availability: result.availability,
      availabilityReason: result.reason,
      scope,
      architectureHints: { frameworks: context.frameworks, relevantConfigurationPaths: relevantConfigurationPaths(recipe.id, context) },
    });
  }
  return reportRecommendationsResponseSchema.parse({ catalogVersion: 1, scope, repositoryContext: context, coverage: makeCoverage(input, report), recommendations });
}

function blocked(recipeId: string, findingId: string, scope: RecommendationScope, reason: z.infer<typeof patchBlockedReasonSchema>): CandidatePatchPreparation {
  return candidatePatchPreparationSchema.parse({ status: 'blocked', recipeId, findingId, scope, reason });
}

/** Prepares one exact source candidate. It never writes storage, invokes tools, or runs customer code. */
export function prepareCandidatePatch(rawInput: CustomerRunInput, rawReport: CustomerAssessmentReport, rawSelection: PrepareCorrectionRequest): CandidatePatchPreparation {
  const { input, report, scope } = validateAssessment(rawInput, rawReport);
  const selection = candidatePatchSelectionSchema.parse(rawSelection);
  if (scope.sourceDigest !== selection.expectedSourceDigest) throw new RecipeBoundaryError('expected_source_digest_mismatch');
  const recommendation = buildRecipeRecommendations(input, report).recommendations.find((candidate) => candidate.recipeId === selection.recipeId
    && candidate.evidenceFindingIds.includes(selection.findingId));
  if (!recommendation) return blocked(selection.recipeId, selection.findingId, scope, 'finding_not_found');
  if (recommendation.availability === 'integration_required') return blocked(selection.recipeId, selection.findingId, scope, 'recipe_requires_integration');
  if (recommendation.availability !== 'candidate_patch') {
    const finding = [...report.internal?.findings ?? [], ...report.external?.findings ?? []].find((item) => item.id === selection.findingId);
    if (!finding) return blocked(selection.recipeId, selection.findingId, scope, 'finding_not_found');
    const inspection = input.source ? inspectExactTransform(selection.recipeId, input.source, finding.location) : undefined;
    return blocked(selection.recipeId, selection.findingId, scope, inspection?.status === 'blocked' ? inspection.reason : 'guided_review_required');
  }
  if (!input.source) return blocked(selection.recipeId, selection.findingId, scope, 'source_required');

  const finding = [...report.internal?.findings ?? [], ...report.external?.findings ?? []].find((item) => item.id === selection.findingId);
  const recipe = remediationRecipeCatalog.find((item) => item.id === selection.recipeId);
  if (!finding || !recipe) return blocked(selection.recipeId, selection.findingId, scope, 'finding_not_found');
  const transform = inspectExactTransform(recipe.id, input.source, finding.location);
  if (transform.status === 'blocked') return blocked(selection.recipeId, selection.findingId, scope, transform.reason);

  const candidateResult = customerSourceSnapshotSchema.safeParse(replaceSourceFile(input.source, transform.path, transform.afterBytes));
  if (!candidateResult.success) return blocked(selection.recipeId, selection.findingId, scope, 'source_limit_exceeded');
  const candidateSnapshot = candidateResult.data;
  const candidateSourceDigest = calculateSourceDigest(candidateSnapshot);
  const originalFileSha256 = createHash('sha256').update(transform.beforeBytes).digest('hex');
  const patchHash = createHash('sha256').update(JSON.stringify({
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    scope,
    findingId: finding.id,
    sourceSnapshotId: input.source.id,
    sourceDigest: input.source.digest,
    path: transform.path,
    originalFileSha256,
    beforeBytes: transform.beforeBytes,
    afterBytes: transform.afterBytes,
  })).digest('hex');

  if (!recipe.candidateChangeDescription) return blocked(selection.recipeId, selection.findingId, scope, 'guided_review_required');

  return candidatePatchPreparationSchema.parse({
    status: 'prepared',
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    findingId: finding.id,
    scope,
    path: transform.path,
    originalFileSha256,
    beforeBytes: transform.beforeBytes,
    afterBytes: transform.afterBytes,
    changes: [{ path: transform.path, description: recipe.candidateChangeDescription }],
    patchHash,
    candidateSourceDigest,
    candidateSourceSnapshot: candidateSnapshot,
  });
}

/** Creates the sanitized HTTP response after the backend stores a source and queues its rescan. */
export function correctionResponseForQueuedScan(preparation: CandidatePatchPreparation, sourceId: string, jobId: string): PrepareCorrectionResponse {
  if (preparation.status !== 'prepared') throw new Error('candidate_patch_not_prepared');
  return prepareCorrectionResponseSchema.parse({ sourceId, jobId, changes: preparation.changes, patchHash: preparation.patchHash });
}

export type { CustomerRunInput, CustomerAssessmentReport };
