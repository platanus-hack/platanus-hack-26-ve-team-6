import { describe, expect, it } from 'vitest';
import { CISA_KEV_FEED_URL, createCisaKevAdapter, type DependencyAdvisory } from '../src/index.js';

const feed = {
  catalogVersion: '2026.10.23', dateReleased: '2026-10-23T19:30:18.9209Z',
  vulnerabilities: [
    { cveID: 'CVE-2020-11023', vulnerabilityName: 'JQuery Cross-Site Scripting (XSS) Vulnerability', dateAdded: '2025-01-23', knownRansomwareCampaignUse: 'Unknown' },
    { cveID: 'CVE-2021-21315', vulnerabilityName: 'System Information Library for Node.JS Command Injection', dateAdded: '2022-01-18', knownRansomwareCampaignUse: 'Known' },
  ],
};
function advisory(id: string, packageName: string, aliases: string[]): DependencyAdvisory {
  return { id, packageName, version: '1.0.0', summary: null, published: null, modified: null, aliases, references: [], databaseSeverity: 'medium',
    evidence: [{ source: 'advisory_database', reference: `https://osv.dev/vulnerability/${id}`, checksum: 'a'.repeat(64), collectedAt: '2026-10-25T00:00:00.000Z', adapter: 'osv_query_api', adapterVersion: '0.1.0' }] };
}

describe('CISA KEV correlation', () => {
  it('flags OSV advisories whose CVE aliases are known exploited, without claiming this application was attacked', async () => {
    const urls: string[] = [];
    const kev = createCisaKevAdapter({ now: () => new Date('2026-10-25T00:00:00Z'), fetchImplementation: async input => {
      urls.push(String(input));
      return new Response(JSON.stringify(feed), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const advisories = [
      advisory('GHSA-gxr4-xjj5-5px2', 'jquery', ['CVE-2020-11023']),
      advisory('CVE-2021-21315', 'systeminformation', []),
      advisory('GHSA-xvch-5gv4-984h', 'minimist', ['CVE-2021-44906']),
    ];
    const result = await kev.correlate(advisories);
    expect(result.catalogVersion).toBe('2026.10.23');
    expect(result.candidates.map(candidate => candidate.summary.match(/CVE-\d+-\d+/)?.[0])).toEqual(['CVE-2020-11023', 'CVE-2021-21315']);
    const [jquery, systeminformation] = result.candidates;
    expect(jquery).toMatchObject({ kind: 'dependency_advisory', severity: 'critical', confidence: 'medium' });
    expect(jquery?.summary).toContain('not established');
    // The operation contract rejects observations that claim more than 24 hours of freshness.
    expect(Date.parse(jquery?.expiresAt ?? '') - Date.parse(jquery?.observedAt ?? '')).toBeLessThanOrEqual(86_400_000);
    expect(jquery?.evidence.map(item => item.adapter)).toEqual(['osv_query_api', 'cisa_kev_feed']);
    expect(systeminformation?.summary).toContain('known ransomware use');

    // One feed read serves every monitor within the cache window.
    await kev.correlate(advisories);
    expect(urls).toEqual([CISA_KEV_FEED_URL]);
  });

  it('fails instead of reporting no matches when the feed is unavailable', async () => {
    const kev = createCisaKevAdapter({ fetchImplementation: async () => new Response('down', { status: 404 }) });
    await expect(kev.correlate([advisory('GHSA-gxr4-xjj5-5px2', 'jquery', ['CVE-2020-11023'])])).rejects.toThrow();
  });
});
