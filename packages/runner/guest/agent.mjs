import { mkdir, readFile, chown, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const job = JSON.parse(await readFile('/input/job.json', 'utf8'));
const work = '/scratch/work';
await mkdir(work, { recursive: true });
const cacheManifest = JSON.parse(await readFile('/npm-cache-source/manifest.json', 'utf8'));
await run('/usr/bin/tar', ['-xf', '/input/project.tar', '-C', work, '--no-same-owner', '--no-same-permissions']);
await run('/usr/bin/chown', ['-R', 'node:node', work]);
await mkdir('/scratch/home', { recursive: true });
await mkdir('/scratch/npm-cache', { recursive: true });
await chown('/scratch/home', 1000, 1000);
await chown('/scratch/npm-cache', 1000, 1000);

const outputLimit = Math.floor(job.limits.outputBytes / 2);
const outputs = { stdout: [], stderr: [] };
let captured = { stdout: 0, stderr: 0 };
let exceededOutput = false;
function collect(stream, name) {
  stream.on('data', (chunk) => {
    const bytes = Buffer.from(chunk);
    const room = Math.max(0, outputLimit - captured[name]);
    if (room > 0) {
      const kept = bytes.subarray(0, room);
      outputs[name].push(kept);
      captured[name] += kept.length;
    }
    if (bytes.length > room) exceededOutput = true;
  });
}

function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/setpriv', [
      '--reuid=1000', '--regid=1000', '--clear-groups',
      '/bin/bash', '-c', 'ulimit -u "$1"; shift; exec "$@"', 'runner', String(job.limits.pids), ...args,
    ], { cwd: work, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scratch/home' }, stdio: ['ignore', 'pipe', 'pipe'] });
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal }));
  });
}

let status = 'completed';
let exitCode = 0;
let resource;
let infrastructureReason;
try {
  let result = { code: 0, signal: null };
  for (const entry of cacheManifest.entries) {
    result = await execute(['npm', 'cache', 'add', `/npm-cache-source/tarballs/${entry.file}`, '--cache', '/scratch/npm-cache', '--offline']);
    if (result.code !== 0) break;
  }
  if (result.code === 0) result = await execute(['npm', 'ci', '--ignore-scripts', '--offline', '--cache', '/scratch/npm-cache']);
  if (result.code === 0) result = await execute(['npm', 'test']);
  exitCode = result.code;
  const combined = Buffer.concat([...outputs.stdout, ...outputs.stderr]).toString('utf8');
  if (/Resource temporarily unavailable|EAGAIN/.test(combined)) {
    status = 'resource_exceeded';
    resource = 'pids';
  } else if (exceededOutput) {
    status = 'resource_exceeded';
    resource = 'output';
  } else if (result.signal === 'SIGXCPU') {
    status = 'resource_exceeded';
    resource = 'cpu';
  }
} catch (error) {
  status = 'infrastructure_failed';
  const value = error instanceof Error ? error.message : 'Guest command could not start';
  outputs.stderr.push(Buffer.from(value.slice(0, 1024)));
  captured.stderr += Math.min(value.length, 1024);
  exitCode = 127;
  infrastructureReason = value.slice(0, 512);
}

const stdout = Buffer.concat(outputs.stdout).toString('utf8');
const stderr = Buffer.concat(outputs.stderr).toString('utf8');
const artifactPolicy = { roots: ['test-results', 'coverage'], maxCount: 10, maxBytes: 256 * 1024 };
const artifacts = [];
let artifactBytes = 0;
async function collectArtifacts(directory, relative = '') {
  for (const entry of (await readdir(directory)).sort()) {
    const path = relative ? `${relative}/${entry}` : entry;
    if (entry === '.' || entry === '..' || path.includes('\\')) throw new Error('Unsafe artifact path');
    const fullPath = `${directory}/${entry}`;
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) throw new Error(`Artifact symlinks are not allowed: ${path}`);
    if (stat.isDirectory()) await collectArtifacts(fullPath, path);
    else if (stat.isFile()) {
      const bytes = await readFile(fullPath);
      artifactBytes += bytes.length;
      if (artifacts.length >= artifactPolicy.maxCount || artifactBytes > artifactPolicy.maxBytes) {
        const error = new Error('Artifact count or byte limit exceeded');
        error.code = 'ARTIFACT_LIMIT';
        throw error;
      }
      artifacts.push({ path, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') });
    }
  }
}
try {
  for (const root of artifactPolicy.roots) {
    const path = `${work}/${root}`;
    try {
      if ((await lstat(path)).isDirectory()) await collectArtifacts(path, root);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
} catch (error) {
  if (error?.code === 'ARTIFACT_LIMIT') {
    status = 'resource_exceeded';
    resource = 'artifact';
    artifacts.length = 0;
  } else {
    status = 'infrastructure_failed';
    infrastructureReason = (error instanceof Error ? error.message : 'Artifact collection failed').slice(0, 512);
  }
}
const payload = status === 'infrastructure_failed' ? { status, reason: infrastructureReason ?? 'Guest execution failed' } : {
  status,
  exitCode,
  ...(resource ? { resource } : {}),
  stdout,
  stderr,
  artifacts,
  lockfileSha256: cacheManifest.lockfileSha256,
  tarballSetSha256: cacheManifest.tarballSetSha256,
};
const frame = Buffer.from(JSON.stringify(payload), 'utf8');
process.stdout.write(`\nGOTCHU_RESULT_V1 ${frame.length}\n`);
process.stdout.write(frame);
process.stdout.write('\n');
process.stdout.end();
try { await run('/sbin/reboot', ['-f']); } catch { process.exit(0); }
