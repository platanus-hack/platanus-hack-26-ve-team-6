import { type ChildProcess } from 'node:child_process';
import { runnerResultSchema, type RunnerJob, type RunnerResult } from './contracts.js';
import { makeOutput, type GuestPayload } from './protocol.js';
import { isolationEvidence } from './images.js';

export const MAX_SERIAL_BYTES = 8 * 1024 * 1024;

export interface VmOutcome {
  readonly result: RunnerResult;
  readonly cleanupVerified: boolean;
}

export function emptyOutput(limitBytes: number) {
  return makeOutput('', limitBytes);
}

export function parseResult(payload: GuestPayload, job: RunnerJob, durationMs: number): RunnerResult {
  const isolation = isolationEvidence(job, undefined, false, true);
  if (payload.status === 'infrastructure_failed') {
    return runnerResultSchema.parse({
      status: 'infrastructure_failed', reason: payload.reason, durationMs, isolation,
    });
  }
  const maxPerStream = Math.floor(job.limits.outputBytes / 2);
  const stdout = makeOutput(payload.stdout, maxPerStream);
  const stderr = makeOutput(payload.stderr, maxPerStream);
  if (payload.status === 'timed_out') return runnerResultSchema.parse({ status: 'timed_out', durationMs, isolation, stdout, stderr });
  if (payload.status === 'resource_exceeded') {
    return runnerResultSchema.parse({
      status: 'resource_exceeded', resource: payload.resource, durationMs, isolation, stdout, stderr,
    });
  }
  return runnerResultSchema.parse({
    status: 'completed', exitCode: payload.exitCode, durationMs, isolation, stdout, stderr, artifacts: [],
  });
}

export function collectCapped(child: ChildProcess, limit: number, onLimit: () => void): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = limit - bytes;
      if (remaining <= 0) {
        onLimit();
        return;
      }
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) onLimit();
    });
    child.stdout?.on('end', () => resolve(Buffer.concat(chunks)));
    if (!child.stdout) resolve(Buffer.alloc(0));
  });
}

export async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export function killProcessGroup(child: ChildProcess | undefined): void {
  if (!child?.pid || child.pid <= 1) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process may already have exited */ }
}

export function finalResult(outcome: RunnerResult, cleanupVerified: boolean): VmOutcome {
  const isolation = { ...outcome.isolation, cleanupVerified };
  if (!cleanupVerified) {
    return {
      result: runnerResultSchema.parse({ status: 'cleanup_uncertain', reason: 'VM process or per-job files could not be verified absent after cleanup', durationMs: outcome.durationMs, isolation }),
      cleanupVerified,
    };
  }
  return { result: runnerResultSchema.parse({ ...outcome, isolation }), cleanupVerified };
}

