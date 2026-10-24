import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();

export const validationStateSchema = z.enum(['queued', 'running', 'passed', 'failed', 'inconclusive', 'quarantined', 'expired']);
export const validationSuiteDefinitionSchema = z.object({
  id: uuid, organizationId: uuid, applicationId: uuid, repositoryLinkId: uuid, version: z.number().int().positive(),
  profile: z.literal('node24-npm-test'), scriptName: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
  suiteName: z.string().trim().min(1).max(128), requiredCount: z.number().int().min(1).max(10_000),
  regressionTestPath: z.string().min(1).max(256).nullable(), createdAt: timestamp,
}).strict();
export const validationSuiteConfigSchema = z.object({
  organizationId: uuid, applicationId: uuid, repositoryLinkId: uuid,
  scriptName: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/), suiteName: z.string().trim().min(1).max(128),
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
  suiteRepositoryLinkId: uuid.nullable(), suiteDefinitionId: uuid.nullable(), suiteVersion: z.number().int().positive().nullable(), runnerProfile: z.literal('node24-npm-test'),
  runnerDigest: digest.nullable(), firecrackerDigest: digest.nullable(), kernelDigest: digest.nullable(), rootfsDigest: digest.nullable(),
  sandboxKind: validationSandboxSchema, limits: validationLimitsSchema,
  state: validationStateSchema, reason: z.string().min(1).max(160).nullable(),
  queuedAt: timestamp, startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), expiresAt: timestamp,
}).strict();
export type ValidationRun = z.infer<typeof validationRunSchema>;

const findingSetSchema = z.object({ identities: z.array(z.string().min(1).max(256)).max(500), coverage: z.enum(['complete', 'partial', 'unknown']) }).strict();
const countsSchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict();
export const validationEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base_reproduction'), result: z.enum(['failed_for_target', 'passed', 'unavailable']), exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('candidate_regression'), result: z.enum(['passed', 'failed', 'unavailable']), exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('functional_suite'), suiteName: z.string().min(1).max(128), result: z.enum(['passed', 'failed', 'inconclusive']), counts: countsSchema, requiredCounts: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('independent_rescan'), result: z.enum(['passed', 'failed', 'inconclusive']), before: findingSetSchema, after: findingSetSchema, targetedIdentities: z.array(z.string().min(1).max(256)).max(500) }).strict(),
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
