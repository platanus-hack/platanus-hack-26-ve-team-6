import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __testOnly } from '../src/firecracker.js';
import { selectedNodeTestReportSchema, type RunnerJob, type RunnerTestSelection } from '../src/contracts.js';
import { SELECTED_NODE_REPORT_PATH } from '../src/profile.js';
import { makeTar } from './tar.js';

const cacheDir = process.env.GOTCHU_RUNNER_CACHE_DIR ?? join(process.env.HOME ?? tmpdir(), '.cache', 'gotchu-runner');
const organizationId = 'dc7dc303-1601-4d3e-ae5a-611839b33167';
let root = '';

function projectArchive(testBody: string, options: { readonly dependencies?: Record<string, string>; readonly postinstall?: string } = {}): Buffer {
  const manifest = JSON.stringify({
    name: 'gotchu-vm-fixture', version: '1.0.0',
    scripts: { ...(options.postinstall ? { postinstall: options.postinstall } : {}), test: 'node test.js' },
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
  });
  const packages: Record<string, unknown> = { '': { name: 'gotchu-vm-fixture', version: '1.0.0', ...(options.dependencies ? { dependencies: options.dependencies } : {}) } };
  for (const [name, version] of Object.entries(options.dependencies ?? {})) {
    packages[`node_modules/${name}`] = name === 'is-number' ? {
      version, resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
      integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
    } : { version, resolved: version };
  }
  const lock = JSON.stringify({
    name: 'gotchu-vm-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages,
  });
  return makeTar([
    { path: 'package.json', content: manifest },
    { path: 'package-lock.json', content: lock },
    { path: 'test.js', content: testBody },
  ]);
}

async function runArchive(archive: Buffer, overrides: Partial<RunnerJob['limits']> = {}, signal?: AbortSignal, probe?: (unit: string) => Promise<{ networkIsolated: boolean; homeHidden: boolean; scopeLimitsApplied: boolean }>, selection?: RunnerTestSelection) {
  const jobId = crypto.randomUUID();
  const job: RunnerJob = {
    jobId,
    organizationId,
    ...(selection ? { profile: 'node24-tsx-selected-v1', testSelection: selection } as const : { profile: 'node24-npm-test' } as const),
    input: { objectId: crypto.randomUUID(), sha256: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length },
    limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048, ...overrides },
    networkPolicy: { mode: 'deny' },
  };
  return { job, ...(await __testOnly.runMicroVm(job, archive, cacheDir, signal, probe)) };
}

async function run(testBody: string, overrides: Partial<RunnerJob['limits']> = {}, signal?: AbortSignal, probe?: (unit: string) => Promise<{ networkIsolated: boolean; homeHidden: boolean; scopeLimitsApplied: boolean }>) {
  return runArchive(projectArchive(testBody), overrides, signal, probe);
}

describe('real Firecracker microVM execution', () => {
  beforeAll(async () => {
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
  }, 90_000);

  it('installs one pure-JS registry dependency offline and preserves its failing test exit code', async () => {
    const archive = projectArchive("const isNumber=require('is-number');if(!isNumber(7))process.exit(4)", { dependencies: { 'is-number': '7.0.0' } });
    const passed = await runArchive(archive);
    expect(passed.result.status, JSON.stringify(passed.result)).toBe('completed');
    if (passed.result.status === 'completed') expect(passed.result.exitCode).toBe(0);
    const failed = await runArchive(projectArchive("require('is-number');process.exit(9)", { dependencies: { 'is-number': '7.0.0' } }));
    expect(failed.result.status, JSON.stringify(failed.result)).toBe('completed');
    if (failed.result.status === 'completed') expect(failed.result.exitCode).toBe(9);
  }, 90_000);

  it('rejects git dependencies and bad tarball integrity before VM boot', async () => {
    const gitArchive = projectArchive('process.exit(0)', { dependencies: { fixture: 'git+https://example.invalid/fixture.git' } });
    await expect(runArchive(gitArchive)).rejects.toMatchObject({ reason: 'unsupported-dependency' });

    const badIntegrity = projectArchive('process.exit(0)', { dependencies: { 'is-number': '7.0.0' } }).toString('utf8').replace(
      '41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    );
    await expect(runArchive(Buffer.from(badIntegrity))).rejects.toMatchObject({ reason: 'integrity-mismatch' });
  });

  it('does not run project postinstall scripts', async () => {
    const result = await runArchive(projectArchive(
      "const fs=require('fs');if(fs.existsSync('postinstall-ran'))process.exit(8)",
      { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran','yes')\"" },
    ));
    expect(result.result.status, JSON.stringify(result.result)).toBe('completed');
    if (result.result.status === 'completed') expect(result.result.exitCode).toBe(0);
  });

  it('verifies no host home or network in the VMM namespace and confirms scope limits', async () => {
    const result = await run('process.exit(0)', {}, undefined, async (unit) => {
      return __testOnly.inspectSandboxScope(unit, { memoryMiB: 1024, tasks: 80, cpuPercent: 100 });
    });
    expect(result.result.status).toBe('completed');
    expect(result.hostProbe).toEqual({ networkIsolated: true, homeHidden: true, scopeLimitsApplied: true });
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

  it('returns allowed artifacts with host-verified digests and rejects oversized artifacts', async () => {
    const accepted = await run("const fs=require('fs');fs.mkdirSync('test-results');fs.writeFileSync('test-results/report.txt','verified artifact')");
    expect(accepted.result.status).toBe('completed');
    if (accepted.result.status === 'completed') {
      expect(accepted.result.artifacts).toHaveLength(1);
      expect(accepted.result.artifacts[0]?.path).toBe('test-results/report.txt');
      expect(Buffer.from(accepted.result.artifacts[0]?.contentBase64 ?? '', 'base64').toString()).toBe('verified artifact');
    }
    const oversized = await run("const fs=require('fs');fs.mkdirSync('coverage');fs.writeFileSync('coverage/large.bin',Buffer.alloc(300000))");
    expect(oversized.result.status).toBe('resource_exceeded');
    if (oversized.result.status === 'resource_exceeded') expect(oversized.result.resource).toBe('artifact');
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

// Unexecuted sources until explicitly run against the rebuilt, pinned guest image.
describe('real Firecracker selected Node profile', () => {
  function runSelected(sources: ReadonlyArray<{ path: string; content: string }>, selection: RunnerTestSelection, limits: Partial<RunnerJob['limits']> = {}) {
    const manifest = { name: 'gotchu-selected-vm-fixture', version: '1.0.0', type: 'module',
      scripts: { test: 'node -e "process.exit(93)"', postinstall: 'node -e "process.exit(94)"' } };
    const archive = makeTar([
      { path: 'package.json', content: JSON.stringify(manifest) },
      { path: 'package-lock.json', content: JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3,
        packages: { '': { name: manifest.name, version: manifest.version } } }) },
      ...sources,
    ]);
    return runArchive(archive, limits, undefined, undefined, selection);
  }
  function report(result: Awaited<ReturnType<typeof runSelected>>['result']) {
    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed VM command');
    const artifact = result.artifacts.find((item) => item.path === SELECTED_NODE_REPORT_PATH);
    if (!artifact) throw new Error('Runner-owned selected report is missing');
    return selectedNodeTestReportSchema.parse(JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8')));
  }

  it('uses pinned tsx, explicit files and a literal name filter without invoking package scripts', async () => {
    const result = await runSelected([
      { path: 'tests/creator.test.ts', content: `
        import test from 'node:test'; import assert from 'node:assert/strict';
        import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os'; import { join } from 'node:path';
        enum Expected { answer = 42 }
        test('selected generated fixture', () => {
          const dir = mkdtempSync(join(tmpdir(), 'selected-'));
          try { writeFileSync(join(dir, 'fixture'), String(Expected.answer)); assert.equal(readFileSync(join(dir, 'fixture'), 'utf8'), '42'); }
          finally { rmSync(dir, { recursive: true, force: true }); }
          assert.throws(() => writeFileSync('/usr/local/lib/gotchu-node-selected-reporter.mjs', 'forged'), { code: 'EROFS' });
        });
        test('Vite assets unavailable', () => assert.fail('excluded compatibility case'));
      ` },
      { path: 'tests/accounts.test.js', content: "import test from 'node:test'; import assert from 'node:assert/strict'; test('selected account behavior', () => assert.equal(2 + 2, 4));" },
      { path: 'tests/unselected.test.js', content: "throw new Error('file selection was ignored')" },
    ], { files: ['tests/creator.test.ts', 'tests/accounts.test.js'], namePattern: '^selected' });
    expect(report(result.result)).toMatchObject({ complete: true, success: true, counts: { passed: 2, failed: 0, cancelled: 0 } });
    expect(result.result.status === 'completed' && result.result.exitCode).toBe(0);
    expect(result.cleanupVerified).toBe(true);
  }, 90_000);

  it('replaces forged customer reports and preserves real assertion failures', async () => {
    const result = await runSelected([{ path: 'tests/failure.test.js', content: `
      import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('test-results', { recursive: true });
      writeFileSync('test-results/gotchu-node-selected-v1.json', JSON.stringify({ complete: true, success: true, passed: 900 }));
      console.log(JSON.stringify({ complete: true, success: true, passed: 900 }));
      test('real assertion', () => assert.equal(1, 2));
    ` }], { files: ['tests/failure.test.js'] });
    expect(report(result.result)).toMatchObject({ complete: true, success: false, counts: { passed: 0, failed: 1, total: 1 } });
    expect(result.result.status === 'completed' && result.result.exitCode).not.toBe(0);
  }, 90_000);

  it.each([
    { source: '', namePattern: undefined },
    { source: "import test from 'node:test'; test('other name', () => {});", namePattern: '^no match$' },
    { source: "import test from 'node:test'; test.skip('skip', () => {});", namePattern: undefined },
    { source: "import test from 'node:test'; test('cancelled', async () => new Promise(() => {}));", namePattern: undefined },
  ])('cannot pass without executed successful tests: $source', async ({ source, namePattern }) => {
    const result = await runSelected([{ path: 'tests/empty.test.js', content: source }], {
      files: ['tests/empty.test.js'], ...(namePattern === undefined ? {} : { namePattern }),
    });
    expect(report(result.result).success).toBe(false);
    expect(result.result.status === 'completed' && result.result.exitCode).not.toBe(0);
    expect(result.cleanupVerified).toBe(true);
  }, 90_000);

  it('cannot pass when customer output exceeds the cap', async () => {
    const result = await runSelected([{ path: 'tests/output.test.js', content:
      "import test from 'node:test'; test('output limit', () => console.log('x'.repeat(50000)));" }],
    { files: ['tests/output.test.js'] }, { outputBytes: 1024 });
    expect(result.result.status).toBe('resource_exceeded');
    if (result.result.status === 'resource_exceeded') expect(result.result.resource).toBe('output');
    expect(result.cleanupVerified).toBe(true);
  }, 90_000);
});
