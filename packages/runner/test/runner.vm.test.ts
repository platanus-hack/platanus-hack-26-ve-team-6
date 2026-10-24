import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __testOnly } from '../src/firecracker.js';
import type { RunnerJob } from '../src/contracts.js';
import { makeTar } from './tar.js';

const cacheDir = join(process.env.HOME ?? tmpdir(), '.cache', 'gotchu-runner');
const organizationId = 'dc7dc303-1601-4d3e-ae5a-611839b33167';
let root = '';

function projectArchive(testBody: string): Buffer {
  const manifest = JSON.stringify({ name: 'gotchu-vm-fixture', version: '1.0.0', scripts: { test: 'node test.js' } });
  const lock = JSON.stringify({
    name: 'gotchu-vm-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'gotchu-vm-fixture', version: '1.0.0' } },
  });
  return makeTar([
    { path: 'package.json', content: manifest },
    { path: 'package-lock.json', content: lock },
    { path: 'test.js', content: testBody },
  ]);
}

async function run(testBody: string, overrides: Partial<RunnerJob['limits']> = {}, signal?: AbortSignal) {
  const jobId = crypto.randomUUID();
  const archive = projectArchive(testBody);
  const job: RunnerJob = {
    jobId,
    organizationId,
    profile: 'node24-npm-test',
    input: { objectId: crypto.randomUUID(), sha256: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length },
    limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048, ...overrides },
    networkPolicy: { mode: 'deny' },
  };
  return { job, ...(await __testOnly.runMicroVm(job, archive, cacheDir, signal)) };
}

describe('real Firecracker microVM execution', () => {
  beforeAll(async () => {
    if (process.env.GOTCHU_TEST_VM !== '1') throw new Error('GOTCHU_TEST_VM=1 is required');
    root = await mkdtemp(join(tmpdir(), 'gotchu-runner-vm-host-'));
    await writeFile(join(root, 'host-secret.txt'), 'host-only-test-sentinel');
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs a real dependency-free Node project and preserves npm test exit codes', async () => {
    const passed = await run("if (2 + 2 !== 4) process.exit(4)");
    expect(passed.result.status, JSON.stringify(passed.result)).toBe('completed');
    if (passed.result.status === 'completed') expect(passed.result.exitCode).toBe(0);
    expect(passed.result.isolation.cleanupVerified).toBe(true);

    const failed = await run('process.exit(7)');
    expect(failed.result.status).toBe('completed');
    if (failed.result.status === 'completed') expect(failed.result.exitCode).toBe(7);
  });

  it('cannot read a host filesystem sentinel or reach public, host, or metadata addresses', async () => {
    const sentinel = join(root, 'host-secret.txt');
    const testBody = `
    (async () => {
      const fs = require('fs'); const net = require('net'); const http = require('http');
      const assert = require('assert');
      assert.throws(() => fs.readFileSync(${JSON.stringify(sentinel)}), { code: 'ENOENT' });
      async function connect(host, port) { return new Promise((resolve) => { const socket = net.connect({ host, port }); const timer = setTimeout(() => socket.destroy(), 500); socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); }); socket.once('error', () => { clearTimeout(timer); resolve(false); }); socket.once('close', () => resolve(false)); }); }
      assert.equal(await connect('1.1.1.1', 80), false);
      assert.equal(await connect('172.17.0.1', 80), false);
      assert.equal(await connect('169.254.169.254', 80), false);
      await new Promise((resolve) => { const request = http.get('http://169.254.169.254/latest/meta-data/', { timeout: 500 }, (response) => { response.resume(); resolve(false); }); request.on('timeout', () => { request.destroy(); resolve(true); }); request.on('error', () => resolve(true)); });
    })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = await run(testBody);
    expect(result.result.status, JSON.stringify(result.result)).toBe('completed');
    if (result.result.status === 'completed') expect(result.result.exitCode, JSON.stringify(result.result)).toBe(0);
  });

  it('truncates output at the configured cap', async () => {
    const result = await run("process.stdout.write('x'.repeat(50000))", { outputBytes: 1024 });
    expect(result.result.status, JSON.stringify(result.result)).toBe('resource_exceeded');
    if (result.result.status === 'resource_exceeded') {
      expect(result.result.resource).toBe('output');
      expect(result.result.stdout.bytes + result.result.stderr.bytes).toBeLessThanOrEqual(1024);
      expect(result.result.stdout.truncated || result.result.stderr.truncated).toBe(true);
    }
  });

  it('contains fork pressure inside the guest and removes the VM', async () => {
    const body = `
      const { spawn } = require('child_process'); let count = 0;
      function fork() { const child = spawn('/bin/sh', ['-c', 'sleep 20'], { stdio: 'ignore' }); count++; child.once('error', (error) => { if (error.code === 'EAGAIN') { console.log('pids limit reached', error.code); process.exit(0); } }); child.once('spawn', fork); }
      fork();
    `;
    const result = await run(body, { pids: 32, wallMs: 15_000 });
    expect(result.result.status, JSON.stringify(result.result)).toBe('resource_exceeded');
    if (result.result.status === 'resource_exceeded') expect(result.result.resource).toBe('pids');
    expect(result.result.isolation.cleanupVerified).toBe(true);
    expect(await readdir(cacheDir).then((names) => names.some((name) => name.startsWith(`job-${result.job.jobId}-`)))).toBe(false);
  });

  it('kills an infinite loop at its wall deadline', async () => {
    const result = await run('while (true) {}', { wallMs: 15_000 });
    expect(result.result.status).toBe('timed_out');
    expect(result.result.isolation.cleanupVerified).toBe(true);
  });

  it('kills a cancelled VM and verifies cleanup', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const result = await run('while (true) {}', { wallMs: 20_000 }, controller.signal);
      expect(result.result.status).toBe('infrastructure_failed');
      expect(result.result.isolation.cleanupVerified).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('removes the guest disk and private job directory after a normal result', async () => {
    const before = new Set(await readdir(cacheDir));
    const result = await run("console.log('cleaned')");
    expect(result.result.isolation.cleanupVerified).toBe(true);
    const after = await readdir(cacheDir);
    expect(after.filter((name) => !before.has(name)).filter((name) => name.startsWith('job-'))).toEqual([]);
  });

  it('rejects traversal and symlinks before any microVM is created', async () => {
    const { validateInputArchive } = await import('../src/archive.js');
    expect(() => validateInputArchive(makeTar([{ path: '../escape', content: 'bad' }]))).toThrow(/traversal/);
    expect(() => validateInputArchive(makeTar([{ path: 'escape', content: 'target', type: '2' }]))).toThrow(/links/);
  });
});
