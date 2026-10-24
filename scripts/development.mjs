#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local', 'dev');
const stateFile = join(directory, 'state.json');
const envFile = join(root, 'infra', '.env');
const dockerHost = 'unix:///var/run/docker.sock';
const action = process.argv[2];
const services = {
  scanner: { entry: 'apps/scanner/dist/main.js', log: '.local/dev/scanner.log' },
  coordinator: { entry: 'apps/coordinator/dist/main.js', log: '.local/dev/coordinator.log' },
  web: { entry: 'apps/web/.output/server/index.mjs', log: '.local/dev/web.log' },
};
const requiredScannerTools = ['semgrep', 'gitleaks', 'trivy', 'npm_advisories'];
const minimumPreparationFreeBytes = 5 * 1024 ** 3;

if (!['start', 'stop', 'prepare'].includes(action)) {
  throw new Error('Usage: node scripts/development.mjs start|stop|prepare');
}

const inheritedPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
const baseEnvironment = { PATH: inheritedPath, NODE_ENV: 'development' };
const dockerEnvironment = {
  ...baseEnvironment,
  DOCKER_HOST: dockerHost,
  DOCKER_CONFIG: '/nonexistent',
  HOME: '/nonexistent',
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

function command(binary, args, { env = baseEnvironment, capture = false, label = binary } = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start. Check the local tool installation.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit status ${result.status ?? 'unknown'}.`);
  return capture ? result.stdout : '';
}

function ensureCommand(binary, args, env = dockerEnvironment, label = binary) {
  const result = spawnSync(binary, args, { cwd: root, env, stdio: 'ignore' });
  if (result.error) throw new Error(`${label} could not start. Check the local tool installation.`);
  return result.status === 0;
}

async function ensurePrivateDirectory() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('.local/dev must be a real directory.');
  await chmod(directory, 0o700);
}

async function privateRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} must be private (mode 0600).`);
  return info;
}

async function ensureInfraEnvironment() {
  if (!await privateRegularFile(envFile, 'infra/.env')) {
    command('bash', ['scripts/infra-local-setup.sh'], { env: baseEnvironment, label: 'Local credential setup' });
  }
  await privateRegularFile(envFile, 'infra/.env');
  const contents = await readFile(envFile, 'utf8');
  const values = Object.create(null);
  for (const [lineNumber, line] of contents.split(/\r?\n/).entries()) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(line.slice(0, separator))) {
      throw new Error(`infra/.env has an invalid entry on line ${lineNumber + 1}.`);
    }
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) throw new Error(`infra/.env contains a duplicate ${key} entry.`);
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function requiredValue(config, key) {
  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${key} in infra/.env.`);
  return value;
}

function requiredHexSecret(config, key) {
  const value = requiredValue(config, key);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} in infra/.env must be a 32-byte lowercase hexadecimal value.`);
  return value;
}

function validIdentifier(value, key) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`${key} in infra/.env must be a lowercase PostgreSQL identifier.`);
  return value;
}

function validPort(value, key) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${key} must be an integer port from 1024 through 65535.`);
  return port;
}

function localConfig(config) {
  const database = validIdentifier(requiredValue(config, 'POSTGRES_DB'), 'POSTGRES_DB');
  validIdentifier(requiredValue(config, 'POSTGRES_USER'), 'POSTGRES_USER');
  const postgresPort = validPort(requiredValue(config, 'POSTGRES_HOST_PORT'), 'POSTGRES_HOST_PORT');
  const redisPort = validPort(requiredValue(config, 'REDIS_HOST_PORT'), 'REDIS_HOST_PORT');
  const authSecret = requiredHexSecret(config, 'AUTH_SECRET');
  const postgresPassword = requiredHexSecret(config, 'POSTGRES_PASSWORD');
  const redisPassword = requiredHexSecret(config, 'REDIS_PASSWORD');
  const apiUsername = validIdentifier(requiredValue(config, 'GOTCHU_API_DB_USERNAME'), 'GOTCHU_API_DB_USERNAME');
  const ingestUsername = validIdentifier(requiredValue(config, 'GOTCHU_INGEST_DB_USERNAME'), 'GOTCHU_INGEST_DB_USERNAME');
  const coordinatorUsername = validIdentifier(requiredValue(config, 'GOTCHU_COORDINATOR_DB_USERNAME'), 'GOTCHU_COORDINATOR_DB_USERNAME');
  validIdentifier(requiredValue(config, 'GOTCHU_GATEWAY_DB_USERNAME'), 'GOTCHU_GATEWAY_DB_USERNAME');
  validIdentifier(requiredValue(config, 'GOTCHU_EXECUTOR_DB_USERNAME'), 'GOTCHU_EXECUTOR_DB_USERNAME');
  const apiPassword = requiredHexSecret(config, 'GOTCHU_API_DB_PASSWORD');
  const ingestPassword = requiredHexSecret(config, 'GOTCHU_INGEST_DB_PASSWORD');
  const coordinatorPassword = requiredHexSecret(config, 'GOTCHU_COORDINATOR_DB_PASSWORD');
  requiredHexSecret(config, 'GOTCHU_GATEWAY_DB_PASSWORD');
  requiredHexSecret(config, 'GOTCHU_EXECUTOR_DB_PASSWORD');
  return {
    database, postgresPort, redisPort, authSecret, postgresPassword, redisPassword,
    apiUsername, ingestUsername, coordinatorUsername, apiPassword, ingestPassword, coordinatorPassword,
  };
}

function runtimePorts(config) {
  const ports = {
    web: validPort(process.env.GOTCHU_DEV_WEB_PORT ?? '3000', 'GOTCHU_DEV_WEB_PORT'),
    coordinator: validPort(process.env.GOTCHU_DEV_COORDINATOR_PORT ?? '3003', 'GOTCHU_DEV_COORDINATOR_PORT'),
    scanner: validPort(process.env.GOTCHU_DEV_SCANNER_PORT ?? '4400', 'GOTCHU_DEV_SCANNER_PORT'),
  };
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new Error('GOTCHU_DEV_WEB_PORT, GOTCHU_DEV_COORDINATOR_PORT, and GOTCHU_DEV_SCANNER_PORT must be distinct.');
  }
  if (Object.values(ports).includes(config.postgresPort) || Object.values(ports).includes(config.redisPort)) {
    throw new Error('App ports must not overlap the configured PostgreSQL or Redis host ports.');
  }
  return ports;
}

function postgresUrl(infra, username, password) {
  const url = new URL(`postgresql://127.0.0.1:${infra.postgresPort}/${encodeURIComponent(infra.database)}`);
  url.username = username;
  url.password = password;
  return url.toString();
}

function redisUrl(infra) {
  const url = new URL(`redis://127.0.0.1:${infra.redisPort}`);
  url.password = infra.redisPassword;
  return url.toString();
}

async function ensureScannerSecret() {
  const path = join(directory, 'scanner.secret');
  let info = await privateRegularFile(path, 'Local scanner secret');
  if (!info) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(32));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    }
    info = await privateRegularFile(path, 'Local scanner secret');
  }
  if (!info || info.size !== 32) throw new Error('The local scanner secret must contain exactly 32 raw bytes; it was left unchanged.');
  return path;
}

function isProcessRecord(value) {
  return isRecord(value)
    && Object.hasOwn(services, value.name)
    && value.entry === services[value.name].entry
    && value.log === services[value.name].log
    && Number.isSafeInteger(value.pid) && value.pid > 1
    && typeof value.startTime === 'string' && /^\d+$/.test(value.startTime)
    && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;
}

async function readState() {
  const info = await privateRegularFile(stateFile, 'Development state file');
  if (!info) return { version: 1, status: 'stopped', processes: [] };
  await chmod(stateFile, 0o600);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    throw new Error('.local/dev/state.json is invalid; no process will be signalled. Inspect it before continuing.');
  }
  const statuses = ['starting', 'running', 'stopping', 'stopped', 'failed'];
  if (!isRecord(parsed) || parsed.version !== 1 || !statuses.includes(parsed.status) || !Array.isArray(parsed.processes)) {
    throw new Error('.local/dev/state.json has an unsupported shape; no process will be signalled.');
  }
  if (parsed.processes.length > 3 || !parsed.processes.every(isProcessRecord)) {
    throw new Error('.local/dev/state.json contains an invalid process record; no process will be signalled.');
  }
  const names = parsed.processes.map(record => record.name);
  if (new Set(names).size !== names.length) throw new Error('.local/dev/state.json contains duplicate service records.');
  return parsed;
}

async function writeState(state) {
  const temporary = join(directory, `.state-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, stateFile);
    await chmod(stateFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function processStatus(record) {
  let statText;
  try {
    statText = await readFile(`/proc/${record.pid}/stat`, 'utf8');
  } catch (error) {
    return isMissing(error) ? 'gone' : 'unknown';
  }
  const commEnd = statText.lastIndexOf(')');
  if (commEnd < 0) return 'unknown';
  const fields = statText.slice(commEnd + 2).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X') return 'gone';
  if (fields[19] !== record.startTime) return 'other';

  try {
    const [status, commandLine] = await Promise.all([
      readFile(`/proc/${record.pid}/status`, 'utf8'),
      readFile(`/proc/${record.pid}/cmdline`, 'utf8'),
    ]);
    const uidLine = status.split('\n').find(line => line.startsWith('Uid:'));
    const uid = uidLine?.trim().split(/\s+/)[1];
    const args = commandLine.split('\0');
    if (uid !== String(process.getuid?.() ?? -1) || !args.includes(record.entry)) return 'other';
    return 'matching';
  } catch (error) {
    return isMissing(error) ? 'gone' : 'unknown';
  }
}

async function pruneDeadRecords(records) {
  const live = [];
  for (const record of records) {
    const status = await processStatus(record);
    if (status === 'matching' || status === 'unknown') live.push(record);
  }
  return live;
}

async function stopRecordedProcesses(state, waitMs = 15_000) {
  const records = [...state.processes].reverse();
  const retained = [];
  for (const record of records) {
    const status = await processStatus(record);
    if (status === 'unknown') {
      retained.push(record);
      continue;
    }
    if (status !== 'matching') continue;
    try {
      process.kill(record.pid, 'SIGTERM');
      retained.push(record);
    } catch (error) {
      if (isRecord(error) && error.code === 'ESRCH') continue;
      retained.push(record);
    }
  }
  state.processes = retained.reverse();
  state.status = 'stopping';
  state.updatedAt = new Date().toISOString();
  await writeState(state);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    state.processes = await pruneDeadRecords(state.processes);
    if (state.processes.length === 0) break;
    await delay(Math.min(150, deadline - Date.now()));
  }
  state.processes = await pruneDeadRecords(state.processes);
  state.updatedAt = new Date().toISOString();
  if (state.processes.length === 0) {
    state.status = 'stopped';
    state.stoppedAt = new Date().toISOString();
  } else {
    state.status = 'stopping';
  }
  await writeState(state);
  return state.processes;
}

async function probePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      server.close(error => error ? reject(error) : resolve());
    });
  }).catch(error => {
    if (isRecord(error) && error.code === 'EADDRINUSE') throw new Error(`127.0.0.1:${port} is already in use.`);
    throw error;
  });
}

function assertDockerAvailable() {
  const rootDirectory = command('docker', ['info', '--format', '{{.DockerRootDir}}'], {
    env: dockerEnvironment, capture: true, label: 'Docker daemon check',
  }).trim();
  if (!rootDirectory.startsWith('/')) throw new Error('Docker returned an invalid local image storage path.');
  return rootDirectory;
}

function imageIsPresent(image) {
  return ensureCommand('docker', ['image', 'inspect', image], dockerEnvironment, `Docker image check for ${image}`);
}

async function scannerProfiles() {
  const modulePath = pathToFileURL(join(root, 'packages/customer-assessment/dist/index.js')).href;
  const imported = await import(modulePath);
  const value = imported.profiles;
  if (!isRecord(value)) throw new Error('The customer-assessment package did not export its scanner profiles.');
  const images = [];
  for (const name of ['semgrep', 'gitleaks', 'trivy']) {
    const profile = value[name];
    if (!isRecord(profile) || typeof profile.image !== 'string' || !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(profile.image)) {
      throw new Error(`The pinned ${name} scanner profile is invalid.`);
    }
    images.push(profile.image);
  }
  return images;
}

function composeDataImages() {
  const output = command('docker', [
    'compose', '--env-file', envFile, '-f', join(root, 'infra/compose.yaml'),
    'config', '--images', 'postgres', 'redis',
  ], { env: dockerEnvironment, capture: true, label: 'Local Compose image check' });
  const images = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (images.length !== 2 || images.some(image => !/^[a-zA-Z0-9._:/@-]+$/.test(image))) {
    throw new Error('Compose did not return exactly the PostgreSQL and Redis image references.');
  }
  return images;
}

async function ensureBuild(...filters) {
  const args = filters.flatMap(filter => ['--filter', filter]);
  args.push('--sort', 'build');
  command('pnpm', args, { env: { ...baseEnvironment, NODE_ENV: 'production' }, label: 'Required workspace build' });
}

async function prepare() {
  await ensurePrivateDirectory();
  const dockerRoot = assertDockerAvailable();
  await ensureInfraEnvironment();
  await ensureBuild('@gotchu/customer-assessment...');
  const images = [...new Set([...await scannerProfiles(), ...composeDataImages()])];
  const missing = images.filter(image => !imageIsPresent(image));
  if (missing.length === 0) {
    console.log('All pinned scanner, PostgreSQL, and Redis images are already cached. No images were pulled.');
    return;
  }

  const space = await statfs(dockerRoot);
  const freeBytes = Number(space.bavail) * Number(space.bsize);
  if (freeBytes < minimumPreparationFreeBytes) {
    const freeGiB = (freeBytes / 1024 ** 3).toFixed(2);
    throw new Error(`Docker storage has ${freeGiB} GiB free; image preparation requires at least 5 GiB. No images were pulled. Free space and rerun pnpm dev:prepare.`);
  }

  for (const image of missing) {
    console.log(`Pulling missing pinned image ${image}.`);
    command('docker', ['pull', image], { env: dockerEnvironment, label: `Pinned image pull for ${image}` });
    if (!imageIsPresent(image)) throw new Error(`Docker did not cache ${image} after pulling it.`);
  }
  console.log(`Prepared ${missing.length} missing pinned image${missing.length === 1 ? '' : 's'}.`);
}

function databaseUrls(infra) {
  return {
    api: postgresUrl(infra, infra.apiUsername, infra.apiPassword),
    ingest: postgresUrl(infra, infra.ingestUsername, infra.ingestPassword),
    coordinator: postgresUrl(infra, infra.coordinatorUsername, infra.coordinatorPassword),
  };
}

async function launchService(state, name, port, extraEnvironment) {
  const service = services[name];
  const logPath = join(root, service.log);
  try {
    const info = await lstat(logPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${service.log} must be a regular file.`);
    await chmod(logPath, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const log = await open(logPath, 'a', 0o600);
  try {
    await chmod(logPath, 0o600);
    const child = spawn(process.execPath, [service.entry], {
      cwd: root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...baseEnvironment, ...extraEnvironment },
    });
    await once(child, 'spawn');
    if (!child.pid) throw new Error(`${name} did not receive a process id.`);
    child.unref();
    let birth = null;
    for (let attempt = 0; attempt < 20 && !birth; attempt++) {
      try {
        const text = await readFile(`/proc/${child.pid}/stat`, 'utf8');
        const end = text.lastIndexOf(')');
        birth = end < 0 ? null : text.slice(end + 2).trim().split(/\s+/)[19] ?? null;
      } catch {
        birth = null;
      }
      if (!birth) await delay(50);
    }
    if (!birth) {
      child.kill('SIGTERM');
      throw new Error(`${name} exited before its process identity could be recorded.`);
    }
    const record = { name, pid: child.pid, startTime: birth, entry: service.entry, port, log: service.log };
    state.processes.push(record);
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    if (await processStatus(record) !== 'matching') throw new Error(`${name} exited during startup.`);
  } finally {
    await log.close();
  }
}

function responseObject(value) {
  return isRecord(value) ? value : null;
}

function scannerReady(value) {
  const body = responseObject(value);
  if (body?.ready !== true || !Array.isArray(body.tools)) return false;
  const tools = new Map();
  for (const tool of body.tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.available !== 'boolean') return false;
    tools.set(tool.name, tool.available);
  }
  return requiredScannerTools.every(name => tools.get(name) === true);
}

async function waitForHttpReady(name, url, predicate, { timeoutMs = 30_000, requestTimeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)) });
      let body = null;
      try { body = await response.json(); } catch { /* An invalid readiness response stays unready. */ }
      if (response.ok && predicate(body)) return;
    } catch {
      // The service may still be starting or completing its first bounded readiness check.
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${name} did not report ready at ${new URL(url).pathname} within ${timeoutMs / 1000} seconds.`);
}

function readinessDescription(value) {
  const body = responseObject(value);
  if (!body || !Array.isArray(body.tools)) return 'invalid response';
  return body.tools.filter(isRecord).filter(tool => tool.available !== true).map(tool => String(tool.name)).join(', ') || 'service not ready';
}

async function waitForScanner(port) {
  const url = `http://127.0.0.1:${port}/readyz`;
  const deadline = Date.now() + 90_000;
  let unavailableTools = 'service not ready';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(30_000, remaining)) });
      let body = null;
      try { body = await response.json(); } catch { /* An invalid readiness response stays unready. */ }
      if (response.ok && scannerReady(body)) return;
      unavailableTools = readinessDescription(body);
    } catch {
      // The initial self-tests may take longer than one request deadline; subsequent calls share readiness work.
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Scanner did not report ready within 90 seconds (unavailable: ${unavailableTools}). Inspect .local/dev/scanner.log; missing pinned images can be checked with pnpm dev:prepare.`);
}

async function start() {
  await ensurePrivateDirectory();
  const previous = await readState();
  previous.processes = await pruneDeadRecords(previous.processes);
  if (previous.processes.length > 0) {
    const names = previous.processes.map(record => record.name).join(', ');
    throw new Error(`Recorded development services are still active or cannot be safely inspected (${names}). Run pnpm dev:stop first.`);
  }

  assertDockerAvailable();
  const rawConfig = await ensureInfraEnvironment();
  const infra = localConfig(rawConfig);
  const ports = runtimePorts(infra);
  for (const port of Object.values(ports)) await probePort(port);
  await ensureScannerSecret();

  const state = {
    version: 1,
    status: 'starting',
    webPort: ports.web,
    coordinatorPort: ports.coordinator,
    scannerPort: ports.scanner,
    processes: [],
    startedAt: new Date().toISOString(),
  };
  await writeState(state);

  try {
    await ensureBuild('@gotchu/coordinator...', '@gotchu/web...');
    const profileImages = await scannerProfiles();
    const dataImages = composeDataImages();
    const missing = [...new Set([...profileImages, ...dataImages])].filter(image => !imageIsPresent(image));
    if (missing.length > 0) {
      throw new Error(`Missing pinned Docker image${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Run pnpm dev:prepare after checking available disk space.`);
    }

    command('bash', ['scripts/infra-local-up.sh'], { env: { ...baseEnvironment, DOCKER_HOST: dockerHost, DOCKER_CONFIG: '/nonexistent' }, label: 'Local PostgreSQL and Redis setup' });
    const urls = databaseUrls(infra);
    const scannerSecretFile = join(directory, 'scanner.secret');
    const origin = `http://localhost:${ports.web}`;

    await launchService(state, 'scanner', ports.scanner, {
      GOTCHU_SCANNER_SECRET_FILE: scannerSecretFile,
      GOTCHU_SCANNER_PORT: String(ports.scanner),
      GOTCHU_SCANNER_OSV: '1',
    });
    await launchService(state, 'coordinator', ports.coordinator, {
      PORT: String(ports.coordinator),
      GOTCHU_COORDINATOR_HOST: '127.0.0.1',
      GOTCHU_ORGANIZATION_IDS: '',
      GOTCHU_CUSTOMER_DISCOVERY: 'true',
      GOTCHU_MONITORING_ENABLED: 'true',
      GOTCHU_MONITORING_OSV: 'true',
      ...(process.env.GOTCHU_MONITORING_CONFIG_FILE ? { GOTCHU_MONITORING_CONFIG_FILE: process.env.GOTCHU_MONITORING_CONFIG_FILE } : {}),
      GOTCHU_COORDINATOR_DATABASE_URL: urls.coordinator,
      GOTCHU_REDIS_URL: redisUrl(infra),
      GOTCHU_SCANNER_ORIGIN: `http://127.0.0.1:${ports.scanner}`,
      GOTCHU_SCANNER_SECRET_FILE: scannerSecretFile,
    });
    await launchService(state, 'web', ports.web, {
      PORT: String(ports.web),
      NITRO_PORT: String(ports.web),
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PUBLIC_APP_URL: origin,
      AUTH_SECRET: infra.authSecret,
      GOTCHU_API_DATABASE_URL: urls.api,
      GOTCHU_INGEST_DATABASE_URL: urls.ingest,
      GOTCHU_LOCAL_AUTH_ENABLED: 'true',
      ...(process.env.GOTCHU_MONITORING_CONFIG_FILE ? { GOTCHU_MONITORING_CONFIG_FILE: process.env.GOTCHU_MONITORING_CONFIG_FILE } : {}),
      GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true',
      GOTCHU_EVENT_CREDENTIAL_DIRECTORY: join(directory, 'event-credentials'),
    });

    await waitForScanner(ports.scanner);
    await waitForHttpReady('Coordinator', `http://127.0.0.1:${ports.coordinator}/health/ready`, body => {
      const value = responseObject(body);
      return value?.status === 'ready' && value.customerDiscovery === true && value.customerScannerConfigured === true;
    });
    await waitForHttpReady('Web service', `http://127.0.0.1:${ports.web}/api/ready`, body => {
      const value = responseObject(body);
      const dependencies = responseObject(value?.dependencies);
      return value?.status === 'ready' && dependencies?.apiDatabase === true
        && dependencies?.intakeDatabase === true && dependencies?.signIn === true;
    });
    await waitForHttpReady('Customer session', `http://127.0.0.1:${ports.web}/api/customer/session`, body => {
      const value = responseObject(body);
      return value?.localAuthEnabled === true && value.registrationEnabled === true
        && Array.isArray(value.providers) && value.providers.some(provider => isRecord(provider) && provider.id === 'credentials');
    });

    const dashboard = await fetch(`http://127.0.0.1:${ports.web}/dashboard`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!dashboard.ok || !dashboard.headers.get('content-type')?.includes('text/html')) throw new Error('The actual dashboard did not render successfully; inspect .local/dev/web.log.');
    await dashboard.body?.cancel();

    state.status = 'running';
    state.readyAt = new Date().toISOString();
    state.updatedAt = state.readyAt;
    await writeState(state);
    console.log(`Gotchu development app is ready at ${origin}. Local account registration is enabled; no workspace is pre-created.`);
    console.log('Recorded process IDs, ports, and private logs: .local/dev/state.json. Stop app processes with pnpm dev:stop; data services remain running.');
  } catch (error) {
    state.status = 'failed';
    state.failedAt = new Date().toISOString();
    state.updatedAt = state.failedAt;
    const remaining = await stopRecordedProcesses(state);
    if (remaining.length === 0) {
      state.status = 'failed';
      state.failedAt = new Date().toISOString();
      await writeState(state);
      throw error;
    }
    const names = remaining.map(record => `${record.name} (PID ${record.pid})`).join(', ');
    throw new Error(`${error instanceof Error ? error.message : 'Development startup failed.'} Startup cleanup is still draining: ${names}. State and logs remain in .local/dev; retry pnpm dev:stop after reviewing them.`);
  }
}

await ensurePrivateDirectory();
if (action === 'stop') {
  const state = await readState();
  const remaining = await stopRecordedProcesses(state);
  if (remaining.length > 0) {
    const names = remaining.map(record => `${record.name} (PID ${record.pid})`).join(', ');
    throw new Error(`Recorded services are still draining after 15 seconds: ${names}. State is retained; no data services were stopped.`);
  }
  console.log('Stopped the recorded web, coordinator, and scanner processes. PostgreSQL, Redis, and their persistent volumes remain running; use scripts/infra-local-down.sh to stop data services.');
} else if (action === 'prepare') {
  await prepare();
} else {
  await start();
}
