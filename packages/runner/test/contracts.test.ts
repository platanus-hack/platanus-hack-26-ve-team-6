import { describe, expect, it } from 'vitest';
import { runnerJobSchema, runnerResultSchema, selectedNodeTestReportSchema } from '../src/contracts.js';

const validJob = {
  jobId: '4f8a1e08-bfde-4597-a753-21c0040bf51f',
  organizationId: 'dc7dc303-1601-4d3e-ae5a-611839b33167',
  profile: 'node24-npm-test',
  input: { objectId: 'e15a9a1a-62e0-4a76-aa98-5c62386ee1a6', sha256: 'a'.repeat(64), sizeBytes: 2048 },
  limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048 },
  networkPolicy: { mode: 'deny' },
};

describe('runner job contract', () => {
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

describe('selected Node profile contract', () => {
  const selected = { ...validJob, profile: 'node24-tsx-selected-v1', testSelection: { files: ['tests/creator.test.ts', 'tests/accounts.test.js'] } };

  it('requires selection only for the selected profile and rejects arbitrary command extensions', () => {
    expect(runnerJobSchema.safeParse(selected).success).toBe(true);
    expect(runnerJobSchema.safeParse({ ...selected, testSelection: undefined }).success).toBe(false);
    expect(runnerJobSchema.safeParse({ ...validJob, testSelection: selected.testSelection }).success).toBe(false);
    expect(runnerJobSchema.safeParse({ ...selected, testSelection: { ...selected.testSelection, command: 'npm test' } }).success).toBe(false);
  });

  it.each(['../escape.test.ts', '/root/x.test.js', '--import=evil.test.js', 'tests/a;echo.test.ts',
    'tests/a\\b.test.js', 'tests/./a.test.ts', 'tests//a.test.ts', 'node_modules/a.test.ts', 'src/app.ts'])('rejects unsafe selection %s', (path) => {
    expect(runnerJobSchema.safeParse({ ...selected, testSelection: { files: [path] } }).success).toBe(false);
  });

  it('bounds file counts, duplicates, name patterns, and their runtime syntax', () => {
    for (const files of [[], Array.from({ length: 21 }, (_, n) => `tests/${n}.test.ts`), ['x.test.ts', 'x.test.ts']]) {
      expect(runnerJobSchema.safeParse({ ...selected, testSelection: { files } }).success).toBe(false);
    }
    for (const namePattern of ['x'.repeat(257), '[', 'x\n', 'x\0']) {
      expect(runnerJobSchema.safeParse({ ...selected, testSelection: { files: ['x.test.ts'], namePattern } }).success).toBe(false);
    }
    expect(runnerJobSchema.safeParse({ ...selected, testSelection: { files: ['x.test.ts'], namePattern: 'x'.repeat(256) } }).success).toBe(true);
  });

  it('requires exact report version/profile, counts and no extra customer fields', () => {
    const report = { schemaVersion: 1, profile: 'node24-tsx-selected-v1', complete: true, success: true,
      counts: { passed: 2, failed: 0, skipped: 1, cancelled: 0, total: 3 } };
    expect(selectedNodeTestReportSchema.safeParse(report).success).toBe(true);
    expect(selectedNodeTestReportSchema.safeParse({ ...report, counts: { ...report.counts, total: 2 } }).success).toBe(false);
    expect(selectedNodeTestReportSchema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
    expect(selectedNodeTestReportSchema.safeParse({ ...report, customerSuccess: true }).success).toBe(false);
  });
});
