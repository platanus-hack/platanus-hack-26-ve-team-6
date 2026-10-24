import { describe, expect, it } from 'vitest';
import { runnerJobSchema, runnerResultSchema } from '../src/contracts.js';

const validJob = {
  jobId: '4f8a1e08-bfde-4597-a753-21c0040bf51f',
  organizationId: 'dc7dc303-1601-4d3e-ae5a-611839b33167',
  profile: 'node24-npm-test',
  input: { objectId: 'e15a9a1a-62e0-4a76-aa98-5c62386ee1a6', sha256: 'a'.repeat(64), sizeBytes: 2048 },
  limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048 },
  networkPolicy: { mode: 'deny' },
};

describe('runner job contract', () => {
  it('accepts a bounded profile-selected job', () => {
    expect(runnerJobSchema.parse(validJob)).toMatchObject({ profile: 'node24-npm-test' });
  });

  it('rejects free-form command fields, oversized input, and unsupported limits', () => {
    expect(runnerJobSchema.safeParse({ ...validJob, command: 'sh -c rm -rf /' }).success).toBe(false);
    expect(runnerJobSchema.safeParse({ ...validJob, input: { ...validJob.input, sizeBytes: 9 * 1024 * 1024 } }).success).toBe(false);
    expect(runnerJobSchema.safeParse({ ...validJob, limits: { ...validJob.limits, memMiB: 0 } }).success).toBe(false);
  });

  it('requires isolation evidence for every result', () => {
    expect(runnerResultSchema.safeParse({ status: 'completed', exitCode: 0, durationMs: 3, stdout: {}, stderr: {}, artifacts: [] }).success).toBe(false);
    expect(runnerResultSchema.safeParse({ status: 'cleanup_uncertain', reason: 'process remains', durationMs: 3, isolation: {} }).success).toBe(false);
  });
});

export { validJob };
