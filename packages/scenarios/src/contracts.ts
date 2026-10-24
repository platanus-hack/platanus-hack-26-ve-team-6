import { z } from 'zod';
import { dependencyFixRecommendationSchema } from '@gotchu/contracts';
import {
  customerOriginSchema,
  customerSourceFileSchema,
  findingConfidenceSchema,
  findingSeveritySchema,
} from '@gotchu/contracts';
import {
  detectorAvailabilitySchema,
  recipeAvailabilitySchema,
  recipeCatalogEntrySchema,
  recipeCoverageSchema,
  recipeOptionSchema,
  remediationRecipeCatalog,
} from './catalog.js';
import { repositoryContextSchema } from './context.js';

const uuid = z.uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const recommendationScopeSchema = z.object({
  organizationId: uuid,
  applicationId: uuid,
  applicationName: z.string().min(1).max(200),
  jobId: uuid,
  reportId: uuid,
  mode: z.enum(['internal', 'external', 'both']),
  sourceSnapshotId: uuid.nullable(),
  sourceDigest: digestSchema.nullable(),
  targetId: uuid.nullable(),
  targetVersion: z.number().int().positive().nullable(),
  targetOrigin: customerOriginSchema.nullable(),
}).strict();

export const architectureHintsSchema = z.object({
  frameworks: repositoryContextSchema.shape.frameworks,
  relevantConfigurationPaths: z.array(z.string().min(1).max(512)).max(20),
}).strict();

export const recipeRecommendationSchema = z.object({
  recipeId: z.string().min(1).max(80),
  recipeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1).max(160),
  risk: z.object({
    severity: findingSeveritySchema,
    confidence: findingConfidenceSchema,
    exploitability: z.enum(['unknown', 'not_demonstrated', 'demonstrated_in_fixture']),
    summary: z.string().min(1).max(500),
  }).strict(),
  options: z.array(recipeOptionSchema).min(1).max(5),
  requirements: z.array(z.string().min(1).max(300)).max(8),
  evidenceFindingIds: z.array(uuid).min(1).max(1),
  availability: recipeAvailabilitySchema,
  availabilityReason: z.string().min(1).max(300),
  scope: recommendationScopeSchema,
  architectureHints: architectureHintsSchema,
}).strict();

export const recipeCoverageStatusSchema = z.object({
  recipeId: z.string().min(1).max(80),
  recipeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  detectorAvailability: recipeCatalogEntrySchema.shape.detectorAvailability,
  coverage: recipeCoverageSchema,
}).strict();

export const reportRecommendationsResponseSchema = z.object({
  catalogVersion: z.literal(1),
  scope: recommendationScopeSchema,
  repositoryContext: repositoryContextSchema,
  coverage: z.array(recipeCoverageStatusSchema).max(20),
  recommendations: z.array(recipeRecommendationSchema).max(200),
  dependencyFixes: z.array(dependencyFixRecommendationSchema).max(20),
}).strict();

export const reportRecommendationsParamsSchema = z.object({ reportId: uuid }).strict();
export const prepareCorrectionRequestSchema = z.object({
  recipeId: z.string().regex(/^[a-z0-9-]{3,80}$/),
  findingId: uuid,
  expectedSourceDigest: digestSchema,
}).strict();

export const correctionChangeSchema = z.object({
  path: customerSourceFileSchema.shape.path,
  description: z.string().min(1).max(240),
}).strict();

export const prepareCorrectionResponseSchema = z.object({
  sourceId: uuid,
  jobId: uuid,
  changes: z.array(correctionChangeSchema).min(1).max(1),
  patchHash: digestSchema,
}).strict();

export type RecommendationScope = z.infer<typeof recommendationScopeSchema>;
export type ArchitectureHints = z.infer<typeof architectureHintsSchema>;
export type RecipeRecommendation = z.infer<typeof recipeRecommendationSchema>;
export type RecipeCoverageStatus = z.infer<typeof recipeCoverageStatusSchema>;
export type ReportRecommendationsResponse = z.infer<typeof reportRecommendationsResponseSchema>;
export type ReportRecommendationsParams = z.infer<typeof reportRecommendationsParamsSchema>;
export type PrepareCorrectionRequest = z.infer<typeof prepareCorrectionRequestSchema>;
export type CorrectionChange = z.infer<typeof correctionChangeSchema>;
export type PrepareCorrectionResponse = z.infer<typeof prepareCorrectionResponseSchema>;

export { remediationRecipeCatalog, detectorAvailabilitySchema, recipeAvailabilitySchema, recipeCatalogEntrySchema, recipeCoverageSchema, recipeOptionSchema };
export type { DetectorAvailability, RecipeAvailability, RecipeCatalogEntry, RecipeCoverage, RecipeOption } from './catalog.js';
export { repositoryContextSchema } from './context.js';
export type { RepositoryContext } from './context.js';
