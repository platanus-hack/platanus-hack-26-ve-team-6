import { mkdir, readFile, chown } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const job = JSON.parse(await readFile('/input/job.json', 'utf8'));
const work = '/scratch/work';
await mkdir(work, { recursive: true });
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
try {
  let result = await execute(['npm', 'ci', '--ignore-scripts', '--offline', '--cache', '/scratch/npm-cache']);
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
}

const stdout = Buffer.concat(outputs.stdout).toString('utf8');
const stderr = Buffer.concat(outputs.stderr).toString('utf8');
const payload = {
  status,
  exitCode,
  ...(resource ? { resource } : {}),
  stdout,
  stderr,
  artifacts: [],
};
const frame = Buffer.from(JSON.stringify(payload), 'utf8');
process.stdout.write(`\nGOTCHU_RESULT_V1 ${frame.length}\n`);
process.stdout.write(frame);
process.stdout.write('\n');
process.stdout.end();
try { await run('/sbin/reboot', ['-f']); } catch { process.exit(0); }
