import { z } from 'zod';
import { validationTestSelectionSchema } from './validation-selection.js';
import { dependencyArtifactIdentities, dependencyRescanScopeSchema, scoreDependencyRescanCoverage, suiteBindingSchema, type DependencyRescanScope } from './dependency-validation.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();

export const validationStateSchema = z.enum(['queued', 'running', 'passed', 'failed', 'inconclusive', 'quarantined', 'expired']);
export const validationProfileSchema = z.enum(['node24-npm-test', 'node24-tsx-selected-v1']);
export { validationTestSelectionSchema } from './validation-selection.js';

export const validationSuiteDefinitionSchema = z.object({
  id: uuid, organizationId: uuid, applicationId: uuid, repositoryLinkId: uuid, version: z.number().int().positive(),
  profile: validationProfileSchema, scriptName: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
  suiteName: z.string().trim().min(1).max(128), requiredCount: z.number().int().min(1).max(10_000),
  regressionTestPath: z.string().min(1).max(256).nullable(), testSelection: validationTestSelectionSchema.nullable().default(null), createdAt: timestamp,
}).strict().superRefine((suite, context) => {
  if (suite.profile === 'node24-tsx-selected-v1' && (suite.scriptName !== 'test' || suite.testSelection === null)) {
    context.addIssue({ code: 'custom', path: ['testSelection'], message: 'The selected test profile requires the test script and an explicit file selection' });
  }
  if (suite.profile === 'node24-npm-test' && suite.testSelection !== null) {
    context.addIssue({ code: 'custom', path: ['testSelection'], message: 'The legacy test profile cannot include a selected file scope' });
  }
});
export const validationSuiteConfigSchema = z.object({
  organizationId: uuid, applicationId: uuid, repositoryLinkId: uuid,
  scriptName: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/), suiteName: z.string().trim().min(1).max(128),
  profile: validationProfileSchema.default('node24-npm-test'),
  testSelection: validationTestSelectionSchema.nullable().default(null),
  requiredCount: z.number().int().min(1).max(10_000), regressionTestPath: z.string().min(1).max(256).nullable().optional(),
}).strict();
export const validationSandboxSchema = z.literal('bwrap+systemd-scope');
export const validationLimitsSchema = z.object({
  vcpu: z.number().int().min(1).max(2), memMiB: z.number().int().min(256).max(4096),
  pids: z.number().int().min(16).max(256), wallMs: z.number().int().min(1_000).max(300_000),
  outputBytes: z.number().int().min(1_024).max(1_048_576), diskMiB: z.number().int().min(2_048).max(4_096),
}).strict();

export const validationRunSchema = z.object({
  id: uuid, organizationId: uuid, applicationId: uuid,
  actionRef: uuid, targetFindingId: uuid, candidateSourceId: uuid, baseSourceId: uuid,
  baseSnapshotDigest: digest, candidateTreeDigest: digest, patchDigest: digest,
  suiteRepositoryLinkId: uuid.nullable(), suiteDefinitionId: uuid.nullable(), suiteVersion: z.number().int().positive().nullable(), runnerProfile: validationProfileSchema,
  runnerDigest: digest.nullable(), firecrackerDigest: digest.nullable(), kernelDigest: digest.nullable(), rootfsDigest: digest.nullable(),
  sandboxKind: validationSandboxSchema, limits: validationLimitsSchema,
  state: validationStateSchema, reason: z.string().min(1).max(160).nullable(),
  queuedAt: timestamp, startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), expiresAt: timestamp,
}).strict();
export type ValidationRun = z.infer<typeof validationRunSchema>;

const findingSetSchema = z.object({ identities: z.array(z.string().min(1).max(256)).max(500), coverage: z.enum(['complete', 'partial', 'unknown']) }).strict();
const countsSchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict();
export type ValidationFindingSet = z.infer<typeof findingSetSchema>;
export type ValidationCounts = z.infer<typeof countsSchema>;

export function scoreIndependentRescan(input: {
  before: ValidationFindingSet;
  after: ValidationFindingSet;
  targetedIdentities: readonly string[];
  dependencyScope?: DependencyRescanScope;
}, mode: 'correction' | 'dependency' = 'correction'): { result: 'passed' | 'failed' | 'inconclusive'; reason: 'new_findings' | 'targeted_findings_remain' | 'rescan_coverage_unknown' | 'target_identity_missing' | null } {
  if (input.dependencyScope !== undefined) {
    if (mode !== 'dependency' || scoreDependencyRescanCoverage(input.dependencyScope).result !== 'passed') return { result: 'inconclusive', reason: 'rescan_coverage_unknown' };
    if (dependencyArtifactIdentities(input.dependencyScope.artifactResults.before).some(identity => !input.before.identities.includes(identity))
      || dependencyArtifactIdentities(input.dependencyScope.artifactResults.after).some(identity => !input.after.identities.includes(identity))) {
      return { result: 'inconclusive', reason: 'rescan_coverage_unknown' };
    }
  } else if (input.before.coverage !== 'complete' || input.after.coverage !== 'complete') return { result: 'inconclusive', reason: 'rescan_coverage_unknown' };
  if (input.targetedIdentities.length === 0 || input.targetedIdentities.some(identity => !input.before.identities.includes(identity))) return { result: 'inconclusive', reason: 'target_identity_missing' };
  if (input.after.identities.some(identity => !input.before.identities.includes(identity))) return { result: 'failed', reason: 'new_findings' };
  if (input.targetedIdentities.some(identity => input.after.identities.includes(identity))) return { result: 'failed', reason: 'targeted_findings_remain' };
  return { result: 'passed', reason: null };
}

export const validationEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base_reproduction'), result: z.enum(['failed_for_target', 'passed', 'unavailable', 'not_required']), exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('candidate_regression'), result: z.enum(['passed', 'failed', 'unavailable']), exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('functional_suite'), suiteName: z.string().min(1).max(128), result: z.enum(['passed', 'failed', 'inconclusive']), counts: countsSchema, baseCounts: countsSchema.optional(), requiredCounts: z.number().int().positive(), suiteBinding: suiteBindingSchema.optional() }).strict(),
  z.object({ kind: z.literal('independent_rescan'), result: z.enum(['passed', 'failed', 'inconclusive']), before: findingSetSchema, after: findingSetSchema, targetedIdentities: z.array(z.string().min(1).max(256)).max(500), dependencyScope: dependencyRescanScopeSchema.optional() }).strict(),
]);
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;

export const validationAttestationPayloadSchema = z.object({
  id: uuid, organizationId: uuid, applicationId: uuid, runId: uuid, actionRef: uuid,
  evidence: validationEvidenceSchema, createdAt: timestamp, expiresAt: timestamp,
}).strict();
export type ValidationAttestationPayload = z.infer<typeof validationAttestationPayloadSchema>;
export const validationAttestationSchema = z.object({
  payload: validationAttestationPayloadSchema,
  keyId: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
}).strict();
export type ValidationAttestation = z.infer<typeof validationAttestationSchema>;

export const validationPublicProjectionSchema = z.object({
  run: validationRunSchema,
  attestations: z.array(validationAttestationPayloadSchema),
  facts: z.object({ objectiveRescanPassed: z.boolean(), functionalSuitePassed: z.boolean(), suiteName: z.string().nullable(), passedCount: z.number().int().nonnegative().nullable() }).strict(),
}).strict();
export type ValidationPublicProjection = z.infer<typeof validationPublicProjectionSchema>;

export const validationFactsSchema = z.object({
  actionRef: uuid, runId: uuid, state: validationStateSchema,
  attestations: z.array(validationAttestationSchema).max(4),
  keys: z.array(z.object({ keyId: digest, publicKey: z.string().min(1).max(256) }).strict()).max(4),
}).strict();
export type ValidationFacts = z.infer<typeof validationFactsSchema>;
