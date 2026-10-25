import { access, mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runnerJobSchema, runnerResultSchema, type RunnerJob, type RunnerResult } from './contracts.js';
import { checkRunnerGate, recordRunnerSelfTest, runnerPackageRoot } from './gate.js';
import { parseGuestFrame, validateGuestPayload } from './protocol.js';
import { readArchiveFiles, validateInputArchive } from './archive.js';
import { fetchNpmDependencies } from './npm-cache.js';
import { isolationEvidence, readImageLock, sha256 } from './images.js';
import { validateSelectedTestFiles } from './profile.js';
import { prepareVmBootFiles } from './vm-config.js';
import { collectCapped, emptyOutput, finalResult, killProcessGroup, MAX_SERIAL_BYTES, parseResult, waitForExit, type VmOutcome } from './vm-output.js';
import { readLocalInputObject } from './input-store.js';

export interface RunnerOptions {
  readonly resolveInput: (reference: RunnerJob['input'], scope: { organizationId: string; jobId: string }) => Promise<Uint8Array>;
  readonly cacheDir?: string;
  readonly maxConcurrent?: number;
}

export interface RunJobOptions {
  readonly signal?: AbortSignal;
}

class AbortBeforeStartError extends Error {
  constructor() {
    super('Run cancelled before it started');
    this.name = 'AbortBeforeStartError';
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new RangeError('Runner concurrency must be between 1 and 16');
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortBeforeStartError();
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new AbortBeforeStartError());
        };
        this.waiting.push(resume);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

interface HostSandboxProbe {
  readonly networkIsolated: boolean;
  readonly homeHidden: boolean;
  readonly scopeLimitsApplied: boolean;
}

async function inspectSandboxScope(unit: string, expected: { memoryMiB: number; tasks: number; cpuPercent: number }): Promise<HostSandboxProbe> {
  let values: Record<string, string> = {};
  let vmmPids: string[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const show = await new Promise<string>((resolve, reject) => {
      const check = spawn('/usr/bin/systemctl', ['--user', 'show', '--property=ActiveState', '--property=MemoryMax', '--property=TasksMax', '--property=CPUQuotaPerSecUSec', '--property=ControlGroup', unit], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      check.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      check.once('error', reject);
      check.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error('Could not inspect runner scope limits')));
    });
    values = Object.fromEntries(show.split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (values.ActiveState === 'active' && values.ControlGroup) {
      const pids = (await readFile(`/sys/fs/cgroup${values.ControlGroup}/cgroup.procs`, 'utf8')).trim().split('\n').filter(Boolean);
      vmmPids = [];
      for (const pid of pids) {
        try {
          const executable = (await readlink(`/proc/${pid}/exe`)).split('/').at(-1);
          if (executable === 'firecracker' || executable?.startsWith('firecracker-')) vmmPids.push(pid);
        } catch { /* process can exit while the scope is inspected */ }
      }
      if (vmmPids.length > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const controlGroup = values.ControlGroup;
  if (!controlGroup || vmmPids.length === 0) throw new Error('Firecracker did not become visible inside the runner scope for the sandbox self-test');
  const hostNetwork = await readlink('/proc/self/ns/net');
  let networkIsolated = true;
  let homeHidden = true;
  for (const pid of vmmPids) {
    const namespace = await readlink(`/proc/${pid}/ns/net`);
    const routes = (await readFile(`/proc/${pid}/net/route`, 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    const interfaces = (await readFile(`/proc/${pid}/net/dev`, 'utf8')).trim().split('\n').slice(2).map((line) => line.split(':')[0]?.trim()).filter(Boolean);
    networkIsolated &&= namespace !== hostNetwork && routes.length === 0 && interfaces.every((name) => name === 'lo');
    try {
      await access(`/proc/${pid}/root${homedir()}`);
      homeHidden = false;
    } catch (error) {
      homeHidden &&= error instanceof Error && 'code' in error && error.code === 'ENOENT';
    }
  }
  return {
    networkIsolated,
    homeHidden,
    scopeLimitsApplied: values.MemoryMax === String(expected.memoryMiB * 1024 * 1024)
      && values.TasksMax === String(expected.tasks)
      && values.CPUQuotaPerSecUSec === `${expected.cpuPercent / 100}s`,
  };
}

async function runMicroVm(job: RunnerJob, input: Buffer, cacheDir: string, signal?: AbortSignal, onSpawn?: (unit: string) => Promise<HostSandboxProbe>): Promise<VmOutcome & { readonly hostProbe?: HostSandboxProbe }> {
  const archive = validateInputArchive(input);
  const files = readArchiveFiles(archive.tarBytes);
  validateSelectedTestFiles(job, files);
  const packageLock = files.get('package-lock.json');
  if (!packageLock) throw new Error(`${job.profile} requires package-lock.json`);
  const npmDependencies = await fetchNpmDependencies(packageLock);
  const dependencyEvidence = { lockfileSha256: npmDependencies.lockfileSha256, tarballSetSha256: npmDependencies.tarballSetSha256 };
  const lock = await readImageLock();
  if (!lock) {
    return {
      result: runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: 'Runner image lock could not be read', durationMs: 0,
        isolation: isolationEvidence(job, lock, false, true, dependencyEvidence),
      }),
      cleanupVerified: true,
    };
  }
  const started = Date.now();
  let tempDir: string;
  try { tempDir = await mkdtemp(join(cacheDir, `job-${job.jobId}-`)); }
  catch (error) {
    return {
      result: runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: error instanceof Error ? error.message.slice(0, 512) : 'Could not create runner job directory', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, false, true, dependencyEvidence),
      }),
      cleanupVerified: true,
    };
  }
  let child: ChildProcess | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let serial: Uint8Array = new Uint8Array(0);
  let firecrackerStderr = '';
  let imagesVerified = false;
  let timedOut = false;
  let outputExceeded = false;
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let cleanupVerified = false;
  let hostProbe: HostSandboxProbe | undefined;
  const unit = `gotchu-runner-${job.jobId}.scope`;
  let outcome: RunnerResult;

  try {
    if (signal?.aborted) throw new AbortBeforeStartError();
    const bootFiles = await prepareVmBootFiles(job, archive.tarBytes, cacheDir, tempDir, lock, npmDependencies);
    imagesVerified = true;
    if (signal?.aborted) throw new AbortBeforeStartError();
    const remainingMs = job.limits.wallMs - (Date.now() - started);
    if (remainingMs <= 0) {
      timedOut = true;
      throw new Error('Job wall-clock deadline elapsed before the VM booted');
    }
    const bwrapArgs = [
      '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--proc', '/proc', '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm', '--tmpfs', '/tmp',
      '--dir', '/runner', '--ro-bind', bootFiles.executable, '/runner/firecracker',
      '--ro-bind', bootFiles.kernel, '/runner/kernel', '--ro-bind', bootFiles.baseRootfs, '/runner/rootfs-base',
      '--bind', tempDir, '/job', '--chdir', '/job',
      '/runner/firecracker', ...bootFiles.args,
    ];
    const scopeArgs = [
      '--user', '--scope', '--quiet', `--unit=${unit}`,
      '-p', `MemoryMax=${bootFiles.memoryMiB + 512}M`, '-p', `TasksMax=${job.limits.pids + 16}`,
      '-p', `CPUQuota=${bootFiles.vcpu * 100}%`, '--', '/usr/bin/bwrap', ...bwrapArgs,
    ];
    child = spawn('/usr/bin/systemd-run', scopeArgs, {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    exitPromise = waitForExit(child);
    const output = collectCapped(child, Math.min(MAX_SERIAL_BYTES, job.limits.outputBytes * 8 + 256 * 1024), () => {
      outputExceeded = true;
      killProcessGroup(child);
    });
    child.stderr?.on('data', (chunk: Buffer) => { firecrackerStderr = (firecrackerStderr + chunk.toString('utf8')).slice(-16 * 1024); });
    if (onSpawn) hostProbe = await onSpawn(unit);
    onAbort = () => {
      killProcessGroup(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, remainingMs);
    exit = await exitPromise;
    serial = await output;
    if (timedOut) {
      outcome = runnerResultSchema.parse({
        status: 'timed_out', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, true, false, dependencyEvidence), stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else if (signal?.aborted) {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: 'Run cancelled by caller', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, true, false, dependencyEvidence),
      });
    } else if (outputExceeded) {
      outcome = runnerResultSchema.parse({
        status: 'resource_exceeded', resource: 'output', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, true, false, dependencyEvidence), stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else {
      const guest = validateGuestPayload(parseGuestFrame(serial));
      const parsed = parseResult(guest, job, Date.now() - started, dependencyEvidence);
      outcome = runnerResultSchema.parse({ ...parsed, isolation: isolationEvidence(job, lock, true, false, dependencyEvidence) });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Firecracker adapter failure';
    const reason = message.slice(0, 512);
    if (timedOut) {
      outcome = runnerResultSchema.parse({
        status: 'timed_out', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, imagesVerified, false, dependencyEvidence),
        stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else if (signal?.aborted) {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: 'Run cancelled by caller', durationMs: Date.now() - started,
        ...(firecrackerStderr ? { firecrackerStderr } : {}),
        isolation: isolationEvidence(job, lock, imagesVerified, false, dependencyEvidence),
      });
    } else {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: reason.slice(0, 512), durationMs: Date.now() - started,
        ...(firecrackerStderr ? { firecrackerStderr } : {}),
        isolation: isolationEvidence(job, lock, imagesVerified, false, dependencyEvidence),
      });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    if (child && exit === undefined) {
      killProcessGroup(child);
      try { exit = await exitPromise; } catch { /* process exit could not be observed */ }
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
      try {
        await stat(tempDir);
        cleanupVerified = false;
      } catch (error) {
        cleanupVerified = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      }
      if (child?.pid && exit) {
        try {
          process.kill(child.pid, 0);
          cleanupVerified = false;
        } catch (error) {
          cleanupVerified = error instanceof Error && 'code' in error && error.code === 'ESRCH';
        }
      }
      try {
        const scopeState = await new Promise<string>((resolve, reject) => {
          const check = spawn('/usr/bin/systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit], { stdio: ['ignore', 'pipe', 'ignore'] });
          let value = '';
          check.stdout?.on('data', (chunk: Buffer) => { value += chunk.toString('utf8'); });
          check.once('error', reject);
          check.once('close', (code) => code === 0 ? resolve(value.trim()) : reject(new Error('Could not verify runner scope cleanup')));
        });
        cleanupVerified &&= scopeState === 'inactive' || scopeState === 'failed' || scopeState === 'not-found';
      } catch { cleanupVerified = false; }
    } catch {
      cleanupVerified = false;
    }
  }

  return { ...finalResult(outcome, cleanupVerified), ...(hostProbe ? { hostProbe } : {}) };
}

function tarFile(path: string, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const block = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(block);
  return Buffer.concat([header, block]);
}

function selfTestArchive(): Buffer {
  const manifest = JSON.stringify({ name: 'gotchu-host-sandbox-canary', version: '1.0.0', scripts: { test: 'node test.js' } });
  const lock = JSON.stringify({ name: 'gotchu-host-sandbox-canary', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'gotchu-host-sandbox-canary', version: '1.0.0' } } });
  const source = "const assert=require('assert');const net=require('net');assert.equal(process.env.HOME,'/scratch/home');const s=net.connect({host:'1.1.1.1',port:80});s.setTimeout(300);s.on('connect',()=>process.exit(2));s.on('timeout',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500);";
  return Buffer.concat([tarFile('package.json', manifest), tarFile('package-lock.json', lock), tarFile('test.js', source), Buffer.alloc(1024)]);
}

export async function selfTest(options: { cacheDir?: string; signal?: AbortSignal } = {}): Promise<{ status: 'passed' } | { status: 'failed'; reason: string }> {
  const cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'gotchu-runner');
  const archive = selfTestArchive();
  const job: RunnerJob = {
    jobId: 'c30f04a6-3ef2-4cab-9541-fc907748c463',
    organizationId: 'dc7dc303-1601-4d3e-ae5a-611839b33167',
    profile: 'node24-npm-test',
    input: { objectId: 'f937cc40-a51e-4c16-b8e9-64e8d6054ef2', sha256: sha256(archive), sizeBytes: archive.length },
    limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 45_000, outputBytes: 16_384, diskMiB: 2048 },
    networkPolicy: { mode: 'deny' },
  };
  try {
    const result = await runMicroVm(job, archive, cacheDir, options.signal, (unit) => inspectSandboxScope(unit, { memoryMiB: 1024, tasks: 80, cpuPercent: 100 }));
    if (result.result.status !== 'completed' || result.result.exitCode !== 0 || !result.cleanupVerified
      || !result.hostProbe?.networkIsolated || !result.hostProbe.homeHidden || !result.hostProbe.scopeLimitsApplied) {
      return { status: 'failed', reason: `Sandbox canary did not verify all controls: ${JSON.stringify({ result: result.result.status, exitCode: result.result.status === 'completed' ? result.result.exitCode : undefined, cleanup: result.cleanupVerified, probe: result.hostProbe })}`.slice(0, 512) };
    }
    await recordRunnerSelfTest(cacheDir, runnerPackageRoot);
    return { status: 'passed' };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message.slice(0, 512) : 'Unknown sandbox self-test failure' };
  }
}

export function createFirecrackerRunner(options: RunnerOptions) {
  const cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'gotchu-runner');
  const semaphore = new Semaphore(options.maxConcurrent ?? 2);

  async function runJob(jobInput: RunnerJob, runOptions: RunJobOptions = {}): Promise<RunnerResult> {
    const job = runnerJobSchema.parse(jobInput);
    const release = await semaphore.acquire(runOptions.signal).catch(async (error: unknown) => {
      const lock = await readImageLock();
      const reason = error instanceof Error ? error.message : 'Run cancelled before it started';
      return runnerResultSchema.parse({
        status: 'infrastructure_failed', reason, durationMs: 0,
        isolation: isolationEvidence(job, lock, false, true),
      });
    });
    if (typeof release !== 'function') return release;

    try {
      if (job.networkPolicy.mode === 'allowlist') {
        const lock = await readImageLock();
        return runnerResultSchema.parse({
          status: 'infrastructure_failed',
          reason: 'Network allowlist is not implemented: this runner has no host-side egress filter or tap setup. Fetch must run as a separate host-side phase.',
          durationMs: 0,
          isolation: isolationEvidence(job, lock, false, true),
        });
      }
      const gate = await checkRunnerGate({ cacheDir });
      if (gate.status === 'closed') {
        const lock = await readImageLock();
        return runnerResultSchema.parse({
          status: 'infrastructure_failed', reason: gate.reason, durationMs: 0,
          isolation: isolationEvidence(job, lock, false, true),
        });
      }
      const input = Buffer.from(await options.resolveInput(job.input, { organizationId: job.organizationId, jobId: job.jobId }));
      if (input.length !== job.input.sizeBytes || sha256(input) !== job.input.sha256) {
        return runnerResultSchema.parse({
          status: 'infrastructure_failed', reason: 'Input object size or digest does not match its reference.', durationMs: 0,
          isolation: isolationEvidence(job, await readImageLock(), true, true),
        });
      }
      const validated = validateInputArchive(input);
      const outcome = await runMicroVm(job, validated.tarBytes, cacheDir, runOptions.signal);
      return outcome.result;
    } catch (error) {
      const lock = await readImageLock();
      const reason = error instanceof Error ? error.message : 'Unknown runner failure';
      return runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: reason.slice(0, 512), durationMs: 0,
        isolation: isolationEvidence(job, lock, false, true),
      });
    } finally {
      release();
    }
  }

  return { runJob } as const;
}

const defaultInputRoot = process.env.GOTCHU_RUNNER_INPUT_DIR ?? join(homedir(), '.local', 'share', 'gotchu-runner', 'inputs');
const defaultRunner = createFirecrackerRunner({
  resolveInput: async (reference, scope) => {
    return readLocalInputObject(defaultInputRoot, reference, scope);
  },
});

export const runJob = defaultRunner.runJob;

export const __testOnly = {
  runMicroVm,
  inspectSandboxScope,
};
