import { z } from 'zod';

const packageName = z.string().min(1).max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const version = z.string().max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const event = z.object({
  introduced: z.string().max(100).optional(),
  fixed: z.string().max(100).optional(),
  last_affected: z.string().max(100).optional(),
  limit: z.string().max(100).optional(),
}).strict().refine(value => Object.keys(value).length === 1);

export const osvAdvisoryMetadataSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  withdrawn: z.iso.datetime().nullable().optional(),
  affected: z.array(z.object({
    package: z.object({ ecosystem: z.string().max(100), name: packageName }).strict(),
    versions: z.array(version).max(200).optional(),
    ranges: z.array(z.object({ type: z.string().max(40), events: z.array(event).max(100) }).strict()).max(20).optional(),
  }).strict()).max(50),
}).strict();

export type OsvAdvisoryMetadata = z.infer<typeof osvAdvisoryMetadataSchema>;

export const dependencyFixReasonSchema = z.enum([
  'source_not_repository_bound',
  'github_connection_unavailable',
  'validation_suite_missing',
  'source_incomplete',
  'lockfile_unsupported',
  'workspace_not_supported',
  'package_not_direct',
  'transitive_override_not_supported',
  'advisory_metadata_missing',
  'advisory_withdrawn',
  'advisory_range_ambiguous',
  'advisory_version_mismatch',
  'no_patch_or_minor_fix',
  'registry_unavailable',
  'package_tree_change_required',
  'candidate_already_prepared',
  'prerelease_not_supported',
  'major_fix_required',
  'package_declaration_ambiguous',
  'lockfile_change_out_of_scope',
]);

export const dependencyFixRecommendationSchema = z.object({
  packageName,
  fromVersion: z.string().max(100),
  toVersion: z.string().max(100).nullable(),
  relationship: z.enum(['direct', 'transitive']),
  findingIds: z.array(z.uuid()).min(1).max(20),
  advisoryIds: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).min(1).max(20),
  withdrawnAdvisoryIds: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).max(20),
  status: z.enum(['eligible', 'guidance_only']),
  reason: dependencyFixReasonSchema.nullable(),
  diffSummary: z.string().min(1).max(500).nullable(),
  validationState: z.enum(['queued', 'running', 'passed', 'failed', 'inconclusive', 'quarantined', 'expired']).nullable(),
  candidateSourceId: z.uuid().nullable(),
  validationRunId: z.uuid().nullable(),
}).strict();

export const dependencyFixPreparationRequestSchema = z.object({ findingId: z.uuid(), expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const dependencyFixPreparationResponseSchema = z.object({
  candidateSourceId: z.uuid(),
  validationRunId: z.uuid(),
  fromVersion: z.string().max(100),
  toVersion: z.string().max(100),
  advisoryIds: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).min(1).max(20),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  diffSummary: z.string().min(1).max(500),
}).strict();

export type DependencyFixRecommendation = z.infer<typeof dependencyFixRecommendationSchema>;
export type DependencyFixPreparationRequest = z.infer<typeof dependencyFixPreparationRequestSchema>;
export type DependencyFixPreparationResponse = z.infer<typeof dependencyFixPreparationResponseSchema>;
