import { randomUUID } from 'node:crypto';
import { aggregateAuthFailures, investigationResultSchema, safeCheckpointSchema, type AuthFailureEvent, type InvestigationResult } from '@gotchu/agent';
import { BackendError, completeJob, createRunService, enqueue, type Backend, type JobClaim } from '@gotchu/backend';
import { jobEnvelopeSchema, securityEventSchema, type JobEnvelope } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { z } from 'zod';
import { runAssessment, runCustomerAssessment, type AssessmentRunner, type CustomerAssessmentRunner } from './assessment.js';
import { observeRuntime, observeAssessment, backendInTransaction } from './observations.js';
import { evaluateTriage } from './triage.js';

const WINDOW_MS = 600_000;
const MAX_WINDOW_EVENTS = 10_000;
// CASE guards the cast even when PostgreSQL reorders query predicates.
const eventTimeSql = "CASE WHEN pg_input_is_valid(payload->>'occurredAt','timestamptz') THEN (payload->>'occurredAt')::timestamptz END";
const payloadSchema = z.object({ incidentId: z.uuid(), evidenceIds: z.array(z.uuid()).min(1).max(20) }).strict();
const projectionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assessment_observation'), reportId: z.uuid() }).strict(),
  z.object({ kind: z.literal('triage_evaluation'), windowBucket: z.number().int().nonnegative() }).strict(),
]);
export interface Investigator {
  investigate(input: { organizationId: string; applicationId: string; runId: string; deadline: Date; evidenceIds: readonly string[] }): Promise<InvestigationResult>;
}
export interface CoordinatorDependencies { readonly database: Database; readonly backend: Backend; readonly investigator?: Investigator; readonly assessmentRunner?: AssessmentRunner; readonly customerAssessmentRunner?: CustomerAssessmentRunner }

async function failJob(tx: Transaction, claim: JobClaim, reason: string) {
  const result = await tx.query("UPDATE gotchu.jobs SET state='failed',result=$4::jsonb,completed_at=clock_timestamp(),lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp()", [claim.envelope.organizationId, claim.envelope.id, claim.leaseToken, JSON.stringify({ reasonCode: reason })]);
  if (result.rowCount !== 1) throw new BackendError('stale_lease', 'Job claim is no longer current', 409);
}

async function aggregate(dependencies: CoordinatorDependencies, claim: JobClaim) {
  const { organizationId, applicationId, id: jobId } = claim.envelope;
  return dependencies.database.tenant(organizationId, async (tx) => {
    const fence = await tx.query("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE", [organizationId, jobId, claim.leaseToken]);
    if (fence.rowCount !== 1) throw new BackendError('stale_lease', 'Job claim is no longer current', 409);
    // Serialize all windows for this application before reading counters.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`gotchu:aggregation:${organizationId}:${applicationId}`]);
    const invalid = await tx.query<{ quarantined: boolean }>(`SELECT EXISTS(SELECT 1 FROM gotchu.events WHERE organization_id=$1 AND application_id=$2
      AND pg_input_is_valid(payload->>'occurredAt','timestamptz') IS NOT TRUE) AS quarantined`, [organizationId, applicationId]);
    const quarantined = invalid.rows[0]?.quarantined === true;
    if (quarantined) {
      await tx.query(`INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES ($1,$2,'login_failure_detection','degraded','Incompatible event timestamps quarantined from detector windows; original events retained',clock_timestamp())
        ON CONFLICT (organization_id,application_id,capability) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at`, [organizationId, applicationId]);
    }
    const input = await tx.query<{ payload: unknown }>(`SELECT payload FROM gotchu.events WHERE organization_id=$1 AND application_id=$2 AND job_id=$3
      AND pg_input_is_valid(payload->>'occurredAt','timestamptz') IS TRUE`, [organizationId, applicationId, jobId]);
    const current = input.rows.map((row) => securityEventSchema.parse(row.payload));
    const operationalProjection = await observeRuntime(dependencies.database, tx, claim, current);
    const auth = current.filter((event) => event.type === 'auth.login_failed' || event.type === 'auth.login_succeeded');
    if (auth.length === 0) {
      await completeJob(tx, { organizationId, jobId, leaseToken: claim.leaseToken, result: { detector: 'auth.login_failures.v1', incidents: 0, quarantinedTimestamps: quarantined, operationalProjection } });
      return;
    }
    const times = auth.map((event) => Date.parse(event.occurredAt));
    const from = new Date(Math.floor(Math.min(...times) / WINDOW_MS) * WINDOW_MS);
    const until = new Date((Math.floor(Math.max(...times) / WINDOW_MS) + 1) * WINDOW_MS);
    const rows = await tx.query<{ payload: unknown }>(`SELECT payload FROM gotchu.events WHERE organization_id=$1 AND application_id=$2
      AND payload->>'type' IN ('auth.login_failed','auth.login_succeeded')
      AND ${eventTimeSql} >= $3 AND ${eventTimeSql} < $4
      ORDER BY received_at,id LIMIT $5`, [organizationId, applicationId, from, until, MAX_WINDOW_EVENTS + 1]);
    if (rows.rows.length > MAX_WINDOW_EVENTS) {
      await tx.query(`INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES ($1,$2,'login_failure_detection','degraded','Detector window exceeds the bounded processing limit',clock_timestamp())
        ON CONFLICT (organization_id,application_id,capability) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at`, [organizationId, applicationId]);
      await failJob(tx, claim, 'detector_window_limit');
      return;
    }
    const events: AuthFailureEvent[] = rows.rows.map((row) => {
      const event = securityEventSchema.parse(row.payload);
      if (event.type !== 'auth.login_failed' && event.type !== 'auth.login_succeeded') throw new Error('Stored detector input has an unsupported event type');
      return { eventId: event.id, organizationId, applicationId, type: event.type, occurredAt: event.occurredAt, outcome: event.outcome, ...(event.actor ? { actor: event.actor } : {}) };
    });
    const result = aggregateAuthFailures(events);
    let created = 0;
    for (const incident of result.incidents) {
      const evidenceIds = incident.eventIds.slice(0, 20);
      const ruleId = `auth.login_failures.v1.${incident.grouping === 'actor_account' ? 'account' : 'ip'}`;
      const summary = `${incident.failedAttempts} failed login attempts in one detector window; suspicious activity, compromise not confirmed.`;
      const inserted = await tx.query<{ id: string }>(`INSERT INTO gotchu.incidents(organization_id,application_id,id,rule_id,dedupe_key,summary,severity,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,'high',$7::jsonb) ON CONFLICT (organization_id,application_id,rule_id,dedupe_key) DO NOTHING RETURNING id`, [organizationId, applicationId, randomUUID(), ruleId, incident.incidentId, summary, JSON.stringify(evidenceIds)]);
      const fresh = inserted.rows[0];
      if (fresh) {
        created++;
        await enqueue(tx, { organizationId, applicationId, id: randomUUID(), kind: 'investigation', idempotencyKey: `incident:${fresh.id}`, payload: { incidentId: fresh.id, evidenceIds } });
      } else {
        // Preserve the original evidence references while updating the counter summary.
        await tx.query('UPDATE gotchu.incidents SET summary=$5 WHERE organization_id=$1 AND application_id=$2 AND rule_id=$3 AND dedupe_key=$4', [organizationId, applicationId, ruleId, incident.incidentId, summary]);
      }
    }
    if (!quarantined) await tx.query(`INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES ($1,$2,'login_failure_detection','active','Account and IP failure detectors v1 only; thresholds are pilot defaults',clock_timestamp())
      ON CONFLICT (organization_id,application_id,capability) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at`, [organizationId, applicationId]);
    await completeJob(tx, { organizationId, jobId, leaseToken: claim.leaseToken, result: { detector: 'auth.login_failures.v1', createdIncidents: created, blockedAttempts: result.blockedAttempts, quarantinedTimestamps: quarantined, operationalProjection } });
  });
}

type InvestigationCompletion = { status: 'result'; result: InvestigationResult } | { status: 'failed'; reasonCode: string };

/** Run finalization and delivery completion share the current job's transaction and fence. */
export async function finalizeInvestigation(dependencies: CoordinatorDependencies, claim: JobClaim, runId: string, completion: InvestigationCompletion) {
  const { organizationId, applicationId, id: jobId } = claim.envelope;
  await dependencies.database.tenant(organizationId, async (tx) => {
    const locked = await tx.query<{ state: string; reserved_micros: string }>(`SELECT r.state,r.reserved_micros FROM gotchu.agent_runs r
      JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
      WHERE r.organization_id=$1 AND r.application_id=$2 AND r.id=$3 AND j.id=$4
        AND j.lease_token=$5 AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE OF r,j`, [organizationId, applicationId, runId, jobId, claim.leaseToken]);
    const run = locked.rows[0];
    if (!run) throw new BackendError('stale_lease', 'Investigation finalization requires the current job claim', 409);
    if (run.state === 'running') {
      if (BigInt(run.reserved_micros) !== 0n) {
        if (completion.status !== 'failed') throw new BackendError('run_unsettled', 'Unsettled provider work requires reconciliation', 409);
      } else {
        const scopedRuns = createRunService({ database: {
          ...dependencies.database,
          tenant: async (id, work) => {
            if (id !== organizationId) throw new Error('Cross-tenant finalization transaction');
            return work(tx);
          },
        } });
        await scopedRuns.finish({ organizationId, runId, outcome: completion.status === 'failed' || completion.result.status === 'delayed' ? 'unavailable' : 'succeeded' });
      }
    }
    if (completion.status === 'failed') await failJob(tx, claim, completion.reasonCode);
    else await completeJob(tx, { organizationId, jobId, leaseToken: claim.leaseToken, result: completion.result });
  });
}

async function investigate(dependencies: CoordinatorDependencies, claim: JobClaim) {
  const payload = payloadSchema.parse(claim.payload);
  const { organizationId, applicationId, id: jobId } = claim.envelope;
  const run = await dependencies.backend.runs.start({ organizationId, applicationId, jobId, leaseToken: claim.leaseToken });
  const currentRun = await dependencies.backend.runs.load({ organizationId, runId: run.runId });
  const saved = safeCheckpointSchema.safeParse(currentRun.checkpoint);
  const checkpoint = saved.success ? saved.data : undefined;
  const canRecover = ['running', 'succeeded', 'unavailable'].includes(currentRun.state) && checkpoint && checkpoint.stage !== 'running' && checkpoint.result
      && checkpoint.scope.organizationId === organizationId && checkpoint.scope.applicationId === applicationId && checkpoint.scope.runId === run.runId
      && checkpoint.result.citedEvidenceIds.every((id) => payload.evidenceIds.includes(id));
  if (canRecover || currentRun.state !== 'running') {
    await finalizeInvestigation(dependencies, claim, run.runId, canRecover && checkpoint?.result
      ? { status: 'result', result: checkpoint.result }
      : { status: 'failed', reasonCode: 'investigation_reconciliation_required' });
    return;
  }
  if (!dependencies.investigator) {
    await finalizeInvestigation(dependencies, claim, run.runId, { status: 'failed', reasonCode: 'investigation_worker_not_configured' });
    return;
  }
  let result: InvestigationResult;
  try {
    result = investigationResultSchema.parse(await dependencies.investigator.investigate({ organizationId, applicationId, ...run, evidenceIds: payload.evidenceIds }));
  } catch (error) {
    // The worker may have reached its provider before its response was lost.
    // Stop automatic replay; durable reservations remain held for reconciliation.
    console.error(JSON.stringify({ event: 'investigation_requires_reconciliation', runId: run.runId, type: error instanceof Error ? error.name : 'unknown' }));
    await finalizeInvestigation(dependencies, claim, run.runId, { status: 'failed', reasonCode: 'investigation_reconciliation_required' });
    return;
  }
  await finalizeInvestigation(dependencies, claim, run.runId, { status: 'result', result });
}

async function assess(dependencies: CoordinatorDependencies, claim: JobClaim) {
  const { organizationId, applicationId, id: jobId } = claim.envelope;
  try {
    if (claim.payload && typeof claim.payload === 'object' && 'version' in claim.payload && claim.payload.version === 2) {
      // A lost consumer may still have admitted remote work. Never replay it or
      // release its target authorization based only on an expired job lease.
      if (claim.attempts > 1) throw new BackendError('assessment_reconciliation_required', 'A previous assessment delivery has an uncertain outcome', 409);
      if (!dependencies.customerAssessmentRunner) throw new BackendError('customer_scanner_not_configured', 'Customer scanner is not configured', 503);
      const input = await dependencies.backend.customers.getRequest({ organizationId, applicationId, jobId, leaseToken: claim.leaseToken });
      const report = await runCustomerAssessment(dependencies.customerAssessmentRunner, input).catch((cause: unknown) => {
        throw new BackendError('assessment_reconciliation_required', 'Scanner work must be reconciled before changing target authorization', 503, { cause });
      });
      await dependencies.backend.customers.recordResult({ input, leaseToken: claim.leaseToken, report });
      return;
    }
    if (!dependencies.assessmentRunner) throw new BackendError('audit_adapter_not_configured', 'Assessment adapter is not configured', 503);
    const input = await dependencies.backend.assessments.getRequest({ organizationId, applicationId, jobId, leaseToken: claim.leaseToken });
    // Source and HTTP reads happen after the request transaction has committed.
    const report = await runAssessment(dependencies.assessmentRunner, input);
    await dependencies.backend.assessments.recordResult({ input, leaseToken: claim.leaseToken, report });
  } catch (error) {
    if (error instanceof BackendError && error.code === 'stale_lease') throw error;
    console.error(JSON.stringify({ event: 'assessment_failed', jobId, type: error instanceof Error ? error.name : 'unknown' }));
    const reason = error instanceof BackendError ? error.code : 'assessment_runner_failed';
    await dependencies.database.tenant(organizationId, tx => failJob(tx, claim, reason));
  }
}

/** Redis is delivery transport; the durable Postgres job is the executable authority. */
export async function processDurableJob(dependencies: CoordinatorDependencies, rawEnvelope: unknown) {
  const envelope = jobEnvelopeSchema.parse(rawEnvelope);
  const actual = await dependencies.database.tenant(envelope.organizationId, async (tx) => {
    const result = await tx.query<{ application_id: string; kind: string; state: string }>('SELECT application_id,kind,state FROM gotchu.jobs WHERE organization_id=$1 AND id=$2', [envelope.organizationId, envelope.id]);
    return result.rows[0];
  });
  if (!actual || actual.application_id !== envelope.applicationId || actual.kind !== envelope.kind) throw new BackendError('job_scope_mismatch', 'Queue envelope does not match durable job intent', 403);
  if (actual.state === 'succeeded' || actual.state === 'failed') return { status: 'already_terminal' };
  const claim = await dependencies.backend.jobs.claim({ organizationId: envelope.organizationId, jobId: envelope.id, leaseMs: 300_000 });
  if (!claim) throw new BackendError('job_busy', 'Job is held by another current consumer', 409);
  try {
    if (envelope.kind === 'events.aggregate') await aggregate(dependencies, claim);
    else if (envelope.kind === 'investigation') await investigate(dependencies, claim);
    else if (envelope.kind === 'audit') await assess(dependencies, claim);
    else if (envelope.kind === 'notification') await dependencies.database.tenant(envelope.organizationId, async tx => {
      const current = await tx.query("SELECT id FROM gotchu.jobs WHERE organization_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_until>clock_timestamp() FOR UPDATE", [envelope.organizationId, envelope.id, claim.leaseToken]);
      if (!current.rowCount) throw new BackendError('stale_lease', 'Observation projection requires a current job claim', 409);
      const payload = projectionPayloadSchema.parse(claim.payload);
      try {
        if(payload.kind==='assessment_observation') await observeAssessment(backendInTransaction(dependencies.database, envelope.organizationId, tx), tx, { organizationId: envelope.organizationId, applicationId: envelope.applicationId, reportId: payload.reportId });
        else await evaluateTriage(tx,{organizationId:envelope.organizationId,applicationId:envelope.applicationId});
        await completeJob(tx, { organizationId: envelope.organizationId, jobId: envelope.id, leaseToken: claim.leaseToken });
      } catch (error) {
        // Expired evidence, archived scope and full storage cannot improve through transport retries.
        if (!(error instanceof BackendError) || !['evidence_stale', 'application_archived', 'observation_capacity_exceeded', 'evidence_not_found'].includes(error.code)) throw error;
        const reason = `assessment_projection_${error.code}`;
        await tx.query(`INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at)
          VALUES($1,$2,'assessment_alert_projection','degraded',$3,clock_timestamp())
          ON CONFLICT(organization_id,application_id,capability) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at`,
        [envelope.organizationId, envelope.applicationId, reason]);
        await failJob(tx, claim, reason);
      }
    });
    else await dependencies.database.tenant(envelope.organizationId, (tx) => failJob(tx, claim, `${envelope.kind}_adapter_not_configured`));
    return { status: 'processed' };
  } catch (error) {
    // Existing run reservations/checkpoints must be reconciled before replaying model work.
    // A stale assessment must not reset a newer consumer's lease either.
    if (envelope.kind === 'investigation' || envelope.kind === 'audit') throw error;
    await dependencies.database.tenant(envelope.organizationId, async (tx) => {
      await tx.query("UPDATE gotchu.jobs SET state='queued',lease_until=NULL WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND state='running'", [envelope.organizationId, envelope.id, claim.leaseToken]);
    });
    throw error;
  }
}

export async function dispatchOutbox(backend: Backend, organizationId: string, publish: (envelope: JobEnvelope) => Promise<void>) {
  const claims = await backend.outbox.claim({ organizationId, limit: 20 });
  for (const claim of claims) {
    await publish(claim.envelope);
    await backend.outbox.delivered({ organizationId, id: claim.id, leaseToken: claim.leaseToken });
  }
  return claims.length;
}
