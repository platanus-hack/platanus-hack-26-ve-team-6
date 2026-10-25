import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunnerJob } from '../src/contracts.js';
import { parseResult } from '../src/vm-output.js';
import { SELECTED_NODE_REPORT_PATH } from '../src/profile.js';
import type { GuestPayload } from '../src/protocol.js';

const job: RunnerJob = {
  jobId: randomUUID(),
  organizationId: randomUUID(),
  profile: 'node24-npm-test',
  input: { objectId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 1 },
  limits: { vcpu: 1, memMiB: 1024, pids: 128, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048 },
  networkPolicy: { mode: 'deny' },
};
const dependencies = { lockfileSha256: 'b'.repeat(64), tarballSetSha256: 'c'.repeat(64) };
const completedPayload: GuestPayload = {
  status: 'completed', exitCode: 0, ...dependencies, stdout: '', stderr: '', artifacts: [],
};

describe('host verified dependency evidence', () => {
  it('binds guest results to host fetched digests and rejects contradictory guest claims', () => {
    const result = parseResult(completedPayload, job, 10, dependencies);
    expect(result.isolation).toMatchObject(dependencies);

    expect(() => parseResult({ ...completedPayload, lockfileSha256: 'd'.repeat(64) }, job, 10, dependencies))
      .toThrow('Guest dependency evidence does not match host-verified dependencies');
    expect(() => parseResult({ ...completedPayload, tarballSetSha256: 'e'.repeat(64) }, job, 10, dependencies))
      .toThrow('Guest dependency evidence does not match host-verified dependencies');
  });

  it('retains host dependency provenance when the guest reports infrastructure failure', () => {
    const result = parseResult({ status: 'infrastructure_failed', reason: 'guest setup failed' }, job, 10, dependencies);
    expect(result).toMatchObject({ status: 'infrastructure_failed', isolation: dependencies });
  });
});

describe('selected Node host result validation', () => {
  const selectedJob: RunnerJob = { ...job, profile: 'node24-tsx-selected-v1', testSelection: { files: ['tests/creator.test.ts'] } };
  const report = { schemaVersion: 1, profile: 'node24-tsx-selected-v1', complete: true, success: true,
    counts: { passed: 2, failed: 0, skipped: 1, cancelled: 0, total: 3 } };
  function payload(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    return { status: 'completed', exitCode: 0, ...dependencies, stdout: '', stderr: '', artifacts: [{ path: SELECTED_NODE_REPORT_PATH, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }] } satisfies GuestPayload;
  }
  it('requires the reserved versioned report even when exit code is zero', () => {
    expect(parseResult(payload(report), selectedJob, 10, dependencies).status).toBe('completed');
    expect(() => parseResult(completedPayload, selectedJob, 10, dependencies)).toThrow('report is missing');
    expect(() => parseResult(payload({ passed: 10 }), selectedJob, 10, dependencies)).toThrow();
    expect(() => parseResult(payload({ ...report, complete: false }), selectedJob, 10, dependencies)).toThrow('complete successful nonempty');
    expect(() => parseResult(payload({ ...report, success: false }), selectedJob, 10, dependencies)).toThrow('complete successful nonempty');
  });
  it.each([
    { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 },
    { passed: 0, failed: 0, skipped: 2, cancelled: 0, total: 2 },
    { passed: 1, failed: 1, skipped: 0, cancelled: 0, total: 2 },
    { passed: 1, failed: 0, skipped: 0, cancelled: 1, total: 2 },
  ])('rejects zero execution, failure or cancellation despite a claimed success', (counts) => {
    expect(() => parseResult(payload({ ...report, counts }), selectedJob, 10, dependencies)).toThrow('complete successful nonempty');
  });
  it('rejects captured output truncation and corrupted structured artifacts', () => {
    expect(() => parseResult({ ...payload(report), stdout: 'x'.repeat(job.limits.outputBytes) }, selectedJob, 10, dependencies)).toThrow('output was truncated');
    const broken = payload(report);
    const artifact = broken.artifacts[0];
    if (!artifact) throw new Error('Expected report fixture');
    expect(() => parseResult({ ...broken, artifacts: [{ ...artifact, sha256: 'd'.repeat(64) }] }, selectedJob, 10, dependencies)).toThrow('digest or size is invalid');
  });
});
