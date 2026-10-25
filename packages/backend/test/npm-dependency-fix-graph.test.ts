import { describe, expect, it } from 'vitest';
import type { OsvAdvisoryMetadata } from '@gotchu/contracts';
import { prepareNpmDependencyPatch } from '../src/npm-dependency-fix.js';

const fromVersion = '2.4.0';
const toVersion = '2.5.0';
const targetPath = 'node_modules/multer';
const identity = (name: string, version: string, fill = 'b') => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${Buffer.alloc(64, fill.charCodeAt(0)).toString('base64')}`,
});
// Public registry dependency metadata; the graph and integrity values are synthetic.
const metadata = {
  dependencies: { 'append-field': '^1.0.0', busboy: '^1.6.0', 'type-is': '^1.6.18' },
  engines: { node: '>= 10.16.0' },
  license: 'MIT',
};
const advisory = {
  id: 'GHSA-q7qp-rjg7-q26m',
  affected: [{ package: { ecosystem: 'npm', name: 'multer' }, ranges: [{
    type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: toVersion }],
  }] }],
} satisfies OsvAdvisoryMetadata;

function graphFixture(lockfileVersion: 2 | 3 = 3) {
  const manifest = { name: 'graph-fixture', dependencies: { multer: '^2.4.0' } };
  const locked: Record<string, unknown> = { ...identity('multer', fromVersion), ...structuredClone(metadata) };
  const release = (version: string, fill: string): Record<string, unknown> => {
    const { resolved, integrity } = identity('multer', version, fill);
    return { version, dist: { tarball: resolved, integrity }, ...structuredClone(metadata), scripts: { test: 'unused' } };
  };
  const previous = release(fromVersion, 'b');
  const next = release(toVersion, 'a');
  const nested = {
    ...identity('type-is', '1.6.18'),
    dependencies: { 'mime-types': '~2.1.24', 'media-typer': '0.3.0' },
  };
  const mirror: Record<string, unknown> = {
    ...identity('multer', fromVersion), requires: structuredClone(metadata.dependencies),
    dependencies: { 'type-is': { ...identity('type-is', '1.6.18'), requires: nested.dependencies } },
  };
  const packages: Record<string, unknown> = {
    '': structuredClone(manifest),
    [targetPath]: locked,
    [`${targetPath}/node_modules/type-is`]: nested,
    [`${targetPath}/node_modules/mime-types`]: { ...identity('mime-types', '2.1.35'), dependencies: { 'mime-db': '1.52.0' } },
    [`${targetPath}/node_modules/mime-db`]: identity('mime-db', '1.52.0'),
    [`${targetPath}/node_modules/media-typer`]: identity('media-typer', '0.3.0'),
    'node_modules/append-field': identity('append-field', '1.0.0'),
    'node_modules/busboy': identity('busboy', '1.6.0'),
    'node_modules/parent': { ...identity('parent', '1.0.0'), dependencies: { multer: '^2.4.0' } },
    'node_modules/parent/node_modules/multer': structuredClone(locked),
  };
  const lockfile = {
    lockfileVersion, packages,
    ...(lockfileVersion === 2 ? { dependencies: { multer: mirror, parent: identity('parent', '1.0.0') } } : {}),
  };
  const input = () => ({
    source: { revision: 'a'.repeat(40), files: [
      { path: 'package.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      { path: 'package-lock.json', content: JSON.stringify(lockfile, null, 2) + '\n' },
    ] },
    name: 'multer', fromVersion, location: `package-lock.json:${targetPath}`,
    advisories: [advisory], packument: { versions: { [fromVersion]: previous, [toVersion]: next } },
  });
  return { manifest, lockfile, locked, previous, next, mirror, input };
}

describe('npm fixes with an unchanged dependency graph', () => {
  it.each([2, 3] as const)('preserves every other entry and the exact nested subtree in lockfile v%s', version => {
    const fixture = graphFixture(version);
    const input = fixture.input();
    const original = structuredClone(input);
    const result = prepareNpmDependencyPatch(input);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected_graph_preserving_patch');
    const expectedLock = structuredClone(fixture.lockfile);
    expectedLock.packages[''] = { ...fixture.manifest, dependencies: { multer: toVersion } };
    expectedLock.packages[targetPath] = { ...fixture.locked, ...identity('multer', toVersion, 'a') };
    if (expectedLock.dependencies) expectedLock.dependencies.multer = { ...fixture.mirror, ...identity('multer', toVersion, 'a') };
    expect(result.toVersion).toBe(toVersion);
    expect(result.files).toEqual([
      { path: 'package.json', content: JSON.stringify({ ...fixture.manifest, dependencies: { multer: toVersion } }, null, 2) + '\n' },
      { path: 'package-lock.json', content: JSON.stringify(expectedLock, null, 2) + '\n' },
    ]);
    expect(input).toEqual(original);
    expect(prepareNpmDependencyPatch(input)).toEqual(result);
  });

  it('accepts matching optional, peer, bundle, install and platform metadata', () => {
    const fixture = graphFixture();
    const extra = {
      optionalDependencies: { busboy: '^1.6.0' }, peerDependencies: { busboy: '^1.6.0' },
      peerDependenciesMeta: { busboy: { optional: true } },
      bundleDependencies: ['append-field'], bundledDependencies: ['append-field'],
      hasInstallScript: true, os: ['linux'], cpu: ['x64'], libc: ['glibc'], bin: { multer: 'cli.js' },
    };
    for (const boundary of [fixture.locked, fixture.previous, fixture.next]) Object.assign(boundary, structuredClone(extra));
    fixture.previous.scripts = { install: 'node install.js', test: 'unused-old' };
    fixture.next.scripts = { install: 'node install.js', test: 'unused-new' };
    expect(prepareNpmDependencyPatch(fixture.input())).toMatchObject({ status: 'ready', toVersion });
  });

  it.each(Object.entries({
    dependencies: { ...metadata.dependencies, busboy: '^2.0.0' },
    optionalDependencies: { native: '^1.0.0' }, peerDependencies: { peer: '^1.0.0' },
    peerDependenciesMeta: { peer: { optional: true } }, engines: { node: '>=24' },
    os: ['linux'], cpu: ['x64'], libc: ['glibc'], bin: { multer: 'cli.js' }, license: 'ISC',
    hasInstallScript: true, bundleDependencies: ['append-field'], bundledDependencies: ['append-field'],
  }))('rejects a %s mismatch at any metadata boundary', (key, value) => {
    for (const boundary of ['locked', 'previous', 'next'] as const) {
      const fixture = graphFixture();
      fixture[boundary][key] = value;
      expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
    }
  });

  it.each(['dependencies', 'engines', 'license'])('rejects removed %s metadata at any boundary', key => {
    for (const boundary of ['locked', 'previous', 'next'] as const) {
      const fixture = graphFixture();
      delete fixture[boundary][key];
      expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
    }
  });

  it.each(['preinstall', 'install', 'postinstall'])('rejects an added %s even without a registry install flag', key => {
    const fixture = graphFixture();
    fixture.next.scripts = { [key]: 'node install.js' };
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it.each(['node changed.js', undefined, 42])('rejects changed, removed or malformed install scripts: %s', install => {
    const fixture = graphFixture();
    for (const boundary of [fixture.locked, fixture.previous, fixture.next]) boundary.hasInstallScript = true;
    fixture.previous.scripts = { install: 'node install.js' };
    fixture.next.scripts = install === undefined ? {} : { install };
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it('rejects unchanged lifecycle scripts that are not recorded as install scripts in the lock', () => {
    const fixture = graphFixture();
    fixture.previous.scripts = fixture.next.scripts = { install: 'node install.js' };
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it('keeps a transitive instance guidance-only even when its graph is unchanged', () => {
    const fixture = graphFixture();
    expect(prepareNpmDependencyPatch({ ...fixture.input(), location: 'package-lock.json:node_modules/parent/node_modules/multer' }))
      .toEqual({ status: 'guidance_only', reason: 'transitive_override_not_supported' });
  });
});

describe('npm v2 dependency mirror safety', () => {
  it.each(Object.entries({
    version: '2.3.0', resolved: 'https://registry.npmjs.org/multer/-/multer-2.3.0.tgz',
    integrity: identity('multer', fromVersion, 'c').integrity,
    requires: { ...metadata.dependencies, busboy: '^2.0.0' },
  }))('rejects a conflicting mirror %s', (key, value) => {
    const fixture = graphFixture(2);
    fixture.mirror[key] = value;
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it.each(['version', 'resolved', 'integrity'])('rejects a mirror without %s', key => {
    const fixture = graphFixture(2);
    delete fixture.mirror[key];
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'lockfile_unsupported' });
  });

  it('requires the mirror to include the dependency requirements', () => {
    const fixture = graphFixture(2);
    delete fixture.mirror.requires;
    expect(prepareNpmDependencyPatch(fixture.input())).toEqual({ status: 'guidance_only', reason: 'package_tree_change_required' });
  });

  it('matches v2 requirements after optional dependencies override ordinary dependencies', () => {
    const fixture = graphFixture(2);
    for (const boundary of [fixture.locked, fixture.previous, fixture.next]) boundary.optionalDependencies = { busboy: '~1.6.0' };
    fixture.mirror.requires = { ...metadata.dependencies, busboy: '~1.6.0' };
    expect(prepareNpmDependencyPatch(fixture.input())).toMatchObject({ status: 'ready', toVersion });
  });
});
