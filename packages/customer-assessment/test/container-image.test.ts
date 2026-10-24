import { describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import type { ScannerAdapter } from '../src/docker.js';
import { input } from './fixtures.js';

const digest = 'a'.repeat(64);
const reference = `docker.io/library/alpine@sha256:${digest}`;
const database = { ociDigest: `sha256:${'b'.repeat(64)}`, updatedAt: '2026-10-24T00:00:00.000Z', databaseSha256: 'c'.repeat(64), javaDatabaseAvailable: false as const };

function scanners(output: unknown): ScannerAdapter {
  return {
    run: async () => { throw new Error('source scanner must not run for an image input'); },
    runImage: async () => ({ output, image: 'aquasec/trivy@sha256:pinned', version: '0.67.2', profileChecksum: 'd'.repeat(64), database }),
    readiness: async () => ({ ready: true, tools: [] }),
  };
}

function imageInput() {
  return {
    ...input([]), inputKind: 'container_image' as const, mode: 'internal' as const, source: null, target: null,
    containerImage: { kind: 'registry' as const, reference, digest },
  };
}

describe('container image report coverage', () => {
  it('keeps unsupported operating systems and language ecosystems unknown', async () => {
    const report = await createCustomerAssessmentRunner({ scanners: scanners({
      SchemaVersion: 2,
      Metadata: { OS: { Family: 'unknown', Name: 'ExampleOS' } },
      Results: [
        { Target: 'ExampleOS', Class: 'os-pkgs', Type: 'unknown', Vulnerabilities: [] },
        { Target: 'app.jar', Class: 'lang-pkgs', Type: 'unrecognized', Vulnerabilities: [] },
      ],
    }) }).run(imageInput());

    expect(report.internal?.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'container_image_os_cves', state: 'unavailable' }),
      expect.objectContaining({ capability: 'container_image_language_cves', state: 'unavailable' }),
      expect.objectContaining({ capability: 'container_image_java_cves', state: 'unavailable' }),
    ]));
  });

  it('reports CVE fixed version, package URL and layer evidence', async () => {
    const report = await createCustomerAssessmentRunner({ scanners: scanners({
      SchemaVersion: 2,
      Metadata: { OS: { Family: 'alpine', Name: '3.6' }, DiffIDs: [`sha256:${'e'.repeat(64)}`] },
      Results: [{
        Target: 'alpine:3.6', Class: 'os-pkgs', Type: 'alpine', Vulnerabilities: [{
          VulnerabilityID: 'CVE-2020-1234', PkgName: 'busybox', InstalledVersion: '1.0-r0', FixedVersion: '1.0-r1', Severity: 'HIGH',
          PkgIdentifier: { PURL: 'pkg:apk/alpine/busybox@1.0-r0' }, Layer: { Digest: `sha256:${'f'.repeat(64)}` },
        }],
      }],
    }) }).run(imageInput());
    const finding = report.internal?.findings.find(item => item.ruleId === 'CVE-2020-1234');
    const evidence = report.internal?.evidence.find(item => item.id === finding?.evidenceIds[0]);

    expect(finding?.severity).toBe('high');
    expect(finding?.recommendation).toContain('1.0-r1');
    expect(evidence?.excerpt).toContain('pkg:apk/alpine/busybox@1.0-r0');
    expect(evidence?.excerpt).toContain(`sha256:${'f'.repeat(64)}`);
    expect(report.internal?.coverage.find(item => item.capability === 'container_image_os_cves')?.state).toBe('inspected');
  });
});
