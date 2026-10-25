import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxSchema = z.object({
  version: z.literal(1),
  executionEnabled: z.boolean(),
  hostSandboxSelfTestRequired: z.literal(true),
  networkMode: z.literal('none'),
  seccomp: z.literal('firecracker-default'),
  pidsCgroup: z.literal(true),
}).strict();

const imageLockSchema = z.object({
  version: z.literal(1),
  architecture: z.literal('x86_64'),
  firecracker: z.object({
    version: z.string(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
    jailerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).passthrough(),
  kernel: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
  rootfs: z.object({ sha256: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal('pending-image-build')]) }).passthrough(),
}).passthrough();

export interface RunnerGateOptions {
  readonly cacheDir?: string | undefined;
  readonly packageRoot?: string;
  readonly sandboxConfigPath?: string;
  readonly kvmPath?: string;
  readonly effectiveUid?: number;
}

export type RunnerGate = { status: 'open' } | { status: 'closed'; reason: string };
const SELF_TEST_TTL_MS = 15 * 60 * 1000;

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function sandboxFingerprint(root: string, sandbox: unknown, lock: z.infer<typeof imageLockSchema>): Promise<string> {
  const [launcher, vmConfig] = await Promise.all([
    sha256(join(root, 'dist', 'firecracker.js')),
    sha256(join(root, 'dist', 'vm-config.js')),
  ]);
  return createHash('sha256').update(JSON.stringify({
    sandbox,
    firecracker: lock.firecracker.binarySha256,
    kernel: lock.kernel.sha256,
    rootfs: lock.rootfs.sha256,
    launcher,
    vmConfig,
  })).digest('hex');
}

export async function checkRunnerGate(options: RunnerGateOptions = {}): Promise<RunnerGate> {
  const root = options.packageRoot ?? packageRoot;
  const cache = options.cacheDir ?? join(homedir(), '.cache', 'gotchu-runner');
  const kvm = options.kvmPath ?? '/dev/kvm';
  try {
    const sandboxRaw: unknown = JSON.parse(await readFile(options.sandboxConfigPath ?? join(root, 'sandbox.json'), 'utf8'));
    const sandbox = sandboxSchema.parse(sandboxRaw);
    const lockRaw: unknown = JSON.parse(await readFile(join(root, 'images.lock.json'), 'utf8'));
    const lock = imageLockSchema.parse(lockRaw);

    await access(kvm, constants.R_OK | constants.W_OK);
    const firecrackerArchive = join(cache, `firecracker-${lock.firecracker.archiveSha256}.tgz`);
    const kernel = join(cache, `vmlinux-${lock.kernel.sha256}`);
    const rootfs = join(cache, `rootfs-${lock.rootfs.sha256}.ext4`);
    const firecracker = join(cache, `firecracker-${lock.firecracker.binarySha256}`);
    await access('/usr/bin/bwrap', constants.X_OK);
    await access('/usr/bin/systemd-run', constants.X_OK);

    if (await sha256(firecrackerArchive) !== lock.firecracker.archiveSha256) {
      return { status: 'closed', reason: 'Pinned Firecracker release archive is missing or its SHA-256 does not match images.lock.json.' };
    }
    if (await sha256(kernel) !== lock.kernel.sha256) {
      return { status: 'closed', reason: 'Pinned guest kernel is missing or its SHA-256 does not match images.lock.json.' };
    }
    if (lock.rootfs.sha256 === 'pending-image-build' || await sha256(rootfs) !== lock.rootfs.sha256) {
      return { status: 'closed', reason: 'Pinned guest root filesystem is missing or its SHA-256 does not match images.lock.json.' };
    }
    await access(firecracker, constants.X_OK);
    if (await sha256(firecracker) !== lock.firecracker.binarySha256) {
      return { status: 'closed', reason: 'Installed Firecracker binary digest does not match the signed release archive contents.' };
    }
    if (!sandbox.executionEnabled) {
      return { status: 'closed', reason: 'Host sandbox self-test has not passed; execution remains disabled.' };
    }
    const selfTestPath = join(cache, 'host-sandbox-self-test.json');
    const selfTest: unknown = JSON.parse(await readFile(selfTestPath, 'utf8'));
    if (typeof selfTest !== 'object' || selfTest === null || !('checkedAt' in selfTest) || !('fingerprint' in selfTest)
      || typeof selfTest.checkedAt !== 'number' || typeof selfTest.fingerprint !== 'string') {
      return { status: 'closed', reason: 'Host sandbox self-test record is invalid.' };
    }
    const fingerprint = await sandboxFingerprint(root, sandbox, lock);
    if (selfTest.fingerprint !== fingerprint || Date.now() - selfTest.checkedAt > SELF_TEST_TTL_MS || selfTest.checkedAt > Date.now()) {
      return { status: 'closed', reason: 'Host sandbox self-test has not passed within the required verification window.' };
    }
    return { status: 'open' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown runner readiness error';
    return { status: 'closed', reason: `Runner prerequisites are unavailable or invalid: ${message}` };
  }
}

export async function recordRunnerSelfTest(cacheDir: string, packageDir: string): Promise<void> {
  const sandboxRaw: unknown = JSON.parse(await readFile(join(packageDir, 'sandbox.json'), 'utf8'));
  const sandbox = sandboxSchema.parse(sandboxRaw);
  const lockRaw: unknown = JSON.parse(await readFile(join(packageDir, 'images.lock.json'), 'utf8'));
  const lock = imageLockSchema.parse(lockRaw);
  const fingerprint = await sandboxFingerprint(packageDir, sandbox, lock);
  await writeFile(join(cacheDir, 'host-sandbox-self-test.json'), JSON.stringify({ checkedAt: Date.now(), fingerprint }), { mode: 0o600 });
}

export const runnerPackageRoot = packageRoot;
