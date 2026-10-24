import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { createBackend } from '@gotchu/backend';
import { createDatabase } from '@gotchu/database';
import { jobEnvelopeSchema, type JobEnvelope } from '@gotchu/contracts';
import { dispatchOutbox, processDurableJob } from './jobs.js';
import { createHttpInvestigator } from './investigator.js';
import { ensureQueueDelivery, reconcileDurableDeliveries } from './delivery.js';

function report(event: string, error?: unknown) {
  console.error(JSON.stringify({ event, type: error instanceof Error ? error.name : 'unknown', ...(error instanceof z.ZodError ? { fields: error.issues.map((issue) => issue.path.join('.')) } : {}) }));
}

async function main() {
  const config = z.object({
    databaseUrl: z.url(), redisUrl: z.url(),
    organizationIds: z.array(z.uuid().transform((id) => id.toLowerCase())).max(5),
    port: z.coerce.number().int().min(1).max(65535),
    nodeEnv: z.enum(['production', 'development', 'test']),
  }).parse({
    databaseUrl: process.env.GOTCHU_COORDINATOR_DATABASE_URL,
    redisUrl: process.env.GOTCHU_REDIS_URL,
    organizationIds: process.env.GOTCHU_ORGANIZATION_IDS?.split(',').filter(Boolean) ?? [],
    port: process.env.PORT ?? 3003,
    nodeEnv: process.env.NODE_ENV ?? 'production',
  });
  if (!['redis:', 'rediss:'].includes(new URL(config.redisUrl).protocol)) throw new Error('Invalid Redis connection protocol');
  const database = createDatabase({ connectionString: config.databaseUrl, role: 'gotchu_coordinator', max: 5 });
  const backend = createBackend({ database });
  const workerUrl = process.env.GOTCHU_WORKER_URL;
  const privateKeyPem = process.env.GOTCHU_RUN_CAPABILITY_PRIVATE_KEY;
  if (Boolean(workerUrl) !== Boolean(privateKeyPem)) throw new Error('Worker URL and capability signing key must be configured together');
  const investigator = workerUrl && privateKeyPem ? await createHttpInvestigator({ workerUrl, privateKeyPem, allowLoopbackHttp: config.nodeEnv !== 'production' }) : undefined;
  const dependencies = { database, backend, ...(investigator ? { investigator } : {}) };
  const allowedOrganizations = new Set(config.organizationIds);
  const queueConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  queueConnection.on('error', (error) => report('coordinator_redis_error', error));
  workerConnection.on('error', (error) => report('coordinator_redis_worker_error', error));
  const queue = new Queue<JobEnvelope>('gotchu-jobs-v1', { connection: queueConnection });
  const worker = new Worker('gotchu-jobs-v1', async (job) => {
    const envelope = jobEnvelopeSchema.parse(job.data);
    if (!allowedOrganizations.has(envelope.organizationId)) throw new Error('Job organization is not assigned to this coordinator');
    return processDurableJob(dependencies, envelope);
  }, { connection: workerConnection, concurrency: 2, lockDuration: 300_000 });
  worker.on('error', (error) => report('coordinator_worker_error', error));
  worker.on('failed', (_job, error) => report('coordinator_job_failed', error));
  const stop = new AbortController();
  const loop = (async () => {
    let lastReconciliation = 0;
    while (!stop.signal.aborted) {
      try {
        for (const organizationId of config.organizationIds) await dispatchOutbox(backend, organizationId, async (envelope) => {
          await ensureQueueDelivery(queue, envelope);
        });
        if (Date.now() - lastReconciliation >= 10_000) {
          for (const organizationId of config.organizationIds) await reconcileDurableDeliveries(database, organizationId, (envelope) => ensureQueueDelivery(queue, envelope));
          lastReconciliation = Date.now();
        }
      } catch (error) { report('coordinator_dispatch_delayed', error); }
      try { await delay(500, undefined, { signal: stop.signal }); }
      catch (error) { if (!stop.signal.aborted) throw error; }
    }
  })();
  const server = createServer((request, response) => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"alive"}'); return;
    }
    if (request.url !== '/health/ready') { response.writeHead(404); response.end(); return; }
    void Promise.all([database.checkHealth(), queueConnection.ping()]).then(() => {
      const ready = allowedOrganizations.size > 0;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'unassigned', assignedOrganizations: allowedOrganizations.size, investigatorConfigured: Boolean(investigator) }));
    }).catch((error: unknown) => {
      report('coordinator_not_ready', error); response.writeHead(503); response.end('{"status":"unavailable"}');
    });
  });
  server.listen(config.port, process.env.GOTCHU_COORDINATOR_HOST ?? '127.0.0.1');
  const shutdown = async () => {
    stop.abort();
    await loop;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await worker.close();
    await queue.close();
    await Promise.all([queueConnection.quit(), workerConnection.quit()]);
    await database.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().catch((error: unknown) => { report('coordinator_shutdown_failed', error); process.exitCode = 1; }); });
  loop.catch((error: unknown) => { report('coordinator_loop_failed', error); process.exitCode = 1; });
  console.log(JSON.stringify({ event: 'coordinator_started', port: config.port, assignedOrganizations: allowedOrganizations.size }));
}

main().catch((error: unknown) => { report('coordinator_start_failed', error); process.exitCode = 1; });
