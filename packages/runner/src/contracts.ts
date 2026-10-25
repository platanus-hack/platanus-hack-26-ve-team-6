import { z } from 'zod';

export const RUNNER_VERSION = '0.1.0';

export const runnerProfileSchema = z.enum(['node24-npm-test', 'node24-tsx-selected-v1']);
export const networkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('deny') }).strict(),
  z.object({
    mode: z.literal('allowlist'),
    hosts: z.array(z.string().min(1).max(253)).min(1).max(32),
  }).strict(),
]);

export const inputReferenceSchema = z.object({
  objectId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();

export const selectedTestFileSchema = z.string().min(1).max(512).regex(
  /^(?:[A-Za-z0-9_@][A-Za-z0-9_@.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/,
).refine((path) => !path.split('/').includes('node_modules'), 'Select repository tests, not installed dependencies');

export const runnerTestSelectionSchema = z.object({
  files: z.array(selectedTestFileSchema).min(1).max(20)
    .refine((files) => new Set(files).size === files.length, 'Duplicate test files are forbidden'),
  namePattern: z.string().min(1).max(256).refine((pattern) => {
    if (/[\x00-\x1f\x7f]/.test(pattern)) return false;
    try { new RegExp(pattern); return true; } catch { return false; }
  }, 'Expected a bounded valid test name regular expression').optional(),
}).strict();

export const selectedNodeTestReportSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.literal('node24-tsx-selected-v1'),
  complete: z.boolean(),
  success: z.boolean(),
  counts: z.object({
    passed: z.number().int().nonnegative().max(1_000_000),
    failed: z.number().int().nonnegative().max(1_000_000),
    skipped: z.number().int().nonnegative().max(1_000_000),
    cancelled: z.number().int().nonnegative().max(1_000_000),
    total: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
}).strict().refine(({ counts }) => counts.total === counts.passed + counts.failed + counts.skipped + counts.cancelled,
  'Test counts must sum to total');

const runnerJobBaseSchema = z.object({
  jobId: z.uuid(),
  organizationId: z.uuid(),
  input: inputReferenceSchema,
  limits: z.object({
    vcpu: z.number().int().min(1).max(2),
    memMiB: z.number().int().min(256).max(4096),
    pids: z.number().int().min(16).max(256),
    wallMs: z.number().int().min(1000).max(300_000),
    outputBytes: z.number().int().min(1024).max(1024 * 1024),
    diskMiB: z.number().int().min(2048).max(4096),
  }).strict(),
  networkPolicy: networkPolicySchema,
}).strict();

export const runnerJobSchema = z.discriminatedUnion('profile', [
  runnerJobBaseSchema.extend({ profile: z.literal('node24-npm-test'), testSelection: z.never().optional() }),
  runnerJobBaseSchema.extend({ profile: z.literal('node24-tsx-selected-v1'), testSelection: runnerTestSelectionSchema }),
]);

export type RunnerTestSelection = z.infer<typeof runnerTestSelectionSchema>;
export type SelectedNodeTestReport = z.infer<typeof selectedNodeTestReportSchema>;

const outputSchema = z.object({
  text: z.string().max(1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative().max(1024 * 1024),
}).strict();

export const runnerArtifactSchema = z.object({
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(256 * 1024),
  contentBase64: z.string().max(350_000),
}).strict();

const sandboxLimits = {
  memoryMaxMiB: z.number().int().positive(),
  tasksMax: z.number().int().positive(),
  cpuQuotaPercent: z.number().int().positive(),
};
const isolationBaseSchema = z.object({
  runnerVersion: z.string().min(1).max(64),
  profile: runnerProfileSchema,
  networkPolicy: networkPolicySchema,
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tarballSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanupVerified: z.boolean(),
}).strict();

const isolationSchema = z.union([
  isolationBaseSchema.extend({
    sandbox: z.object({ kind: z.literal('bwrap+systemd-scope'), ...sandboxLimits }).strict(),
    firecrackerVersion: z.string().min(1).max(64),
    kernelDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rootfsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  isolationBaseSchema.extend({
    sandbox: z.object({ kind: z.literal('docker'), ...sandboxLimits }).strict(),
    containerImageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    firecrackerVersion: z.null(),
    kernelDigest: z.null(),
    rootfsDigest: z.null(),
  }),
]);

const timed = z.object({
  durationMs: z.number().int().nonnegative().max(300_000),
  isolation: isolationSchema,
}).strict();

export const runnerResultSchema = z.discriminatedUnion('status', [
  timed.extend({
    status: z.literal('completed'),
    exitCode: z.number().int(),
    stdout: outputSchema,
    stderr: outputSchema,
    artifacts: z.array(runnerArtifactSchema).max(10),
  }),
  timed.extend({
    status: z.literal('timed_out'),
    stdout: outputSchema,
    stderr: outputSchema,
  }),
  timed.extend({
    status: z.literal('resource_exceeded'),
    resource: z.enum(['pids', 'memory', 'disk', 'output', 'cpu', 'artifact']),
    stdout: outputSchema,
    stderr: outputSchema,
  }),
  timed.extend({
    status: z.literal('infrastructure_failed'),
    reason: z.string().min(1).max(512),
    firecrackerStderr: z.string().max(16 * 1024).optional(),
  }),
  timed.extend({
    status: z.literal('cleanup_uncertain'),
    reason: z.string().min(1).max(512),
  }),
]);

export type RunnerJob = z.infer<typeof runnerJobSchema>;
export type RunnerProfile = z.infer<typeof runnerProfileSchema>;
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export type RunnerResult = z.infer<typeof runnerResultSchema>;
export type RunnerIsolation = z.infer<typeof isolationSchema>;
