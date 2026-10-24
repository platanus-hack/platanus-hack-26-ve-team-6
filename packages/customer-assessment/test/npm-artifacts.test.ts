import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { extractNpmTarball, verifySha512Integrity, createNpmArtifactAdapter } from '../src/npm-artifacts.js';
import { input, absentScanners } from './fixtures.js';

function octal(value: number, bytes: number) { return value.toString(8).padStart(bytes - 1, '0') + '\0'; }
function tarEntry(name: string, content: Uint8Array, type: '0' | '2' = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(content.byteLength, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const data = Buffer.from(content);
  const padding = Buffer.alloc((512 - data.byteLength % 512) % 512);
  return Buffer.concat([header, data, padding]);
}
function archive(entries: Buffer[]) { return gzipSync(Buffer.concat([...entries, Buffer.alloc(1_024)])); }
function sri(bytes: Uint8Array) { return `sha512-${createHash('sha512').update(bytes).digest('base64')}`; }

describe('bounded npm artifact parsing', () => {
  it('extracts ordinary package source in memory and verifies the exact SHA-512 bytes', () => {
    const bytes = archive([tarEntry('package/index.js', Buffer.from('export const answer = 42;'))]);
    expect(extractNpmTarball(bytes)).toMatchObject({ fileCount: 1, files: [{ path: 'index.js', content: 'export const answer = 42;' }], capped: false });
    expect(verifySha512Integrity(sri(bytes), bytes)).toBe('verified');
    expect(verifySha512Integrity(sri(bytes), Buffer.concat([bytes, Buffer.from('tampered')]))).toBe('mismatch');
  });

  it('rejects path traversal and symlink members before returning files', () => {
    const traversal = archive([tarEntry('package/../outside.js', Buffer.from('not safe'))]);
    const symlink = archive([tarEntry('package/link.js', Buffer.from('target'), '2')]);
    expect(() => extractNpmTarball(traversal)).toThrow('archive_path_rejected');
    expect(() => extractNpmTarball(symlink)).toThrow('archive_link_rejected');
  });

  it('rejects a gzip expansion whose decompression ratio exceeds the configured limit', () => {
    const bomb = archive([tarEntry('package/repeated.js', Buffer.from('A'.repeat(250_000)))]);
    expect(() => extractNpmTarball(bomb)).toThrow('archive_decompression_ratio');
  });

  it('reports a tampered tarball against the lockfile checksum as a high-signal finding', async () => {
    const lockedArtifact = archive([tarEntry('package/index.js', Buffer.from('export const safe = true;'))]);
    const tamperedArtifact = archive([tarEntry('package/index.js', Buffer.from('export const evil = true;'))]);
    const lockIntegrity = sri(lockedArtifact);
    const scan = vi.fn(async () => ({ findings: [], tools: [], evidence: [], complete: true }));
    const adapter = createNpmArtifactAdapter(scan, {
      async get(url) {
        if (url.pathname === '/alpha/1.2.3') return Buffer.from(JSON.stringify({
          name: 'alpha', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz', integrity: sri(tamperedArtifact) },
        }));
        if (url.pathname.endsWith('/alpha-1.2.3.tgz')) return tamperedArtifact;
        throw new Error('unexpected_registry_path');
      },
    });
    const source = input([
      { path: 'app.ts', content: 'export const app = true;' },
      { path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3', integrity: lockIntegrity, license: 'MIT' } } }) },
    ]);
    const report = await createCustomerAssessmentRunner({
      scanners: absentScanners,
      artifacts: adapter,
      advisory: { query: async () => [{ ids: ['GHSA-1111-1111-1111'], complete: true, advisories: [{ id: 'GHSA-1111-1111-1111', affected: [{ package: { ecosystem: 'npm', name: 'alpha' }, symbols: [] }] }] }] },
    }).run(source);
    const finding = report.internal?.findings.find(item => item.ruleId === 'dependency.artifact.integrity_mismatch');
    expect(finding).toMatchObject({ severity: 'high', confidence: 'observed', exploitability: 'unknown', dependencyAssessment: { artifactStatus: 'checksum_mismatch' } });
    expect(report.internal?.dependencyInventory?.components[0]?.artifactAnalysis).toMatchObject({ status: 'checksum_mismatch', integrity: 'mismatch' });
    expect(scan).not.toHaveBeenCalled();
  });
});
