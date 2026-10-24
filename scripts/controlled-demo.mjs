import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = `${root}.local/demo`;
const stateFile = `${directory}/state.json`;
const action = process.argv[2];
if (action !== 'start' && action !== 'stop') throw new Error('Usage: node scripts/controlled-demo.mjs start|stop');
await mkdir(directory, { recursive: true, mode: 0o700 });

async function startTime(pid) {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.split(' ')[19] ?? null; }
  catch { return null; }
}
async function savedState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { processes: [] }; throw error; }
}
async function stopProcesses(state) {
  for (const record of state.processes) {
    if (record.startTime && await startTime(record.pid) === record.startTime) process.kill(record.pid, 'SIGTERM');
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const alive = await Promise.all(state.processes.map(async (record) => record.startTime && await startTime(record.pid) === record.startTime));
    if (!alive.some(Boolean)) break;
    await delay(100);
  }
  const remaining = await Promise.all(state.processes.map(async (record) => record.startTime && await startTime(record.pid) === record.startTime));
  if (remaining.some(Boolean)) throw new Error('A recorded process is still draining; inspect .local/demo logs before restarting.');
}
const previous = await savedState();
if (action === 'stop') {
  await stopProcesses(previous);
  await writeFile(stateFile, JSON.stringify({ ...previous, processes: [], stoppedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log('Stopped the recorded demo web/coordinator processes. Data volumes are retained; scripts/infra-local-down.sh also stops the data services.');
} else {
  for (const record of previous.processes) if (record.startTime && await startTime(record.pid) === record.startTime) throw new Error('The demo is already running. Use pnpm demo:stop first.');
  function run(binary, args, env = process.env) {
    const result = spawnSync(binary, args, { cwd: root, env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${binary} failed; demo startup stopped.`);
  }
  try { await readFile(`${root}infra/.env`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; run('bash', ['scripts/infra-local-setup.sh']); }
  const config = Object.fromEntries((await readFile(`${root}infra/.env`, 'utf8')).split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  function required(name) { if (!config[name]) throw new Error(`Missing ${name} in infra/.env`); return config[name]; }
  function port(value) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Invalid local port'); return parsed; }
  const webPort = port(process.env.GOTCHU_DEMO_WEB_PORT ?? config.WEB_HOST_PORT ?? 3000);
  const coordinatorPort = port(process.env.GOTCHU_DEMO_COORDINATOR_PORT ?? config.COORDINATOR_HOST_PORT ?? 3003);
  for (const selectedPort of [webPort, coordinatorPort, 4100]) {
    const probe = createServer(); probe.listen(selectedPort, '127.0.0.1'); await once(probe, 'listening'); await new Promise((resolve) => probe.close(resolve));
  }
  run('pnpm', ['--filter', '@gotchu/coordinator...', '--filter', '@gotchu/web...', '--sort', 'build']);
  run('bash', ['scripts/infra-local-up.sh']);
  function postgres(username, password) {
    const url = new URL(`postgresql://127.0.0.1:${port(required('POSTGRES_HOST_PORT'))}/${encodeURIComponent(required('POSTGRES_DB'))}`);
    url.username = username; url.password = password; return url.toString();
  }
  run(process.execPath, ['scripts/assessment-demo-seed.mjs'], { ...process.env, GOTCHU_MIGRATION_DATABASE_URL: postgres(required('POSTGRES_USER'), required('POSTGRES_PASSWORD')) });
  const origin = `http://127.0.0.1:${webPort}`;
  const state = { origin, webPort, coordinatorPort, targetPort: 4100, processes: [], startedAt: new Date().toISOString() };
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production', GOTCHU_DEMO_ENABLED: 'true' };
  async function start(name, entry, env) {
    const log = await open(`${directory}/${name}.log`, 'a', 0o600);
    const child = spawn(process.execPath, [entry], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...base, ...env } });
    await once(child, 'spawn'); child.unref(); await log.close();
    if (!child.pid) throw new Error(`${name} failed to start`);
    const birth = await startTime(child.pid);
    if (!birth) throw new Error(`${name} exited during startup`);
    state.processes.push({ name, pid: child.pid, startTime: birth });
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  try {
    await start('coordinator', 'apps/coordinator/dist/main.js', {
      PORT: String(coordinatorPort), GOTCHU_COORDINATOR_HOST: '127.0.0.1',
      GOTCHU_ORGANIZATION_IDS: 'd3e00000-0000-4000-8000-000000000001',
      GOTCHU_COORDINATOR_DATABASE_URL: postgres(required('GOTCHU_COORDINATOR_DB_USERNAME'), required('GOTCHU_COORDINATOR_DB_PASSWORD')),
      GOTCHU_REDIS_URL: `redis://:${encodeURIComponent(required('REDIS_PASSWORD'))}@127.0.0.1:${port(required('REDIS_HOST_PORT'))}`,
    });
    await start('web', 'apps/web/.output/server/index.mjs', {
      PORT: String(webPort), NITRO_PORT: String(webPort), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PUBLIC_APP_URL: origin,
      GOTCHU_API_DATABASE_URL: postgres(required('GOTCHU_API_DB_USERNAME'), required('GOTCHU_API_DB_PASSWORD')),
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [web, coordinator] = await Promise.all([fetch(`${origin}/api/demo/workspace`, { signal: AbortSignal.timeout(1000) }), fetch(`http://127.0.0.1:${coordinatorPort}/health/ready`, { signal: AbortSignal.timeout(1000) })]);
        if (web.ok && coordinator.ok && (await web.json()).targetConfigured === true) { ready = true; break; }
      } catch { /* Processes may still be binding their loopback ports. */ }
      await delay(100);
    }
    if (!ready) throw new Error('Demo readiness failed. Inspect .local/demo/web.log and coordinator.log.');
    console.log(`Controlled demo ready: ${origin}/dashboard\nRecorded PIDs/ports: .local/demo/state.json. Stop with pnpm demo:stop.`);
  } catch (error) { await stopProcesses(state); throw error; }
}
