import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScannerProbe } from './infra-scanner-probe.mjs';

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
  const probeCert = join(temp, 'probe.crt');
  const probeKey = join(temp, 'probe.key');
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', probeKey, '-out', probeCert, '-subj', '/CN=127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(certificate.status, 0, certificate.stderr);
  let scannerReady = true;
  const scanner = createHttpsServer({ key: await readFile(probeKey), cert: await readFile(probeCert) }, (_request, response) => {
    response.writeHead(scannerReady ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: scannerReady }));
  });
  await new Promise(resolve => scanner.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `https://127.0.0.1:${scanner.address().port}`;
    await assert.doesNotReject(runScannerProbe({ origin, caFile: probeCert }));
    scannerReady = false;
    await assert.rejects(runScannerProbe({ origin, caFile: probeCert }), /scanner_not_ready/);
  } finally {
    await new Promise((resolve, reject) => scanner.close(error => error ? reject(error) : resolve()));
  }

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
  const [webPort, coordinatorPort, scannerPort, postgresPort, redisPort, gatewayPort, workerPort] = await freePorts(7);
  const configuredPorts = { GOTCHU_STATE_DIR: stateDir, GOTCHU_WEB_PORT: webPort, GOTCHU_COORDINATOR_PORT: coordinatorPort, GOTCHU_SCANNER_PORT: scannerPort, GOTCHU_POSTGRES_PORT: postgresPort, GOTCHU_REDIS_PORT: redisPort, GOTCHU_GATEWAY_PORT: gatewayPort, GOTCHU_WORKER_PORT: workerPort };
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

  const cryptoInput = join(temp, 'backup-input');
  const encrypted = join(temp, 'backup.gotchu');
  const decrypted = join(temp, 'backup-output');
  const payload = 'private database and local secrets';
  const passphrase = 'a long local backup passphrase';
  await writeFile(cryptoInput, payload);
  const encryptedResult = spawnSync('node', [join(root, 'scripts/gotchu-backup-crypto.mjs'), 'encrypt', cryptoInput, encrypted], { input: `${passphrase}\n`, encoding: 'utf8' });
  assert.equal(encryptedResult.status, 0, encryptedResult.stderr);
  assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
  assert.equal((await readFile(encrypted)).includes(Buffer.from(payload)), false);
  const decryptedResult = spawnSync('node', [join(root, 'scripts/gotchu-backup-crypto.mjs'), 'decrypt', encrypted, decrypted], { input: `${passphrase}\n`, encoding: 'utf8' });
  assert.equal(decryptedResult.status, 0, decryptedResult.stderr);
  assert.equal(await readFile(decrypted, 'utf8'), payload);
  const rejectedPassphrase = spawnSync('node', [join(root, 'scripts/gotchu-backup-crypto.mjs'), 'decrypt', encrypted, join(temp, 'wrong-passphrase')], { input: 'a wrong passphrase with length\n', encoding: 'utf8' });
  assert.notEqual(rejectedPassphrase.status, 0);
  const existingOutput = join(temp, 'existing-backup-output');
  await writeFile(existingOutput, 'preserve an existing destination');
  const refusedOverwrite = spawnSync('node', [join(root, 'scripts/gotchu-backup-crypto.mjs'), 'encrypt', cryptoInput, existingOutput], { input: `${passphrase}\n`, encoding: 'utf8' });
  assert.notEqual(refusedOverwrite.status, 0);
  assert.equal(await readFile(existingOutput, 'utf8'), 'preserve an existing destination');
  const backupEnvironment = join(temp, 'backup.env');
  const mergedEnvironment = join(temp, 'restored.env');
  await writeFile(backupEnvironment, envBefore.replace(/^AUTH_SECRET=.*$/mu, 'AUTH_SECRET=backup-session-secret'));
  const merged = spawnSync('node', [join(root, 'scripts/gotchu-restore-env.mjs'), backupEnvironment, join(stateDir, '.env'), mergedEnvironment], { encoding: 'utf8' });
  assert.equal(merged.status, 0, merged.stderr);
  const restoredSettings = new Map((await readFile(mergedEnvironment, 'utf8')).trim().split(/\r?\n/u).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(restoredSettings.get('AUTH_SECRET'), 'backup-session-secret');
  assert.equal(restoredSettings.get('POSTGRES_PASSWORD'), new Map(envBefore.trim().split(/\r?\n/u).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])).get('POSTGRES_PASSWORD'));
  assert.equal((await stat(mergedEnvironment)).mode & 0o777, 0o600);

  const second = run(['up'], configuredPorts);
  assert.notEqual(second.status, 0);
  assert.equal(await readFile(join(stateDir, '.env'), 'utf8'), envBefore);
  assert.deepEqual(await readFile(join(stateDir, 'scanner.secret')), scannerSecret);
  for (const secret of secrets) assert.equal(`${second.stdout}${second.stderr}`.includes(secret), false);

  const githubSetup = run(['github', 'setup'], { GOTCHU_STATE_DIR: stateDir });
  assert.equal(githubSetup.status, 0, githubSetup.stderr);
  assert.match(githubSetup.stdout, new RegExp(`http://localhost:${webPort}/api/customer/github/callback`));
  assert.match(githubSetup.stdout, new RegExp(`http://localhost:${webPort}/api/auth/callback/github`));
  assert.match(githubSetup.stdout, /AUTH_GITHUB_ID=<client-id> y AUTH_GITHUB_SECRET=<client-secret>/);
  assert.match(githubSetup.stdout, /botón aparece sólo cuando ambos están configurados/);
  for (const secret of secrets) assert.equal(`${githubSetup.stdout}${githubSetup.stderr}`.includes(secret), false);

  const googleSetup = run(['google', 'setup'], { GOTCHU_STATE_DIR: stateDir });
  assert.equal(googleSetup.status, 0, googleSetup.stderr);
  assert.match(googleSetup.stdout, new RegExp(`Orígenes de JavaScript autorizados \\(exacto\\): http://localhost:${webPort}`));
  assert.match(googleSetup.stdout, new RegExp(`URI de redirección autorizados \\(exacto\\): http://localhost:${webPort}/api/auth/callback/google`));
  assert.match(googleSetup.stdout, /AUTH_GOOGLE_ID=<client-id> y AUTH_GOOGLE_SECRET=<client-secret>/);
  assert.match(googleSetup.stdout, /openid, email y profile/);
  for (const secret of secrets) assert.equal(`${googleSetup.stdout}${googleSetup.stderr}`.includes(secret), false);

  const upgrade = run(['upgrade'], { GOTCHU_STATE_DIR: stateDir });
  assert.notEqual(upgrade.status, 0);
  assert.match(upgrade.stdout, /Se reconstruirá desde este checkout/);
  assert.match(upgrade.stderr, /pnpm 11/);
} finally {
  await rm(temp, { recursive: true, force: true });
}
process.stdout.write('Self-host script tests passed (scanner TLS readiness, private secrets, encrypted backup format, environment restore, idempotent state, occupied ports, GitHub and Google callback instructions, missing Docker).\n');
