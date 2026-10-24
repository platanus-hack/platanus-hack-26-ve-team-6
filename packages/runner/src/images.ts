import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RUNNER_VERSION, type RunnerJob } from './contracts.js';
import { runnerPackageRoot } from './gate.js';

export interface RunnerImageLock {
  readonly version: number;
  readonly firecracker: { readonly version: string; readonly archiveSha256: string; readonly binarySha256: string; readonly jailerSha256: string };
  readonly kernel: { readonly version: string; readonly sha256: string };
  readonly rootfs: { readonly sha256: string };
}

const lockSchema = z.object({
  version: z.number().int(),
  firecracker: z.object({ version: z.string(), archiveSha256: z.string(), binarySha256: z.string(), jailerSha256: z.string() }),
  kernel: z.object({ version: z.string(), sha256: z.string() }),
  rootfs: z.object({ sha256: z.string() }),
});

export async function readImageLock(): Promise<RunnerImageLock | undefined> {
  try {
    const payload: unknown = JSON.parse(await readFile(join(runnerPackageRoot, 'images.lock.json'), 'utf8'));
    const parsed = lockSchema.safeParse(payload);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const UNAVAILABLE_DIGEST = '0'.repeat(64);

export function isolationEvidence(job: RunnerJob, lock: RunnerImageLock | undefined, verified: boolean, cleanupVerified: boolean) {
  return {
    runnerVersion: RUNNER_VERSION,
    firecrackerVersion: lock?.firecracker.version ?? 'unavailable',
    kernelDigest: verified ? lock?.kernel.sha256 ?? UNAVAILABLE_DIGEST : UNAVAILABLE_DIGEST,
    rootfsDigest: verified ? lock?.rootfs.sha256 ?? UNAVAILABLE_DIGEST : UNAVAILABLE_DIGEST,
    profile: job.profile,
    networkPolicy: job.networkPolicy,
    cleanupVerified,
  } as const;
}
