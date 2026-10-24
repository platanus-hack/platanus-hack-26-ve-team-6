import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { BackendError, type Backend } from '@gotchu/backend';
import { customerSourceSnapshotSchema, customerAssessmentReportSchema, recordOperationObservationSchema, type MonitorWork, type MonitorClaim, type CustomerSourceSnapshot } from '@gotchu/contracts';
import type { Database } from '@gotchu/database';
import type { MonitoringCandidate, RepositorySnapshotObservation, ProviderStatusObservation, DependencyObservation } from '@gotchu/monitoring';

export interface MonitoringAdapters {
  repository(input: MonitorClaim & { repositoryKey: string; previousRevision: string | null; signal: AbortSignal }): Promise<RepositorySnapshotObservation>;
  dependencies(repository: RepositorySnapshotObservation, signal: AbortSignal): Promise<DependencyObservation>;
  provider(name: 'cloudflare' | 'railway', signal: AbortSignal): Promise<ProviderStatusObservation>;
}
export interface MonitoringDependencies { backend: Backend; database: Database; adapters: MonitoringAdapters }

/** One independently owned monitor slot; canonical audits still run through their durable queue lane. */
export async function runMonitoringWork(deps: MonitoringDependencies, initial: MonitorWork, parentSignal?: AbortSignal) {
  const claim: MonitorClaim = { organizationId: initial.organizationId, applicationId: initial.applicationId, runId: initial.runId, leaseToken: initial.leaseToken };
  const stop = new AbortController(); const signal = parentSignal ? AbortSignal.any([stop.signal, parentSignal]) : stop.signal;
  let heartbeatFailure: unknown;
  const heartbeat = (async () => {
    while (!signal.aborted) {
      await delay(15_000, undefined, { signal });
      await deps.backend.operations.heartbeatRun(claim);
    }
  })().catch(error => { if (!signal.aborted) { heartbeatFailure = error; stop.abort(error); } });
  let queuedJob: string | null = null; let degraded = false;
  async function jobState(id: string) {
    return deps.database.tenant(claim.organizationId, async tx => {
      const row = await tx.query<{ state: string; result: unknown }>('SELECT state,result FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND id=$3', [claim.organizationId, claim.applicationId, id]);
      if (!row.rows[0]) throw new Error('monitor_job_missing');
      if (row.rows[0].state === 'succeeded') {
        const reports = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND job_id=$3', [claim.organizationId, claim.applicationId, id]);
        const report = customerAssessmentReportSchema.parse(reports.rows[0]?.body);
        if ([report.internal, report.external].some(a => a !== null && a.status !== 'completed')) degraded = true;
      }
      return row.rows[0].state;
    });
  }
  async function record(candidate: MonitoringCandidate | { kind: 'coverage_check'; summary: string; evidence: RepositorySnapshotObservation['evidence']; observedAt: string; expiresAt: string }) {
    if (candidate.kind === 'coverage_gap') degraded = true;
    await deps.backend.operations.getWatch(claim);
    const evidence = candidate.evidence.slice(0, 20);
    const idempotencyKey = `monitor:${claim.runId}:${createHash('sha256').update(candidate.kind + JSON.stringify(evidence.map(e => [e.source, e.reference, e.checksum]))).digest('hex').slice(0, 40)}`;
    const prior = await deps.database.tenant(claim.organizationId, tx => tx.query('SELECT id FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND idempotency_key=$3', [claim.organizationId, claim.applicationId, idempotencyKey]));
    if (prior.rowCount) return;
    const value = recordOperationObservationSchema.parse({ ...candidate, organizationId: claim.organizationId, applicationId: claim.applicationId, basis: { kind: 'monitor', runId: claim.runId, leaseToken: claim.leaseToken }, idempotencyKey, evidence,
      severity: 'severity' in candidate ? candidate.severity : 'info', confidence: 'confidence' in candidate ? candidate.confidence : 'high',
      metrics: null, incidentId: null, upstreamImpact: 'upstreamImpact' in candidate ? candidate.upstreamImpact : 'not_applicable' });
    await deps.backend.operations.recordObservation(value);
  }
  async function healthy(summary: string, evidence: RepositorySnapshotObservation['evidence'], observedAt: string) {
    await record({ kind: 'coverage_check', summary, evidence: evidence.slice(0, 20), observedAt, expiresAt: new Date(Date.parse(observedAt) + 86_400_000).toISOString() });
  }
  try {
    const watch = await deps.backend.operations.getWatch(claim);
    const persisted = await deps.database.tenant(claim.organizationId, async tx => {
      const current = await tx.query<{ job_id: string | null }>('SELECT job_id FROM gotchu.operation_runs WHERE organization_id=$1 AND application_id=$2 AND id=$3', [claim.organizationId, claim.applicationId, claim.runId]);
      const previous = await tx.query<{ revision: unknown }>(`SELECT q.input->'source'->>'revision' AS revision FROM gotchu.operation_runs r
        JOIN gotchu.customer_requests q ON q.organization_id=r.organization_id AND q.application_id=r.application_id AND q.job_id=r.job_id
        WHERE r.organization_id=$1 AND r.application_id=$2 AND r.id<>$3 AND r.monitor_revision=$4 AND r.repository_digest IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 1`, [claim.organizationId, claim.applicationId, claim.runId, watch.monitorRevision]);
      const revision = previous.rows[0]?.revision;
      return { jobId: current.rows[0]?.job_id ?? null, previousRevision: typeof revision === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision) ? revision : null };
    });
    queuedJob = persisted.jobId;
    if (!queuedJob) {
      let snapshot: CustomerSourceSnapshot | undefined;
      if (watch.config.repositoryKey) {
        try {
          await deps.backend.operations.getWatch(claim); signal.throwIfAborted();
          const repository = await deps.adapters.repository({ ...claim, repositoryKey: watch.config.repositoryKey, previousRevision: persisted.previousRevision, signal: AbortSignal.any([signal, AbortSignal.timeout(55_000)]) });
          snapshot = customerSourceSnapshotSchema.parse(repository.snapshot);
          if (repository.candidate) await record(repository.candidate);
          else await healthy('Read the configured repository at an exact commit. Only supported captured source files are covered.', repository.evidence, repository.capturedAt);
          try {
            await deps.backend.operations.getWatch(claim); signal.throwIfAborted();
            const dependencies = await deps.adapters.dependencies(repository, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
            for (const candidate of dependencies.candidates.slice(0, 20)) await record(candidate);
            if (!dependencies.complete) degraded = true;
            if (!dependencies.candidates.length && dependencies.complete) await healthy('Queried supported exact dependency versions; dependency source repositories and runtime reachability are not established.', dependencies.evidence, repository.capturedAt);
          } catch { degraded = true; }
        } catch { degraded = true; }
      }
      for (const provider of watch.config.providers) {
        try {
          await deps.backend.operations.getWatch(claim); signal.throwIfAborted();
          const status = await deps.adapters.provider(provider, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
          if (!status.fresh) { degraded = true; continue; }
          if (status.candidate) await record(status.candidate);
          else await healthy(`Read ${provider} public status; customer impact is not independently verified.`, [status.evidence], status.collectedAt);
        } catch { degraded = true; }
      }
      // Never silently replace an unavailable selected repository with older uploaded source.
      if (!watch.config.repositoryKey || snapshot) {
        signal.throwIfAborted();
        const materialized = await deps.backend.operations.materialize({ ...claim, ...(snapshot ? { repositorySnapshot: snapshot } : {}) });
        queuedJob = materialized.jobId;
      }
    }
    if (queuedJob) {
      while (true) {
        signal.throwIfAborted();
        const state = await jobState(queuedJob);
        if (state === 'succeeded' || state === 'failed') { if (state === 'failed') degraded = true; break; }
        await delay(500, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    await deps.backend.operations.finishRun({ ...claim, status: degraded ? 'degraded' : 'completed', ...(degraded ? { reason: 'Some selected monitoring inputs were unavailable or incomplete. Review coverage and configured access.' } : {}) });
  } catch (error) {
    if (!signal.aborted) {
      if (!queuedJob || ['succeeded', 'failed'].includes(await jobState(queuedJob))) {
        await deps.backend.operations.finishRun({ ...claim, status: 'degraded', reason: error instanceof BackendError ? error.code : 'monitor_adapter_unavailable' });
      }
    }
    throw error;
  } finally {
    stop.abort(); await heartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
  }
}
