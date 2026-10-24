import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunnerJob } from '../src/contracts.js';
import { parseResult } from '../src/vm-output.js';
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
