import { z } from 'zod';
import type { CustomerSourceSnapshot } from '@gotchu/contracts';
import { MONITORING_ADAPTER_VERSION, type DependencyAdvisory, type DependencyObservation, type MonitoringCandidate, type MonitoringEvidence } from './types.js';
import { parseJsonBody, requestJson, type JsonRequestOptions } from './http.js';
import { OBSERVATION_TTL_MS, sha256 } from './source.js';

const MAX_LOCKFILES = 10;
const MAX_PACKAGES = 200;
const QUERY_BATCH_SIZE = 100;
const MAX_QUERY_PAGES = 3;
const MAX_ADVISORIES = 20;
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const exactVersion = z.string().max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const lockEntrySchema = z.object({
  name: packageName.optional(),
  version: z.string().optional(),
  link: z.boolean().optional(),
}).passthrough();
const lockfileSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), lockEntrySchema),
}).passthrough();
const queryBatchResponseSchema = z.object({
  results: z.array(z.object({
    vulns: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
      modified: z.string().optional(),
    }).passthrough()).max(10_000).optional(),
    next_page_token: z.string().max(4096).optional(),
  }).passthrough()).max(QUERY_BATCH_SIZE),
}).passthrough();
const osvSeveritySchema = z.object({ type: z.string().max(32), score: z.string().max(256) }).passthrough();
const osvReferenceSchema = z.object({ type: z.string().max(64).optional(), url: z.string().url().max(2048) }).passthrough();
const osvVulnerabilitySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  summary: z.string().max(4000).optional(),
  published: z.string().optional(),
  modified: z.string().optional(),
  aliases: z.array(z.string().max(128)).max(100).optional(),
  references: z.array(osvReferenceSchema).max(200).optional(),
  severity: z.array(osvSeveritySchema).max(20).optional(),
  database_specific: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export interface OsvDependencyAdapterOptions {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  ttlMs?: number;
  maxPagesPerPackage?: number;
  maxAdvisories?: number;
}

export interface OsvReadRequest {
  repositoryKey: string;
  commitSha: string;
  repositoryReference: string;
  snapshot: CustomerSourceSnapshot;
  signal?: AbortSignal;
}

interface LockedPackage {
  name: string;
  version: string;
  lockfilePath: string;
  lockfileContent: string;
}

interface QueryFinding {
  package: LockedPackage;
  id: string;
  modified: string | null;
}

export function createOsvDependencyAdapter(options: OsvDependencyAdapterOptions = {}) {
  return {
    async read(input: OsvReadRequest): Promise<DependencyObservation> {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(input.commitSha) || input.snapshot.revision !== input.commitSha) {
        throw new Error('repository_snapshot_binding_mismatch');
      }
      assertRepositoryReference(input.repositoryReference, input.repositoryKey, input.commitSha);
      const lockfiles = input.snapshot.files.filter(file => file.path === 'package-lock.json' || file.path.endsWith('/package-lock.json'));
      const parsed = readLockedPackages(lockfiles);
      const now = options.now ?? (() => new Date());
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(options.deadlineMs ?? 60_000)])
        : AbortSignal.timeout(options.deadlineMs ?? 60_000);
      const httpOptions = {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'Gotchu-Monitoring/0.1.0',
        },
        signal,
        timeoutMs: options.requestTimeoutMs ?? 8000,
        maxBytes: 1_048_576,
        retries: 1,
        ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      } satisfies Omit<JsonRequestOptions, 'method' | 'body'>;
      const query = await queryLockedPackages(parsed.packages, httpOptions, options.maxPagesPerPackage ?? MAX_QUERY_PAGES, now);
      const uniqueFindings = deduplicateFindings(query.findings);
      const maxAdvisories = options.maxAdvisories ?? MAX_ADVISORIES;
      if (!Number.isInteger(maxAdvisories) || maxAdvisories < 1 || maxAdvisories > 100) throw new Error('invalid_osv_advisory_limit');
      const selected = uniqueFindings.slice(0, maxAdvisories);
      const metadata = await hydrateAdvisories(selected, httpOptions);
      const observedAt = now().toISOString();
      const snapshotReference = input.repositoryReference;
      const advisories = metadata.map(({ finding, vulnerability, rawBody }) => {
        const lockfileReference = lockReference(snapshotReference, input.commitSha, finding.package.lockfilePath);
        const repositoryEvidence: MonitoringEvidence = {
          source: 'repository',
          reference: lockfileReference,
          checksum: sha256(finding.package.lockfileContent),
          collectedAt: observedAt,
          adapter: 'npm_package_lock',
          adapterVersion: MONITORING_ADAPTER_VERSION,
        };
        const advisoryEvidence: MonitoringEvidence = {
          source: 'advisory_database',
          reference: 'https://osv.dev/vulnerability/' + encodeURIComponent(vulnerability.id),
          checksum: sha256(rawBody),
          collectedAt: observedAt,
          adapter: 'osv_query_api',
          adapterVersion: MONITORING_ADAPTER_VERSION,
        };
        return {
          id: vulnerability.id,
          packageName: finding.package.name,
          version: finding.package.version,
          summary: cleanText(vulnerability.summary ?? '', 1000) || null,
          published: validTimestamp(vulnerability.published),
          modified: validTimestamp(vulnerability.modified) ?? validTimestamp(finding.modified),
          aliases: (vulnerability.aliases ?? []).slice(0, 20).map(alias => cleanText(alias, 128)),
          references: (vulnerability.references ?? []).slice(0, 20).map(reference => reference.url).filter(isAllowedReference),
          databaseSeverity: databaseSeverity(vulnerability),
          evidence: [repositoryEvidence, advisoryEvidence],
        } satisfies DependencyAdvisory;
      });
      const repositoryEvidence = parsed.lockfiles.map(file => ({
        source: 'repository' as const,
        reference: lockReference(snapshotReference, input.commitSha, file.path),
        checksum: sha256(file.content),
        collectedAt: observedAt,
        adapter: 'npm_package_lock',
        adapterVersion: MONITORING_ADAPTER_VERSION,
      }));
      const evidence = [...repositoryEvidence, ...query.evidence];
      const complete = lockfiles.length > 0 && parsed.complete && query.complete && uniqueFindings.length <= selected.length;
      const candidates = advisories.map(advisory => advisoryCandidate(advisory, observedAt, options.ttlMs ?? OBSERVATION_TTL_MS));
      const limitations = [
        'An OSV match against package-lock.json does not establish installation, runtime reachability, deployment equivalence, or exploitation.',
        'The adapter inspected npm package-lock files only; other lockfile formats are not scanned.',
      ];
      if (lockfiles.length === 0) limitations.push('No supported package-lock.json was present in this source snapshot.');
      if (parsed.skipped > 0) limitations.push(parsed.skipped + ' dependency entries were omitted because their name or exact version was unsupported.');
      if (parsed.packages.length >= MAX_PACKAGES || parsed.lockfiles.length > MAX_LOCKFILES) limitations.push('Package or lockfile enumeration reached its configured bound.');
      if (!query.complete) limitations.push('OSV query pagination reached its configured bound; advisory results may be incomplete.');
      if (uniqueFindings.length > selected.length) limitations.push((uniqueFindings.length - selected.length) + ' matching advisories were omitted by the detail cap; the candidate set is incomplete.');
      return {
        repositoryKey: input.repositoryKey,
        commitSha: input.commitSha,
        lockfilesFound: lockfiles.length,
        packagesChecked: parsed.packages.length,
        packagesSkipped: parsed.skipped,
        advisoryCount: uniqueFindings.length,
        advisories,
        evidence,
        complete,
        candidates,
        limitations,
      };
    },
  };
}

function readLockedPackages(lockfiles: readonly CustomerSourceSnapshot['files'][number][]): { packages: LockedPackage[]; skipped: number; complete: boolean; lockfiles: typeof lockfiles } {
  const packages: LockedPackage[] = [];
  let skipped = 0;
  let complete = true;
  const inspectedLockfiles = lockfiles.slice(0, MAX_LOCKFILES);
  if (lockfiles.length > MAX_LOCKFILES) complete = false;
  for (const file of inspectedLockfiles) {
    let parsed: z.infer<typeof lockfileSchema>;
    try {
      parsed = lockfileSchema.parse(JSON.parse(file.content) as unknown);
    } catch {
      skipped += 1;
      complete = false;
      continue;
    }
    for (const [path, entry] of Object.entries(parsed.packages).sort(([left], [right]) => left.localeCompare(right))) {
      if (!path) continue;
      const inferredName = path.split('node_modules/').at(-1) ?? '';
      const nameResult = packageName.safeParse(entry.name ?? inferredName);
      const versionResult = exactVersion.safeParse(entry.version);
      if (entry.link || !path.includes('node_modules/') || !nameResult.success || !versionResult.success) {
        skipped += 1;
        complete = false;
        continue;
      }
      packages.push({
        name: nameResult.data,
        version: versionResult.data,
        lockfilePath: file.path,
        lockfileContent: file.content,
      });
      if (packages.length >= MAX_PACKAGES) {
        complete = false;
        return { packages: deduplicatePackages(packages), skipped, complete, lockfiles: inspectedLockfiles };
      }
    }
  }
  return { packages: deduplicatePackages(packages), skipped, complete, lockfiles: inspectedLockfiles };
}

function deduplicatePackages(packages: readonly LockedPackage[]): LockedPackage[] {
  const byCoordinates = new Map<string, LockedPackage>();
  for (const item of packages) {
    const key = item.name + '\0' + item.version;
    if (!byCoordinates.has(key)) byCoordinates.set(key, item);
  }
  return [...byCoordinates.values()];
}

async function queryLockedPackages(
  packages: readonly LockedPackage[],
  options: Omit<JsonRequestOptions, 'method' | 'body'>,
  maxPages: number,
  now: () => Date,
): Promise<{ findings: QueryFinding[]; complete: boolean; evidence: MonitoringEvidence[] }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('invalid_osv_page_limit');
  const findings: QueryFinding[] = [];
  const evidence: MonitoringEvidence[] = [];
  let complete = true;
  for (let offset = 0; offset < packages.length; offset += QUERY_BATCH_SIZE) {
    const batch = packages.slice(offset, offset + QUERY_BATCH_SIZE);
    let pending = batch.map((item, index) => ({ item, index, pageToken: null as string | null }));
    const idsByIndex = new Map<number, Map<string, string | null>>();
    for (let page = 1; pending.length > 0 && page <= maxPages; page += 1) {
      const body = JSON.stringify({
        queries: pending.map(({ item, pageToken }) => ({
          package: { ecosystem: 'npm', name: item.name },
          version: item.version,
          ...(pageToken ? { page_token: pageToken } : {}),
        })),
      });
      const response = await requestJson(new URL('https://api.osv.dev/v1/querybatch'), {
        ...options,
        method: 'POST',
        body,
        maxBytes: 4 * 1024 * 1024,
      });
      evidence.push({
        source: 'advisory_database',
        reference: 'https://api.osv.dev/v1/querybatch',
        checksum: sha256(response.body),
        collectedAt: now().toISOString(),
        adapter: 'osv_query_api',
        adapterVersion: MONITORING_ADAPTER_VERSION,
      });
      const parsed = queryBatchResponseSchema.parse(parseJsonBody(response.body));
      if (parsed.results.length !== pending.length) throw new Error('osv_result_count_mismatch');
      const next: typeof pending = [];
      for (const [index, result] of parsed.results.entries()) {
        const query = pending[index];
        if (!query) throw new Error('osv_result_count_mismatch');
        const findingsForPackage = idsByIndex.get(query.index) ?? new Map<string, string | null>();
        for (const vulnerability of result.vulns ?? []) findingsForPackage.set(vulnerability.id, validTimestamp(vulnerability.modified));
        idsByIndex.set(query.index, findingsForPackage);
        if (result.next_page_token) {
          if (page === maxPages) complete = false;
          else next.push({ item: query.item, index: query.index, pageToken: result.next_page_token });
        }
      }
      pending = next;
    }
    for (const [index, advisories] of idsByIndex) {
      const item = batch[index];
      if (!item) throw new Error('osv_query_state_invalid');
      for (const [id, modified] of advisories) findings.push({ package: item, id, modified });
    }
  }
  return { findings, complete, evidence };
}

async function hydrateAdvisories(
  findings: readonly QueryFinding[],
  options: Omit<JsonRequestOptions, 'method' | 'body'>,
): Promise<Array<{ finding: QueryFinding; vulnerability: z.infer<typeof osvVulnerabilitySchema>; rawBody: Buffer }>> {
  const hydrated: Array<{ finding: QueryFinding; vulnerability: z.infer<typeof osvVulnerabilitySchema>; rawBody: Buffer }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, findings.length) }, async () => {
    while (cursor < findings.length) {
      const finding = findings[cursor];
      cursor += 1;
      if (!finding) continue;
      const url = new URL('https://api.osv.dev/v1/vulns/' + encodeURIComponent(finding.id));
      const response = await requestJson(url, { ...options, maxBytes: 1_048_576 });
      const vulnerability = osvVulnerabilitySchema.parse(parseJsonBody(response.body));
      if (vulnerability.id !== finding.id) throw new Error('osv_advisory_mismatch');
      hydrated.push({ finding, vulnerability, rawBody: response.body });
    }
  });
  await Promise.all(workers);
  return hydrated.sort((left, right) => left.vulnerability.id.localeCompare(right.vulnerability.id));
}

function advisoryCandidate(advisory: DependencyAdvisory, observedAt: string, ttlMs: number): MonitoringCandidate {
  const summary = [
    'OSV lists npm package ' + advisory.packageName + '@' + advisory.version + ' as affected by ' + advisory.id + '.',
    advisory.summary ? cleanText(advisory.summary, 1200) : 'The advisory metadata did not include a summary.',
    'Lockfile and advisory records are evidence of version metadata only; installed state, reachability, deployment, and exploitation are unknown.',
  ].join(' ').slice(0, 2000);
  return {
    kind: 'dependency_advisory',
    summary,
    severity: advisory.databaseSeverity ?? 'medium',
    confidence: 'medium',
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
    evidence: advisory.evidence,
    metrics: null,
    incidentId: null,
    upstreamImpact: 'not_applicable',
  };
}

function lockReference(repositoryReference: string, commitSha: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  if (repositoryReference.startsWith('https://github.com/')) {
    return repositoryReference.replace('/commit/' + commitSha, '/blob/' + commitSha) + '/' + encodedPath;
  }
  return repositoryReference + '#' + encodedPath;
}

function assertRepositoryReference(reference: string, repositoryKey: string, commitSha: string): void {
  const localReference = 'gotchu://repository/' + encodeURIComponent(repositoryKey) + '/commit/' + commitSha;
  if (reference === localReference) return;
  try {
    const url = new URL(reference);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
        || url.search || url.hash || parts.length !== 4 || parts[2] !== 'commit' || parts[3] !== commitSha
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0] ?? '')
        || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1] ?? '')) {
      throw new Error('repository_reference_invalid');
    }
  } catch {
    throw new Error('repository_reference_invalid');
  }
}

function deduplicateFindings(findings: readonly QueryFinding[]): QueryFinding[] {
  const unique = new Map<string, QueryFinding>();
  for (const finding of findings) {
    const key = finding.id + '\0' + finding.package.name + '\0' + finding.package.version;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id) || left.package.name.localeCompare(right.package.name));
}

function databaseSeverity(vulnerability: z.infer<typeof osvVulnerabilitySchema>): MonitoringCandidate['severity'] | null {
  const raw = vulnerability.database_specific?.['severity'];
  if (typeof raw !== 'string') return null;
  switch (raw.toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'moderate':
    case 'medium': return 'medium';
    case 'low': return 'low';
    case 'info':
    case 'informational': return 'info';
    default: return null;
  }
}

function validTimestamp(value: string | undefined | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isAllowedReference(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
