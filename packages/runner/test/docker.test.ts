// Mocked control-plane regressions; these are not live isolation evidence.
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDockerRunner, checkDockerRunnerGate } from '../src/docker.js';
import { runnerJobSchema, runnerResultSchema } from '../src/contracts.js';
import { sha256 } from '../src/images.js';
import { SELECTED_NODE_REPORT_PATH } from '../src/profile.js';
import { makeTar } from './tar.js';

const controls = vi.hoisted(() => ({
  command: vi.fn<(file: string, args: string[], options: unknown) => Promise<{ stdout: string; stderr: string }>>(),
  spawn: vi.fn<() => ChildProcess>(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: controls.command }), spawn: controls.spawn };
});

const imageDigest = 'd'.repeat(64);
const containerId = 'e'.repeat(64);
const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } });
const archive = makeTar([{ path: 'package.json', content: '{"name":"fixture","version":"1.0.0"}' },
  { path: 'package-lock.json', content: lock }, { path: 'tests/app.test.ts', content: '// inert fixture' }]);
const job = runnerJobSchema.parse({ jobId: randomUUID(), organizationId: randomUUID(), profile: 'node24-tsx-selected-v1',
  input: { objectId: randomUUID(), sha256: sha256(archive), sizeBytes: archive.length },
  limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048 },
  networkPolicy: { mode: 'deny' }, testSelection: { files: ['tests/app.test.ts'] } });

function guestFrame(count = 1, complete = true) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, profile: job.profile, complete, success: true,
    counts: { passed: count, failed: 0, cancelled: 0, skipped: 0, total: count } }));
  const payload = Buffer.from(JSON.stringify({ status: 'completed', exitCode: 0, stdout: '', stderr: '',
    lockfileSha256: sha256(Buffer.from(lock)), tarballSetSha256: sha256(Buffer.from('[]')),
    artifacts: [{ path: SELECTED_NODE_REPORT_PATH, sizeBytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') }] }));
  return Buffer.concat([Buffer.from(`\nGOTCHU_RESULT_V1 ${payload.length}\n`), payload, Buffer.from('\n')]);
}

function transport(frame = guestFrame()) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdout, stderr });
  queueMicrotask(() => { stdout.end(frame); stderr.end(); child.emit('close', 0, null); });
  return child;
}

describe('offline selected runner', () => {
  let cacheDir: string;
  let owner = '';
  let present = false;
  let denyCleanup = false;
  beforeEach(async () => {
    vi.clearAllMocks();
    present = false;
    denyCleanup = false;
    cacheDir = await mkdtemp(join(tmpdir(), 'gotchu-selected-test-'));
    controls.command.mockImplementation(async (_file: string, args: string[]) => {
      let stdout = '';
      if (args[0] === 'image') stdout = JSON.stringify({ Id: `sha256:${imageDigest}`, Os: 'linux', Architecture: 'amd64',
        Config: { User: '1000:1000', Entrypoint: ['/usr/local/bin/node', '/usr/local/lib/gotchu-docker-agent.mjs'] } });
      else if (args[0] === 'create') { present = true; owner = args[args.indexOf('--name') + 1] ?? ''; stdout = containerId; }
      else if (args[1] === 'ls') stdout = present ? `${containerId}${args.at(-1)?.includes('Label') ? ` ${owner}` : ''}` : '';
      else if (args[1] === 'rm') { if (denyCleanup) throw new Error('Unreachable daemon'); present = false; }
      return { stdout, stderr: '' };
    });
    controls.spawn.mockImplementation(() => transport());
  });
  afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

  it('rejects tags and mismatched local identities without pulling', async () => {
    expect((await checkDockerRunnerGate({ imageDigest: 'runner:latest' })).status).toBe('closed');
    expect(controls.command).not.toHaveBeenCalled();
    controls.command.mockResolvedValue({ stdout: JSON.stringify({ Id: `sha256:${'f'.repeat(64)}`, Os: 'linux', Architecture: 'amd64',
      Config: { User: '1000:1000', Entrypoint: ['/usr/local/bin/node', '/usr/local/lib/gotchu-docker-agent.mjs'] } }), stderr: '' });
    expect((await checkDockerRunnerGate({ imageDigest })).status).toBe('closed');
  });

  it('binds the input lookup to tenant/job scope and records actual isolation with verified cleanup', async () => {
    const resolveInput = vi.fn(async () => archive);
    const result = await createDockerRunner({ imageDigest, cacheDir, resolveInput }).runJob(job);
    expect(resolveInput).toHaveBeenCalledWith(job.input, { organizationId: job.organizationId, jobId: job.jobId });
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, isolation: {
      sandbox: { kind: 'docker', memoryMaxMiB: 512, tasksMax: 64, cpuQuotaPercent: 100 },
      containerImageDigest: imageDigest, firecrackerVersion: null, kernelDigest: null, rootfsDigest: null, cleanupVerified: true } });
    expect(runnerResultSchema.safeParse(result).success).toBe(true);
    expect(await readdir(cacheDir)).toEqual([]);
    const create = controls.command.mock.calls.find((call) => call[1][0] === 'create')?.[1];
    expect(create).toEqual(expect.arrayContaining(['--pull', 'never', '--network', 'none', '--read-only', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m',
      '--cpus', '1', '--pids-limit', '64', '--no-healthcheck', '--log-driver', 'none', `sha256:${imageDigest}`]));
    expect(controls.command).toHaveBeenCalledWith('docker', ['container', 'rm', '--force', containerId], expect.anything());
  });

  it('rejects changed bytes and absent selected files before creating a guest', async () => {
    const runner = createDockerRunner({ imageDigest, cacheDir, resolveInput: async () => archive });
    const mismatch = await runner.runJob({ ...job, input: { ...job.input, sha256: '0'.repeat(64) } });
    expect(mismatch.status).toBe('infrastructure_failed');
    const missing = await runner.runJob({ ...job, profile: 'node24-tsx-selected-v1', testSelection: { files: ['missing.test.ts'] } });
    expect(missing.status).toBe('infrastructure_failed');
    expect(controls.spawn).not.toHaveBeenCalled();
    expect(controls.command.mock.calls.some((call) => call[1][0] === 'create')).toBe(false);
  });

  it.each([guestFrame(0), guestFrame(1, false), guestFrame().subarray(0, -10)])('rejects zero, incomplete and truncated success frames', async (frame) => {
    controls.spawn.mockImplementation(() => transport(frame));
    const result = await createDockerRunner({ imageDigest, cacheDir, resolveInput: async () => archive }).runJob(job);
    expect(result.status).toBe('infrastructure_failed');
    expect(result.isolation.cleanupVerified).toBe(true);
  });

  it('overrides successful test output when exact-owned cleanup is uncertain', async () => {
    denyCleanup = true;
    const result = await createDockerRunner({ imageDigest, cacheDir, resolveInput: async () => archive }).runJob(job);
    expect(result.status).toBe('cleanup_uncertain');
    expect(result.isolation.cleanupVerified).toBe(false);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('rejects allowlists and arbitrary npm-test jobs before fetching input', async () => {
    const resolveInput = vi.fn(async () => archive);
    const runner = createDockerRunner({ imageDigest, cacheDir, resolveInput });
    await expect(runner.runJob({ ...job, networkPolicy: { mode: 'allowlist', hosts: ['registry.npmjs.org'] } })).rejects.toThrow('Only offline selected-test');
    const { testSelection: _selection, ...base } = job;
    await expect(runner.runJob({ ...base, profile: 'node24-npm-test' })).rejects.toThrow('Only offline selected-test');
    expect(resolveInput).not.toHaveBeenCalled();
  });
});
