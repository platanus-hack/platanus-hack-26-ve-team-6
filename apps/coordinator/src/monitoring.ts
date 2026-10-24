import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { BackendError, type Backend } from '@gotchu/backend';
import { providerStatusInputSchema, httpsProbeSchema } from '@gotchu/triage';
import { customerSourceSnapshotSchema, customerAssessmentReportSchema, recordOperationObservationSchema, type MonitorWork, type MonitorClaim, type CustomerSourceSnapshot } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import type { MonitoringCandidate, RepositorySnapshotObservation, ProviderStatusObservation, DependencyObservation, TrustedCustomerTarget } from '@gotchu/monitoring';
import type { AuthorizedHttpsHealthObservation } from '@gotchu/monitoring';

export interface MonitoringAdapters {
  repository(input: MonitorClaim & { repositoryKey: string; previousRevision: string | null; signal: AbortSignal }): Promise<RepositorySnapshotObservation>;
  dependencies(repository: RepositorySnapshotObservation, signal: AbortSignal): Promise<DependencyObservation>;
  provider(name: 'cloudflare' | 'railway', signal: AbortSignal): Promise<ProviderStatusObservation>;
  httpsHealth(target: TrustedCustomerTarget, route: string, signal: AbortSignal): Promise<AuthorizedHttpsHealthObservation>;
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
    const idempotencyKey = `monitor:${claim.runId}:${createHash('sha256').update(JSON.stringify({ kind: candidate.kind, summary: candidate.summary, evidence: evidence.map(e => [e.source, e.reference, e.checksum]) })).digest('hex').slice(0, 40)}`;
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
    // A persisted audit proves admission, not that every adapter finished before a crash.
    // Until adapter outcomes are independently persisted, recovered work stays unknown.
    const recovered = queuedJob !== null;
    if (recovered) degraded = true;
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
          await persistProviderTriageInputs(deps.database, claim, status);
          if (!status.fresh) { degraded = true; continue; }
          if (status.candidate) await record(status.candidate);
          else await healthy(`Read ${provider} public status; customer impact is not independently verified.`, [status.evidence], status.collectedAt);
          if (!status.coverageComplete && status.candidate?.kind !== 'coverage_gap') await record({
            kind: 'coverage_gap', summary: `${provider} reported a known issue while some component coverage remained unknown. Review both the upstream observation and missing coverage.`,
            severity: 'info', confidence: 'high', evidence: [status.evidence], observedAt: status.collectedAt,
            expiresAt: new Date(Date.parse(status.collectedAt) + 3_600_000).toISOString(), metrics: null, incidentId: null, upstreamImpact: 'not_applicable',
          });
        } catch { degraded = true; }
      }
      if (watch.config.targetId) {
        try {
          await deps.backend.operations.getWatch(claim); signal.throwIfAborted();
          const probeContext = await deps.database.tenant(claim.organizationId, async tx => {
            const target = await tx.query<{id:string;origin:string;version:number;verified_at:Date;expires_at:Date;scan_profile:'root'|'public_surface'}>(`SELECT id,origin,version,verified_at,expires_at,scan_profile FROM gotchu.customer_targets
              WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND status='verified' AND expires_at>clock_timestamp()`,[claim.organizationId,claim.applicationId,watch.config.targetId]);
            const routes = await tx.query<{route:string;service:string;provider:string|null;role:'application'|'control'}>(`SELECT r.route,s.name AS service,d.provider,r.role FROM gotchu.triage_probe_routes r
              JOIN gotchu.application_services s ON s.organization_id=r.organization_id AND s.application_id=r.application_id AND s.id=r.service_id
              LEFT JOIN gotchu.application_dependencies d ON d.organization_id=r.organization_id AND d.application_id=r.application_id AND d.id=r.dependency_id
              WHERE r.organization_id=$1 AND r.application_id=$2 ORDER BY r.route`,[claim.organizationId,claim.applicationId]);
            return {target:target.rows[0],routes:routes.rows};
          });
          if (!probeContext.target) throw new Error('verified_monitor_target_missing');
          const target:TrustedCustomerTarget={id:probeContext.target.id,origin:probeContext.target.origin,version:probeContext.target.version,scanProfile:probeContext.target.scan_profile,
            verifiedAt:probeContext.target.verified_at.toISOString(),expiresAt:probeContext.target.expires_at.toISOString()};
          const routes=probeContext.routes.length?probeContext.routes:[{route:'/',service:'application',provider:null,role:'application' as const}];
          for(const configured of routes){
            const result = await deps.adapters.httpsHealth(target,configured.route,AbortSignal.any([signal,AbortSignal.timeout(10_000)]));
            if(probeContext.routes.length){
              const probe = httpsProbeSchema.parse({route:result.route,service:configured.service,dependsOnProvider:configured.provider,
                role:configured.role,outcome:result.incomplete?'unknown':result.status>=500?'unavailable':result.status>=400?'degraded':'healthy',at:result.observedAt});
              await persistHttpsProbeInput(deps.database,claim,probe);
            }
            if (result.candidate) await record(result.candidate);
          }
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
    await deps.backend.operations.finishRun({ ...claim, status: degraded ? 'degraded' : 'completed', ...(degraded ? { reason: recovered ? 'Recovered monitoring work has unknown adapter completion; selected inputs require a fresh scheduled check.' : 'Some selected monitoring inputs were unavailable or incomplete. Review coverage and configured access.' } : {}) });
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

export async function persistProviderTriageInputs(database: Database, claim: MonitorClaim, status: ProviderStatusObservation) {
  const observedAt = status.publishedAt ?? status.collectedAt;
  if (Date.now() - Date.parse(observedAt) > 7 * 24 * 60 * 60 * 1000) return;
  const state = (value: string): 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown' => {
    if (value === 'operational' || value === 'degraded' || value === 'partial_outage' || value === 'major_outage') return value;
    if (value === 'degraded_performance') return 'degraded';
    if (value === 'major') return 'major_outage';
    if (value === 'minor') return 'degraded';
    return 'unknown';
  };
  const inputs = [
    { provider: status.provider, component: null, region: null, state: status.fresh ? status.globalStatus : 'unknown', observedAt, scope: 'global', fixture: status.fixture },
    ...status.components.map(component => ({ provider: status.provider, component: component.name, region: null, state: status.fresh ? state(component.status) : 'unknown', observedAt, scope: 'component', fixture: status.fixture })),
  ];
  await database.tenant(claim.organizationId, async tx => {
    for (const value of inputs) {
      const input = providerStatusInputSchema.parse(value);
      await recordTriageInput(tx,claim,'provider_status',input.observedAt,input);
    }
  });
}

export async function persistHttpsProbeInput(database:Database,claim:MonitorClaim,input:unknown) {
  const probe=httpsProbeSchema.parse(input);
  await database.tenant(claim.organizationId,tx=>recordTriageInput(tx,claim,'https_probe',probe.at,probe));
}

async function recordTriageInput(tx:Transaction,claim:MonitorClaim,kind:'provider_status'|'https_probe',observedAt:string,payload:unknown) {
  await tx.query('SELECT gotchu.triage_record_input($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[
    claim.organizationId,claim.applicationId,claim.runId,claim.leaseToken,randomUUID(),kind,observedAt,JSON.stringify(payload),
  ]);
}
