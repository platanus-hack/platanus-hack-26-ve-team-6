import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runnerJobSchema, runnerResultSchema, type RunnerJob, type RunnerResult } from './contracts.js';
import { checkRunnerGate, runnerPackageRoot } from './gate.js';
import { parseGuestFrame, validateGuestPayload } from './protocol.js';
import { validateInputArchive } from './archive.js';
import { isolationEvidence, readImageLock, sha256 } from './images.js';
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

async function runMicroVm(job: RunnerJob, input: Buffer, cacheDir: string, signal?: AbortSignal): Promise<VmOutcome> {
  const lock = await readImageLock();
  if (!lock) throw new Error('Runner image lock could not be read');
  const started = Date.now();
  const tempDir = await mkdtemp(join(cacheDir, `job-${job.jobId}-`));
  let child: ChildProcess | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let serial: Uint8Array = new Uint8Array(0);
  let imagesVerified = false;
  let timedOut = false;
  let outputExceeded = false;
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let cleanupVerified = false;
  const unit = `gotchu-runner-${job.jobId}.scope`;
  let outcome: RunnerResult;

  try {
    if (signal?.aborted) throw new AbortBeforeStartError();
    const bootFiles = await prepareVmBootFiles(job, input, cacheDir, tempDir, lock);
    imagesVerified = true;
    if (signal?.aborted) throw new AbortBeforeStartError();
    const remainingMs = job.limits.wallMs - (Date.now() - started);
    if (remainingMs <= 0) {
      timedOut = true;
      throw new Error('Job wall-clock deadline elapsed before the VM booted');
    }
    const bwrapArgs = [
      '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc',
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
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    exitPromise = waitForExit(child);
    const output = collectCapped(child, Math.min(MAX_SERIAL_BYTES, job.limits.outputBytes * 8 + 256 * 1024), () => {
      outputExceeded = true;
      killProcessGroup(child);
    });
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
        isolation: isolationEvidence(job, lock, true, false), stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else if (signal?.aborted) {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: 'Run cancelled by caller', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, true, false),
      });
    } else if (outputExceeded) {
      outcome = runnerResultSchema.parse({
        status: 'resource_exceeded', resource: 'output', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, true, false), stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else {
      const guest = validateGuestPayload(parseGuestFrame(serial));
      const parsed = parseResult(guest, job, Date.now() - started);
      outcome = runnerResultSchema.parse({ ...parsed, isolation: isolationEvidence(job, lock, true, false) });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown Firecracker adapter failure';
    if (timedOut) {
      outcome = runnerResultSchema.parse({
        status: 'timed_out', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, imagesVerified, false),
        stdout: emptyOutput(job.limits.outputBytes), stderr: emptyOutput(job.limits.outputBytes),
      });
    } else if (signal?.aborted) {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: 'Run cancelled by caller', durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, imagesVerified, false),
      });
    } else {
      outcome = runnerResultSchema.parse({
        status: 'infrastructure_failed', reason: reason.slice(0, 512), durationMs: Date.now() - started,
        isolation: isolationEvidence(job, lock, imagesVerified, false),
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

  return finalResult(outcome, cleanupVerified);
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
};
