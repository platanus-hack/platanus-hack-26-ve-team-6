import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// PostgreSQL 17.11, pinned to its OCI manifest digest for repeatable live tests.
const postgresImage = 'postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb';
const redisImage = 'redis:7.4.11-bookworm@sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b';
const suffix = randomBytes(6).toString('hex');
const name = `gotchu-executor-test-${suffix}`;
const redisName = `gotchu-executor-redis-test-${suffix}`;
const password = randomBytes(32).toString('hex');
const redisPassword = randomBytes(32).toString('hex');
const started = new Set();
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr ?? result.error?.message ?? 'unknown error'}`);
  return result.stdout.trim();
}
function cleanup() {
  for (const container of started) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  started.clear();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(130); });
try {
  command('docker', ['run', '--detach', '--rm', '--name', name, '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=gotchu_test_executor', postgresImage], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  started.add(name);
  command('docker', ['run', '--detach', '--rm', '--name', redisName, '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/data:rw', '-p', '127.0.0.1::6379', redisImage, 'redis-server', '--save', '', '--appendonly', 'no', '--requirepass', redisPassword]);
  started.add(redisName);
  const address = command('docker', ['port', name, '5432/tcp']);
  const port = address.split(':').at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error('Docker did not return a local Postgres port');
  const redisAddress = command('docker', ['port', redisName, '6379/tcp']);
  const redisPort = redisAddress.split(':').at(-1);
  if (!redisPort || !/^\d+$/.test(redisPort)) throw new Error('Docker did not return a local Redis port');
  let ready = false;
  let redisReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) ready = true;
    if (spawnSync('docker', ['exec', '-e', `REDISCLI_AUTH=${redisPassword}`, redisName, 'redis-cli', 'ping'], { stdio: 'ignore' }).status === 0) redisReady = true;
    await setTimeout(250);
    if (ready && redisReady) break;
  }
  if (!ready || !redisReady) throw new Error('Isolated Postgres and Redis did not become ready');
  process.stdout.write(`Testing against isolated PostgreSQL 17.11 and Redis 7.4.11 on loopback ports ${port}/${redisPort}. No existing volumes are used.\n`);
  // These suites share the global recovery singleton in the disposable database.
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@gotchu/executor', 'test', '--no-file-parallelism'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, GOTCHU_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/gotchu_test_executor`, GOTCHU_TEST_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${redisPort}` },
  });
  process.exitCode = result.status ?? 1;
} finally { cleanup(); }
