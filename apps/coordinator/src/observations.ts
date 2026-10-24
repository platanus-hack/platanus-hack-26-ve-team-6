import { createBackend, BackendError, canonicalJson, sha256, type Backend, type JobClaim } from '@gotchu/backend';
import { customerAssessmentReportSchema, securityEventSchema, type SecurityEvent, type RecordOperationObservation } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { detectOperationalSignals } from './operational-detectors.js';

const windowMs = 600_000;
const eventTime = "CASE WHEN pg_input_is_valid(payload->>'occurredAt','timestamptz') THEN (payload->>'occurredAt')::timestamptz END";
/** Reuse the caller's fenced effect transaction; no cross-tenant nested transaction. */
function inTransaction(database: Database, organizationId: string, tx: Transaction) {
  return createBackend({ database: { ...database, tenant: async (tenant, work) => {
    if (tenant !== organizationId) throw new Error('observation_tenant_mismatch');
    return work(tx);
  } } });
}
export async function observeRuntime(database: Database, tx: Transaction, claim: JobClaim, accepted: readonly SecurityEvent[]) {
  const { organizationId, applicationId } = claim.envelope;
  const backend = inTransaction(database, organizationId, tx);
  const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = clock.rows[0]?.now; if (!now) throw new Error('database_clock_unavailable');
  const buckets = [...new Set(accepted.map(e => Math.floor(Date.parse(e.occurredAt) / windowMs) * windowMs))]
    .filter(t => t >= now.getTime() - 86_400_000 && t <= now.getTime()).sort((a, b) => b - a);
  let limited = buckets.length > 3;
  for (const bucket of buckets.slice(0, 3)) {
    const start = new Date(bucket).toISOString(); const end = new Date(bucket + windowMs).toISOString();
    const rows = await tx.query<{ payload: unknown; payload_hash: string; id: string }>(`SELECT payload,payload_hash,id FROM gotchu.events WHERE organization_id=$1 AND application_id=$2
      AND ${eventTime}>=$3 AND ${eventTime}<$4 ORDER BY received_at,id LIMIT 10001`, [organizationId, applicationId, start, end]);
    if (rows.rows.length > 10_000) { limited = true; continue; }
    const events = rows.rows.map(row => securityEventSchema.parse(row.payload));
    const requests = events.filter(event => event.type === 'http.request'
      && Number.isInteger(event.attributes.statusCode) && Number(event.attributes.statusCode) >= 100);
    if (requests.length >= 20) {
      const durations = requests.flatMap(event => {
        const value = event.attributes.durationMs;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000 ? [value] : [];
      }).sort((a, b) => a - b);
      const capacities = requests.flatMap(event => {
        const value = event.attributes.capacityUtilization;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? [value] : [];
      }).sort((a, b) => a - b);
      const first = requests[0];
      const windowStartedAt = new Date(bucket).toISOString();
      const windowEndedAt = new Date(bucket + windowMs).toISOString();
      if (!first) throw new Error('metric_window_without_requests');
      try {
        await backend.operations.recordObservation({ organizationId, applicationId, idempotencyKey: `signal:metrics:${bucket}`,
        basis: { kind: 'events', eventIds: requests.slice(0, 100).map(event => event.id) }, kind: 'coverage_check',
        summary: `Recorded bounded metrics for ${requests.length} signed HTTP requests; this is a checked sample, not an alert.`,
        severity: 'info', confidence: 'medium', observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        evidence: requests.slice(0, 20).map(event => {
          const row = rows.rows.find(item => item.id === event.id);
          if (!row) throw new Error('metric_evidence_missing');
          return { source: 'signed_event' as const, reference: event.id, checksum: row.payload_hash, collectedAt: now.toISOString(), adapter: 'runtime.metrics.v1', adapterVersion: '1' };
        }),
        metrics: { windowStartedAt, windowEndedAt, requestCount: requests.length,
          errorCount: requests.filter(event => Number(event.attributes.statusCode) >= 500).length,
          latencyP95Ms: durations.length >= 20 ? durations[Math.max(0, Math.ceil(durations.length * .95) - 1)] ?? null : null,
          capacityUtilization: capacities.length >= 20 ? capacities[Math.max(0, Math.ceil(capacities.length * .95) - 1)] ?? null : null },
          incidentId: null, upstreamImpact: 'not_applicable' });
      } catch (error) {
        if (!(error instanceof BackendError) || error.code !== 'observation_capacity_exceeded') throw error;
        limited = true;
      }
    }
    for (const signal of detectOperationalSignals(events, start, end)) {
      const key = `signal:${signal.rule}:${signal.key}`;
      // A fixed window emits one immutable first-detection alert, rather than one per incoming batch.
      const prior = await tx.query('SELECT id FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND idempotency_key=$3', [organizationId, applicationId, key]);
      if (prior.rowCount) continue;
      const references = signal.eventIds.map(id => {
        const row = rows.rows.find(r => r.id === id);
        if (!row) throw new Error('signal_evidence_missing');
        return { source: 'signed_event' as const, reference: id, checksum: row.payload_hash, collectedAt: now.toISOString(), adapter: signal.rule, adapterVersion: '1' };
      });
      try {
        await backend.operations.recordObservation({ organizationId, applicationId, idempotencyKey: key, basis: { kind: 'events', eventIds: signal.eventIds },
          kind: signal.kind, summary: signal.summary, severity: signal.severity, confidence: signal.confidence,
          observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), evidence: references,
          metrics: signal.metrics, incidentId: null, upstreamImpact: 'not_applicable' });
      } catch (error) {
        if (!(error instanceof BackendError) || error.code !== 'observation_capacity_exceeded') throw error;
        limited = true; break;
      }
    }
  }
  if (buckets.length) await tx.query(`INSERT INTO gotchu.coverage(organization_id,application_id,capability,state,reason,checked_at) VALUES($1,$2,'operational_detection',$3,$4,clock_timestamp())
    ON CONFLICT(organization_id,application_id,capability) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,checked_at=EXCLUDED.checked_at`,
  [organizationId, applicationId, limited ? 'degraded' : 'active', limited ? 'Operational windows exceeded bounded processing limits; coverage is incomplete.' : 'Versioned observed-error, latency, resource, password-spray, route and privilege rules; thresholds require traffic calibration.']);
  return limited ? 'degraded' as const : 'active' as const;
}

export async function observeAssessment(backend: Backend, tx: Transaction, scope: { organizationId: string; applicationId: string; reportId: string }) {
  const rows = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [scope.organizationId, scope.applicationId, scope.reportId]);
  const row = rows.rows[0]; if (!row) throw new Error('assessment_observation_not_found');
  const report = customerAssessmentReportSchema.parse(row.body);
  const findings = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
  const base = { organizationId: scope.organizationId, applicationId: scope.applicationId, basis: { kind: 'assessment' as const, reportId: report.id },
    observedAt: report.finishedAt, expiresAt: new Date(Date.parse(report.finishedAt) + 86_400_000).toISOString(),
    evidence: [{ source: 'assessment' as const, reference: report.id, checksum: sha256(canonicalJson(row.body)), collectedAt: report.finishedAt, adapter: 'gotchu-assessment-projection', adapterVersion: '1' }],
    metrics: null, incidentId: null, upstreamImpact: 'not_applicable' as const };
  const groups: Array<{ kind: RecordOperationObservation['kind']; count: number; summary: string; severity: 'info' | 'medium' | 'high' }> = [];
  const dependencies = findings.filter(f => f.ruleId.startsWith('osv.'));
  const other = findings.filter(f => !f.ruleId.startsWith('osv.'));
  if (dependencies.length) groups.push({ kind: 'dependency_advisory', count: dependencies.length, summary: `${dependencies.length} exact-version advisory matches. Review fixed versions and reachability; unassessed severity does not mean low risk.`, severity: 'info' });
  if (other.length) groups.push({ kind: 'security_finding', count: other.length, summary: `${other.length} source or public-surface observations require review. The persisted assessment holds evidence and correction options; exploitation is not established.`, severity: other.some(f => f.severity === 'critical' || f.severity === 'high') ? 'high' : 'medium' });
  if ([report.internal, report.external].some(a => a !== null && a.status !== 'completed')) groups.push({ kind: 'coverage_gap', count: 1, summary: 'Assessment coverage is partial or unavailable. Retained findings remain valid observations; missing coverage must not be presented as clean.', severity: 'info' });
  if (!groups.length) groups.push({ kind: 'coverage_check', count: 1, summary: 'A bounded assessment completed. Only the recorded profile was inspected; absence of findings is not proof of safety.', severity: 'info' });
  for (const group of groups) await backend.operations.recordObservation({ ...base, idempotencyKey: `assessment:${report.id}:${group.kind}`, kind: group.kind, summary: group.summary, severity: group.severity, confidence: 'medium' });
}
export { inTransaction as backendInTransaction };
