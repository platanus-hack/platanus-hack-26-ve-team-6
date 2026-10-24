import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const postgres = `gotchu-stack-pg-${suffix}`;
const redis = `gotchu-stack-redis-${suffix}`;
const pgPassword = randomBytes(32).toString('hex');
const redisPassword = randomBytes(32).toString('hex');
const started = [];
function command(binary, args, env = process.env) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr ?? result.error?.message ?? 'unknown error'}`);
  return result.stdout.trim();
}
function cleanup() {
  for (const name of started.splice(0)) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });
try {
  command('docker', ['run', '--detach', '--rm', '--name', postgres, '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=gotchu_test_stack', 'postgres:17-alpine'], { ...process.env, POSTGRES_PASSWORD: pgPassword });
  started.push(postgres);
  command('docker', ['run', '--detach', '--rm', '--name', redis, '--memory', '256m', '--cpus', '0.5', '-p', '127.0.0.1::6379', '-e', 'REDIS_PASSWORD', 'redis:7.4-alpine', 'sh', '-ec', 'exec redis-server --appendonly no --requirepass "$REDIS_PASSWORD"'], { ...process.env, REDIS_PASSWORD: redisPassword });
  started.push(redis);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const pgReady = spawnSync('docker', ['exec', postgres, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0;
    const redisReady = spawnSync('docker', ['exec', '-e', 'REDISCLI_AUTH', redis, 'redis-cli', 'ping'], { env: { ...process.env, REDISCLI_AUTH: redisPassword }, stdio: 'ignore' }).status === 0;
    if (pgReady && redisReady) { ready = true; break; }
    await setTimeout(250);
  }
  if (!ready) throw new Error('Isolated test data services did not become ready');
  const pgPort = command('docker', ['port', postgres, '5432/tcp']).split(':').at(-1);
  const redisPort = command('docker', ['port', redis, '6379/tcp']).split(':').at(-1);
  if (!pgPort || !redisPort || !/^\d+$/.test(pgPort) || !/^\d+$/.test(redisPort)) throw new Error('Invalid Docker loopback mapping');
  console.log(`Live pipeline checks: Postgres on 127.0.0.1:${pgPort}, Redis on 127.0.0.1:${redisPort}; credentials remain private.`);
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      GOTCHU_TEST_DATABASE_URL: `postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/gotchu_test_stack`,
      GOTCHU_TEST_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${redisPort}/0`,
    },
  });
  process.exitCode = result.status ?? 1;
} finally { cleanup(); }
