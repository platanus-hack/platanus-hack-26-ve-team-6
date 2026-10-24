import type { Backend } from '@gotchu/backend';
import { jobEnvelopeSchema } from '@gotchu/contracts';
import type { Database } from '@gotchu/database';
import { z } from 'zod';
import { createActionExecutor, type ActionExecutionLedger, type ActionProvider } from './action-execution.js';

const executionPayloadSchema = z.object({
  approvalId: z.uuid(), expectedActionHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedResourceVersion: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict();

/** Handles one Redis delivery while using Postgres as the durable lease and source of truth. */
export function createExecutionJobProcessor(options: {
  database: Database;
  backend: Pick<Backend, 'jobs' | 'executionArtifacts'>;
  ledger: ActionExecutionLedger;
  provider: ActionProvider;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
}) {
  const leaseMs = options.leaseMs ?? 300_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;

  return async (job: { data: unknown }) => {
    const envelope = jobEnvelopeSchema.parse(job.data);
    if (envelope.kind !== 'execution') throw new Error('executor_queue_kind_mismatch');
    const durable = await options.database.tenant(envelope.organizationId, tx => tx.query<{
      application_id: string; kind: string; payload: unknown; state: string;
    }>('SELECT application_id,kind,payload,state FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [envelope.organizationId,envelope.id]));
    const row = durable.rows[0];
    if (!row || row.application_id !== envelope.applicationId || row.kind !== 'execution') throw new Error('executor_job_scope_mismatch');
    if (row.state === 'succeeded' || row.state === 'failed') return { status: 'already_terminal' };
    const payload = executionPayloadSchema.parse(row.payload);
    const durableClaim = await options.backend.jobs.claim({ organizationId:envelope.organizationId,jobId:envelope.id,leaseMs });
    if (!durableClaim) return { status:'already_claimed' };

    let heartbeatError: unknown;
    const heartbeat = async () => {
      try {
        await options.backend.jobs.heartbeat({ organizationId:envelope.organizationId,jobId:envelope.id,leaseToken:durableClaim.leaseToken,leaseMs });
      } catch (error) { heartbeatError = error; }
    };
    const heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatIntervalMs);
    heartbeatTimer.unref();
    try {
      const executor = createActionExecutor({
        ledger: {
          ...options.ledger,
          async assertWritable(input) {
            if (heartbeatError) throw heartbeatError;
            await heartbeat();
            if (heartbeatError) throw heartbeatError;
            await options.ledger.assertWritable(input);
          },
        },
        provider:options.provider,
        loadArtifact: input => options.backend.executionArtifacts.readForExecutor(input),
      });
      const result = await executor.execute({ organizationId:envelope.organizationId,applicationId:envelope.applicationId,approvalId:payload.approvalId,
        expectedActionHash:payload.expectedActionHash,expectedResourceVersion:payload.expectedResourceVersion });
      if (heartbeatError) throw heartbeatError;
      if (result.status === 'verified') {
        await options.backend.jobs.complete({ organizationId:envelope.organizationId,jobId:envelope.id,leaseToken:durableClaim.leaseToken,result:{status:'verified',providerReference:result.providerReference} });
      } else if (result.status === 'failed' || result.status === 'rejected') {
        await options.backend.jobs.fail({ organizationId:envelope.organizationId,jobId:envelope.id,leaseToken:durableClaim.leaseToken,reasonCode:result.reasonCode });
      }
      // Unknown outcomes keep their durable lease until expiry, then reconciliation redelivers them.
      return { status:result.status,reasonCode:result.reasonCode };
    } finally { clearInterval(heartbeatTimer); }
  };
}
