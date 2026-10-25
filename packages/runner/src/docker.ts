import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RUNNER_VERSION, runnerJobSchema, runnerResultSchema, type RunnerJob, type RunnerResult } from './contracts.js';
import { readArchiveFiles, validateInputArchive } from './archive.js';
import { sha256 } from './images.js';
import { fetchNpmDependencies, type FetchedNpmDependencies } from './npm-cache.js';
import { validateSelectedTestFiles } from './profile.js';
import { makeOutput, parseGuestFrame } from './protocol.js';
import { collectCapped, parseResult, waitForExit, type DependencyEvidence } from './vm-output.js';
import type { RunnerOptions, RunJobOptions } from './firecracker.js';

const exec = promisify(execFile);
const digestPattern = /^[a-f0-9]{64}$/;
const unavailable = '0'.repeat(64);
const imageSchema = z.object({ Id: z.string(), Os: z.literal('linux'), Architecture: z.literal('amd64'),
  Config: z.object({ User: z.literal('1000:1000'), Entrypoint: z.tuple([z.literal('/usr/local/bin/node'), z.literal('--disable-sigusr1'), z.literal('/usr/local/lib/gotchu-docker-agent.mjs')]) }) });

async function command(args: string[], timeout = 10_000): Promise<string> {
  try {
    const result = await exec('docker', args, { timeout, maxBuffer: 16 * 1024, encoding: 'utf8' });
    return result.stdout.trim();
  } catch (cause) { throw new Error('Local runner control command failed', { cause }); }
}

export async function checkDockerRunnerGate(options: { imageDigest: string }): Promise<{ status: 'open' } | { status: 'closed'; reason: string }> {
  if (!digestPattern.test(options.imageDigest)) return { status: 'closed', reason: 'Runner image must be a bare immutable SHA-256 ID' };
  try {
    const payload: unknown = JSON.parse(await command(['image', 'inspect', `sha256:${options.imageDigest}`, '--format', '{{json .}}']));
    const image = imageSchema.parse(payload);
    if (image.Id !== `sha256:${options.imageDigest}`) throw new Error('Image identity mismatch');
    return { status: 'open' };
  } catch { return { status: 'closed', reason: 'Pinned local runner image is unavailable or has an invalid identity or entrypoint' }; }
}

function evidence(job: RunnerJob, imageDigest: string, dependencies: DependencyEvidence, cleanupVerified: boolean) {
  return { sandbox: { kind: 'docker', memoryMaxMiB: job.limits.memMiB, tasksMax: job.limits.pids, cpuQuotaPercent: job.limits.vcpu * 100 },
    runnerVersion: RUNNER_VERSION, containerImageDigest: imageDigest,
    firecrackerVersion: null, kernelDigest: null, rootfsDigest: null,
    profile: job.profile, networkPolicy: job.networkPolicy, ...dependencies, cleanupVerified } as const;
}

async function stageInput(directory: string, job: RunnerJob, tar: Buffer, dependencies: FetchedNpmDependencies) {
  const input = join(directory, 'input');
  const cache = join(directory, 'npm-cache');
  await mkdir(input, { mode: 0o755 });
  await mkdir(join(cache, 'tarballs'), { recursive: true, mode: 0o755 });
  await writeFile(join(input, 'project.tar'), tar, { mode: 0o444, flag: 'wx' });
  await writeFile(join(input, 'job.json'), JSON.stringify(job), { mode: 0o444, flag: 'wx' });
  const unique = [...new Map(dependencies.tarballs.map((entry) => [entry.sha256, entry])).values()];
  for (const entry of unique) await writeFile(join(cache, 'tarballs', `${entry.sha256}.tgz`), entry.bytes, { mode: 0o444, flag: 'wx' });
  await writeFile(join(cache, 'manifest.json'), JSON.stringify({ lockfileSha256: dependencies.lockfileSha256,
    tarballSetSha256: dependencies.tarballSetSha256, entries: unique.map((entry) => ({ file: `${entry.sha256}.tgz` })) }), { mode: 0o444, flag: 'wx' });
}

function createArgs(job: RunnerJob, directory: string, name: string, imageDigest: string) {
  return ['create', '--name', name, '--label', `gotchu.runner.owner=${name}`, '--pull', 'never',
    '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${job.limits.memMiB}m`, '--memory-swap', `${job.limits.memMiB}m`, '--cpus', String(job.limits.vcpu),
    '--pids-limit', String(job.limits.pids), '--no-healthcheck', '--log-driver', 'none', '--ipc', 'none',
    '--tmpfs', `/scratch:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=${job.limits.diskMiB * 1024 * 1024}`,
    '--mount', `type=bind,src=${join(directory, 'input')},dst=/input,readonly`,
    '--mount', `type=bind,src=${join(directory, 'npm-cache')},dst=/npm-cache-source,readonly`,
    `sha256:${imageDigest}`];
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const abort = () => reject(new Error('Runner deadline or cancellation'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolveValue, reject).finally(() => signal.removeEventListener('abort', abort)).catch(reject);
    if (signal.aborted) abort();
  });
}

export interface DockerRunnerOptions extends RunnerOptions { readonly imageDigest: string }

export function createDockerRunner(options: DockerRunnerOptions) {
  if (!digestPattern.test(options.imageDigest)) throw new Error('Runner image must be a bare immutable SHA-256 ID');
  const limit = options.maxConcurrent ?? 2;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new RangeError('Runner concurrency must be between 1 and 16');
  const cacheDir = resolve(options.cacheDir ?? join(homedir(), '.cache', 'gotchu-selected-runner'));
  if (cacheDir.includes(',')) throw new Error('Runner cache path cannot contain mount separators');
  let active = 0;
  const waiting: Array<() => void> = [];

  async function runJob(jobInput: RunnerJob, runOptions: RunJobOptions = {}): Promise<RunnerResult> {
    const job = runnerJobSchema.parse(jobInput);
    if (job.profile !== 'node24-tsx-selected-v1' || job.networkPolicy.mode !== 'deny') throw new Error('Only offline selected-test jobs are supported');
    if (runOptions.signal?.aborted) throw new Error('Run cancelled before it started');
    if (active >= limit) {
      await new Promise<void>((resume, reject) => {
        const ready = () => { runOptions.signal?.removeEventListener('abort', cancel); resume(); };
        const cancel = () => { const index = waiting.indexOf(ready); if (index >= 0) waiting.splice(index, 1); reject(new Error('Run cancelled before it started')); };
        waiting.push(ready);
        runOptions.signal?.addEventListener('abort', cancel, { once: true });
      });
    } else active += 1;
    try { return await runSelectedJob(job, options, cacheDir, runOptions.signal); }
    finally { const next = waiting.shift(); if (next) next(); else active -= 1; }
  }
  return { runJob };
}

async function runSelectedJob(job: RunnerJob, options: DockerRunnerOptions, cacheDir: string, callerSignal?: AbortSignal): Promise<RunnerResult> {
  const gate = await checkDockerRunnerGate(options);
  if (gate.status === 'closed') throw new Error(gate.reason);
  const started = Date.now();
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, job.limits.wallMs);
  let directory: string | undefined;
  const name = `gotchu-selected-${randomUUID()}`;
  let containerId: string | undefined;
  let createAttempted = false;
  let cleanupVerified = true;
  let dependencies: DependencyEvidence = { lockfileSha256: unavailable, tarballSetSha256: unavailable };
  const isolation = () => evidence(job, options.imageDigest, dependencies, false);
  const durationMs = () => Math.min(job.limits.wallMs, Date.now() - started);
  const empty = () => ({ stdout: makeOutput('', job.limits.outputBytes), stderr: makeOutput('', job.limits.outputBytes) });
  let outcome: RunnerResult;
  try {
    const input = Buffer.from(await abortable(options.resolveInput(job.input, { organizationId: job.organizationId, jobId: job.jobId }), signal));
    if (input.length !== job.input.sizeBytes || sha256(input) !== job.input.sha256) throw new Error('Input object size or digest mismatch');
    const archive = validateInputArchive(input);
    const files = readArchiveFiles(archive.tarBytes);
    validateSelectedTestFiles(job, files);
    const lockfile = files.get('package-lock.json');
    if (!lockfile) throw new Error('Selected tests require package-lock.json');
    const fetched = await fetchNpmDependencies(lockfile, { targetPlatform: 'linux-x64-glibc', maxTarballBytes: 192 * 1024 * 1024,
      maxBytes: 256 * 1024 * 1024, fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }) });
    dependencies = { lockfileSha256: fetched.lockfileSha256, tarballSetSha256: fetched.tarballSetSha256 };
    signal.throwIfAborted();
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(cacheDir, 'job-'));
    await stageInput(directory, job, archive.tarBytes, fetched);
    signal.throwIfAborted();
    createAttempted = true;
    containerId = await command(createArgs(job, directory, name, options.imageDigest), Math.max(1, Math.min(10_000, job.limits.wallMs - (Date.now() - started))));
    if (!digestPattern.test(containerId)) throw new Error('Runner returned an invalid container identity');
    signal.throwIfAborted();
    const child = spawn('docker', ['start', '--attach', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let outputExceeded = false;
    const stop = () => child.kill('SIGKILL');
    const output = collectCapped(child, job.limits.outputBytes * 2 + 64 * 1024, () => { outputExceeded = true; stop(); });
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16 * 1024) { outputExceeded = true; stop(); } });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    let exit;
    try { exit = await waitForExit(child); }
    finally { signal.removeEventListener('abort', stop); }
    const serial = await output;
    if (timedOut) outcome = runnerResultSchema.parse({ status: 'timed_out', durationMs: durationMs(), isolation: isolation(), ...empty() });
    else if (signal.aborted) throw new Error('Run cancelled by caller');
    else if (outputExceeded) outcome = runnerResultSchema.parse({ status: 'resource_exceeded', resource: 'output', durationMs: durationMs(), isolation: isolation(), ...empty() });
    else if (exit.code !== 0) {
      const oom = await command(['container', 'inspect', containerId, '--format', '{{.State.OOMKilled}}']);
      if (oom !== 'true') throw new Error('Guest exited without a successful result transport');
      outcome = runnerResultSchema.parse({ status: 'resource_exceeded', resource: 'memory', durationMs: durationMs(), isolation: isolation(), ...empty() });
    } else {
      const parsed = parseResult(parseGuestFrame(serial), job, durationMs(), dependencies);
      outcome = runnerResultSchema.parse({ ...parsed, isolation: isolation() });
    }
  } catch (error) {
    outcome = runnerResultSchema.parse(timedOut
      ? { status: 'timed_out', durationMs: durationMs(), isolation: isolation(), ...empty() }
      : { status: 'infrastructure_failed', reason: (error instanceof Error ? error.message : 'Runner failed').slice(0, 512), durationMs: durationMs(), isolation: isolation() });
  } finally {
    clearTimeout(deadline);
    if (createAttempted) {
      try {
        const owned = await command(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}} {{.Label "gotchu.runner.owner"}}']);
        if (owned) {
          const [id, owner] = owned.split(' ');
          if (!id || !digestPattern.test(id) || owner !== name || (containerId && id !== containerId)) throw new Error('Container ownership is uncertain');
          await command(['container', 'rm', '--force', id]);
        }
        const byName = await command(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
        const byId = containerId ? await command(['container', 'ls', '--all', '--no-trunc', '--filter', `id=${containerId}`, '--format', '{{.ID}}']) : '';
        cleanupVerified = Boolean(containerId) && byName === '' && byId === '';
      } catch { cleanupVerified = false; }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
        try { await stat(directory); cleanupVerified = false; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) cleanupVerified = false; }
      } catch { cleanupVerified = false; }
    }
  }
  const finalIsolation = { ...outcome.isolation, cleanupVerified };
  return runnerResultSchema.parse(cleanupVerified ? { ...outcome, isolation: finalIsolation }
    : { status: 'cleanup_uncertain', reason: 'Per-job process or files could not be verified absent after cleanup', durationMs: outcome.durationMs, isolation: finalIsolation });
}
