import { createHash } from 'node:crypto';
import { type ChildProcess } from 'node:child_process';
import { runnerArtifactSchema, runnerResultSchema, type RunnerJob, type RunnerResult } from './contracts.js';
import { makeOutput, type GuestPayload } from './protocol.js';
import { isolationEvidence } from './images.js';
import { isAllowedArtifactPath, NODE24_NPM_TEST_PROFILE } from './profile.js';

export interface DependencyEvidence {
  readonly lockfileSha256: string;
  readonly tarballSetSha256: string;
}

export const MAX_SERIAL_BYTES = 8 * 1024 * 1024;

export interface VmOutcome {
  readonly result: RunnerResult;
  readonly cleanupVerified: boolean;
}

export function emptyOutput(limitBytes: number) {
  return makeOutput('', limitBytes);
}

export function parseResult(payload: GuestPayload, job: RunnerJob, durationMs: number, dependencies: DependencyEvidence): RunnerResult {
  if (payload.status !== 'infrastructure_failed'
    && (payload.lockfileSha256 !== dependencies.lockfileSha256 || payload.tarballSetSha256 !== dependencies.tarballSetSha256)) {
    throw new Error('Guest dependency evidence does not match host-verified dependencies');
  }
  const isolation = isolationEvidence(job, undefined, false, true, dependencies);
  if (payload.status === 'infrastructure_failed') {
    return runnerResultSchema.parse({
      status: 'infrastructure_failed', reason: payload.reason, durationMs, isolation,
    });
  }
  const maxPerStream = Math.floor(job.limits.outputBytes / 2);
  const guestCappedOutput = payload.status === 'resource_exceeded' && payload.resource === 'output';
  const captured = (value: string) => {
    const output = makeOutput(value, maxPerStream);
    return guestCappedOutput ? { ...output, truncated: true } : output;
  };
  const artifactPaths = new Set<string>();
  const artifacts = payload.artifacts.map((item) => {
    const artifact = runnerArtifactSchema.parse(item);
    if (!isAllowedArtifactPath(artifact.path)) throw new Error(`Guest returned an artifact outside the profile allowlist: ${artifact.path}`);
    if (artifactPaths.has(artifact.path)) throw new Error(`Guest returned a duplicate artifact path: ${artifact.path}`);
    artifactPaths.add(artifact.path);
    const bytes = Buffer.from(artifact.contentBase64, 'base64');
    if (bytes.toString('base64') !== artifact.contentBase64 || bytes.length !== artifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error(`Guest artifact digest or size is invalid: ${artifact.path}`);
    }
    return artifact;
  });
  if (artifacts.length > NODE24_NPM_TEST_PROFILE.artifacts.maxCount || artifacts.reduce((sum, item) => sum + item.sizeBytes, 0) > NODE24_NPM_TEST_PROFILE.artifacts.maxBytes) {
    throw new Error('Guest artifacts exceed the profile count or byte limit');
  }
  const stdout = captured(payload.stdout);
  const stderr = captured(payload.stderr);
  if (payload.status === 'timed_out') return runnerResultSchema.parse({ status: 'timed_out', durationMs, isolation, stdout, stderr });
  if (payload.status === 'resource_exceeded') {
    return runnerResultSchema.parse({
      status: 'resource_exceeded', resource: payload.resource, durationMs, isolation, stdout, stderr,
    });
  }
  return runnerResultSchema.parse({
    status: 'completed', exitCode: payload.exitCode, durationMs, isolation, stdout, stderr, artifacts,
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
