import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { runnerResultSchema } from '@gotchu/runner';
import { suiteCounts } from '../src/suite-results.js';

const report = { schemaVersion: 1, profile: 'node24-tsx-selected-v1', complete: true, success: true,
  counts: { passed: 18, failed: 0, skipped: 1, cancelled: 0, total: 19 } };
function result(body: unknown, path = 'test-results/gotchu-node-selected-v1.json', truncated = false) {
  const bytes = Buffer.from(JSON.stringify(body));
  const digest = 'a'.repeat(64);
  const output = { text: '', sha256: digest, bytes: 0, truncated };
  return runnerResultSchema.parse({ status: 'completed', durationMs: 12, exitCode: 0, stdout: output, stderr: output,
    isolation: { sandbox: { kind: 'bwrap+systemd-scope', memoryMaxMiB: 1024, tasksMax: 128, cpuQuotaPercent: 100 },
      runnerVersion: '0.1.0', firecrackerVersion: '1.17.0', kernelDigest: digest, rootfsDigest: digest,
      profile: 'node24-tsx-selected-v1', networkPolicy: { mode: 'deny' }, lockfileSha256: digest,
      tarballSetSha256: digest, cleanupVerified: true },
    artifacts: [{ path, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }],
  });
}

it('accepts completed fixed-reporter counts and preserves explicitly omitted tests', () => {
  expect(suiteCounts(result(report), 'node24-tsx-selected-v1')).toEqual({ counts: { passed: 18, failed: 0, skipped: 1 }, regression: null, success: true });
});

it('rejects customer reports, missing completion, empty execution and truncated output', () => {
  expect(suiteCounts(result({ passed: 18, failed: 0, skipped: 0 }, 'test-results/customer.json'), 'node24-tsx-selected-v1')).toBeNull();
  expect(suiteCounts(result({ ...report, complete: false }), 'node24-tsx-selected-v1')).toBeNull();
  expect(suiteCounts(result({ ...report, counts: { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 } }), 'node24-tsx-selected-v1')).toBeNull();
  expect(suiteCounts(result(report, undefined, true), 'node24-tsx-selected-v1')).toBeNull();
  expect(suiteCounts(result(report), 'node24-npm-test')).toBeNull();
});

it('does not turn cancelled or failed tests into a passing suite', () => {
  const cancelled = { ...report, success: false, counts: { passed: 17, failed: 0, skipped: 1, cancelled: 1, total: 19 } };
  expect(suiteCounts(result(cancelled), 'node24-tsx-selected-v1')).toEqual({ counts: { passed: 17, failed: 1, skipped: 1 }, regression: null, success: false });
});
