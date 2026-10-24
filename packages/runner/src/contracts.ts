import { z } from 'zod';

export const RUNNER_VERSION = '0.1.0';

export const runnerProfileSchema = z.enum(['node24-npm-test']);
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

export const runnerJobSchema = z.object({
  jobId: z.uuid(),
  organizationId: z.uuid(),
  profile: runnerProfileSchema,
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

const outputSchema = z.object({
  text: z.string().max(1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative().max(1024 * 1024),
}).strict();

const artifactSchema = z.object({
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(64 * 1024 * 1024),
}).strict();

const isolationSchema = z.object({
  sandbox: z.object({ kind: z.literal('bwrap+systemd-scope'), memoryMaxMiB: z.number().int().positive(), tasksMax: z.number().int().positive(), cpuQuotaPercent: z.number().int().positive() }).strict(),
  runnerVersion: z.string().min(1).max(64),
  firecrackerVersion: z.string().min(1).max(64),
  kernelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  rootfsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  profile: runnerProfileSchema,
  networkPolicy: networkPolicySchema,
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tarballSetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanupVerified: z.boolean(),
}).strict();

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
    artifacts: z.array(artifactSchema).max(1000),
  }),
  timed.extend({
    status: z.literal('timed_out'),
    stdout: outputSchema,
    stderr: outputSchema,
  }),
  timed.extend({
    status: z.literal('resource_exceeded'),
    resource: z.enum(['pids', 'memory', 'disk', 'output', 'cpu']),
    stdout: outputSchema,
    stderr: outputSchema,
  }),
  timed.extend({
    status: z.literal('infrastructure_failed'),
    reason: z.string().min(1).max(512),
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
