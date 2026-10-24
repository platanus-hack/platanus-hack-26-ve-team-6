import { describe, expect, it } from 'vitest';
import type { OsvAdvisoryMetadata, CustomerSourceSnapshot } from '@gotchu/contracts';
import { z } from 'zod';
import { prepareNpmDependencyPatch, selectNpmFixVersion } from '../src/npm-dependency-fix.js';

const lodashPackage = { ecosystem: 'npm', name: 'lodash' };
function advisory(id: string, fixed: string, withdrawn?: string): OsvAdvisoryMetadata {
  return {
    id,
    ...(withdrawn ? { withdrawn } : {}),
    affected: [{ package: lodashPackage, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
  };
}
function packument(versions: readonly string[]) {
  const integrity = (fill: string) => `sha512-${Buffer.alloc(64, fill.charCodeAt(0)).toString('base64')}`;
  const allVersions = [...new Set(['4.17.20', ...versions])];
  return { versions: Object.fromEntries(allVersions.map(version => [version, {
    version,
    dist: { tarball: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`, integrity: integrity(version === '4.17.20' ? 'b' : 'a') },
  }])) };
}
function source(manifest = JSON.stringify({ name: 'small-project', dependencies: { lodash: '^4.17.20' } }, null, 2)) : CustomerSourceSnapshot {
  const oldIntegrity = `sha512-${Buffer.alloc(64, 'b'.charCodeAt(0)).toString('base64')}`;
  const lockfile = {
    name: 'small-project', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'small-project', dependencies: { lodash: '^4.17.20' } },
      'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: oldIntegrity },
    },
  };
  return { revision: 'a'.repeat(40), files: [
    { path: 'package.json', content: manifest },
    { path: 'package-lock.json', content: JSON.stringify(lockfile, null, 2) + '\n' },
  ] };
}

describe('npm dependency fix selection', () => {
  it('prefers the smallest patch release before a minor', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21', '4.18.0']) }))
      .toEqual({ toVersion: '4.17.21' });
  });

  it('selects a release outside every active advisory range', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20',
      advisories: [advisory('GHSA-a', '4.17.21'), advisory('GHSA-b', '4.17.22')], packument: packument(['4.17.21', '4.17.22']) }))
      .toEqual({ toVersion: '4.17.22' });
  });

  it('allows a minor when no safe patch release exists', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20', advisories: [advisory('GHSA-a', '4.18.0')], packument: packument(['4.18.0']) }))
      .toEqual({ toVersion: '4.18.0' });
  });

  it('allows a safe minor and updates a tilde declaration beyond its old range', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '~4.17.20', advisories: [advisory('GHSA-a', '4.18.0')], packument: packument(['4.18.0']) }))
      .toEqual({ toVersion: '4.18.0' });
  });

  it('rejects a fix that requires a major release', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20', advisories: [advisory('GHSA-a', '5.0.0')], packument: packument(['5.0.0']) }))
      .toEqual({ reason: 'major_fix_required' });
  });

  it('ignores withdrawn advisories but gives guidance when all are withdrawn', () => {
    const withdrawn = advisory('GHSA-old', '4.17.21', '2025-01-01T00:00:00Z');
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20',
      advisories: [withdrawn, advisory('GHSA-live', '4.17.21')], packument: packument(['4.17.21']) })).toEqual({ toVersion: '4.17.21' });
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20', advisories: [withdrawn], packument: packument(['4.17.21']) }))
      .toEqual({ reason: 'advisory_withdrawn' });
  });

  it('rejects prereleases and ambiguous ranges or package declarations', () => {
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20-beta.1', declaration: '^4.17.20-beta.1', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toEqual({ reason: 'prerelease_not_supported' });
    const ambiguous = { id: 'GHSA-ambiguous', affected: [{ package: lodashPackage, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { limit: '4.18.0' }] }] }] } satisfies OsvAdvisoryMetadata;
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '^4.17.20', advisories: [ambiguous], packument: packument(['4.18.0']) }))
      .toEqual({ reason: 'advisory_range_ambiguous' });
    expect(selectNpmFixVersion({ name: 'lodash', fromVersion: '4.17.20', declaration: '>=4.17.20', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toEqual({ reason: 'package_declaration_ambiguous' });
  });
});

describe('npm dependency patch scope', () => {
  it('produces a deterministic two-file patch with a registry SHA-512 integrity', () => {
    const input = { source: source(), name: 'lodash', fromVersion: '4.17.20', location: 'package-lock.json:node_modules/lodash',
      advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) };
    const first = prepareNpmDependencyPatch(input);
    const second = prepareNpmDependencyPatch(input);
    expect(first.status).toBe('ready');
    expect(second).toEqual(first);
    if (first.status !== 'ready') return;
    expect(first.files.map(file => file.path)).toEqual(['package.json', 'package-lock.json']);
    expect(first.toVersion).toBe('4.17.21');
    const lockFile = first.files.find(file => file.path === 'package-lock.json');
    if (!lockFile) throw new Error('candidate_lockfile_missing');
    const lock = z.object({ packages: z.record(z.string(), z.object({ integrity: z.string().optional() }).passthrough()) }).passthrough().parse(JSON.parse(lockFile.content));
    expect(lock.packages['node_modules/lodash']?.integrity).toBe(`sha512-${Buffer.alloc(64, 'a'.charCodeAt(0)).toString('base64')}`);
  });

  it('updates both package metadata and the legacy dependency mirror in lockfile v2', () => {
    const oldIntegrity = `sha512-${Buffer.alloc(64, 'b'.charCodeAt(0)).toString('base64')}`;
    const lockfile = {
      lockfileVersion: 2, requires: true,
      packages: {
        '': { name: 'small-project', dependencies: { lodash: '^4.17.20' } },
        'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: oldIntegrity },
      },
      dependencies: { lodash: { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: oldIntegrity } },
    };
    const base = source();
    const manifest = base.files.find(file => file.path === 'package.json');
    if (!manifest) throw new Error('candidate_manifest_missing');
    const snapshot = { ...base, files: [manifest, { path: 'package-lock.json', content: JSON.stringify(lockfile, null, 2) + '\n' }] };
    const result = prepareNpmDependencyPatch({ source: snapshot, name: 'lodash', fromVersion: '4.17.20',
      location: 'package-lock.json:node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const output = JSON.parse(result.files.find(file => file.path === 'package-lock.json')?.content ?? '{}') as { dependencies?: Record<string, { version?: string }> };
    expect(output.dependencies?.lodash?.version).toBe('4.17.21');
  });

  it('rejects a base lock entry that does not match registry metadata', () => {
    const mismatched = source();
    const lockfile = z.object({ packages: z.record(z.string(), z.object({ integrity: z.string().optional() }).passthrough()) }).passthrough().parse(JSON.parse(mismatched.files.find(file => file.path === 'package-lock.json')?.content ?? '{}'));
    const lodash = lockfile.packages['node_modules/lodash'];
    if (!lodash) throw new Error('base_lodash_entry_missing');
    lodash.integrity = `sha512-${Buffer.alloc(64, 'c'.charCodeAt(0)).toString('base64')}`;
    const lockFile = mismatched.files.find(file => file.path === 'package-lock.json');
    if (!lockFile) throw new Error('base_lockfile_missing');
    lockFile.content = JSON.stringify(lockfile);
    expect(prepareNpmDependencyPatch({ source: mismatched, name: 'lodash', fromVersion: '4.17.20',
      location: 'package-lock.json:node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toMatchObject({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it('keeps nested npm projects guidance-only until D05 validates that project scope', () => {
    const nested = { ...source(), files: [
      { path: 'apps/site/package.json', content: JSON.stringify({ name: 'site', dependencies: { lodash: '^4.17.20' } }) },
      { path: 'apps/site/package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: { lodash: '^4.17.20' } },
        'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: `sha512-${Buffer.alloc(64, 'b'.charCodeAt(0)).toString('base64')}` },
      } }) },
    ] };
    expect(prepareNpmDependencyPatch({ source: nested, name: 'lodash', fromVersion: '4.17.20',
      location: 'apps/site/package-lock.json:node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toMatchObject({ status: 'guidance_only', reason: 'lockfile_unsupported' });
  });

  it('keeps npm workspaces guidance-only until every workspace manifest is resolved together', () => {
    const workspaceManifest = JSON.stringify({ name: 'small-project', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.20' } }, null, 2);
    expect(prepareNpmDependencyPatch({ source: source(workspaceManifest), name: 'lodash', fromVersion: '4.17.20',
      location: 'package-lock.json:node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toMatchObject({ status: 'guidance_only', reason: 'workspace_not_supported' });
  });

  it('rejects a text edit that would leave a duplicate manifest key unresolved', () => {
    const duplicateManifest = '{\n  "name": "small-project",\n  "dependencies": { "lodash": "^4.17.20", "lodash": "^4.17.20" }\n}\n';
    expect(prepareNpmDependencyPatch({ source: source(duplicateManifest), name: 'lodash', fromVersion: '4.17.20',
      location: 'package-lock.json:node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toMatchObject({ status: 'guidance_only', reason: 'lockfile_change_out_of_scope' });
  });

  it('keeps transitive dependencies guidance-only', () => {
    expect(prepareNpmDependencyPatch({ source: source(), name: 'lodash', fromVersion: '4.17.20',
      location: 'package-lock.json:node_modules/parent/node_modules/lodash', advisories: [advisory('GHSA-a', '4.17.21')], packument: packument(['4.17.21']) }))
      .toMatchObject({ status: 'guidance_only', reason: 'transitive_override_not_supported' });
  });
});
