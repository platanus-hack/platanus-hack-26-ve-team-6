import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  customerScopeSchema, customerSourceSnapshotSchema, monitorClaimSchema, monitorConfigInputSchema, monitorConfigSchema,
  monitorWorkSchema, operationAlertSchema, operationCoverageSchema, operationObservationSchema, operationPlanBindingSchema, operationPlanRequestSchema,
  operationPlanSchema, operationPlanStepSchema, operationReadinessSchema, recordOperationObservationSchema,
  type CustomerSourceSnapshot, type MonitorClaim, type MonitorConfig, type MonitorConfigInput, type MonitorWork,
  type OperationPlan, type OperationPlanBinding, type OperationPlanRequest, type RecordOperationObservation,
} from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { audit, authorize, BackendError, canonicalJson, parse, sha256, type BaseDependencies, type Identity } from './core.js';
import { enqueue } from './jobs.js';
import { enqueueNotificationEvent } from './notifications.js';

type Scope = z.infer<typeof customerScopeSchema>;
const writes = ['owner', 'operator'] as const;
/** Matches the dashboard's preselected frequency. */
export const DEFAULT_MONITOR_INTERVAL_SECONDS = 21_600;
const discoveryTenant = '00000000-0000-0000-0000-000000000000';
const limitsSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) });
const listSchema = customerScopeSchema.extend(limitsSchema.shape).strict();
const configProjection = `jsonb_build_object('organizationId',organization_id,'applicationId',application_id,'enabled',enabled,
 'intervalSeconds',interval_seconds,'sourceSnapshotId',source_id,'targetId',target_id,'repositoryKey',repository_key,'providers',providers,
 'revision',revision,'nextDueAt',to_char(next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS body`;
async function application(tx: Transaction, scope: Scope, write = false) {
  if (write) await tx.query('SELECT gotchu.lock_customer_organization($1)', [scope.organizationId]);
  const result = write
    ? await tx.query<{ body: unknown }>('SELECT gotchu.lock_customer_application($1,$2) AS body', [scope.organizationId, scope.applicationId])
    : await tx.query<{ body: unknown }>("SELECT jsonb_build_object('name',name,'archived',archived) AS body FROM gotchu.applications WHERE organization_id=$1 AND id=$2", [scope.organizationId, scope.applicationId]);
  if (!result.rows[0]?.body) throw new BackendError('not_found', 'Application not found', 404);
  const app = parse(z.object({ name: z.string(), archived: z.boolean() }), result.rows[0].body);
  if (write && app.archived) throw new BackendError('application_archived', 'Restore this application before changing operations', 409);
  return app;
}
async function config(tx: Transaction, scope: Scope): Promise<MonitorConfig | null> {
  const result = await tx.query<{ body: unknown }>(`SELECT ${configProjection} FROM gotchu.operation_monitors WHERE organization_id=$1 AND application_id=$2`, [scope.organizationId, scope.applicationId]);
  return result.rows[0] ? parse(monitorConfigSchema, result.rows[0].body) : null;
}
function coordinator(deps: BaseDependencies) {
  if (deps.database.role !== 'gotchu_coordinator') throw new BackendError('forbidden', 'Only the trusted coordinator may record observations or schedule monitoring', 403);
}
async function checkClaim(tx: Transaction, claim: MonitorClaim) {
  const result = await tx.query<{ status: string }>('SELECT gotchu.operation_check_claim($1,$2,$3,$4) AS status', [claim.organizationId, claim.applicationId, claim.runId, claim.leaseToken]);
  const status = result.rows[0]?.status;
  if (status !== 'ok') throw new BackendError(status ?? 'stale_lease', 'Monitoring scope, membership or lease is no longer current', 409);
}
async function watch(tx: Transaction, claim: MonitorClaim): Promise<MonitorWork> {
  await checkClaim(tx, claim);
  const result = await tx.query<{ monitor_revision: number; lease_until: Date }>('SELECT monitor_revision,lease_until FROM gotchu.operation_runs WHERE organization_id=$1 AND application_id=$2 AND id=$3', [claim.organizationId, claim.applicationId, claim.runId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Monitoring run not found', 404);
  return parse(monitorWorkSchema, { ...claim, monitorRevision: row.monitor_revision, leaseUntil: row.lease_until.toISOString(), config: await config(tx, claim) });
}
function translateFence(error: unknown): never {
  if (error instanceof Error && error.message.includes('monitor_work_in_progress')) throw new BackendError('monitor_work_in_progress', 'Monitoring work must settle before changing configuration; authorization remains active', 409, { cause: error });
  throw error;
}
const executionRequirements = [
  'Trusted provider capability and independent executor adapters are not configured.',
  'A separately verified exact proposal and fresh MFA approval are required for production writes.',
  'Independent destination, cost, health, rollback and cutover preflight evidence is required.',
  'Caller attestations are self-reported and do not satisfy verification gates.',
];
function planHash(plan: Omit<OperationPlan, 'actionHash'>) { return sha256(canonicalJson(plan)); }
async function loadPlan(tx: Transaction, scope: Scope & { planId: string }) {
  const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.operation_plans WHERE organization_id=$1 AND application_id=$2 AND id=$3 FOR UPDATE', [scope.organizationId, scope.applicationId, scope.planId]);
  if (!result.rows[0]) throw new BackendError('not_found', 'Operation plan not found', 404);
  return parse(operationPlanSchema, result.rows[0].body);
}
function checkBinding(plan: OperationPlan, binding: OperationPlanBinding) {
  const { actionHash, ...content } = plan;
  if (plan.revision !== binding.revision || actionHash !== binding.actionHash || actionHash !== planHash(content)) throw new BackendError('plan_changed', 'Reload the exact plan revision before continuing', 409);
}
async function savePlan(tx: Transaction, plan: OperationPlan) {
  await tx.query('UPDATE gotchu.operation_plans SET revision=$4,action_hash=$5,body=$6::jsonb,updated_at=clock_timestamp() WHERE organization_id=$1 AND application_id=$2 AND id=$3', [plan.organizationId, plan.applicationId, plan.id, plan.revision, plan.actionHash, JSON.stringify(plan)]);
}
async function observations(tx: Transaction, scope: Scope, ids: string[]) {
  const result = await tx.query<{ body: unknown; fresh: boolean }>('SELECT body,expires_at>clock_timestamp() AS fresh FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2 AND id=ANY($3::uuid[])', [scope.organizationId, scope.applicationId, ids]);
  if (result.rows.length !== new Set(ids).size) throw new BackendError('evidence_not_found', 'Observation references must belong to this application', 404);
  return result.rows.map(row => parse(operationObservationSchema, { ...parse(operationObservationSchema, row.body), fresh: row.fresh }));
}
function step(key: z.infer<typeof operationPlanStepSchema>['key'], instruction: string): z.infer<typeof operationPlanStepSchema> {
  return { key, instruction, state: 'todo', attestation: null };
}
export function createOperationsService(deps: BaseDependencies) {
  return {
    async getConfig(identity: Identity, input: Scope) {
      const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => { await authorize(tx, scope.organizationId, identity); await application(tx, scope); return config(tx, scope); });
    },
    async configure(identity: Identity, input: MonitorConfigInput) {
      const value = parse(monitorConfigInputSchema, input);
      try {
        return await deps.database.tenant(value.organizationId, async tx => {
          await authorize(tx, value.organizationId, identity, writes); await application(tx, value, true);
          if (value.enabled && value.sourceSnapshotId) {
            const source = await tx.query('SELECT 1 FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND deleted_at IS NULL', [value.organizationId, value.applicationId, value.sourceSnapshotId]);
            if (!source.rowCount) throw new BackendError('source_unavailable', 'Choose an active source from this application', 409);
          }
          let targetVersion: number | null = null;
          if (value.enabled && value.targetId) {
            const target = await tx.query<{ version: number }>("SELECT version FROM gotchu.customer_targets WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND status='authorized' AND expires_at>clock_timestamp()", [value.organizationId, value.applicationId, value.targetId]);
            if (!target.rows[0]) throw new BackendError('target_not_authorized', 'Enter a target origin before monitoring it', 409);
            targetVersion = target.rows[0].version;
          }
          await tx.query(`INSERT INTO gotchu.operation_monitors(organization_id,application_id,enabled,interval_seconds,source_id,target_id,target_version,repository_key,providers,author_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT(organization_id,application_id) DO UPDATE SET enabled=EXCLUDED.enabled,
           interval_seconds=EXCLUDED.interval_seconds,source_id=EXCLUDED.source_id,target_id=EXCLUDED.target_id,target_version=EXCLUDED.target_version,
           repository_key=EXCLUDED.repository_key,providers=EXCLUDED.providers,author_id=EXCLUDED.author_id,revision=operation_monitors.revision+1,next_due_at=clock_timestamp(),updated_at=clock_timestamp()`,
          [value.organizationId, value.applicationId, value.enabled, value.intervalSeconds, value.sourceSnapshotId, value.targetId, targetVersion, value.repositoryKey, JSON.stringify([...new Set(value.providers)]), identity.userId]);
          await audit(tx, value.organizationId, identity.userId, 'monitor.configured', value.applicationId, { enabled: value.enabled });
          return parse(monitorConfigSchema, await config(tx, value));
        });
      } catch (error) { translateFence(error); }
    },
    /**
     * Turns on default monitoring for a newly connected repository, only when the application has never
     * had a monitor; an existing configuration, including a deliberately disabled one, is left alone.
     * The first check waits one interval because connecting already queued a scan.
     */
    async enableDefault(identity: Identity, input: Scope & { repositoryKey: string }): Promise<boolean> {
      const value = parse(monitorConfigInputSchema, { organizationId: input.organizationId, applicationId: input.applicationId, enabled: true, intervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS, repositoryKey: input.repositoryKey });
      try {
        return await deps.database.tenant(value.organizationId, async tx => {
          await authorize(tx, value.organizationId, identity, writes); await application(tx, value, true);
          const inserted = await tx.query(`INSERT INTO gotchu.operation_monitors(organization_id,application_id,enabled,interval_seconds,repository_key,author_id,next_due_at)
            VALUES($1,$2,true,$3::integer,$4,$5,clock_timestamp()+$3::integer*interval '1 second') ON CONFLICT(organization_id,application_id) DO NOTHING`,
          [value.organizationId, value.applicationId, value.intervalSeconds, value.repositoryKey, identity.userId]);
          if (!inserted.rowCount) return false;
          await audit(tx, value.organizationId, identity.userId, 'monitor.configured', value.applicationId, { enabled: true, default: true });
          return true;
        });
      } catch (error) { translateFence(error); }
    },
    async claimDue(input: { limit?: number; leaseMs?: number } = {}): Promise<MonitorWork[]> {
      coordinator(deps);
      const value = parse(limitsSchema.extend({ leaseMs: z.number().int().min(1000).max(300000).default(300000) }).strict(), input);
      const claims = await deps.database.tenant(discoveryTenant, async tx => {
        const result = await tx.query<{ organization_id: string; application_id: string; id: string; lease_token: string; monitor_revision: number; lease_until: Date }>('SELECT * FROM gotchu.operation_claim_due($1,$2)', [value.limit, value.leaseMs]);
        return result.rows;
      });
      const result: MonitorWork[] = [];
      // Bounded sequential hydration avoids a cross-tenant table-read capability.
      for (const row of claims) {
        const scope = { organizationId: row.organization_id, applicationId: row.application_id };
        const current = await deps.database.tenant(scope.organizationId, tx => config(tx, scope));
        await deps.database.tenant(scope.organizationId, tx => tx.query(`INSERT INTO gotchu.monitoring_liveness(organization_id,application_id,state,last_check_heartbeat_at)
          VALUES($1,$2,'unknown',clock_timestamp()) ON CONFLICT(organization_id,application_id) DO UPDATE SET last_check_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()`, [scope.organizationId,scope.applicationId]));
        result.push(parse(monitorWorkSchema, { ...scope, runId: row.id, leaseToken: row.lease_token, monitorRevision: row.monitor_revision, leaseUntil: row.lease_until.toISOString(), config: current }));
      }
      return result;
    },
    async getWatch(input: MonitorClaim) {
      coordinator(deps); const claim = parse(monitorClaimSchema, input);
      return deps.database.tenant(claim.organizationId, tx => watch(tx, claim));
    },
    async heartbeatRun(input: MonitorClaim & { leaseMs?: number }) {
      coordinator(deps); const value = parse(monitorClaimSchema.extend({ leaseMs: z.number().int().min(1000).max(300000).default(300000) }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ status: string }>('SELECT gotchu.operation_heartbeat($1,$2,$3,$4,$5) AS status', [value.organizationId, value.applicationId, value.runId, value.leaseToken, value.leaseMs]);
        if (result.rows[0]?.status !== 'ok') throw new BackendError(result.rows[0]?.status ?? 'stale_lease', 'Monitoring heartbeat requires current scope and lease', 409);
        await tx.query(`INSERT INTO gotchu.monitoring_liveness(organization_id,application_id,state,last_check_heartbeat_at)
          VALUES($1,$2,'unknown',clock_timestamp()) ON CONFLICT(organization_id,application_id) DO UPDATE SET last_check_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()`, [value.organizationId,value.applicationId]);
      });
    },
    async materialize(input: MonitorClaim & { repositorySnapshot?: CustomerSourceSnapshot }): Promise<{ jobId: string | null }> {
      coordinator(deps); const value = parse(monitorClaimSchema.extend({ repositorySnapshot: customerSourceSnapshotSchema.optional() }).strict(), input);
      const snapshot = value.repositorySnapshot ? { ...value.repositorySnapshot, files: [...value.repositorySnapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) } : null;
      return deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query<{ result: unknown }>('SELECT gotchu.operation_materialize($1,$2,$3,$4,$5::jsonb,$6) AS result', [value.organizationId, value.applicationId, value.runId, value.leaseToken, snapshot === null ? null : JSON.stringify(snapshot), snapshot === null ? null : sha256(canonicalJson(snapshot))]);
        const error = z.object({ error: z.string() }).safeParse(result.rows[0]?.result);
        if (error.success) throw new BackendError(error.data.error, 'Scheduled assessment could not be admitted; monitoring coverage remains incomplete', /capacity/.test(error.data.error) ? 429 : 409);
        return parse(z.object({ jobId: z.uuid().nullable() }).strict(), result.rows[0]?.result);
      });
    },
    async finishRun(input: MonitorClaim & { status: 'completed' | 'degraded'; reason?: string }) {
      coordinator(deps); const value = parse(monitorClaimSchema.extend({ status: z.enum(['completed', 'degraded']), reason: z.string().min(1).max(2000).optional() }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => {
        const result = await tx.query(`UPDATE gotchu.operation_runs r SET status=$5,reason=$6,finished_at=clock_timestamp()
          WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND lease_token=$4 AND status='running' AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM gotchu.jobs j WHERE j.organization_id=r.organization_id AND j.id=r.job_id AND j.state IN ('queued','running'))
          AND ($5='degraded' OR (r.job_id IS NOT NULL AND EXISTS(SELECT 1 FROM gotchu.customer_reports p JOIN gotchu.jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id WHERE p.organization_id=r.organization_id AND p.application_id=r.application_id AND p.job_id=r.job_id AND j.state='succeeded'))
            OR (r.job_id IS NULL AND EXISTS(SELECT 1 FROM gotchu.operation_observations o WHERE o.organization_id=r.organization_id AND o.application_id=r.application_id AND o.basis->>'runId'=r.id::text AND o.body->>'kind'<>'coverage_gap')))` ,
        [value.organizationId, value.applicationId, value.runId, value.leaseToken, value.status, value.reason ?? null]);
        if (!result.rowCount) throw new BackendError('stale_lease', 'Monitoring lease expired, assessment work has not settled, or successful observation evidence is missing', 409);
        await tx.query(`INSERT INTO gotchu.monitoring_liveness(organization_id,application_id,state,last_check_heartbeat_at)
          VALUES($1,$2,'unknown',clock_timestamp()) ON CONFLICT(organization_id,application_id) DO UPDATE SET last_check_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()`, [value.organizationId,value.applicationId]);
      });
    },
    async recordObservation(input: RecordOperationObservation): Promise<{ observationId: string; alertId: string | null }> {
      coordinator(deps); const value = parse(recordOperationObservationSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await application(tx, value, true);
        // Lease tokens fence delivery, but rotating a claim does not change evidence identity.
        const basis = value.basis.kind === 'monitor' ? { kind: 'monitor', runId: value.basis.runId } : value.basis;
        const contentHash = sha256(canonicalJson({ ...value, basis }));
        const prior = await tx.query<{ id: string; content_hash: string; alert_id: string | null }>(`SELECT o.id,o.content_hash,a.id AS alert_id FROM gotchu.operation_observations o LEFT JOIN gotchu.operation_alerts a
         ON a.organization_id=o.organization_id AND a.application_id=o.application_id AND a.observation_id=o.id WHERE o.organization_id=$1 AND o.application_id=$2 AND o.idempotency_key=$3`, [value.organizationId, value.applicationId, value.idempotencyKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].content_hash !== contentHash) throw new BackendError('idempotency_conflict', 'Observation key already identifies different evidence', 409);
          return { observationId: prior.rows[0].id, alertId: prior.rows[0].alert_id };
        }
        const nowResult = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const now = nowResult.rows[0]?.now.getTime();
        if (now === undefined) throw new Error('Database clock unavailable');
        if (Date.parse(value.observedAt) > now + 30_000 || Date.parse(value.observedAt) < now - 86_400_000 || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > Date.parse(value.observedAt) + 86_400_000
          || value.evidence.some(e => Date.parse(e.collectedAt) > now + 30_000 || Date.parse(e.collectedAt) < Date.parse(value.observedAt) - 86_400_000)) throw new BackendError('evidence_stale', 'Observations must carry current evidence and at most 24 hours of freshness', 409);
        if (value.basis.kind === 'monitor') {
          await checkClaim(tx, { organizationId: value.organizationId, applicationId: value.applicationId, runId: value.basis.runId, leaseToken: value.basis.leaseToken });
          const current = await config(tx, value);
          if (value.evidence.some(e => !['repository', 'provider_status', 'advisory_database'].includes(e.source))) throw new BackendError('evidence_mismatch', 'Monitor adapter evidence must identify repository, advisory database or provider status provenance', 409);
          if (value.evidence.some(e => e.source === 'repository' || e.source === 'advisory_database') && !current?.repositoryKey) throw new BackendError('evidence_mismatch', 'Repository monitoring is not configured', 409);
          if (value.evidence.some(e => e.source === 'provider_status') && !current?.providers.length) throw new BackendError('evidence_mismatch', 'Upstream monitoring is not configured', 409);
        } else if (value.basis.kind === 'events') {
          const rows = await tx.query<{ id: string; payload_hash: string; received_at: Date }>('SELECT id,payload_hash,received_at FROM gotchu.events WHERE organization_id=$1 AND application_id=$2 AND id=ANY($3::uuid[])', [value.organizationId, value.applicationId, value.basis.eventIds]);
          if (rows.rows.length !== new Set(value.basis.eventIds).size || rows.rows.some(e => e.received_at.getTime() < now - 86_400_000)) throw new BackendError('evidence_not_found', 'Event references must be recent authenticated events from this application', 409);
          if (value.evidence.some(e => e.source !== 'signed_event' || !rows.rows.some(row => row.id === e.reference && row.payload_hash === e.checksum))) throw new BackendError('evidence_mismatch', 'Event evidence checksum must match persisted authenticated content', 409);
        } else {
          const rows = await tx.query<{ body: unknown; created_at: Date }>('SELECT body,created_at FROM gotchu.customer_reports WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.basis.reportId]);
          const report = rows.rows[0];
          if (!report || report.created_at.getTime() < now - 86_400_000) throw new BackendError('evidence_not_found', 'Assessment reference must be a recent report from this application', 409);
          if (value.evidence.some(e => e.source !== 'assessment' || e.reference !== (value.basis.kind === 'assessment' ? value.basis.reportId : '') || e.checksum !== sha256(canonicalJson(report.body)))) throw new BackendError('evidence_mismatch', 'Assessment checksum must match the persisted report', 409);
        }
        if (value.incidentId) {
          const incident = await tx.query('SELECT 1 FROM gotchu.incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.incidentId]);
          if (!incident.rowCount) throw new BackendError('evidence_not_found', 'Incident must belong to this application', 404);
        }
        const counts = await tx.query<{ total: number; daily: number }>("SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 day')::int AS daily FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2", [value.organizationId, value.applicationId]);
        if ((counts.rows[0]?.total ?? 2000) >= 2000 || (counts.rows[0]?.daily ?? 100) >= 100) throw new BackendError('observation_capacity_exceeded', 'Observation storage admission is full; operator retention maintenance is required', 429);
        const observationId = randomUUID(); const alertId = value.kind === 'coverage_check' ? null : randomUUID();
        const { basis: _basis, idempotencyKey: _key, ...fields } = value;
        const body = parse(operationObservationSchema, { ...fields, id: observationId, verification: 'trusted_observation', fresh: true });
        await tx.query('INSERT INTO gotchu.operation_observations(organization_id,application_id,id,idempotency_key,content_hash,body,basis,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [value.organizationId, value.applicationId, observationId, value.idempotencyKey, contentHash, JSON.stringify(body), JSON.stringify(basis), value.expiresAt]);
        if (alertId) {
          await tx.query('INSERT INTO gotchu.operation_alerts(organization_id,application_id,id,observation_id) VALUES($1,$2,$3,$4)', [value.organizationId, value.applicationId, alertId, observationId]);
          if (value.severity === 'high' || value.severity === 'critical') {
            if (value.basis.kind === 'monitor') {
              await enqueueNotificationEvent(tx, { organizationId:value.organizationId, applicationId:value.applicationId, eventKey:`monitor-alert:${alertId}`,
                eventKind:'finding', severity:value.severity, title:value.severity==='critical'?'Nuevo hallazgo crítico':'Nuevo hallazgo de severidad alta', message:value.summary });
            } else if (value.basis.kind === 'events') {
              await enqueueNotificationEvent(tx, { organizationId:value.organizationId, applicationId:value.applicationId, eventKey:`runtime-alert:${alertId}`,
                eventKind:'runtime_alert', severity:value.severity, title:value.severity==='critical'?'Alerta crítica del detector en tiempo de ejecución':'Alerta del detector en tiempo de ejecución', message:value.summary });
            }
          }
        }
        const windowBucket = Math.floor(now / 300_000);
        await enqueue(tx,{organizationId:value.organizationId,applicationId:value.applicationId,id:randomUUID(),kind:'notification',idempotencyKey:`triage:${value.applicationId}:${windowBucket}`,payload:{kind:'triage_evaluation',windowBucket}});
        return { observationId, alertId };
      });
    },
    async listAlerts(identity: Identity, input: Scope & { limit?: number }) {
      const value = parse(listSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity); await application(tx, value);
        const result = await tx.query<{ id: string; body: unknown; state: string; resolution: string | null; updated_at: Date; fresh: boolean }>(`SELECT a.id,o.body,a.state,a.resolution,a.updated_at,o.expires_at>clock_timestamp() AS fresh FROM gotchu.operation_alerts a JOIN gotchu.operation_observations o
         ON o.organization_id=a.organization_id AND o.application_id=a.application_id AND o.id=a.observation_id WHERE a.organization_id=$1 AND a.application_id=$2 ORDER BY a.updated_at DESC,a.id LIMIT $3`, [value.organizationId, value.applicationId, value.limit]);
        return result.rows.map(row => parse(operationAlertSchema, { id: row.id, observation: { ...parse(operationObservationSchema, row.body), fresh: row.fresh }, state: row.state, resolution: row.resolution, updatedAt: row.updated_at.toISOString() }));
      });
    },
    async updateAlert(identity: Identity, input: Scope & { alertId: string; state: 'acknowledged' | 'resolved'; resolution?: string }) {
      const value = parse(customerScopeSchema.extend({ alertId: z.uuid(), state: z.enum(['acknowledged', 'resolved']), resolution: z.string().min(1).max(2000).optional() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writes); await application(tx, value);
        const result = await tx.query('UPDATE gotchu.operation_alerts SET state=$4,resolution=$5,updated_by=$6,updated_at=clock_timestamp() WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId, value.applicationId, value.alertId, value.state, value.resolution ?? null, identity.userId]);
        if (!result.rowCount) throw new BackendError('not_found', 'Alert not found', 404);
        await audit(tx, value.organizationId, identity.userId, `alert.${value.state}`, value.alertId, { verification: 'customer_acknowledgment_only' });
        const updated = await tx.query<{ body: unknown; state: string; resolution: string | null; updated_at: Date; fresh: boolean }>(`SELECT o.body,a.state,a.resolution,a.updated_at,o.expires_at>clock_timestamp() AS fresh
          FROM gotchu.operation_alerts a JOIN gotchu.operation_observations o ON o.organization_id=a.organization_id AND o.application_id=a.application_id AND o.id=a.observation_id
          WHERE a.organization_id=$1 AND a.application_id=$2 AND a.id=$3`, [value.organizationId, value.applicationId, value.alertId]);
        const row = updated.rows[0];
        if (!row) throw new Error('Updated alert disappeared');
        return parse(operationAlertSchema, { id: value.alertId, observation: { ...parse(operationObservationSchema, row.body), fresh: row.fresh }, state: row.state, resolution: row.resolution, updatedAt: row.updated_at.toISOString() });
      });
    },
    async getCoverage(identity: Identity, input: Scope) {
      const value = parse(customerScopeSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity); const app = await application(tx, value); const current = await config(tx, value);
        const runs = await tx.query<{ id: string; job_id: string | null; status: string; reason: string | null; created_at: Date; finished_at: Date | null }>('SELECT id,job_id,status,reason,created_at,finished_at FROM gotchu.operation_runs WHERE organization_id=$1 AND application_id=$2 AND monitor_revision=$3 ORDER BY created_at DESC,id LIMIT 1', [value.organizationId, value.applicationId, current?.revision ?? 0]);
        const count = await tx.query<{ fresh: number; stale: number }>('SELECT count(*) FILTER(WHERE expires_at>clock_timestamp())::int AS fresh,count(*) FILTER(WHERE expires_at<=clock_timestamp())::int AS stale FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2', [value.organizationId, value.applicationId]);
        const authorization = await tx.query<{ valid: boolean }>(`SELECT
          EXISTS(SELECT 1 FROM gotchu.memberships u WHERE u.organization_id=m.organization_id AND u.user_id=m.author_id AND u.role IN ('owner','operator'))
          AND (m.source_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_sources s WHERE s.organization_id=m.organization_id AND s.application_id=m.application_id AND s.id=m.source_id AND s.deleted_at IS NULL))
          AND (m.target_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_targets t WHERE t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id AND t.version=m.target_version AND t.status='authorized' AND t.expires_at>clock_timestamp())) AS valid
          FROM gotchu.operation_monitors m WHERE m.organization_id=$1 AND m.application_id=$2`, [value.organizationId, value.applicationId]);
        const scopeCurrent = authorization.rows[0]?.valid ?? false;
        const gaps = await tx.query<{ capability: string; reason: string }>(`SELECT capability,reason FROM gotchu.coverage WHERE organization_id=$1 AND application_id=$2
          AND capability IN ('operational_detection','assessment_alert_projection') AND state='degraded' ORDER BY capability`, [value.organizationId, value.applicationId]);
        const admission = await tx.query<{ runs: number; observations: number; daily: number; plans: number }>(`SELECT
          (SELECT count(*)::int FROM gotchu.operation_runs WHERE organization_id=$1 AND application_id=$2) AS runs,
          count(*)::int AS observations,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 day')::int AS daily,
          (SELECT count(*)::int FROM gotchu.operation_plans WHERE organization_id=$1 AND application_id=$2) AS plans
          FROM gotchu.operation_observations WHERE organization_id=$1 AND application_id=$2`, [value.organizationId, value.applicationId]);
        const capacity = admission.rows[0] ?? { runs: 0, observations: 0, daily: 0, plans: 0 };
        const full = capacity.runs >= 1000 || capacity.observations >= 2000 || capacity.daily >= 100;
        const last = runs.rows[0];
        const expired = current && Date.parse(current.nextDueAt) < Date.now() - current.intervalSeconds * 1000;
        const livenessResult=await tx.query<{state:string;reason:string|null;since:Date|null;last_scheduler_heartbeat_at:Date|null;last_check_heartbeat_at:Date|null;consecutive_failures:number;database_now:Date}>(`SELECT l.state,l.reason,l.since,l.last_scheduler_heartbeat_at,l.last_check_heartbeat_at,l.consecutive_failures,clock_timestamp() AS database_now
          FROM gotchu.monitoring_liveness l WHERE l.organization_id=$1 AND l.application_id=$2`,[value.organizationId,value.applicationId]);
        let livenessRow=livenessResult.rows[0];
        const schedulerStaleAt=livenessRow?.last_scheduler_heartbeat_at
          ? new Date(livenessRow.last_scheduler_heartbeat_at.getTime()+30_000)
          : current ? new Date(Date.parse(current.nextDueAt)+current.intervalSeconds*2_000) : null;
        const databaseNow=livenessRow?.database_now ?? (await tx.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
        const coordinatorStopped=Boolean(current?.enabled && !app.archived && schedulerStaleAt && databaseNow && schedulerStaleAt<=databaseNow);
        let stoppedSince=livenessRow?.since?.toISOString()??null;
        if(coordinatorStopped&&livenessRow?.state!=='stopped'&&schedulerStaleAt){
          const persisted=livenessRow
            ? await tx.query<{since:Date}>(`UPDATE gotchu.monitoring_liveness SET state='stopped',reason='El coordinador dejó de enviar latidos de planificación.',since=$3,updated_at=clock_timestamp()
                WHERE organization_id=$1 AND application_id=$2 AND state<>'stopped' RETURNING since`,[value.organizationId,value.applicationId,schedulerStaleAt])
            : await tx.query<{since:Date}>(`INSERT INTO gotchu.monitoring_liveness(organization_id,application_id,state,reason,since)
                VALUES($1,$2,'stopped','El coordinador dejó de enviar latidos de planificación.',$3) ON CONFLICT(organization_id,application_id) DO NOTHING RETURNING since`,[value.organizationId,value.applicationId,schedulerStaleAt]);
          const transitionSince=persisted.rows[0]?.since;
          if(transitionSince){
            stoppedSince=transitionSince.toISOString();
            await enqueueNotificationEvent(tx,{organizationId:value.organizationId,applicationId:value.applicationId,
              eventKey:`monitoring-stopped:${value.applicationId}:${stoppedSince}`,eventKind:'monitoring_stopped',severity:'high',
              title:'Vigilancia detenida',message:`El coordinador dejó de enviar latidos de planificación. Desde ${stoppedSince}.`});
          }
          const latest=await tx.query<Omit<NonNullable<typeof livenessRow>,'database_now'>>(`SELECT state,reason,since,last_scheduler_heartbeat_at,last_check_heartbeat_at,consecutive_failures
            FROM gotchu.monitoring_liveness WHERE organization_id=$1 AND application_id=$2`,[value.organizationId,value.applicationId]);
          if(latest.rows[0]&&livenessRow)livenessRow={...latest.rows[0],database_now:livenessRow.database_now};
          stoppedSince=livenessRow?.since?.toISOString()??stoppedSince;
        }
        const liveness={state:!current?.enabled||app.archived?'unknown':coordinatorStopped||livenessRow?.state==='stopped'?'stopped':livenessRow?.state??'unknown',
          reason:!current?.enabled||app.archived?null:coordinatorStopped&&livenessRow?.state!=='stopped'?'El coordinador dejó de enviar latidos de planificación.':livenessRow?.reason??null,
          since:!current?.enabled||app.archived?null:stoppedSince,
          lastSchedulerHeartbeatAt:livenessRow?.last_scheduler_heartbeat_at?.toISOString()??null,lastCheckHeartbeatAt:livenessRow?.last_check_heartbeat_at?.toISOString()??null,
          consecutiveFailures:livenessRow?.consecutive_failures??0};
        return parse(operationCoverageSchema, { config: current, status: !current?.enabled || app.archived ? 'not_configured' as const : liveness.state === 'stopped' ? 'stopped' as const : !scopeCurrent || full ? 'degraded' as const : expired || liveness.state === 'late' ? 'stale' as const : !last || last.status === 'running' ? 'pending' as const : last.status === 'completed' ? 'active' as const : 'degraded' as const,
          liveness,
          scopeCurrent, lastRun: last ? { runId: last.id, jobId: last.job_id, status: last.status, reason: last.reason, startedAt: last.created_at.toISOString(), finishedAt: last.finished_at?.toISOString() ?? null } : null,
          observations: count.rows[0] ?? { fresh: 0, stale: 0 },
          quotas: { runs: { used: capacity.runs, limit: 1000 }, observations: { used: capacity.observations, limit: 2000, lastDayUsed: capacity.daily, lastDayLimit: 100 }, plans: { used: capacity.plans, limit: 100 } },
          limitations: ['Scheduled checks cover only selected inputs; uninspected paths remain unknown.', 'A sent notification means the provider accepted it, not that a person read it.', 'Runtime event telemetry is a separate integration.', 'Provider status reports do not establish application impact.',
            ...(capacity.runs >= 1000 ? ['El historial de ejecuciones llegó al límite; la limpieza durable eliminará las más antiguas antes del próximo turno.'] : []),
            ...(capacity.observations >= 2000 ? ['El historial de observaciones llegó al límite; la limpieza durable eliminará las más antiguas.'] : []),
            ...(capacity.daily >= 100 ? ['Se alcanzó el límite diario de proyecciones; las detecciones autenticadas se aceptan y procesan aunque esta vista quede incompleta.'] : []),
            ...(capacity.plans >= 100 ? ['Se alcanzó el límite de planes; la limpieza durable elimina los más antiguos para dejar espacio.'] : []),
            ...gaps.rows.map(gap => `${gap.capability}: ${gap.reason}. Operator reconciliation is required; some alerts were not projected.`)] });
      });
    },
    async createPlan(identity: Identity, input: OperationPlanRequest) {
      const value = parse(operationPlanRequestSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writes); await application(tx, value, true);
        const evidence = await observations(tx, value, value.observationIds);
        if (evidence.some(e => !e.fresh)) throw new BackendError('evidence_stale', 'Refresh observations before generating a plan', 409);
        if (value.kind === 'investigate_capacity' && !evidence.some(e => e.kind === 'traffic_pressure' && e.metrics && (e.metrics.errorCount > 0 || (e.metrics.latencyP95Ms ?? 0) > 1000 || (e.metrics.capacityUtilization ?? 0) > 0.8))) throw new BackendError('capacity_evidence_required', 'Load-balancing assessment requires observed errors, latency pressure or capacity pressure; traffic volume alone is insufficient', 409);
        if (value.kind === 'migration_readiness' && !evidence.some(e => e.kind === 'upstream_outage')) throw new BackendError('upstream_evidence_required', 'Migration readiness requires an upstream status observation', 409);
        const count = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM gotchu.operation_plans WHERE organization_id=$1 AND application_id=$2', [value.organizationId, value.applicationId]);
        if ((count.rows[0]?.count ?? 100) >= 100) throw new BackendError('plan_capacity_exceeded', 'Plan storage admission is full', 429);
        const steps = value.kind === 'migration_readiness' ? [
          step('inventory', 'Inventory services, domains, dependencies, storage, owners and actual upstream impact.'),
          step('data', 'Define data export, consistency, encryption, transfer and restore validation; prove recovery objectives.'),
          step('secrets', 'Inventory secret references and destination provisioning; never paste secrets into this plan.'),
          step('destination', 'Review destination compatibility, region, capacity, permissions and independent capability checks.'),
          step('cost', 'Compare destination operating costs, migration costs and approved spending limits.'),
          step('health', 'Define application health checks and independently validate destination behavior before traffic.'),
          step('rollback', 'Document rollback triggers, data divergence handling and an independently tested recovery path.'),
          step('cutover', 'Define staged traffic cutover, exact changes, owner decision and separate verified approval gates.'),
        ] : value.kind === 'investigate_capacity' ? [step('capacity', 'Investigate observed error, latency and capacity pressure; distinguish genuine demand from attack before selecting a load-balancing design.'), step('inventory', 'Map application replicas, stateful dependencies and existing traffic distribution.'), step('cost', 'Estimate bounded capacity options and their cost before recommending changes.'), step('validation', 'Test the proposed design and rollback in an isolated environment; no production writes are authorized.')] : [step('inventory', 'Review the referenced finding and its exact affected source, component or public endpoint.'), step('validation', 'Prepare an exact correction candidate with relevant tests and independent rescan evidence; unknown safety remains explicit.'), step('rollback', 'Document reversal and review requirements before requesting any write capability.')];
        const now = new Date().toISOString();
        const body = { organizationId: value.organizationId, applicationId: value.applicationId, id: randomUUID(), kind: value.kind, revision: 1, state: 'draft' as const, observationIds: [...new Set(value.observationIds)].sort(), steps,
          limitations: ['Advisory preparation only; no provider changes are performed.', 'Incident severity never expands permissions.', 'Self-reported checklist completion is not independent verification.', ...(value.kind === 'migration_readiness' ? ['Upstream outage is reported; application impact remains unverified.'] : [])], createdAt: now, updatedAt: now, execution: 'disabled' as const };
        const plan = parse(operationPlanSchema, { ...body, actionHash: planHash(body) });
        await tx.query('INSERT INTO gotchu.operation_plans(organization_id,application_id,id,revision,action_hash,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [value.organizationId, value.applicationId, plan.id, plan.revision, plan.actionHash, JSON.stringify(plan)]);
        await audit(tx, value.organizationId, identity.userId, 'operation_plan.created', plan.id, { actionHash: plan.actionHash });
        return plan;
      });
    },
    async listPlans(identity: Identity, input: Scope & { limit?: number }) {
      const value = parse(listSchema, input);
      return deps.database.tenant(value.organizationId, async tx => { await authorize(tx, value.organizationId, identity); await application(tx, value);
        const result = await tx.query<{ body: unknown }>('SELECT body FROM gotchu.operation_plans WHERE organization_id=$1 AND application_id=$2 ORDER BY updated_at DESC,id LIMIT $3', [value.organizationId, value.applicationId, value.limit]);
        return result.rows.map(row => parse(operationPlanSchema, row.body));
      });
    },
    async requestPreparation(identity: Identity, input: OperationPlanBinding) {
      const value = parse(operationPlanBindingSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writes); await application(tx, value, true);
        const old = await loadPlan(tx, value); checkBinding(old, value);
        if ((await observations(tx, value, old.observationIds)).some(e => !e.fresh)) throw new BackendError('evidence_stale', 'Refresh evidence before requesting preparation', 409);
        if (old.state === 'preparation_requested') return old;
        const { actionHash: _hash, ...body } = old;
        const content = { ...body, state: 'preparation_requested' as const, revision: old.revision + 1, updatedAt: new Date().toISOString() };
        const plan = parse(operationPlanSchema, { ...content, actionHash: planHash(content) });
        await savePlan(tx, plan); await audit(tx, value.organizationId, identity.userId, 'operation_plan.preparation_requested', plan.id, { actionHash: plan.actionHash });
        return plan;
      });
    },
    async attestStep(identity: Identity, input: OperationPlanBinding & { key: z.infer<typeof operationPlanStepSchema>['key']; attestation: string }) {
      const value = parse(operationPlanBindingSchema.extend({ key: operationPlanStepSchema.shape.key, attestation: z.string().min(1).max(2000) }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, writes); await application(tx, value, true);
        const old = await loadPlan(tx, value); checkBinding(old, value);
        if (!old.steps.some(s => s.key === value.key)) throw new BackendError('invalid_input', 'This step is not part of the plan');
        const { actionHash: _hash, ...body } = old;
        const content = { ...body, state: 'draft' as const, revision: old.revision + 1, updatedAt: new Date().toISOString(), steps: old.steps.map(s => s.key === value.key ? { ...s, state: 'self_reported' as const, attestation: value.attestation } : s) };
        const plan = parse(operationPlanSchema, { ...content, actionHash: planHash(content) });
        await savePlan(tx, plan); await audit(tx, value.organizationId, identity.userId, 'operation_plan.attested', plan.id, { key: value.key, verification: 'self_reported', actionHash: plan.actionHash });
        return plan;
      });
    },
    async checkReadiness(identity: Identity, input: OperationPlanBinding) {
      const value = parse(operationPlanBindingSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity); await application(tx, value);
        const plan = await loadPlan(tx, value); checkBinding(plan, value);
        const evidence = await observations(tx, value, plan.observationIds);
        return parse(operationReadinessSchema, { planId: plan.id, revision: plan.revision, actionHash: plan.actionHash, ready: false, execution: 'disabled', requirements: [...(evidence.some(e => !e.fresh) ? ['Referenced observation evidence has expired.'] : []), ...plan.steps.filter(s => s.state === 'todo').map(s => `Prepare ${s.key} evidence.`), ...executionRequirements] });
      });
    },
    async requestExecution(identity: Identity, input: OperationPlanBinding): Promise<never> {
      const value = parse(operationPlanBindingSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner']); await application(tx, value, true);
        const plan = await loadPlan(tx, value); checkBinding(plan, value);
        throw new BackendError('operation_execution_unavailable', executionRequirements.join(' '), 409);
      });
    },
  };
}
