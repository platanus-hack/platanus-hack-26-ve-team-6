import { randomUUID } from 'node:crypto';
import { jobEnvelopeSchema, type JobEnvelope } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { z } from 'zod';
import { BackendError, parse, type BaseDependencies } from './core.js';

/** Trusted coordinator helper; call in the SAME transaction as the business effect. */
export async function enqueue(tx: Transaction, input: Omit<JobEnvelope, 'version'> & { idempotencyKey: string; payload?: unknown }): Promise<string> {
  const envelope = parse(jobEnvelopeSchema, { version: 1, id: input.id, organizationId: input.organizationId, applicationId: input.applicationId, kind: input.kind });
  const inserted = await tx.query<{ id: string }>(`INSERT INTO gotchu.jobs(organization_id, application_id, id, kind, idempotency_key, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (organization_id,application_id,kind,idempotency_key) DO NOTHING RETURNING id`, [input.organizationId, input.applicationId, input.id, input.kind, input.idempotencyKey, JSON.stringify(input.payload ?? {})]);
  if (!inserted.rowCount) {
    const prior = await tx.query<{ id: string }>('SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind=$3 AND idempotency_key=$4', [input.organizationId, input.applicationId, input.kind, input.idempotencyKey]);
    const row = prior.rows[0];
    if (!row) throw new BackendError('job_conflict', 'Idempotent job disappeared during enqueue', 409);
    return row.id;
  }
  await tx.query('INSERT INTO gotchu.outbox(organization_id,id,job_id,envelope) VALUES ($1,$2,$3,$4::jsonb)', [input.organizationId, randomUUID(), input.id, JSON.stringify(envelope)]);
  return input.id;
}
const leaseMsSchema = z.number().int().min(1_000).max(300_000).default(30_000);
const claimSchema = z.object({ organizationId: z.uuid(), jobId: z.uuid(), leaseMs: leaseMsSchema }).strict();
const tokenSchema = z.object({ organizationId: z.uuid(), jobId: z.uuid(), leaseToken: z.uuid() }).strict();
export interface JobClaim { envelope: JobEnvelope; payload: unknown; leaseToken: string; leaseUntil: Date; attempts: number }
export interface OutboxClaim { id: string; envelope: JobEnvelope; leaseToken: string; leaseUntil: Date; attempts: number }

export function createOutboxService(deps: BaseDependencies) {
  return {
    async claim(input: { organizationId: string; limit?: number; leaseMs?: number }): Promise<OutboxClaim[]> {
      const value = parse(z.object({ organizationId: z.uuid(), limit: z.number().int().min(1).max(100).default(20), leaseMs: leaseMsSchema }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ id: string; envelope: unknown; lease_token: string; lease_until: Date; attempts: number }>(`WITH next AS (
          SELECT id FROM gotchu.outbox WHERE organization_id=$1 AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
        ) UPDATE gotchu.outbox o SET lease_token=gen_random_uuid(), lease_until=clock_timestamp()+$3*interval '1 millisecond', attempts=o.attempts+1
          FROM next WHERE o.organization_id=$1 AND o.id=next.id RETURNING o.id,o.envelope,o.lease_token,o.lease_until,o.attempts`, [value.organizationId, value.limit, value.leaseMs]);
        return result.rows.map(row => ({ id: row.id, envelope: parse(jobEnvelopeSchema, row.envelope), leaseToken: row.lease_token, leaseUntil: row.lease_until, attempts: row.attempts }));
      });
    },
    async delivered(input: { organizationId: string; id: string; leaseToken: string }): Promise<void> {
      const value = parse(z.object({ organizationId: z.uuid(), id: z.uuid(), leaseToken: z.uuid() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query('UPDATE gotchu.outbox SET delivered_at=clock_timestamp(),lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND delivered_at IS NULL', [value.organizationId, value.id, value.leaseToken]);
        if (result.rowCount !== 1) throw new BackendError('stale_lease', 'Outbox claim expired or has already been acknowledged', 409);
      });
    },
  };
}
export async function completeJob(tx: Transaction, input: { organizationId: string; jobId: string; leaseToken: string; result?: unknown }): Promise<void> {
  const result = await tx.query("UPDATE gotchu.jobs SET state='succeeded', result=$4::jsonb, completed_at=clock_timestamp(),lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp()", [input.organizationId, input.jobId, input.leaseToken, JSON.stringify(input.result ?? {})]);
  if (result.rowCount !== 1) throw new BackendError('stale_lease', 'Job claim expired or is no longer current', 409);
}
export function createJobService(deps: BaseDependencies) {
  return {
    async claim(input: { organizationId: string; jobId: string; leaseMs?: number }): Promise<JobClaim | null> {
      const value = parse(claimSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ id: string; application_id: string; kind: JobEnvelope['kind']; payload: unknown; lease_token: string; lease_until: Date; attempts: number }>(`UPDATE gotchu.jobs SET state='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+$3*interval '1 millisecond',attempts=attempts+1
          WHERE organization_id=$1 AND id=$2 AND (state='queued' OR (state='running' AND lease_until<=clock_timestamp()))
          RETURNING id,application_id,kind,payload,lease_token,lease_until,attempts`, [value.organizationId, value.jobId, value.leaseMs]);
        const row = result.rows[0];
        return row ? { envelope: { version: 1, id: row.id, organizationId: value.organizationId, applicationId: row.application_id, kind: row.kind }, payload: row.payload, leaseToken: row.lease_token, leaseUntil: row.lease_until, attempts: row.attempts } : null;
      });
    },
    async complete(input: { organizationId: string; jobId: string; leaseToken: string; result?: unknown }): Promise<void> {
      const { result, ...scope } = input;
      const value = parse(tokenSchema, scope);
      await deps.database.tenant(value.organizationId, tx => completeJob(tx, { ...value, result }));
    },
    async heartbeat(input: { organizationId: string; jobId: string; leaseToken: string; leaseMs?: number }): Promise<void> {
      const value = parse(tokenSchema.extend({ leaseMs: leaseMsSchema }), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query("UPDATE gotchu.jobs SET lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp()", [value.organizationId, value.jobId, value.leaseToken, value.leaseMs]);
        if (result.rowCount !== 1) throw new BackendError('stale_lease', 'Job claim expired or is no longer current', 409);
      });
    },
  };
}
