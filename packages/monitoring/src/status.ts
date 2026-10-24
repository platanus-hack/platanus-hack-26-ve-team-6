import { z } from 'zod';
import { MONITORING_ADAPTER_VERSION, type MonitoringCandidate, type MonitoringEvidence, type ProviderStatusObservation } from './types.js';
import { parseJsonBody, requestJson } from './http.js';
import { sha256 } from './source.js';

export const STATUS_PROVIDER_CATALOG = [
  { key: 'cloudflare', displayName: 'Cloudflare', pageUrl: 'https://www.cloudflarestatus.com/' },
  { key: 'railway', displayName: 'Railway', pageUrl: 'https://status.railway.com/' },
] as const;

const cloudflareIndicator = z.enum(['none', 'minor', 'major', 'critical', 'maintenance']);
const cloudflareComponentStatus = z.enum(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
const cloudflareStatusSchema = z.object({
  page: z.object({ updated_at: z.string().optional() }).passthrough(),
  status: z.object({ indicator: cloudflareIndicator, description: z.string().max(256) }).passthrough(),
  components: z.array(z.object({ name: z.string().min(1).max(256), status: cloudflareComponentStatus, updated_at: z.string().optional() }).passthrough()).max(2000),
  incidents: z.array(z.object({
    id: z.string().max(128).optional(),
    name: z.string().max(512).optional(),
    title: z.string().max(512).optional(),
    status: z.string().max(64),
    impact: z.string().max(64).optional(),
    updated_at: z.string().optional(),
    created_at: z.string().optional(),
  }).passthrough()).max(500),
  scheduled_maintenances: z.array(z.object({
    id: z.string().max(128).optional(),
    name: z.string().max(512).optional(),
    title: z.string().max(512).optional(),
    status: z.string().max(64),
    updated_at: z.string().optional(),
    created_at: z.string().optional(),
  }).passthrough()).max(500).optional(),
}).passthrough();

const railwayDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['none', 'operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']),
}).passthrough();
const railwayComponentSchema = z.object({
  id: z.string().max(128),
  name: z.string().min(1).max(256),
  months: z.array(z.object({ days: z.array(railwayDaySchema).max(35) }).passthrough()).max(24),
}).passthrough();
const railwayStatusSchema = z.object({
  generatedAt: z.string(),
  entries: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('group'),
      data: z.object({
        name: z.string().min(1).max(256),
        components: z.array(railwayComponentSchema).max(500),
      }).passthrough(),
    }).passthrough(),
    z.object({ type: z.literal('component'), data: railwayComponentSchema }).passthrough(),
  ])).max(100),
  activeIncidents: z.array(z.object({
    id: z.string().max(128).optional(),
    title: z.string().min(1).max(512),
    status: z.string().min(1).max(64),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    components: z.array(z.object({ name: z.string().max(256), impact: z.string().max(64).optional() }).passthrough()).max(500).optional(),
  }).passthrough()).max(500),
  maintenances: z.array(z.object({
    id: z.string().max(128).optional(),
    title: z.string().min(1).max(512),
    status: z.string().min(1).max(64),
    scheduledFor: z.string().optional(),
    updatedAt: z.string().optional(),
  }).passthrough()).max(500),
}).passthrough();

export interface ProviderStatusReaderOptions {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  responseMaxBytes?: number;
  ttlMs?: number;
  cloudflareMaxPublishedAgeMs?: number;
  railwayMaxAgeMs?: number;
}

export const providerStatusSelectionSchema = z.array(z.enum(['cloudflare', 'railway']))
  .max(2)
  .refine(values => new Set(values).size === values.length, 'Provider status selections must be unique');
export type ProviderStatusName = z.infer<typeof providerStatusSelectionSchema>[number];
export function parseProviderStatusSelection(input: unknown): ProviderStatusName[] {
  return providerStatusSelectionSchema.parse(input);
}

export function createCloudflareStatusAdapter(options: ProviderStatusReaderOptions = {}) {
  return {
    async read(signal?: AbortSignal): Promise<ProviderStatusObservation> {
      const response = await requestJson(new URL('https://www.cloudflarestatus.com/api/v2/summary.json'), {
        headers: { accept: 'application/json', 'user-agent': 'Gotchu-Monitoring/0.1.0 (+https://developers.cloudflare.com/support/cloudflare-status/)' },
        ...(signal ? { signal } : {}),
        timeoutMs: options.timeoutMs ?? 8000,
        maxBytes: options.responseMaxBytes ?? 1_048_576,
        retries: 1,
        ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      });
      const parsed = cloudflareStatusSchema.parse(parseJsonBody(response.body));
      const collectedAt = (options.now ?? (() => new Date()))().toISOString();
      const publicationCandidates = [
        parsed.page.updated_at,
        ...parsed.components.map(component => component.updated_at),
        ...parsed.incidents.map(incident => incident.updated_at ?? incident.created_at),
        ...(parsed.scheduled_maintenances ?? []).map(item => item.updated_at ?? item.created_at),
      ].filter((value): value is string => Boolean(value));
      const publishedAt = maxTimestamp(publicationCandidates);
      const fresh = isRecent(publishedAt, collectedAt, options.cloudflareMaxPublishedAgeMs ?? 30 * 24 * 60 * 60 * 1000);
      const components = parsed.components.slice(0, 100).map(component => ({ name: cleanText(component.name, 256), status: component.status }));
      const activeItems = [
        ...parsed.incidents.filter(item => isOpenStatus(item.status)).slice(0, 25).map(item => ({ id: uuidOrNull(item.id), title: cleanText(item.title ?? item.name ?? 'Status incident', 512), status: cleanText(item.status, 64) })),
        ...(parsed.scheduled_maintenances ?? []).filter(item => isOpenStatus(item.status)).slice(0, 25).map(item => ({ id: uuidOrNull(item.id), title: cleanText(item.title ?? item.name ?? 'Scheduled maintenance', 512), status: cleanText(item.status, 64) })),
      ];
      const evidence = makeEvidence('cloudflare', 'https://www.cloudflarestatus.com/api/v2/summary.json', response.body, collectedAt);
      const openIncidents = parsed.incidents.some(item => isOpenStatus(item.status));
      const issue = ['minor', 'major', 'critical'].includes(parsed.status.indicator)
        || parsed.components.some(component => component.status !== 'operational' && component.status !== 'under_maintenance')
        || openIncidents;
      const candidate = !fresh
        ? coverageCandidate(evidence, collectedAt, 'The Cloudflare status response was collected, but its publication timestamp is outside the freshness window.', 'coverage_gap', options.ttlMs)
        : issue
          ? statusCandidate('Cloudflare', parsed.status.description, components, activeItems, evidence, collectedAt, options.ttlMs, parsed.status.indicator === 'none' ? undefined : cloudflareSeverity(parsed.status.indicator))
          : coverageCandidate(evidence, collectedAt, 'The fresh Cloudflare status feed reported no current provider outage. This is upstream feed coverage only; it does not establish this application is healthy.', 'coverage_check', options.ttlMs);
      const limitations = ['A public provider status page is upstream context only; it does not verify impact on this application.'];
      if (!fresh) limitations.push('The newest publication timestamp on the status feed is older than the configured freshness window.');
      if (parsed.components.length > components.length) limitations.push('Component evidence was limited to the first 100 current components.');
      return {
        provider: 'cloudflare',
        pageUrl: 'https://www.cloudflarestatus.com/',
        collectedAt,
        publishedAt,
        fresh,
        components,
        activeItems,
        evidence,
        candidate,
        limitations,
      };
    },
  };
}

export function createRailwayStatusAdapter(options: ProviderStatusReaderOptions = {}) {
  return {
    async read(signal?: AbortSignal): Promise<ProviderStatusObservation> {
      // This is the live JSON route used by Railway's status page, not a legacy Statuspage v2 endpoint.
      const response = await requestJson(new URL('https://status.railway.com/api/status'), {
        headers: { accept: 'application/json', 'user-agent': 'Gotchu-Monitoring/0.1.0 (+https://status.railway.com/)' },
        ...(signal ? { signal } : {}),
        timeoutMs: options.timeoutMs ?? 8000,
        maxBytes: options.responseMaxBytes ?? 1_048_576,
        retries: 1,
        ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      });
      const parsed = railwayStatusSchema.parse(parseJsonBody(response.body));
      const collectedAt = (options.now ?? (() => new Date()))().toISOString();
      const publishedAt = validTimestamp(parsed.generatedAt);
      const fresh = isRecent(publishedAt, collectedAt, options.railwayMaxAgeMs ?? 15 * 60 * 1000);
      const generatedDay = publishedAt?.slice(0, 10) ?? '';
      const components = flattenRailwayComponents(parsed.entries).map(component => ({
        name: component.group ? cleanText(component.group + ' / ' + component.data.name, 256) : cleanText(component.data.name, 256),
        status: statusForRailwayDay(component.data, generatedDay),
      }));
      const activeItems = [
        ...parsed.activeIncidents.filter(item => isOpenStatus(item.status)).slice(0, 25).map(item => ({ id: uuidOrNull(item.id), title: cleanText(item.title, 512), status: cleanText(item.status, 64) })),
        ...parsed.maintenances.filter(item => isOpenStatus(item.status)).slice(0, 25).map(item => ({ id: uuidOrNull(item.id), title: cleanText(item.title, 512), status: cleanText(item.status, 64) })),
      ];
      const evidence = makeEvidence('railway', 'https://status.railway.com/api/status', response.body, collectedAt);
      const unknownComponents = components.some(component => component.status === 'unknown');
      const issue = components.some(component => ['degraded_performance', 'partial_outage', 'major_outage'].includes(component.status))
        || parsed.activeIncidents.some(item => isOpenStatus(item.status));
      const candidate = !fresh
        ? coverageCandidate(evidence, collectedAt, 'The Railway status response was collected, but generatedAt is outside the freshness window.', 'coverage_gap', options.ttlMs)
        : unknownComponents
          ? coverageCandidate(evidence, collectedAt, 'The fresh Railway status feed did not include a current-day status for every component; coverage is incomplete.', 'coverage_gap', options.ttlMs)
          : issue
            ? statusCandidate('Railway', 'Public status feed generated at ' + (publishedAt ?? 'unknown publication time'), components, activeItems, evidence, collectedAt, options.ttlMs)
            : coverageCandidate(evidence, collectedAt, 'The fresh Railway status feed reported no current provider outage. This is upstream feed coverage only; it does not establish this application is healthy.', 'coverage_check', options.ttlMs);
      const limitations = ['A public provider status page is upstream context only; it does not verify impact on this application.'];
      if (!fresh) limitations.push('The status feed publication timestamp is outside the configured freshness window; a coverage gap was recorded and no provider outage was inferred.');
      if (components.some(component => component.status === 'unknown')) limitations.push('One or more components had no current-day status record; that coverage remains unknown.');
      return {
        provider: 'railway',
        pageUrl: 'https://status.railway.com/',
        collectedAt,
        publishedAt,
        fresh,
        components: components.slice(0, 100),
        activeItems,
        evidence,
        candidate,
        limitations,
      };
    },
  };
}

type RailwayComponent = z.infer<typeof railwayComponentSchema>;

function flattenRailwayComponents(entries: z.infer<typeof railwayStatusSchema>['entries']): Array<{ group: string | null; data: RailwayComponent }> {
  const components: Array<{ group: string | null; data: RailwayComponent }> = [];
  for (const entry of entries) {
    if (entry.type === 'group') {
      for (const data of entry.data.components) components.push({ group: entry.data.name, data });
    } else {
      components.push({ group: null, data: entry.data });
    }
  }
  return components;
}

function statusForRailwayDay(component: z.infer<typeof railwayComponentSchema>, generatedDay: string): string {
  const days = component.months.flatMap(month => month.days)
    .filter(day => day.date <= generatedDay)
    .sort((left, right) => right.date.localeCompare(left.date));
  const status = days[0]?.status;
  if (!status) return 'unknown';
  return status === 'none' ? 'operational' : status;
}

function makeEvidence(provider: 'cloudflare' | 'railway', reference: string, body: Buffer, collectedAt: string): MonitoringEvidence {
  return {
    source: 'provider_status',
    reference,
    checksum: sha256(body),
    collectedAt,
    adapter: provider + '_status_api',
    adapterVersion: MONITORING_ADAPTER_VERSION,
  };
}

function statusCandidate(
  provider: string,
  providerDescription: string,
  components: ProviderStatusObservation['components'],
  activeItems: ProviderStatusObservation['activeItems'],
  evidence: MonitoringEvidence,
  observedAt: string,
  ttlMs = 60 * 60 * 1000,
  severityOverride?: MonitoringCandidate['severity'],
): MonitoringCandidate {
  const affected = components.filter(component => component.status !== 'operational' && component.status !== 'unknown').slice(0, 10);
  const statusList = affected.map(component => cleanText(component.name, 120) + ': ' + component.status).join('; ');
  const incidentList = activeItems.slice(0, 5).map(item => cleanText(item.title, 120) + ' (' + cleanText(item.status, 40) + ')').join('; ');
  const details = [providerDescription, statusList, incidentList].filter(Boolean).join(' — ').slice(0, 1400);
  const severity = severityOverride ?? mapStatusSeverity(affected, activeItems.length > 0);
  return {
    kind: 'upstream_outage',
    summary: provider + ' public status reports ' + details + '. Application impact is unverified; check the authorized target and provider-specific incident details.',
    severity,
    confidence: 'high',
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
    evidence: [evidence],
    metrics: null,
    incidentId: null,
    upstreamImpact: 'unverified',
  };
}

function coverageCandidate(
  evidence: MonitoringEvidence,
  observedAt: string,
  summary: string,
  kind: 'coverage_check' | 'coverage_gap' = 'coverage_check',
  ttlMs = 60 * 60 * 1000,
): MonitoringCandidate {
  return {
    kind,
    summary,
    severity: 'info',
    confidence: kind === 'coverage_check' ? 'high' : 'low',
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
    evidence: [evidence],
    metrics: null,
    incidentId: null,
    upstreamImpact: 'not_applicable',
  };
}

function isOpenStatus(status: string): boolean {
  return !['resolved', 'completed', 'cancelled', 'canceled', 'postmortem', 'post-mortem'].includes(status.toLowerCase());
}

function cloudflareSeverity(indicator: z.infer<typeof cloudflareIndicator>): MonitoringCandidate['severity'] {
  switch (indicator) {
    case 'critical': return 'critical';
    case 'major': return 'high';
    case 'minor': return 'medium';
    case 'maintenance': return 'low';
    case 'none': return 'info';
  }
}

function mapStatusSeverity(components: ProviderStatusObservation['components'], activeItem: boolean): MonitoringCandidate['severity'] {
  if (components.some(component => component.status === 'major_outage' || component.status === 'critical')) return 'critical';
  if (components.some(component => component.status === 'partial_outage' || component.status === 'major')) return 'high';
  if (components.some(component => component.status === 'degraded_performance' || component.status === 'minor')) return 'medium';
  return activeItem ? 'low' : 'info';
}

function maxTimestamp(values: readonly string[]): string | null {
  const timestamps = values.map(validTimestamp).filter((value): value is string => value !== null).sort();
  return timestamps.at(-1) ?? null;
}

function validTimestamp(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function isRecent(timestamp: string | null, collectedAt: string, maxAgeMs: number): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('invalid_status_freshness_window');
  if (!timestamp) return false;
  const age = Date.parse(collectedAt) - Date.parse(timestamp);
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uuidOrNull(value: string | undefined): string | null {
  return value && z.uuid().safeParse(value).success ? value.toLowerCase() : null;
}
