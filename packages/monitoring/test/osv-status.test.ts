import { randomUUID } from 'node:crypto';
import { customerSourceSnapshotSchema } from '@gotchu/contracts';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createCloudflareStatusAdapter,
  createOsvDependencyAdapter,
  createRailwayStatusAdapter,
} from '../src/index.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('OSV dependency metadata adapter', () => {
  it('queries exact npm package coordinates, follows bounded per-query pages, and retains separate lockfile/advisory evidence', async () => {
    const commitSha = 'a'.repeat(40);
    const lockfile = JSON.stringify({
      name: 'company-app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'company-app', version: '1.0.0', dependencies: { example: '1.2.3' } },
        'node_modules/example': { version: '1.2.3' },
      },
    });
    const snapshot = customerSourceSnapshotSchema.parse({
      revision: commitSha,
      files: [{ path: 'package-lock.json', content: lockfile }],
    });
    const requests: Array<{ url: string; body: string }> = [];
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url, body });
      if (url === 'https://api.osv.dev/v1/querybatch') {
        const payload: unknown = JSON.parse(body);
        const queryBatch = z.object({
          queries: z.array(z.object({
            package: z.object({ ecosystem: z.string(), name: z.string() }),
            version: z.string(),
            page_token: z.string().optional(),
          })),
        }).parse(payload);
        expect(queryBatch.queries[0]?.package).toEqual({ ecosystem: 'npm', name: 'example' });
        expect(queryBatch.queries[0]?.version).toBe('1.2.3');
        expect(body).not.toContain(lockfile);
        if (!queryBatch.queries[0]?.page_token) {
          return jsonResponse({ results: [{ vulns: [{ id: 'GHSA-example', modified: '2026-10-20T00:00:00Z' }], next_page_token: 'next-page' }] });
        }
        expect(queryBatch.queries[0]?.page_token).toBe('next-page');
        return jsonResponse({ results: [{ vulns: [{ id: 'GHSA-example', modified: '2026-10-20T00:00:00Z' }] }] });
      }
      if (url === 'https://api.osv.dev/v1/vulns/GHSA-example') {
        return jsonResponse({
          id: 'GHSA-example',
          summary: 'A test vulnerability in the pinned package.',
          published: '2026-10-01T00:00:00Z',
          modified: '2026-10-20T00:00:00Z',
          aliases: ['CVE-2026-12345'],
          references: [{ type: 'WEB', url: 'https://github.com/advisories/GHSA-example' }],
          database_specific: { severity: 'HIGH' },
        });
      }
      throw new Error('unexpected_osv_endpoint');
    };
    const adapter = createOsvDependencyAdapter({
      fetchImplementation: fetchFixture,
      now: () => new Date('2026-10-24T08:00:00Z'),
    });

    const result = await adapter.read({
      repositoryKey: 'company-main',
      commitSha,
      repositoryReference: 'gotchu://repository/company-main/commit/' + commitSha,
      snapshot,
    });
    expect(result.complete).toBe(true);
    expect(result.packagesChecked).toBe(1);
    expect(result.advisoryCount).toBe(1);
    expect(result.advisories[0]).toMatchObject({
      id: 'GHSA-example',
      packageName: 'example',
      version: '1.2.3',
      databaseSeverity: 'high',
      aliases: ['CVE-2026-12345'],
    });
    expect(result.evidence.map(item => item.source)).toEqual(['repository', 'advisory_database', 'advisory_database']);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.kind).toBe('dependency_advisory');
    expect(result.candidates[0]?.evidence.map(item => item.source)).toEqual(['repository', 'advisory_database']);
    expect(result.candidates[0]?.summary).toContain('exploitation are unknown');
    expect(requests).toHaveLength(3);
    expect(requests.every(request => new URL(request.url).hostname === 'api.osv.dev')).toBe(true);
  });

  it('does not claim a complete dependency check when no supported lockfile exists', async () => {
    const commitSha = 'b'.repeat(40);
    const snapshot = customerSourceSnapshotSchema.parse({
      revision: commitSha,
      files: [{ path: 'src/index.ts', content: 'export const ready = true;\n' }],
    });
    let requests = 0;
    const adapter = createOsvDependencyAdapter({ fetchImplementation: async () => { requests += 1; return jsonResponse({}); } });
    const result = await adapter.read({
      repositoryKey: 'company-main',
      commitSha,
      repositoryReference: 'gotchu://repository/company-main/commit/' + commitSha,
      snapshot,
    });
    expect(result.complete).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.limitations.join(' ')).toContain('No supported package-lock.json');
    expect(requests).toBe(0);
  });
});

describe('official provider status adapters', () => {
  it('parses Cloudflare summary status, freshness, and maintenance as unverified upstream evidence', async () => {
    const body = {
      page: { updated_at: '2026-10-23T07:00:00Z' },
      status: { indicator: 'major', description: 'Partial System Outage' },
      components: [{ name: 'Cloudflare API', status: 'partial_outage', updated_at: '2026-10-23T07:00:00Z' }],
      incidents: [{ id: 'abc123', name: 'API incident', title: 'API unavailable', status: 'investigating', impact: 'major', updated_at: '2026-10-23T07:00:00Z' }],
      scheduled_maintenances: [{ id: 'def456', name: 'Planned work', status: 'scheduled', updated_at: '2026-10-23T07:00:00Z' }],
    };
    let requested = '';
    const adapter = createCloudflareStatusAdapter({
      now: () => new Date('2026-10-24T08:00:00Z'),
      fetchImplementation: async input => {
        requested = String(input);
        return jsonResponse(body);
      },
    });
    const result = await adapter.read();
    expect(requested).toBe('https://www.cloudflarestatus.com/api/v2/summary.json');
    expect(result.fresh).toBe(true);
    expect(result.candidate?.kind).toBe('upstream_outage');
    expect(result.candidate?.severity).toBe('high');
    expect(result.candidate?.upstreamImpact).toBe('unverified');
    expect(result.evidence.checksum).toMatch(/^[a-f0-9]{64}$/);

    const healthy = createCloudflareStatusAdapter({
      now: () => new Date('2026-10-24T08:00:00Z'),
      fetchImplementation: async () => jsonResponse({
        page: { updated_at: '2026-10-24T07:59:00Z' },
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [{ name: 'Cloudflare API', status: 'operational', updated_at: '2026-10-24T07:59:00Z' }],
        incidents: [],
        scheduled_maintenances: [],
      }),
    });
    const healthyResult = await healthy.read();
    expect(healthyResult.candidate?.kind).toBe('coverage_check');
    expect(healthyResult.candidate?.evidence).toEqual([healthyResult.evidence]);
  });

  it('reads Railway current first-party JSON format rather than a Statuspage v2 feed and honors freshness', async () => {
    const body = {
      generatedAt: '2026-10-24T08:00:00Z',
      entries: [{
        type: 'group',
        data: {
          name: 'Railway',
          components: [{ id: randomUUID(), name: 'API — backboard.railway.com', months: [{ days: [{ date: '2026-10-24', status: 'partial_outage' }] }] }],
        },
      }],
      activeIncidents: [{ id: randomUUID(), title: 'API degraded', status: 'INVESTIGATING', createdAt: '2026-10-24T07:45:00Z', components: [{ name: 'API', impact: 'PARTIAL_OUTAGE' }] }],
      maintenances: [],
    };
    let requested = '';
    const adapter = createRailwayStatusAdapter({
      now: () => new Date('2026-10-24T08:00:01Z'),
      fetchImplementation: async input => {
        requested = String(input);
        return jsonResponse(body);
      },
    });
    const result = await adapter.read();
    expect(requested).toBe('https://status.railway.com/api/status');
    expect(result.fresh).toBe(true);
    expect(result.components[0]?.status).toBe('partial_outage');
    expect(result.candidate?.kind).toBe('upstream_outage');
    expect(result.candidate?.upstreamImpact).toBe('unverified');

    const stale = createRailwayStatusAdapter({
      now: () => new Date('2026-10-24T08:00:00Z'),
      fetchImplementation: async () => jsonResponse({ ...body, generatedAt: '2026-10-23T07:00:00Z' }),
    });
    const staleResult = await stale.read();
    expect(staleResult.fresh).toBe(false);
    expect(staleResult.candidate?.kind).toBe('coverage_gap');

    const healthy = createRailwayStatusAdapter({
      now: () => new Date('2026-10-24T08:00:01Z'),
      fetchImplementation: async () => jsonResponse({
        ...body,
        entries: [{
          type: 'group',
          data: {
            name: 'Railway',
            components: [{ id: randomUUID(), name: 'API — backboard.railway.com', months: [{ days: [{ date: '2026-10-24', status: 'none' }] }] }],
          },
        }],
        activeIncidents: [],
      }),
    });
    const healthyResult = await healthy.read();
    expect(healthyResult.candidate?.kind).toBe('coverage_check');
  });

  it('does not reuse an older Railway component health or outage as current-day coverage', async () => {
    for (const staleStatus of ['none', 'partial_outage'] as const) {
      const adapter = createRailwayStatusAdapter({
        now: () => new Date('2026-10-24T08:00:01Z'),
        fetchImplementation: async () => jsonResponse({
          generatedAt: '2026-10-24T08:00:00Z',
          entries: [{
            type: 'group',
            data: {
              name: 'Railway',
              components: [{ id: randomUUID(), name: 'API', months: [{ days: [{ date: '2026-10-01', status: staleStatus }] }] }],
            },
          }],
          activeIncidents: [],
          maintenances: [],
        }),
      });

      const result = await adapter.read();
      expect(result.fresh).toBe(true);
      expect(result.components).toMatchObject([{ status: 'unknown' }]);
      expect(result.candidate?.kind).toBe('coverage_gap');
      expect(result.limitations.join(' ')).toContain('current-day status record');
    }
  });

  it('retains a known Railway outage independently from missing component coverage', async () => {
    const adapter = createRailwayStatusAdapter({ now: () => new Date('2026-10-24T08:00:01Z'), fetchImplementation: async () => jsonResponse({
      generatedAt: '2026-10-24T08:00:00Z',
      entries: [{ type: 'group', data: { name: 'Railway', components: [
        { id: randomUUID(), name: 'API', months: [{ days: [{ date: '2026-10-24', status: 'partial_outage' }] }] },
        { id: randomUUID(), name: 'Unknown component', months: [{ days: [{ date: '2026-10-01', status: 'none' }] }] },
      ] } }], activeIncidents: [{ id: randomUUID(), title: 'API unavailable', status: 'INVESTIGATING' }], maintenances: [],
    }) });
    const result = await adapter.read();
    expect(result).toMatchObject({ fresh: true, coverageComplete: false, candidate: { kind: 'upstream_outage', upstreamImpact: 'unverified' } });
    expect(result.components).toContainEqual({ name: 'Railway / Unknown component', status: 'unknown' });
  });
});
