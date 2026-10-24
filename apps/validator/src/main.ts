import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createDatabase } from '@gotchu/database';
import { checkRunnerGate } from '@gotchu/runner';
import { loadValidatorKey } from './keys.js';
import { createValidationWorker } from './validator.js';

const portSchema = z.coerce.number().int().min(1024).max(65535).default(4410);

export async function main() {
  const connectionString = z.string().url().parse(process.env.GOTCHU_VALIDATOR_DATABASE_URL);
  const port = portSchema.parse(process.env.GOTCHU_VALIDATOR_PORT ?? 4410);
  const database = createDatabase({ connectionString, role: 'gotchu_validator', max: 2 });
  const key = await loadValidatorKey();
  await database.tenant('00000000-0000-0000-0000-000000000000', async tx => {
    await tx.query('INSERT INTO gotchu.validation_keys(id,public_key) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [key.keyId, key.publicKey]);
    const stored = await tx.query<{ public_key: string }>('SELECT public_key FROM gotchu.validation_keys WHERE id=$1', [key.keyId]);
    if (stored.rows[0]?.public_key !== key.publicKey) throw new Error('validator_public_key_conflict');
  });
  const shutdown = new AbortController();
  const worker = createValidationWorker({ database, key, concurrency: 1, shutdownSignal: shutdown.signal, runnerGate: async () => {
    if (process.env.GOTCHU_VALIDATOR_FORCE_GATE_CLOSED === '1') return { status: 'closed', reason: 'Runner gate closed by validator configuration.' };
    return checkRunnerGate();
  } });
  let stopping = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || (request.url !== '/healthz' && request.url !== '/readyz')) {
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' }).end('{"error":"not_found"}'); return;
    }
    const databaseReady = !stopping && await database.checkHealth().then(() => true, () => false);
    const gate = request.url === '/readyz' && databaseReady
      ? process.env.GOTCHU_VALIDATOR_FORCE_GATE_CLOSED === '1' ? { status: 'closed', reason: 'Runner gate closed by validator configuration.' } : await checkRunnerGate()
      : null;
    const ready = databaseReady && (gate === null || gate.status === 'open');
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }).end(JSON.stringify({ ready, ...(gate?.status === 'closed' ? { reason: 'runner_gate_closed' } : {}) }));
  });
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const loop = async () => {
    while (!shutdown.signal.aborted) {
      try {
        const claim = await worker.claim();
        if (claim) await worker.processClaim(claim);
        else await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        process.emitWarning(`Validator worker iteration failed: ${error instanceof Error ? error.name : 'unknown'}`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
  };
  const workerLoop = loop();
  const stop = () => {
    if (stopping) return;
    stopping = true; shutdown.abort();
    server.close();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await new Promise<void>(resolve => server.once('close', resolve));
  await workerLoop;
  await database.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.emitWarning(`Validator startup failed: ${error instanceof Error ? error.name : 'unknown'}`); process.exitCode = 1; });
}
