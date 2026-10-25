import { z } from 'zod';
import { MONITORING_ADAPTER_VERSION, type DependencyAdvisory, type MonitoringCandidate, type MonitoringEvidence } from './types.js';
import { parseJsonBody, requestJson } from './http.js';
import { sha256 } from './source.js';

export const CISA_KEV_FEED_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const cveId = /^CVE-\d{4}-\d{4,}$/;
const kevSchema = z.object({
  catalogVersion: z.string().max(64),
  dateReleased: z.string().max(64),
  vulnerabilities: z.array(z.object({
    cveID: z.string().max(64),
    vulnerabilityName: z.string().max(512),
    dateAdded: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    knownRansomwareCampaignUse: z.string().max(32).optional(),
  }).passthrough()).max(20_000),
}).passthrough();

interface KevEntry { name: string; dateAdded: string; ransomware: boolean }
interface KevCatalog { entries: Map<string, KevEntry>; checksum: string; version: string; fetchedAt: number }

export interface CisaKevAdapterOptions {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  /** The catalog changes a few times a week; one read serves every monitor in this window. */
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * Correlates OSV advisories with the CISA Known Exploited Vulnerabilities feed.
 * A match means the CVE is exploited somewhere, not that this application was attacked.
 */
export function createCisaKevAdapter(options: CisaKevAdapterOptions = {}) {
  const now = options.now ?? (() => new Date());
  let cached: KevCatalog | null = null;

  async function catalog(signal?: AbortSignal): Promise<KevCatalog> {
    if (cached && now().getTime() - cached.fetchedAt < (options.ttlMs ?? 6 * 3_600_000)) return cached;
    const response = await requestJson(new URL(CISA_KEV_FEED_URL), {
      headers: { accept: 'application/json', 'user-agent': 'Gotchu-Monitoring/0.1.0' },
      timeoutMs: options.timeoutMs ?? 15_000, maxBytes: 16 * 1024 * 1024, retries: 1,
      ...(signal ? { signal } : {}), ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    });
    const parsed = kevSchema.parse(parseJsonBody(response.body));
    const entries = new Map<string, KevEntry>();
    for (const item of parsed.vulnerabilities) {
      if (cveId.test(item.cveID)) entries.set(item.cveID, { name: item.vulnerabilityName, dateAdded: item.dateAdded, ransomware: item.knownRansomwareCampaignUse === 'Known' });
    }
    cached = { entries, checksum: sha256(response.body), version: parsed.catalogVersion, fetchedAt: now().getTime() };
    return cached;
  }

  return {
    async correlate(advisories: readonly DependencyAdvisory[], signal?: AbortSignal): Promise<{ candidates: MonitoringCandidate[]; evidence: MonitoringEvidence; catalogVersion: string }> {
      const feed = await catalog(signal);
      const observedAt = now().toISOString();
      const feedEvidence = (reference: string): MonitoringEvidence => ({
        source: 'advisory_database', reference, checksum: feed.checksum, collectedAt: observedAt, adapter: 'cisa_kev_feed', adapterVersion: MONITORING_ADAPTER_VERSION,
      });
      const candidates: MonitoringCandidate[] = [];
      for (const advisory of advisories) {
        const cves = [advisory.id, ...advisory.aliases].filter(alias => cveId.test(alias));
        const match = cves.map(cve => ({ cve, entry: feed.entries.get(cve) })).find(item => item.entry);
        if (!match?.entry) continue;
        const summary = [
          `CISA KEV lists ${match.cve} (${match.entry.name}) as exploited in the wild since ${match.entry.dateAdded}${match.entry.ransomware ? ', including known ransomware use' : ''}.`,
          `The repository lockfile pins npm ${advisory.packageName}@${advisory.version}, which OSV advisory ${advisory.id} lists as affected.`,
          'This shows active exploitation elsewhere; whether this application is reachable, deployed with this version, or was attacked is not established.',
        ].join(' ').slice(0, 2000);
        candidates.push({
          kind: 'dependency_advisory', summary, severity: 'critical', confidence: 'medium', observedAt,
          expiresAt: new Date(Date.parse(observedAt) + 7 * 86_400_000).toISOString(),
          evidence: [...advisory.evidence, feedEvidence(`https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(match.cve)}`)].slice(0, 20),
          metrics: null, incidentId: null, upstreamImpact: 'not_applicable',
        });
      }
      return { candidates, evidence: feedEvidence(CISA_KEV_FEED_URL), catalogVersion: feed.version };
    },
  };
}
