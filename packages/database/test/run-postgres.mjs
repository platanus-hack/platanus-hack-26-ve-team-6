import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// PostgreSQL 17.11, pinned to its OCI manifest digest for repeatable live tests.
const postgresImage = 'postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb';
const name = `gotchu-backend-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(32).toString('hex');
let started = false;
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr ?? result.error?.message ?? 'unknown error'}`);
  return result.stdout.trim();
}
function cleanup() {
  if (started) {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    started = false;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(130); });
try {
  command('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@gotchu/contracts', '--filter', '@gotchu/database', '--filter', '@gotchu/backend', '--filter', '@gotchu/web...', '--sort', 'build']);
  command('docker', ['run', '--detach', '--rm', '--name', name, '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=gotchu_test_backend', postgresImage], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  started = true;
  const address = command('docker', ['port', name, '5432/tcp']);
  const port = address.split(':').at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error('Docker did not return a local Postgres port');
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await setTimeout(250);
  }
  if (!ready) throw new Error('Isolated Postgres did not become ready');
  process.stdout.write(`Testing against isolated PostgreSQL 17.11 on loopback port ${port}. No existing volumes are used.\n`);
  const result = spawnSync('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@gotchu/database', '--filter', '@gotchu/backend', 'test'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, GOTCHU_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/gotchu_test_backend` },
  });
  process.exitCode = result.status ?? 1;
  const webResult = spawnSync('pnpm', ['--config.verify-deps-before-run=false', '--filter', '@gotchu/web', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'test/self-host-setup-postgres.test.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, GOTCHU_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/gotchu_test_backend` },
  });
  if (webResult.status !== 0) process.exitCode = webResult.status ?? 1;
} finally { cleanup(); }
