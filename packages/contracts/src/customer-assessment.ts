import { z } from 'zod';
import { assessmentModeSchema, assessmentReportFields, refineAssessmentReport } from './assessment.js';
import { licensePolicySchema } from './supply-chain.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => !value.startsWith('0000-'));
const name = z.string().trim().min(1).max(200).refine(value => !value.includes('\0'));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CUSTOMER_MAX_SOURCE_BYTES = 4_194_304;
export const CUSTOMER_MAX_SOURCE_FILES = 1_000;
export const CUSTOMER_MAX_SOURCE_FILE_BYTES = 1_048_576;
export const CUSTOMER_MAX_CONTAINER_IMAGE_BYTES = 8_388_608;
export const CUSTOMER_MAX_REPORT_BYTES = 1_048_576;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** A syntactic origin allowlist. The trusted transport must also reject non-public DNS answers. */
export const customerOriginSchema = z.string().max(300).refine(value => {
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::443)?\/?$/.test(value)) return false;
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      && /[a-z]/.test(labels.at(-1) ?? '') && url.hostname.length <= 253
      && !/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(url.hostname);
  } catch { return false; }
}, 'Use a public HTTPS DNS origin without credentials, paths, query, fragment or custom port').transform(value => new URL(value).origin);
export const customerScopeSchema = z.object({ organizationId: uuid, applicationId: uuid }).strict();
export const customerWorkspaceSchema = z.object({ id: uuid, name, role: z.enum(['owner', 'operator', 'viewer']) }).strict();
export const customerCreateWorkspaceSchema = z.object({ name }).strict();
export const customerUpdateWorkspaceSchema = z.object({ organizationId: uuid, name }).strict();
export const customerCreateApplicationSchema = z.object({ organizationId: uuid, name }).strict();
export const customerApplicationSchema = customerScopeSchema.extend({ name, archived: z.boolean(), createdAt: timestamp }).strict();
export const customerUpdateApplicationSchema = customerScopeSchema.extend({ name: name.optional(), archived: z.boolean().optional() }).strict().refine(value => value.name !== undefined || value.archived !== undefined);
export const customerScanProfileSchema = z.enum(['root', 'public_surface']);
export const customerEnrollTargetSchema = customerScopeSchema.extend({ origin: customerOriginSchema, scanProfile: customerScanProfileSchema.optional() }).strict();
export const customerTargetIdSchema = customerScopeSchema.extend({ targetId: uuid }).strict();
export const customerTargetSchema = customerScopeSchema.extend({
  id: uuid, origin: customerOriginSchema, version: z.number().int().positive(),
  status: z.enum(['authorized', 'revoked']), requestedBy: z.string().min(1).max(256), requestedAt: timestamp,
  authorizedAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
  scanProfile: customerScanProfileSchema.optional(),
}).strict();
export const customerEnrollmentSchema = z.object({ target: customerTargetSchema }).strict();
export const customerSourceFileSchema = z.object({
  path: z.string().min(1).max(512).refine(path => {
    const parts = path.split('/');
    const lockFiles = new Set(['bun.lock', 'bun.lockb', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'pipfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'gradle.lockfile', 'yarn.lock']);
    return !/[\\\x00-\x1f\x7f:]/.test(path) && parts.every(part => part !== '' && part !== '.' && part !== '..'
      && !['.git', 'node_modules'].includes(part.toLowerCase()) && !part.toLowerCase().startsWith('.env'))
      && (/(?:^|\/)(?:dockerfile|containerfile)(?:\.[a-z0-9_-]+)?$/i.test(path)
        || /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|py|go|java|tf|tfvars|hcl|dockerfile)$/i.test(path)
        || lockFiles.has(parts.at(-1)?.toLowerCase() ?? ''));
  }, 'Only normalized relative JS/TS, Python, Go, Java, Dockerfile/Containerfile, Terraform, JSON, YAML, TOML and recognized lockfile paths are supported'),
  content: z.string().refine(value => !value.includes('\0') && bytes(value) <= CUSTOMER_MAX_SOURCE_FILE_BYTES, 'File exceeds 1 MiB or contains NUL'),
}).strict();
export const customerSourceSnapshotSchema = z.object({ revision: z.string().min(1).max(200).refine(value => !value.includes('\0')), files: z.array(customerSourceFileSchema).min(1).max(CUSTOMER_MAX_SOURCE_FILES) }).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) context.addIssue({ code: 'custom', message: 'Source paths must be unique' });
  if (bytes(JSON.stringify({ revision: value.revision, files: value.files })) > CUSTOMER_MAX_SOURCE_BYTES) context.addIssue({ code: 'custom', message: 'Snapshot exceeds 4 MiB' });
});
export const customerDeleteSourceSchema = customerScopeSchema.extend({ sourceSnapshotId: uuid }).strict();
export const customerUploadSourceSchema = customerScopeSchema.extend({ snapshot: customerSourceSnapshotSchema, authorized: z.literal(true) }).strict();
export const customerSourceSummarySchema = customerScopeSchema.extend({ id: uuid, digest, revision: z.string().min(1).max(200), fileCount: z.number().int().min(1).max(CUSTOMER_MAX_SOURCE_FILES), createdAt: timestamp }).strict();
const registryImageReferencePattern = /^(?:docker\.io|ghcr\.io|quay\.io|public\.ecr\.aws|gcr\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
export const customerPublicImageReferenceSchema = z.string().min(1).max(512).regex(registryImageReferencePattern, 'Use a public allowlisted registry reference pinned to a SHA-256 digest');
const customerContainerImageSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('archive'), imageId: uuid }).strict(),
  z.object({ kind: z.literal('registry'), reference: customerPublicImageReferenceSchema }).strict(),
]);
const archiveImageBase64 = z.string().max(Math.ceil(CUSTOMER_MAX_CONTAINER_IMAGE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
function base64ByteLength(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}
const customerRunContainerImageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('archive'), id: uuid, digest, size: z.number().int().positive().max(CUSTOMER_MAX_CONTAINER_IMAGE_BYTES), archiveBase64: archiveImageBase64 })
    .strict().superRefine((value, context) => {
      if (base64ByteLength(value.archiveBase64) !== value.size) context.addIssue({ code: 'custom', message: 'Container image archive size does not match its bytes' });
    }),
  z.object({ kind: z.literal('registry'), reference: customerPublicImageReferenceSchema, digest }).strict()
    .refine(value => value.reference.endsWith(`@sha256:${value.digest}`), 'Registry digest must match its pinned reference'),
]);
const customerContainerImageIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('archive'), id: uuid, digest, size: z.number().int().positive().max(CUSTOMER_MAX_CONTAINER_IMAGE_BYTES) }).strict(),
  z.object({ kind: z.literal('registry'), reference: customerPublicImageReferenceSchema, digest }).strict()
    .refine(value => value.reference.endsWith(`@sha256:${value.digest}`), 'Registry digest must match its pinned reference'),
]);
export const customerContainerImageUploadMetadataSchema = z.object({ label: name, authorized: z.literal(true) }).strict();
export const customerContainerImageSummarySchema = customerScopeSchema.extend({
  id: uuid, digest, label: name, size: z.number().int().positive().max(CUSTOMER_MAX_CONTAINER_IMAGE_BYTES), createdAt: timestamp,
}).strict();
export const customerQueueSchema = customerScopeSchema.extend({
  mode: assessmentModeSchema, sourceSnapshotId: uuid.nullable(), targetId: uuid.nullable(),
  inputKind: z.enum(['source_snapshot', 'container_image']).optional(),
  containerImage: customerContainerImageSelectionSchema.nullable().optional(),
  idempotencyKey: z.string().min(1).max(200),
}).strict().superRefine((value, context) => {
  const inputKind = value.inputKind ?? 'source_snapshot';
  const hasSource = value.mode !== 'external';
  const hasTarget = value.mode !== 'internal';
  if (hasTarget !== (value.targetId !== null)) context.addIssue({ code: 'custom', message: 'Target must match the requested mode' });
  if (inputKind === 'source_snapshot') {
    if (hasSource !== (value.sourceSnapshotId !== null) || value.containerImage != null) context.addIssue({ code: 'custom', message: 'Source snapshot must match the requested input kind' });
  } else if (value.mode !== 'internal' || value.sourceSnapshotId !== null || value.containerImage == null) {
    context.addIssue({ code: 'custom', message: 'Container image assessments require only an image input and the internal mode' });
  }
});
export const customerRunInputSchema = customerScopeSchema.extend({
  version: z.literal(2), jobId: uuid, applicationName: name, mode: assessmentModeSchema,
  inputKind: z.enum(['source_snapshot', 'container_image']).optional(),
  source: customerSourceSnapshotSchema.safeExtend({ id: uuid, digest }).nullable(),
  containerImage: customerRunContainerImageSchema.nullable().optional(),
  target: z.object({ id: uuid, origin: customerOriginSchema, version: z.number().int().positive(), authorizedAt: timestamp, expiresAt: timestamp, scanProfile: customerScanProfileSchema.optional() }).strict().nullable(),
  licensePolicy: licensePolicySchema.optional(),
}).strict().superRefine((value, context) => {
  const inputKind = value.inputKind ?? 'source_snapshot';
  const hasSource = value.mode !== 'external';
  const hasTarget = value.mode !== 'internal';
  if (hasTarget !== (value.target !== null)) context.addIssue({ code: 'custom', message: 'Target must match the requested mode' });
  if (inputKind === 'source_snapshot') {
    if (hasSource !== (value.source !== null) || value.containerImage != null) context.addIssue({ code: 'custom', message: 'Source snapshot must match the requested input kind' });
  } else if (value.mode !== 'internal' || value.source !== null || value.containerImage == null) {
    context.addIssue({ code: 'custom', message: 'Container image assessments require only an image input and the internal mode' });
  }
});
/** Compact durable intent; raw source exists only in the canonical snapshot store. */
export const customerAssessmentIntentSchema = z.object({
  ...customerRunInputSchema.shape,
  source: z.object({ id: uuid, digest, revision: z.string().min(1).max(200) }).strict().nullable(),
  containerImage: customerContainerImageIntentSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  const inputKind = value.inputKind ?? 'source_snapshot';
  const hasSource = value.mode !== 'external';
  const hasTarget = value.mode !== 'internal';
  if (hasTarget !== (value.target !== null)) context.addIssue({ code: 'custom', message: 'Target must match the requested mode' });
  if (inputKind === 'source_snapshot') {
    if (hasSource !== (value.source !== null) || value.containerImage != null) context.addIssue({ code: 'custom', message: 'Source snapshot must match the requested input kind' });
  } else if (value.mode !== 'internal' || value.source !== null || value.containerImage == null) {
    context.addIssue({ code: 'custom', message: 'Container image assessments require only an image input and the internal mode' });
  }
});
export const customerReportSubjectSchema = z.object({
  sourceSnapshotId: uuid.nullable(), sourceDigest: digest.nullable(), targetId: uuid.nullable(), targetVersion: z.number().int().positive().nullable(), origin: customerOriginSchema.nullable(),
  containerImageId: uuid.nullable().optional(), containerImageDigest: digest.nullable().optional(), containerImageReference: customerPublicImageReferenceSchema.nullable().optional(),
}).strict();
export const customerAssessmentReportSchema = z.object({ ...assessmentReportFields, version: z.literal(2), subject: customerReportSubjectSchema }).strict().superRefine(refineAssessmentReport).superRefine((report, context) => {
  const imageId = report.subject.containerImageId ?? null;
  const imageDigest = report.subject.containerImageDigest ?? null;
  const imageReference = report.subject.containerImageReference ?? null;
  const hasImage = imageId !== null || imageReference !== null;
  const source = report.mode !== 'external' && !hasImage;
  const target = report.mode !== 'internal';
  if (source !== (report.subject.sourceSnapshotId !== null) || source !== (report.subject.sourceDigest !== null)
    || target !== (report.subject.targetId !== null) || target !== (report.subject.targetVersion !== null) || target !== (report.subject.origin !== null)) context.addIssue({ code: 'custom', message: 'Report subject must match its mode' });
  if (hasImage !== (imageDigest !== null) || imageId !== null && imageReference !== null
    || hasImage && (report.mode !== 'internal' || report.subject.sourceSnapshotId !== null || report.subject.sourceDigest !== null)) {
    context.addIssue({ code: 'custom', message: 'Container image subject must be exclusive, digest-bound internal input' });
  }
  if (bytes(JSON.stringify(report)) > CUSTOMER_MAX_REPORT_BYTES) context.addIssue({ code: 'custom', message: 'Report exceeds 1 MiB' });
});
export const customerPendingOrganizationsSchema = z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict();
export const customerClaimSchema = customerScopeSchema.extend({ jobId: uuid, leaseToken: uuid }).strict();
export const customerReportSummarySchema = z.object({ id: uuid, jobId: uuid, applicationName: name, mode: assessmentModeSchema, startedAt: timestamp, finishedAt: timestamp, findingCount: z.number().int().min(0).max(200), subject: customerReportSubjectSchema }).strict();
export type CustomerWorkspace = z.infer<typeof customerWorkspaceSchema>;
export type CustomerApplication = z.infer<typeof customerApplicationSchema>;
export type CustomerTarget = z.infer<typeof customerTargetSchema>;
export type CustomerEnrollment = z.infer<typeof customerEnrollmentSchema>;
export type CustomerSourceSnapshot = z.infer<typeof customerSourceSnapshotSchema>;
export type CustomerSourceSummary = z.infer<typeof customerSourceSummarySchema>;
export type CustomerContainerImageSummary = z.infer<typeof customerContainerImageSummarySchema>;
export type CustomerQueueInput = z.infer<typeof customerQueueSchema>;
export type CustomerRunInput = z.infer<typeof customerRunInputSchema>;
export type CustomerAssessmentReport = z.infer<typeof customerAssessmentReportSchema>;
export type CustomerReportSummary = z.infer<typeof customerReportSummarySchema>;
export type CustomerClaim = z.infer<typeof customerClaimSchema>;

export type CustomerAssessmentIntent = z.infer<typeof customerAssessmentIntentSchema>;
