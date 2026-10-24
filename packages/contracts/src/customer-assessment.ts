import { z } from 'zod';
import { assessmentModeSchema, assessmentReportFields, refineAssessmentReport } from './assessment.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => !value.startsWith('0000-'));
const name = z.string().trim().min(1).max(200).refine(value => !value.includes('\0'));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CUSTOMER_MAX_SOURCE_BYTES = 4_194_304;
export const CUSTOMER_MAX_SOURCE_FILES = 1_000;
export const CUSTOMER_MAX_SOURCE_FILE_BYTES = 1_048_576;
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
export const customerCreateApplicationSchema = z.object({ organizationId: uuid, name }).strict();
export const customerApplicationSchema = customerScopeSchema.extend({ name, archived: z.boolean(), createdAt: timestamp }).strict();
export const customerUpdateApplicationSchema = customerScopeSchema.extend({ name: name.optional(), archived: z.boolean().optional() }).strict().refine(value => value.name !== undefined || value.archived !== undefined);
export const customerEnrollTargetSchema = customerScopeSchema.extend({ origin: customerOriginSchema, authorized: z.literal(true) }).strict();
export const customerTargetIdSchema = customerScopeSchema.extend({ targetId: uuid }).strict();
export const customerTargetSchema = customerScopeSchema.extend({
  id: uuid, origin: customerOriginSchema, version: z.number().int().positive(),
  status: z.enum(['pending', 'verified', 'revoked']), consentActor: z.string().min(1).max(256), consentAt: timestamp,
  challengeExpiresAt: timestamp, verifiedAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
}).strict();
export const customerEnrollmentSchema = z.object({ target: customerTargetSchema, challenge: z.object({ name: z.string(), value: z.string(), expiresAt: timestamp }).strict() }).strict();
export const customerSourceFileSchema = z.object({
  path: z.string().min(1).max(512).refine(path => {
    const parts = path.split('/');
    return !/[\\\x00-\x1f\x7f:]/.test(path) && parts.every(part => part !== '' && part !== '.' && part !== '..'
      && !['.git', 'node_modules'].includes(part.toLowerCase()) && !part.toLowerCase().startsWith('.env'))
      && /\.(?:[cm]?[jt]sx?|json|ya?ml|toml)$/i.test(path);
  }, 'Only normalized relative JS/TS, JSON, YAML and TOML paths are supported'),
  content: z.string().refine(value => !value.includes('\0') && bytes(value) <= CUSTOMER_MAX_SOURCE_FILE_BYTES, 'File exceeds 1 MiB or contains NUL'),
}).strict();
export const customerSourceSnapshotSchema = z.object({ revision: z.string().min(1).max(200).refine(value => !value.includes('\0')), files: z.array(customerSourceFileSchema).min(1).max(CUSTOMER_MAX_SOURCE_FILES) }).strict().superRefine((value, context) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) context.addIssue({ code: 'custom', message: 'Source paths must be unique' });
  if (bytes(JSON.stringify({ revision: value.revision, files: value.files })) > CUSTOMER_MAX_SOURCE_BYTES) context.addIssue({ code: 'custom', message: 'Snapshot exceeds 4 MiB' });
});
export const customerDeleteSourceSchema = customerScopeSchema.extend({ sourceSnapshotId: uuid }).strict();
export const customerUploadSourceSchema = customerScopeSchema.extend({ snapshot: customerSourceSnapshotSchema, authorized: z.literal(true) }).strict();
export const customerSourceSummarySchema = customerScopeSchema.extend({ id: uuid, digest, revision: z.string().min(1).max(200), fileCount: z.number().int().min(1).max(CUSTOMER_MAX_SOURCE_FILES), createdAt: timestamp }).strict();
export const customerQueueSchema = customerScopeSchema.extend({ mode: assessmentModeSchema, sourceSnapshotId: uuid.nullable(), targetId: uuid.nullable(), idempotencyKey: z.string().min(1).max(200) }).strict().superRefine((value, context) => {
  if ((value.mode !== 'external') !== (value.sourceSnapshotId !== null) || (value.mode !== 'internal') !== (value.targetId !== null)) context.addIssue({ code: 'custom', message: 'Source and target must match the requested mode' });
});
export const customerRunInputSchema = customerScopeSchema.extend({
  version: z.literal(2), jobId: uuid, applicationName: name, mode: assessmentModeSchema,
  source: customerSourceSnapshotSchema.safeExtend({ id: uuid, digest }).nullable(),
  target: z.object({ id: uuid, origin: customerOriginSchema, version: z.number().int().positive(), verifiedAt: timestamp, expiresAt: timestamp }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.mode !== 'external') !== (value.source !== null) || (value.mode !== 'internal') !== (value.target !== null)) context.addIssue({ code: 'custom', message: 'Source and target must match the requested mode' });
});
/** Compact durable intent; raw source exists only in the canonical snapshot store. */
export const customerAssessmentIntentSchema = z.object({
  ...customerRunInputSchema.shape,
  source: z.object({ id: uuid, digest, revision: z.string().min(1).max(200) }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.mode !== 'external') !== (value.source !== null) || (value.mode !== 'internal') !== (value.target !== null)) context.addIssue({ code: 'custom', message: 'Source and target must match the requested mode' });
});
export const customerReportSubjectSchema = z.object({ sourceSnapshotId: uuid.nullable(), sourceDigest: digest.nullable(), targetId: uuid.nullable(), targetVersion: z.number().int().positive().nullable(), origin: customerOriginSchema.nullable() }).strict();
export const customerAssessmentReportSchema = z.object({ ...assessmentReportFields, version: z.literal(2), subject: customerReportSubjectSchema }).strict().superRefine(refineAssessmentReport).superRefine((report, context) => {
  const source = report.mode !== 'external'; const target = report.mode !== 'internal';
  if (source !== (report.subject.sourceSnapshotId !== null) || source !== (report.subject.sourceDigest !== null)
    || target !== (report.subject.targetId !== null) || target !== (report.subject.targetVersion !== null) || target !== (report.subject.origin !== null)) context.addIssue({ code: 'custom', message: 'Report subject must match its mode' });
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
export type CustomerQueueInput = z.infer<typeof customerQueueSchema>;
export type CustomerRunInput = z.infer<typeof customerRunInputSchema>;
export type CustomerAssessmentReport = z.infer<typeof customerAssessmentReportSchema>;
export type CustomerReportSummary = z.infer<typeof customerReportSummarySchema>;
export type CustomerClaim = z.infer<typeof customerClaimSchema>;

export type CustomerAssessmentIntent = z.infer<typeof customerAssessmentIntentSchema>;
