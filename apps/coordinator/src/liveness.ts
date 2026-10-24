import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@gotchu/database';
import { enqueueNotificationEvent } from '@gotchu/backend';

const failureThreshold = 3;
const schedulerGraceMs = 30_000;
const leaseGraceMs = 30_000;

type MonitorRow = {
  application_id: string;
  interval_seconds: number;
  next_due_at: Date;
  monitor_updated_at: Date;
  run_status: string | null;
  run_reason: string | null;
  run_created_at: Date | null;
  run_finished_at: Date | null;
  run_lease_until: Date | null;
  recent_statuses: string[] | null;
  failure_since: Date | null;
  previous_state: string | null;
  previous_reason: string | null;
  previous_since: Date | null;
  last_check_heartbeat_at: Date | null;
  previous_failures: number | null;
  database_now: Date;
};

type DerivedState = {
  state: 'unknown' | 'healthy' | 'late' | 'stopped';
  reason: string | null;
  since: Date | null;
  consecutiveFailures: number;
};

export function deriveMonitoringLiveness(input: {
  now: Date;
  schedulerHeartbeatAt: Date | null;
  monitorUpdatedAt: Date;
  nextDueAt: Date;
  intervalSeconds: number;
  runStatus: string | null;
  runReason: string | null;
  runCreatedAt: Date | null;
  runFinishedAt: Date | null;
  runLeaseUntil: Date | null;
  recentStatuses: readonly string[];
  failureSince: Date | null;
  previous: { state: string | null; reason: string | null; since: Date | null; consecutiveFailures: number | null };
}): DerivedState {
  let consecutiveFailures = 0;
  for (const status of input.recentStatuses.slice(0, failureThreshold)) {
    if (status !== 'degraded') break;
    consecutiveFailures += 1;
  }
  const intervalMs = input.intervalSeconds * 1000;
  const heartbeatAt = input.schedulerHeartbeatAt ?? input.monitorUpdatedAt;
  const schedulerAgeMs = input.now.getTime() - heartbeatAt.getTime();
  const overdueAt = new Date(input.nextDueAt.getTime() + intervalMs);
  const stopAt = new Date(input.nextDueAt.getTime() + intervalMs * 2);
  let next: DerivedState = { state: 'healthy', reason: null, since: null, consecutiveFailures };

  if (consecutiveFailures >= failureThreshold) {
    next = { state: 'stopped', reason: `Las últimas ${failureThreshold} comprobaciones terminaron con fallos. ${input.runReason ?? 'Revisa la conexión y el alcance configurado.'}`,
      since: input.failureSince ?? input.runFinishedAt ?? input.runCreatedAt ?? input.now, consecutiveFailures };
  } else if (input.runStatus === 'running' && input.runLeaseUntil && input.runLeaseUntil.getTime() + leaseGraceMs < input.now.getTime()) {
    next = { state: 'stopped', reason: 'La última comprobación perdió su concesión y no se reanudó.', since: new Date(input.runLeaseUntil.getTime() + leaseGraceMs), consecutiveFailures };
  } else if (input.now.getTime() >= stopAt.getTime()) {
    const schedulerStopped = schedulerAgeMs > schedulerGraceMs;
    next = { state: 'stopped', reason: schedulerStopped ? 'El coordinador dejó de enviar latidos de planificación.' : 'No se ejecutaron comprobaciones dentro del umbral esperado.',
      since: schedulerStopped ? new Date(heartbeatAt.getTime() + schedulerGraceMs) : stopAt, consecutiveFailures };
  } else if (schedulerAgeMs > schedulerGraceMs) {
    next = { state: 'stopped', reason: 'El coordinador dejó de enviar latidos de planificación.', since: new Date(heartbeatAt.getTime() + schedulerGraceMs), consecutiveFailures };
  } else if (input.runStatus === 'degraded') {
    next = { state: 'late', reason: `La última comprobación terminó de forma incompleta. ${input.runReason ?? ''}`.trim(), since: input.runFinishedAt ?? input.runCreatedAt ?? input.now, consecutiveFailures };
  } else if (input.now.getTime() >= overdueAt.getTime()) {
    next = { state: 'late', reason: 'La siguiente comprobación se está ejecutando con retraso.', since: overdueAt, consecutiveFailures };
  } else if (input.runStatus === null && input.now.getTime() - input.monitorUpdatedAt.getTime() > schedulerGraceMs) {
    next = { state: 'late', reason: 'La vigilancia espera su primera comprobación programada.', since: input.monitorUpdatedAt, consecutiveFailures };
  }

  if (next.state === input.previous.state && next.state !== 'healthy' && input.previous.since) next.since = input.previous.since;
  if (next.state === 'late' && input.previous.state === 'stopped') next.since = input.previous.since ?? next.since;
  if (input.previous.state === 'stopped' && input.previous.since
    && (input.runStatus !== 'completed' || !input.runFinishedAt || input.runFinishedAt.getTime() <= input.previous.since.getTime())) {
    next = { state: 'stopped', reason: input.previous.reason ?? next.reason ?? 'La comprobación programada no se ha recuperado.', since: input.previous.since, consecutiveFailures };
  }
  return next;
}

export async function recordSchedulerHeartbeat(database: Database, coordinatorId: string) {
  await database.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query(`
    INSERT INTO gotchu.coordinator_heartbeats(coordinator_id,heartbeat_at) VALUES($1,clock_timestamp())
    ON CONFLICT(coordinator_id) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at`, [coordinatorId]));
}

async function inspectOrganization(database: Database, organizationId: string, schedulerHeartbeatAt: Date | null) {
  const rows = await database.tenant(organizationId, tx => tx.query<MonitorRow>(`SELECT clock_timestamp() AS database_now,m.application_id,m.interval_seconds,m.next_due_at,m.updated_at AS monitor_updated_at,
      run.status AS run_status,run.reason AS run_reason,run.created_at AS run_created_at,run.finished_at AS run_finished_at,run.lease_until AS run_lease_until,
      recent.recent_statuses,recent.failure_since,l.state AS previous_state,l.reason AS previous_reason,l.since AS previous_since,
      l.last_check_heartbeat_at,l.consecutive_failures AS previous_failures
    FROM gotchu.operation_monitors m
    LEFT JOIN LATERAL (SELECT r.status,r.reason,r.created_at,r.finished_at,r.lease_until FROM gotchu.operation_runs r
      WHERE r.organization_id=m.organization_id AND r.application_id=m.application_id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) run ON true
    LEFT JOIN LATERAL (SELECT array_agg(x.status ORDER BY x.created_at DESC) AS recent_statuses,
        CASE WHEN count(*)=3 AND bool_and(x.status='degraded') THEN min(x.finished_at) END AS failure_since
      FROM (SELECT r.status,r.created_at,r.finished_at FROM gotchu.operation_runs r WHERE r.organization_id=m.organization_id AND r.application_id=m.application_id
        AND r.status IN ('completed','degraded') ORDER BY r.created_at DESC,r.id DESC LIMIT 3) x) recent ON true
    LEFT JOIN gotchu.monitoring_liveness l ON l.organization_id=m.organization_id AND l.application_id=m.application_id
    WHERE m.organization_id=$1 AND m.enabled ORDER BY m.application_id LIMIT 500`, [organizationId]));

  for (const row of rows.rows) {
    const next = deriveMonitoringLiveness({ now:row.database_now, schedulerHeartbeatAt, monitorUpdatedAt:row.monitor_updated_at,nextDueAt:row.next_due_at,
      intervalSeconds:row.interval_seconds,runStatus:row.run_status,runReason:row.run_reason,runCreatedAt:row.run_created_at,
      runFinishedAt:row.run_finished_at,runLeaseUntil:row.run_lease_until,recentStatuses:row.recent_statuses??[],failureSince:row.failure_since,
      previous:{state:row.previous_state,reason:row.previous_reason,since:row.previous_since,consecutiveFailures:row.previous_failures} });
    await database.tenant(organizationId, async tx => {
      await persistLiveness(tx, organizationId, row, schedulerHeartbeatAt, next);
    });
  }
}

async function persistLiveness(tx: Transaction, organizationId: string, row: MonitorRow, schedulerHeartbeatAt: Date | null, next: DerivedState) {
  const previousState = row.previous_state ?? 'unknown';
  const since = next.state === 'late' || next.state === 'stopped' ? next.since : null;
  await tx.query(`INSERT INTO gotchu.monitoring_liveness(organization_id,application_id,state,reason,since,last_scheduler_heartbeat_at,last_check_heartbeat_at,consecutive_failures)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,application_id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,since=EXCLUDED.since,
    last_scheduler_heartbeat_at=EXCLUDED.last_scheduler_heartbeat_at,last_check_heartbeat_at=EXCLUDED.last_check_heartbeat_at,
    consecutive_failures=EXCLUDED.consecutive_failures,updated_at=clock_timestamp()`,
  [organizationId,row.application_id,next.state,next.reason,since,schedulerHeartbeatAt,row.last_check_heartbeat_at,next.consecutiveFailures]);

  if (next.state === 'stopped' && previousState !== 'stopped') {
    const sinceKey = (since ?? new Date()).toISOString();
    await enqueueNotificationEvent(tx,{organizationId,applicationId:row.application_id,eventKey:`monitoring-stopped:${row.application_id}:${sinceKey}`,
      eventKind:'monitoring_stopped',severity:'high',title:'Vigilancia detenida',message:`${next.reason ?? 'La comprobación programada no está funcionando.'} Desde ${sinceKey}.`});
  } else if (previousState === 'stopped' && next.state === 'healthy') {
    const stoppedSince = row.previous_since?.toISOString() ?? 'unknown';
    await enqueueNotificationEvent(tx,{organizationId,applicationId:row.application_id,eventKey:`monitoring-recovered:${row.application_id}:${stoppedSince}`,
      eventKind:'monitoring_recovered',severity:'medium',title:'Vigilancia reanudada',message:'La comprobación programada volvió a completarse correctamente.'});
  }
}

export async function inspectMonitoringLiveness(database: Database, organizationIds: readonly string[]) {
  const heartbeat = await database.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query<{ heartbeat_at: Date | null }>('SELECT max(heartbeat_at) AS heartbeat_at FROM gotchu.coordinator_heartbeats'));
  const schedulerHeartbeatAt = heartbeat.rows[0]?.heartbeat_at ?? null;
  for (const organizationId of organizationIds) await inspectOrganization(database, organizationId, schedulerHeartbeatAt);
}
