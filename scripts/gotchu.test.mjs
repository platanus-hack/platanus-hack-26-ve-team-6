import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'gotchu');
const temp = await mkdtemp(join(tmpdir(), 'gotchu-installer-test-'));
const fakeBin = join(temp, 'bin');
const noDockerBin = join(temp, 'no-docker-bin');
await mkdir(fakeBin);
await mkdir(noDockerBin);
for (const binary of ['dirname', 'basename', 'tr', 'sha256sum', 'cut', 'date', 'mkdir', 'chmod', 'find']) await symlink(`/usr/bin/${binary}`, join(noDockerBin, binary));
await writeFile(join(fakeBin, 'docker'), '#!/bin/sh\nif [ "$1" = compose ]; then [ "$2" = version ] && { echo 2.40.0; exit 0; }; fi\nexit 0\n', { mode: 0o700 });
const basePath = `${fakeBin}:/usr/local/bin:/usr/bin:/bin`;
function run(args, env = {}) {
  return spawnSync('/bin/bash', [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: basePath, ...env } });
}
async function freePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const ports = servers.map(server => String(server.address().port));
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

try {
  const missing = run(['up'], { PATH: noDockerBin, GOTCHU_STATE_DIR: join(temp, 'missing-state') });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Docker no está instalado/);

  const occupiedServer = createServer();
  await new Promise(resolve => occupiedServer.listen(0, '127.0.0.1', resolve));
  const occupied = occupiedServer.address().port;
  const conflictDir = join(temp, 'conflict-state');
  const conflict = run(['up'], { GOTCHU_STATE_DIR: conflictDir, GOTCHU_WEB_PORT: String(occupied), GOTCHU_COORDINATOR_PORT: '35123', GOTCHU_SCANNER_PORT: '35124' });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, new RegExp(`puerto ${occupied} está ocupado`));
  await new Promise(resolve => occupiedServer.close(resolve));
  assert.equal(await readFile(join(conflictDir, '.env')).catch(() => null), null);

  const stateDir = join(temp, 'state');
  const [webPort, coordinatorPort, scannerPort, postgresPort, redisPort] = await freePorts(5);
  const configuredPorts = { GOTCHU_STATE_DIR: stateDir, GOTCHU_WEB_PORT: webPort, GOTCHU_COORDINATOR_PORT: coordinatorPort, GOTCHU_SCANNER_PORT: scannerPort, GOTCHU_POSTGRES_PORT: postgresPort, GOTCHU_REDIS_PORT: redisPort };
  const first = run(['up'], configuredPorts);
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /pnpm 11/);
  const envBefore = await readFile(join(stateDir, '.env'), 'utf8');
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDir, '.env'))).mode & 0o777, 0o600);
  const secrets = envBefore.split(/\r?\n/).filter(line => /PASSWORD=|AUTH_SECRET=/.test(line)).map(line => line.slice(line.indexOf('=') + 1)).filter(Boolean);
  assert.ok(secrets.length >= 4);
  for (const secret of secrets) assert.equal(`${first.stdout}${first.stderr}`.includes(secret), false);
  const scannerSecret = await readFile(join(stateDir, 'scanner.secret'));
  assert.equal((await stat(join(stateDir, 'scanner.secret'))).mode & 0o777, 0o600);
  const second = run(['up'], configuredPorts);
  assert.notEqual(second.status, 0);
  assert.equal(await readFile(join(stateDir, '.env'), 'utf8'), envBefore);
  assert.deepEqual(await readFile(join(stateDir, 'scanner.secret')), scannerSecret);
  for (const secret of secrets) assert.equal(`${second.stdout}${second.stderr}`.includes(secret), false);

  const upgrade = run(['upgrade'], { GOTCHU_STATE_DIR: stateDir });
  assert.notEqual(upgrade.status, 0);
  assert.match(upgrade.stdout, /Se reconstruirá desde este checkout/);
  assert.match(upgrade.stderr, /pnpm 11/);
} finally {
  await rm(temp, { recursive: true, force: true });
}
process.stdout.write('Self-host script tests passed (private secret generation, idempotent state, occupied port, missing Docker).\n');
