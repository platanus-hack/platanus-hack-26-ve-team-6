import { createHash, randomUUID } from 'node:crypto';
import { correlate, revise, correlationWindowInputSchema, providerStatusInputSchema, httpsProbeSchema, type CorrelationWindowInput } from '@gotchu/triage';
import { operationObservationSchema, securityEventSchema } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';

type MetricObservation = {
  id: string;
  body: { kind: string; observedAt: string; metrics: { windowStartedAt: string; windowEndedAt: string; requestCount: number; errorCount: number; latencyP95Ms: number | null; capacityUtilization: number | null } | null };
  acceptedAt: string;
  eventAt?: string;
  service?: string;
  environment?: string;
  release?: string;
  route?: string;
};

function average(values: number[]): number | undefined {
  return values.length >= 3 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectRecentDistinct<T>(input: {
  values: readonly T[];
  key: (value: T) => string;
  observedAt: (value: T) => string;
  limit: number;
  priority?: (value: T) => number;
}) {
  const sorted = [...input.values].sort((left, right) => Date.parse(input.observedAt(right)) - Date.parse(input.observedAt(left))
    || (input.priority?.(left) ?? 0) - (input.priority?.(right) ?? 0)
    || compareText(input.key(left), input.key(right)));
  const distinct = new Map<string, T>();
  for (const value of sorted) {
    const key = input.key(value);
    if (!distinct.has(key)) distinct.set(key, value);
  }
  const values = [...distinct.values()];
  return { values: values.slice(0, input.limit), omitted: Math.max(0, values.length - input.limit) };
}

export function buildCorrelationInput(input: {
  now: Date;
  observations: readonly MetricObservation[];
  providerStatuses?: readonly unknown[];
  probes?: readonly unknown[];
  context?: CorrelationWindowInput['context'];
  anomalies?: readonly string[];
  windowMs?: number;
}): CorrelationWindowInput {
  const windowMs = input.windowMs ?? 30 * 60_000;
  const endMs = input.now.getTime();
  const startMs = endMs - windowMs;
  const startedAt = new Date(startMs).toISOString();
  const endedAt = new Date(endMs).toISOString();
  const observations = input.observations.filter(item => item.body.metrics
    && Date.parse(item.eventAt ?? item.body.metrics.windowEndedAt) >= Date.parse(startedAt));
  type Metric = 'error_rate' | 'latency_ms' | 'request_rate' | 'resource_utilization';
  type Series = { id: string; metric: Metric; service: string; environment: string; samples: { eventAt: string; acceptedAt: string; value: number }[] };
  const grouped = new Map<string, Series>();
  for (const item of observations) {
    const metrics = item.body.metrics;
    if (!metrics) continue;
    const service = item.service ?? 'application';
    const environment = item.environment ?? 'application';
    const dimensions = [service, environment, item.release ?? '', item.route ?? ''].join('\0');
    const measures: Array<[Metric, number | null]> = [
      ['error_rate', metrics.requestCount ? metrics.errorCount / metrics.requestCount : null],
      ['latency_ms', metrics.latencyP95Ms],
      ['request_rate', metrics.requestCount / Math.max(1, (Date.parse(metrics.windowEndedAt) - Date.parse(metrics.windowStartedAt)) / 1000)],
      ['resource_utilization', metrics.capacityUtilization],
    ];
    for (const [metric, value] of measures) {
      if (value === null || !Number.isFinite(value)) continue;
      const key = `${metric}\0${dimensions}`;
      let series = grouped.get(key);
      if (!series) {
        const suffix = createHash('sha256').update(dimensions).digest('hex').slice(0, 12);
        series = { id: `${metric}:${suffix}`, metric, service, environment, samples: [] };
        grouped.set(key, series);
      }
      series.samples.push({ eventAt: item.eventAt ?? metrics.windowEndedAt, acceptedAt: item.acceptedAt, value });
    }
  }
  const signals = [...grouped.values()].map(series => ({
    ...series,
    sampling: 1,
    freshnessMs: 15 * 60_000,
  }));
  const baselineRows = new Map<string, { service: string; environment: string; error: number[]; latency: number[]; requests: number[]; resource: number[] }>();
  for (const item of input.observations) {
    const metrics = item.body.metrics;
    if (!metrics || !item.service || !item.environment
      || Date.parse(item.eventAt ?? metrics.windowEndedAt) >= Date.parse(startedAt)) continue;
    const key = `${item.service}\0${item.environment}`;
    const row = baselineRows.get(key) ?? { service: item.service, environment: item.environment, error: [], latency: [], requests: [], resource: [] };
    if (metrics.requestCount) row.error.push(metrics.errorCount / metrics.requestCount);
    if (metrics.latencyP95Ms !== null) row.latency.push(metrics.latencyP95Ms);
    row.requests.push(metrics.requestCount / Math.max(1, (Date.parse(metrics.windowEndedAt) - Date.parse(metrics.windowStartedAt)) / 1000));
    if (metrics.capacityUtilization !== null) row.resource.push(metrics.capacityUtilization);
    baselineRows.set(key, row);
  }
  const baselines = [...baselineRows.values()].flatMap(row => {
    const errorRate = average(row.error); const latencyMs = average(row.latency);
    const requestRate = average(row.requests); const resourceUtilization = average(row.resource);
    return errorRate !== undefined && latencyMs !== undefined && requestRate !== undefined && resourceUtilization !== undefined
      ? [{ service: row.service, environment: row.environment, errorRate, latencyMs, requestRate, resourceUtilization, authFailures: 0 }]
      : [];
  });
  const providerStartMs = Math.max(startMs, endMs - 30 * 60_000);
  const parsedProviderStatuses = (input.providerStatuses ?? []).map(value => providerStatusInputSchema.parse(value))
    .filter(status => Date.parse(status.observedAt) >= providerStartMs && Date.parse(status.observedAt) <= endMs);
  const providerSelection = selectRecentDistinct({
    values: parsedProviderStatuses,
    key: status => JSON.stringify([status.provider, status.scope, status.component, status.region, status.fixture]),
    observedAt: status => status.observedAt,
    limit: 100,
    priority: status => status.scope === 'global' ? 0 : status.scope === 'regional' ? 1 : 2,
  });
  const parsedProbes = (input.probes ?? []).map(value => httpsProbeSchema.parse(value))
    .filter(probe => Date.parse(probe.at) >= startMs && Date.parse(probe.at) <= endMs);
  const probeSelection = selectRecentDistinct({
    values: parsedProbes,
    key: probe => JSON.stringify([probe.route, probe.service, probe.dependsOnProvider, probe.role]),
    observedAt: probe => probe.at,
    limit: 200,
  });
  const anomalies = [...(input.anomalies ?? [])];
  if (providerSelection.omitted > 0) anomalies.push(`Provider status coverage is incomplete: ${providerSelection.omitted} distinct recent inputs omitted at the 100-record limit.`);
  if (probeSelection.omitted > 0) anomalies.push(`HTTPS probe coverage is incomplete: ${probeSelection.omitted} distinct recent inputs omitted at the 200-record limit.`);
  return correlationWindowInputSchema.parse({ window: { startedAt, endedAt }, ...(input.context ? { context: input.context } : {}), signals,
    providerStatuses: providerSelection.values, probes: probeSelection.values, baselines, anomalies });
}

export function hasCorrelationEvidence(input: CorrelationWindowInput) {
  return input.signals.length > 0 || input.providerStatuses.length > 0 || input.probes.length > 0;
}

function commonAttribute(events: readonly ReturnType<typeof securityEventSchema.parse>[], key: 'service' | 'release' | 'route', complete: boolean) {
  if (!complete) return undefined;
  const values = events.map(event => event.attributes[key]);
  if (!values.length || values.some(value => typeof value !== 'string') || new Set(values).size !== 1) return undefined;
  const value = values[0];
  return typeof value === 'string' ? value : undefined;
}

function latestEventTime(events: readonly ReturnType<typeof securityEventSchema.parse>[]) {
  return events.map(event => event.occurredAt).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

export async function evaluateTriage(tx: Transaction, scope: { organizationId: string; applicationId: string }, now = new Date()) {
  const observations = await tx.query<{ id: string; body: unknown; basis: unknown; accepted_at: Date }>(`SELECT id,body,basis,created_at AS accepted_at FROM gotchu.operation_observations
    WHERE organization_id=$1 AND application_id=$2 AND created_at>clock_timestamp()-interval '7 days' ORDER BY created_at DESC LIMIT 500`, [scope.organizationId, scope.applicationId]);
  const structured = await tx.query<{ kind: string; payload: unknown }>(`SELECT kind,payload FROM gotchu.triage_inputs
    WHERE organization_id=$1 AND application_id=$2 AND observed_at>clock_timestamp()-interval '7 days' ORDER BY observed_at DESC LIMIT 300`, [scope.organizationId, scope.applicationId]);
  const context = await loadContext(tx, scope);
  const serviceRows = await tx.query<{ name: string; environment: string }>(`SELECT s.name,e.name AS environment FROM gotchu.application_services s
    JOIN gotchu.application_environments e ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id
    WHERE s.organization_id=$1 AND s.application_id=$2 AND NOT e.archived`, [scope.organizationId, scope.applicationId]);
  const environmentsByService = new Map<string, Set<string>>();
  for (const row of serviceRows.rows) {
    const names = environmentsByService.get(row.name) ?? new Set<string>();
    names.add(row.environment);
    environmentsByService.set(row.name, names);
  }
  const environmentByService = new Map<string, string>();
  for (const [name, names] of environmentsByService) {
    if (names.size !== 1) continue;
    const environment = names.values().next().value;
    if (environment) environmentByService.set(name, environment);
  }
  const observationIds = observations.rows.map(row => row.id);
  const eventsByObservation = new Map<string, ReturnType<typeof securityEventSchema.parse>[]>();
  if (observationIds.length) {
    const eventRows = await tx.query<{ observation_id: string; payload: unknown }>(`SELECT o.id AS observation_id,e.payload FROM gotchu.operation_observations o
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(o.basis->'eventIds','[]'::jsonb)) refs(event_id)
      JOIN gotchu.events e ON e.organization_id=o.organization_id AND e.application_id=o.application_id AND e.id=refs.event_id::uuid
      WHERE o.organization_id=$1 AND o.application_id=$2 AND o.id=ANY($3::uuid[]) LIMIT 10000`, [scope.organizationId, scope.applicationId, observationIds]);
    for (const row of eventRows.rows) {
      const events = eventsByObservation.get(row.observation_id) ?? [];
      events.push(securityEventSchema.parse(row.payload));
      eventsByObservation.set(row.observation_id, events);
    }
  }
  const metricObservations = observations.rows.map(row => {
    const body = operationObservationSchema.parse(row.body);
    const events = eventsByObservation.get(row.id) ?? [];
    const completeLabels = body.metrics !== null && events.length === body.metrics.requestCount;
    const declaredService = commonAttribute(events, 'service', completeLabels);
    const environment = declaredService ? environmentByService.get(declaredService) : undefined;
    const service = environment ? declaredService : undefined;
    const release = commonAttribute(events, 'release', completeLabels);
    const route = commonAttribute(events, 'route', completeLabels);
    const eventAt = latestEventTime(events);
    return { id: row.id, body: { kind: body.kind, observedAt: body.observedAt, metrics: body.metrics }, acceptedAt: row.accepted_at.toISOString(),
      ...(eventAt ? { eventAt } : {}),
      ...(service && environment ? { service, environment } : {}), ...(release ? { release } : {}), ...(route ? { route } : {}) };
  });
  const input = buildCorrelationInput({ now, context, providerStatuses: structured.rows.filter(row => row.kind === 'provider_status').map(row => row.payload),
    probes: structured.rows.filter(row => row.kind === 'https_probe').map(row => row.payload), observations: metricObservations });
  if (!hasCorrelationEvidence(input)) return;
  const first = correlate(input, { now, rulesVersion: 'triage.rules.v1' });
  const environment = input.context?.environment ?? 'production';
  const active = await tx.query<{ id: string; last_evidence_at: Date; revision_body: unknown }>(`SELECT i.id,i.last_evidence_at,r.body AS revision_body FROM gotchu.triage_incidents i
    LEFT JOIN LATERAL(SELECT body FROM gotchu.triage_revisions WHERE organization_id=i.organization_id AND application_id=i.application_id AND incident_id=i.id ORDER BY revision DESC LIMIT 1)r ON true
    WHERE i.organization_id=$1 AND i.application_id=$2 AND i.environment=$3 AND i.status<>'closed' AND i.last_evidence_at>clock_timestamp()-interval '2 hours'
    ORDER BY i.last_evidence_at DESC LIMIT 1`, [scope.organizationId, scope.applicationId, environment]);
  const current = active.rows[0]; const prior = current?.revision_body ? JSON.parse(JSON.stringify(current.revision_body)) : null;
  const revision = prior ? revise(prior, input, { now, rulesVersion: 'triage.rules.v1' }) : first; const incidentId = current?.id ?? randomUUID();
  const evidenceRefs = [...observations.rows.map(row => row.id), ...revision.impact.checkedPoints, ...revision.hypotheses.flatMap(hypothesis => [...hypothesis.evidenceFor, ...hypothesis.evidenceAgainst])]
    .map(item => typeof item === 'string' ? item : item.ref).slice(0, 500);
  await tx.query('SELECT gotchu.triage_insert_revision($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)', [scope.organizationId, scope.applicationId, incidentId,
    randomUUID(), environment, revision.impact.window.startedAt, revision.impact.window.endedAt, JSON.stringify(revision), JSON.stringify(evidenceRefs)]);
}

async function loadContext(tx: Transaction, scope: { organizationId: string; applicationId: string }): Promise<CorrelationWindowInput['context']> {
  const result = await tx.query<{ environment: string | null; deployments: unknown; dependencies: unknown }>(`SELECT
    (SELECT name FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1) AS environment,
    coalesce((SELECT jsonb_agg(jsonb_build_object('service',s.name,'releaseId',d.release_id,'commit',d.commit_sha,'deployedAt',to_char(d.deployed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state',d.state) ORDER BY d.deployed_at DESC)
      FROM gotchu.application_deployments d JOIN gotchu.application_services s ON s.organization_id=d.organization_id AND s.application_id=d.application_id AND s.id=d.service_id
      WHERE d.organization_id=$1 AND d.application_id=$2 AND d.environment_id=(SELECT id FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1)),'[]'::jsonb) AS deployments,
    coalesce((SELECT jsonb_agg(jsonb_build_object('service',s.name,'provider',d.provider,'component',d.component,'region',d.region,'state',d.state))
      FROM gotchu.application_dependencies d JOIN gotchu.application_services s ON s.organization_id=d.organization_id AND s.application_id=d.application_id AND s.id=d.service_id
      WHERE d.organization_id=$1 AND d.application_id=$2 AND d.environment_id=(SELECT id FROM gotchu.application_environments WHERE organization_id=$1 AND application_id=$2 AND archived=false ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END,created_at LIMIT 1)),'[]'::jsonb) AS dependencies`, [scope.organizationId, scope.applicationId]);
  const row = result.rows[0];
  if (!row) return undefined;
  const deployments = Array.isArray(row.deployments) ? row.deployments : [];
  const dependencies = Array.isArray(row.dependencies) ? row.dependencies : [];
  if (row.environment === null && deployments.length === 0 && dependencies.length === 0) return undefined;
  return correlationWindowInputSchema.shape.context.parse({ ...(row.environment ? { environment: row.environment } : {}), service: 'application', deployments, dependencies });
}
