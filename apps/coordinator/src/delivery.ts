import type { Queue } from 'bullmq';
import { jobEnvelopeSchema, type JobEnvelope } from '@gotchu/contracts';
import type { Database } from '@gotchu/database';

/** A restored Postgres intent may outlive, or predate, the corresponding Redis record. */
export async function ensureQueueDelivery(queue: Queue<JobEnvelope>, envelope: JobEnvelope) {
  const prior = await queue.getJob(envelope.id);
  if (prior) {
    const state = await prior.getState();
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return;
    // A locked active delivery cannot be removed; BullMQ rejects that race.
    await prior.remove();
  }
  await queue.add(envelope.kind, envelope, {
    jobId: envelope.id, attempts: 5, backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 604800, count: 1000 },
  });
}

export async function reconcileDurableDeliveries(database: Database, organizationId: string, publish: (envelope: JobEnvelope) => Promise<void>) {
  const eligible = await database.tenant(organizationId, async (tx) => {
    const rows = await tx.query<{ id: string; application_id: string; kind: string; reserved_micros: string | null }>(`SELECT j.id,j.application_id,j.kind,r.reserved_micros
      FROM gotchu.jobs j LEFT JOIN gotchu.agent_runs r ON r.organization_id=j.organization_id AND r.job_id=j.id
      WHERE j.organization_id=$1 AND (j.state='queued' OR (j.state='running' AND j.lease_until<=clock_timestamp()))
      ORDER BY j.created_at,j.id LIMIT 100 FOR UPDATE OF j SKIP LOCKED`, [organizationId]);
    const envelopes: JobEnvelope[] = [];
    for (const row of rows.rows) {
      if (row.kind === 'investigation' && row.reserved_micros !== null && BigInt(row.reserved_micros) > 0n) {
        await tx.query(`UPDATE gotchu.jobs SET state='failed',result='{"reasonCode":"investigation_reconciliation_required"}'::jsonb,completed_at=clock_timestamp(),lease_until=NULL
          WHERE organization_id=$1 AND id=$2 AND (state='queued' OR (state='running' AND lease_until<=clock_timestamp()))`, [organizationId, row.id]);
        continue;
      }
      envelopes.push(jobEnvelopeSchema.parse({ version: 1, id: row.id, organizationId, applicationId: row.application_id, kind: row.kind }));
    }
    return envelopes;
  });
  for (const envelope of eligible) await publish(envelope);
  return eligible.length;
}
