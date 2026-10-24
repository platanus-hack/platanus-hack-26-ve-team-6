import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { jobEnvelopeSchema, type JobEnvelope } from '@gotchu/contracts';
import { ensureQueueDelivery } from './delivery.js';
import { processDurableJob, type CoordinatorDependencies } from './jobs.js';

/** Owns all delivery lanes and their Redis clients; the caller owns the database. */
export function createCoordinatorTransport(options: {
  redisUrl: string;
  organizationIds: readonly string[];
  dependencies: CoordinatorDependencies;
  report: (event: string, error: unknown) => void;
  prefix?: string;
}) {
  if (!['redis:', 'rediss:'].includes(new URL(options.redisUrl).protocol)) throw new Error('Invalid Redis connection protocol');
  const allowedOrganizations = new Set(options.organizationIds);
  const connections: Redis[] = [];
  function connect(event: string) {
    const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', (error) => options.report(event, error));
    connections.push(connection);
    return connection;
  }
  const prefix = options.prefix ?? 'bull';
  const queueConnection = connect('coordinator_redis_error');
  const queues = {
    deterministic: new Queue<JobEnvelope>('gotchu-deterministic-v1', { connection: queueConnection, prefix }),
    investigation: new Queue<JobEnvelope>('gotchu-investigations-v1', { connection: queueConnection, prefix }),
    assessment: new Queue<JobEnvelope>('gotchu-assessments-v1', { connection: queueConnection, prefix }),
  };
  for (const queue of Object.values(queues)) queue.on('error', (error) => options.report('coordinator_queue_error', error));
  function queueFor(kind: JobEnvelope['kind']) {
    // Other kinds retain the domain's explicit adapter-not-configured failure.
    if (kind === 'investigation') return queues.investigation;
    return kind === 'audit' ? queues.assessment : queues.deterministic;
  }
  function consume(queue: Queue<JobEnvelope>, concurrency: number) {
    const worker = new Worker<unknown>(queue.name, async (job) => {
      const envelope = jobEnvelopeSchema.parse(job.data);
      if (!allowedOrganizations.has(envelope.organizationId)) throw new Error('Job organization is not assigned to this coordinator');
      if (queueFor(envelope.kind) !== queue) throw new Error('Job kind does not belong to this transport lane');
      return processDurableJob(options.dependencies, envelope);
    }, { connection: connect('coordinator_redis_worker_error'), prefix, concurrency, lockDuration: 300_000 });
    worker.on('error', (error) => options.report('coordinator_worker_error', error));
    worker.on('failed', (_job, error) => options.report('coordinator_job_failed', error));
    return worker;
  }
  const workers = [consume(queues.deterministic, 1), consume(queues.investigation, 2), consume(queues.assessment, 1)];
  let closing: Promise<void> | undefined;
  async function close() {
    // Workers drain active jobs and close BullMQ's internally duplicated blocking clients.
    const workersClosed = await Promise.allSettled(workers.map((worker) => worker.close()));
    const queuesClosed = await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
    // Supplied clients are ours, not BullMQ's. No commands remain after the drain.
    for (const connection of connections) connection.disconnect();
    const errors = [...workersClosed, ...queuesClosed].flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'Coordinator transport shutdown failed');
  }
  return {
    queues,
    setOrganizationIds(ids: readonly string[]) {
      if (ids.length > 500) throw new Error('Coordinator organization batch exceeds its bound');
      const checked = ids.map(id => jobEnvelopeSchema.shape.organizationId.parse(id));
      allowedOrganizations.clear();
      for (const id of checked) allowedOrganizations.add(id);
    },
    // Outbox publication and Postgres reconciliation must use this same route.
    publish: (envelope: JobEnvelope) => ensureQueueDelivery(queueFor(envelope.kind), envelope),
    waitUntilReady: async () => { await Promise.all([...Object.values(queues).map((queue) => queue.waitUntilReady()), ...workers.map((worker) => worker.waitUntilReady())]); },
    checkHealth: async () => { await Promise.all(connections.map((connection) => connection.ping())); },
    close: () => closing ??= close(),
  };
}
