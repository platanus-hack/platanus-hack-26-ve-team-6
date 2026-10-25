import { describe, expect, it } from 'vitest';
import type { CustomerReportSummary, CustomerTarget } from '@gotchu/contracts';
import { examineSources, projectSources } from '../src/components/project-risk.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const applicationId = '20000000-0000-4000-8000-000000000002';
const targetId = '30000000-0000-4000-8000-000000000003';
const timestamp = '2026-10-24T12:00:00.000Z';

function target(origin: string, version: number): CustomerTarget {
  return { organizationId, applicationId, id: targetId, origin, version, status: 'authorized', requestedBy: 'user', requestedAt: timestamp, authorizedAt: timestamp, expiresAt: '2026-11-24T12:00:00.000Z', scanProfile: 'root' };
}

function externalReport(origin: string, version: number): CustomerReportSummary {
  return { id: '40000000-0000-4000-8000-000000000004', jobId: '50000000-0000-4000-8000-000000000005', applicationName: 'App', mode: 'external', startedAt: timestamp, finishedAt: timestamp, findingCount: 0,
    subject: { sourceSnapshotId: null, sourceDigest: null, targetId, targetVersion: version, origin } };
}

describe('project sources', () => {
  it('does not treat a report for the previous origin as covering a renewed target', () => {
    const sources = projectSources({ sources: [], images: [], targets: [target('https://ejemplo2.co', 2)] });
    expect(examineSources(sources, [externalReport('https://ejemplo.com', 1)]).pending).toHaveLength(1);
    expect(examineSources(sources, [externalReport('https://ejemplo2.co', 2)]).examined).toHaveLength(1);
  });
});
