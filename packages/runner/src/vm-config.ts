import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { RunnerJob } from './contracts.js';
import { sha256, type RunnerImageLock } from './images.js';
import type { FetchedNpmDependencies } from './npm-cache.js';

export interface VmBootFiles {
  readonly executable: string;
  readonly args: readonly string[];
  readonly kernel: string;
  readonly baseRootfs: string;
  readonly memoryMiB: number;
  readonly vcpu: number;
}

async function runBuildCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`)));
  });
}

async function createInputDisk(stage: string, input: Buffer, job: RunnerJob): Promise<string> {
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, 'project.tar'), input, { mode: 0o400 });
  await writeFile(join(stage, 'job.json'), JSON.stringify({ profile: job.profile, limits: job.limits, ...(job.profile === 'node24-tsx-selected-v1' ? { testSelection: job.testSelection } : {}) }), { mode: 0o400 });
  const image = join(stage, '..', 'input.ext4');
  const size = Math.max(16, Math.ceil((input.length + 4096) / (1024 * 1024)) + 8);
  await runBuildCommand('truncate', ['-s', `${size}M`, image]);
  await runBuildCommand('mkfs.ext4', ['-q', '-F', '-d', stage, image]);
  return image;
}

async function createNpmCacheDisk(stage: string, dependencies: FetchedNpmDependencies): Promise<string> {
  const cacheStage = join(stage, 'npm-cache');
  await mkdir(join(cacheStage, 'tarballs'), { recursive: true });
  const entries = dependencies.tarballs.map((tarball) => ({ file: `${tarball.sha256}.tgz`, integrity: tarball.integrity }));
  await Promise.all(dependencies.tarballs.map((tarball) => writeFile(join(cacheStage, 'tarballs', `${tarball.sha256}.tgz`), tarball.bytes, { mode: 0o444 })));
  await writeFile(join(cacheStage, 'manifest.json'), JSON.stringify({ lockfileSha256: dependencies.lockfileSha256, tarballSetSha256: dependencies.tarballSetSha256, entries }), { mode: 0o444 });
  const image = join(stage, 'npm-cache.ext4');
  const size = Math.max(16, Math.ceil((dependencies.tarballs.reduce((total, item) => total + item.bytes.length, 0) + 4096) / (1024 * 1024)) + 8);
  await runBuildCommand('truncate', ['-s', `${size}M`, image]);
  await runBuildCommand('mkfs.ext4', ['-q', '-F', '-d', cacheStage, image]);
  return image;
}

export async function prepareVmBootFiles(
  job: RunnerJob,
  input: Buffer,
  cacheDir: string,
  tempDir: string,
  lock: RunnerImageLock,
  npmDependencies: FetchedNpmDependencies,
): Promise<VmBootFiles> {
  const kernel = join(cacheDir, `vmlinux-${lock.kernel.sha256}`);
  const baseRootfs = join(cacheDir, `rootfs-${lock.rootfs.sha256}.ext4`);
  const firecracker = join(cacheDir, `firecracker-${lock.firecracker.binarySha256}`);
  for (const path of [kernel, baseRootfs, firecracker, '/dev/kvm']) await access(path, constants.R_OK);
  await access('/dev/kvm', constants.W_OK);
  if (sha256(await readFile(kernel)) !== lock.kernel.sha256 || sha256(await readFile(baseRootfs)) !== lock.rootfs.sha256) {
    throw new Error('Pinned VM image digest mismatch');
  }

  const rootfs = join(tempDir, 'rootfs.ext4');
  const inputStage = join(tempDir, 'input');
  const scratch = join(tempDir, 'scratch.ext4');
  await copyFile(baseRootfs, rootfs);
  const inputImage = await createInputDisk(inputStage, input, job);
  const npmCacheImage = await createNpmCacheDisk(tempDir, npmDependencies);
  await runBuildCommand('truncate', ['-s', `${job.limits.diskMiB - 1024 - 16}M`, scratch]);
  await runBuildCommand('mkfs.ext4', ['-q', '-F', scratch]);

  const jobKernel = join(tempDir, 'kernel');
  await copyFile(kernel, jobKernel);
  const config = {
    'boot-source': { kernel_image_path: '/job/kernel', boot_args: 'console=ttyS0 panic=1 reboot=k pci=off init=/sbin/init' },
    drives: [
      { drive_id: 'rootfs', path_on_host: '/job/rootfs.ext4', is_root_device: true, is_read_only: false },
      { drive_id: 'input', path_on_host: '/job/input.ext4', is_root_device: false, is_read_only: true },
      { drive_id: 'scratch', path_on_host: '/job/scratch.ext4', is_root_device: false, is_read_only: false },
      { drive_id: 'npm-cache', path_on_host: '/job/npm-cache.ext4', is_root_device: false, is_read_only: true },
    ],
    'machine-config': { vcpu_count: job.limits.vcpu, mem_size_mib: job.limits.memMiB, smt: false },
  };
  const configPath = join(tempDir, 'firecracker.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return {
    executable: firecracker,
    args: ['--no-api', '--log-path', '/job/firecracker.log', '--metrics-path', '/job/firecracker.metrics', '--config-file', '/job/firecracker.json'],
    kernel,
    baseRootfs,
    memoryMiB: job.limits.memMiB,
    vcpu: job.limits.vcpu,
  };
}
