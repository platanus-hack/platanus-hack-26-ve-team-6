import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SELECTED_NODE_PROFILE, SELECTED_NODE_REPORT_PATH, MAX_REPORT_BYTES, emptySelectedReport, selectedNodeArgs, readSelectedReport } from './selected-node.mjs';

const work = '/scratch/work';
let report = emptySelectedReport();
let exceeded = false;
let manifest;
const output = { stdout: [], stderr: [] };
const sizes = { stdout: 0, stderr: 0 };
let outputLimit = 512;

function execute(command, args, structured = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: work,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scratch/home', TMPDIR: '/scratch/tmp', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
      stdio: structured ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      const room = Math.max(0, outputLimit - sizes[name]);
      const kept = chunk.subarray(0, room);
      output[name].push(kept);
      sizes[name] += kept.length;
      if (chunk.length > room) { exceeded = true; child.kill('SIGKILL'); }
    });
    const chunks = [];
    let bytes = 0;
    let reportError = false;
    if (structured) {
      child.stdio[3].on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_REPORT_BYTES) chunks.push(Buffer.from(chunk));
        else { reportError = true; child.kill('SIGKILL'); }
      });
      child.stdio[3].once('error', () => { reportError = true; });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (structured) {
        report = reportError ? emptySelectedReport() : readSelectedReport(Buffer.concat(chunks));
        report.success &&= code === 0 && signal === null && !exceeded;
      }
      resolve({ code: code ?? 1, signal });
    });
  });
}

let payload;
try {
  if (process.getuid() !== 1000) throw new Error('Guest requires the unprivileged runner identity');
  const job = JSON.parse(await readFile('/input/job.json', 'utf8'));
  if (job.profile !== SELECTED_NODE_PROFILE || job.networkPolicy.mode !== 'deny') throw new Error('Unsupported selected-test job');
  outputLimit = Math.floor(job.limits.outputBytes / 2);
  manifest = JSON.parse(await readFile('/npm-cache-source/manifest.json', 'utf8'));
  for (const path of [work, '/scratch/home', '/scratch/tmp', '/scratch/npm-cache']) await mkdir(path, { recursive: true });
  let result = await execute('/usr/bin/tar', ['-xf', '/input/project.tar', '-C', work, '--no-same-owner', '--no-same-permissions']);
  if (result.code !== 0) throw new Error('Input archive extraction failed');
  const npmArgs = ['--ignore-scripts', '--offline', '--cache', '/scratch/npm-cache', '--no-audit', '--no-fund'];
  for (const entry of manifest.entries) {
    if (!/^[a-f0-9]{64}\.tgz$/.test(entry.file)) throw new Error('Invalid cache entry');
    result = await execute('/usr/local/bin/npm', ['cache', 'add', `/npm-cache-source/tarballs/${entry.file}`, ...npmArgs]);
    if (result.code !== 0 || exceeded) break;
  }
  if (result.code === 0 && !exceeded) result = await execute('/usr/local/bin/npm', ['ci', ...npmArgs]);
  if (result.code === 0 && !exceeded) {
    const [command, ...args] = selectedNodeArgs(job.testSelection);
    result = await execute(command, args, true);
  }
  const stdout = Buffer.concat(output.stdout).toString('utf8');
  const stderr = Buffer.concat(output.stderr).toString('utf8');
  const bytes = Buffer.from(JSON.stringify(report));
  const resource = exceeded ? 'output' : /ENOSPC/.test(stderr) ? 'disk'
    : /Resource temporarily unavailable|EAGAIN/.test(stderr) ? 'pids' : undefined;
  payload = { status: resource ? 'resource_exceeded' : 'completed',
    exitCode: result.code === 0 && !report.success ? 1 : result.code,
    ...(resource ? { resource } : {}), stdout, stderr,
    lockfileSha256: manifest.lockfileSha256, tarballSetSha256: manifest.tarballSetSha256,
    artifacts: [{ path: SELECTED_NODE_REPORT_PATH, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }] };
} catch (error) {
  payload = { status: 'infrastructure_failed', reason: (error instanceof Error ? error.message : 'Guest execution failed').slice(0, 512) };
}
const frame = Buffer.from(JSON.stringify(payload));
process.stdout.write(`\nGOTCHU_RESULT_V1 ${frame.length}\n`);
process.stdout.write(frame);
process.stdout.end('\n');
