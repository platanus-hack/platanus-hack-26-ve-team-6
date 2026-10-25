import { readFile } from 'node:fs/promises';
import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import { describe, expect, it, vi } from 'vitest';
import { defaultLicensePolicy } from '@gotchu/contracts';
import { createCustomerAssessmentRunner, buildCycloneDx, evaluateLicensePolicy, normalizeLicenseExpression, normalizeLicensePolicy, parseLockfile } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

function parseFiles(files: Array<{ path: string; content: string }>) {
  const run = input(files);
  if (!run.source) throw new Error('fixture_source_missing');
  return parseLockfile(run.source);
}

const manifest = JSON.stringify({ name: 'fixture', dependencies: { alpha: '^1.0.0' } });

describe('bounded dependency lockfile inventory', () => {
  it('parses pnpm v6 package metadata and the root dependency graph', () => {
    const result = parseFiles([
      { path: 'package.json', content: manifest },
      { path: 'pnpm-lock.yaml', content: `lockfileVersion: '6.0'\ndependencies:\n  alpha:\n    specifier: ^1.0.0\n    version: 1.2.3\npackages:\n  /alpha/1.2.3:\n    resolution: {integrity: sha512-x}\n    dependencies:\n      beta: 2.1.0\n  /beta/2.1.0:\n    resolution: {integrity: sha512-y}\n` },
    ]);
    expect(result.inventory.map(({ name, version, relationship, dependencies }) => ({ name, version, relationship, dependencies }))).toEqual([
      { name: 'alpha', version: '1.2.3', relationship: 'direct', dependencies: ['pkg:npm/beta@2.1.0'] },
      { name: 'beta', version: '2.1.0', relationship: 'transitive', dependencies: [] },
    ]);
    expect(result.complete).toBe(true);
  });

  it('parses npm lockfile v2 and resolves nested transitive package paths', () => {
    const result = parseFiles([{ path: 'package-lock.json', content: JSON.stringify({
      lockfileVersion: 2,
      packages: {
        '': { dependencies: { alpha: '^1.0.0' } },
        'node_modules/alpha': { version: '1.2.3', dependencies: { beta: '^2.0.0' } },
        'node_modules/alpha/node_modules/beta': { version: '2.1.0' },
        'node_modules/beta': { version: '3.0.0' },
      },
    }) }]);
    expect(result.inventory.map(({ name, version, relationship, dependencies }) => ({ name, version, relationship, dependencies }))).toEqual([
      { name: 'alpha', version: '1.2.3', relationship: 'direct', dependencies: ['pkg:npm/beta@2.1.0'] },
      { name: 'beta', version: '2.1.0', relationship: 'transitive', dependencies: [] },
      { name: 'beta', version: '3.0.0', relationship: 'transitive', dependencies: [] },
    ]);
    expect(result.complete).toBe(true);
  });

  it('parses pnpm v9 importer refs, snapshots and exact purls', () => {
    const result = parseFiles([
      { path: 'package.json', content: manifest },
      { path: 'pnpm-lock.yaml', content: `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: ^1.0.0\n        version: 1.2.3\npackages:\n  alpha@1.2.3:\n    resolution: {integrity: sha512-x}\n  beta@2.1.0:\n    resolution: {integrity: sha512-y}\nsnapshots:\n  alpha@1.2.3:\n    dependencies:\n      beta: 2.1.0\n  beta@2.1.0: {}\n` },
    ]);
    expect(result.inventory.map(({ purl, relationship, dependencies }) => ({ purl, relationship, dependencies }))).toEqual([
      { purl: 'pkg:npm/alpha@1.2.3', relationship: 'direct', dependencies: ['pkg:npm/beta@2.1.0'] },
      { purl: 'pkg:npm/beta@2.1.0', relationship: 'transitive', dependencies: [] },
    ]);
    expect(result.complete).toBe(true);
  });

  it('recognizes pnpm v6 workspace importers as direct roots', () => {
    const result = parseFiles([{ path: 'pnpm-lock.yaml', content: `lockfileVersion: '6.0'
importers:
  packages/app:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.2.3
packages:
  /alpha@1.2.3: {}
` }]);
    expect(result.inventory[0]?.relationship).toBe('direct');
    expect(result.graphComplete).toBe(true);
  });

  it.each(['', 'snapshots: {}\n'])('keeps missing pnpm v9 dependency snapshots unknown (%s)', snapshots => {
    const result = parseFiles([{ path: 'pnpm-lock.yaml', content: `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      alpha:
        version: 1.2.3
packages:
  alpha@1.2.3: {}
${snapshots}` }]);
    expect(result.inventory[0]).toMatchObject({ name: 'alpha', version: '1.2.3' });
    expect(result.graphComplete).toBe(false);
  });

  it('keeps pnpm relationship unknown when no importer dependency edges identify roots', () => {
    const result = parseFiles([{ path: 'pnpm-lock.yaml', content: `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  alpha@1.2.3:\n    resolution: {integrity: sha512-x}\nsnapshots:\n  alpha@1.2.3: {}\n` }]);
    expect(result.inventory[0]?.relationship).toBe('unknown');
    expect(result.graphComplete).toBe(false);
  });

  it.each([
    ['classic', `# yarn lockfile v1\nalpha@^1.0.0:\n  version "1.2.3"\n  resolved "https://registry.yarnpkg.com/alpha/-/alpha-1.2.3.tgz"\n  dependencies:\n    beta "^2.0.0"\nbeta@^2.0.0:\n  version "2.1.0"\n`],
    ['berry', `__metadata:\n  version: 6\n\n"alpha@npm:^1.0.0":\n  version: 1.2.3\n  resolution: "alpha@npm:1.2.3"\n  dependencies:\n    beta: "npm:^2.0.0"\n"beta@npm:^2.0.0":\n  version: 2.1.0\n  resolution: "beta@npm:2.1.0"\n`],
  ])('parses Yarn %s selectors and dependency graph', (_format, content) => {
    const result = parseFiles([{ path: 'package.json', content: manifest }, { path: 'yarn.lock', content }]);
    expect(result.inventory.map(({ name, version, relationship, dependencies }) => ({ name, version, relationship, dependencies }))).toEqual([
      { name: 'alpha', version: '1.2.3', relationship: 'direct', dependencies: ['pkg:npm/beta@2.1.0'] },
      { name: 'beta', version: '2.1.0', relationship: 'transitive', dependencies: [] },
    ]);
    expect(result.complete).toBe(true);
    expect(result.graphComplete).toBe(true);
  });

  it('makes malformed, unsupported, oversized and entry-capped lockfiles visible', () => {
    const malformed = parseFiles([{ path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":[' }]);
    expect(malformed.complete).toBe(false);
    expect(malformed.lockfiles[0]?.state).toBe('unavailable');
    const unsupported = parseFiles([{ path: 'Cargo.lock', content: '[[package]]\nname="alpha"\nversion="1.2.3"' }]);
    expect(unsupported.lockfiles[0]?.state).toBe('unsupported');
    const oversized = parseFiles([{ path: 'yarn.lock', content: 'x'.repeat(1_048_577) }]);
    expect(oversized.lockfiles[0]?.state).toBe('unavailable');
    const hostile = parseFiles([{ path: 'package-lock.json', content: `{"lockfileVersion":3,"packages":${'['.repeat(60)}${'0'.repeat(60)}${']'.repeat(60)}}` }]);
    expect(hostile.lockfiles[0]?.state).toBe('unavailable');
    const yamlAlias = parseFiles([{ path: 'pnpm-lock.yaml', content: 'lockfileVersion: "9.0"\npackages: &packages {alpha@1.0.0: invalid}\nsnapshots: *packages\n' }]);
    expect(yamlAlias.lockfiles[0]?.state).toBe('unavailable');
    const entries = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`node_modules/p${index}`, { version: '1.0.0' }]));
    const capped = parseFiles([{ path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: entries }) }]);
    expect(capped.lockfiles[0]?.state).toBe('unavailable');
    expect(capped.unknownCount).toBeGreaterThan(0);
    const legacyNpm = parseFiles([{ path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 1, dependencies: {} }) }]);
    expect(legacyNpm.lockfiles[0]).toMatchObject({ format: 'unsupported', state: 'unsupported' });
  });

  it('reports unsupported lockfile coverage instead of hiding it', () => {
    const result = parseFiles([{ path: 'go.sum', content: 'module h1:value' }]);
    expect(result.found).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.lockfiles[0]).toMatchObject({ sourceFile: 'go.sum', format: 'unsupported', state: 'unsupported' });
  });

  it('keeps a Yarn package unknown when its direct manifest range is missing from the lockfile', () => {
    const result = parseFiles([{ path: 'package.json', content: manifest }, { path: 'yarn.lock', content: '# yarn lockfile v1\nalpha@^2.0.0:\n  version "2.1.0"\n' }]);
    expect(result.inventory[0]?.relationship).toBe('unknown');
    expect(result.graphComplete).toBe(false);
  });

  it('does not treat malformed Yarn text or ambiguous directness as complete', () => {
    const malformed = parseFiles([{ path: 'package.json', content: manifest }, { path: 'yarn.lock', content: 'not a lock entry' }]);
    expect(malformed.complete).toBe(false);
    expect(malformed.lockfiles[0]?.state).toBe('unavailable');
    const ambiguous = parseFiles([{ path: 'package.json', content: '{' }, { path: 'yarn.lock', content: '# yarn lockfile v1\nalpha@^1.0.0:\n  version "1.2.3"\n' }]);
    expect(ambiguous.inventory[0]?.relationship).toBe('unknown');
    expect(ambiguous.graphComplete).toBe(false);
  });
});

describe('license declarations and workspace policy', () => {
  it('normalizes SPDX OR, AND, WITH, deprecated identifiers and unknown declarations', () => {
    expect(normalizeLicenseExpression('GPL-2.0+ WITH Classpath-exception-2.0')).toBe('GPL-2.0-or-later WITH Classpath-exception-2.0');
    expect(normalizeLicenseExpression('GPL-2.0-with-classpath-exception')).toBe('GPL-2.0-only WITH Classpath-exception-2.0');
    expect(normalizeLicenseExpression('(MIT OR Apache-2.0) AND BSD-3-Clause')).toBe('(MIT OR Apache-2.0) AND BSD-3-Clause');
    expect(normalizeLicenseExpression('UNLICENSED')).toBeNull();
    expect(normalizeLicenseExpression('SEE LICENSE IN LICENSE.txt')).toBeNull();
    expect(normalizeLicenseExpression('LicenseRef-private')).toBe('LicenseRef-private');
    expect(normalizeLicenseExpression('made-up-license')).toBeNull();
  });

  it('classifies unknown and strong copyleft conservatively and rejects policy conflicts', () => {
    const policy = normalizeLicensePolicy(defaultLicensePolicy);
    expect(evaluateLicensePolicy('MIT', policy)).toBe('allowed');
    expect(evaluateLicensePolicy('AGPL-3.0-or-later', policy)).toBe('review');
    expect(evaluateLicensePolicy(null, policy)).toBe('review');
    expect(() => normalizeLicensePolicy({ allow: ['MIT'], deny: ['MIT'], review: [] })).toThrow('license_policy_conflict');
  });

  it('looks up exact package metadata and records policy evidence without source content', async () => {
    const lookup = vi.fn(async (packages: ReadonlyArray<{ name: string; version: string }>) => {
      expect(packages).toEqual([{ name: 'alpha', version: '1.2.3' }]);
      return [{ declaredLicense: 'GPL-3.0', complete: true }];
    });
    const run = input([{ path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3' } } }) }]);
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners, licenses: { lookup } }).run(run);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(report.internal?.dependencyInventory?.components[0]).toMatchObject({ licenseExpression: 'GPL-3.0-only', licenseSource: 'registry', licenseConfidence: 'declared', policyStatus: 'review' });
    expect(report.internal?.findings[0]).toMatchObject({ ruleId: 'license.policy.review', severity: 'unknown', confidence: 'observed', location: 'package-lock.json:node_modules/alpha' });
    expect(report.internal?.evidence[0]?.excerpt).toContain('"sourceFile":"package-lock.json"');
    expect(report.internal?.evidence[0]?.excerpt).toContain('"licenseSource":"registry"');
  });

  it('counts deduplicated exact versions once for bounded OSV coverage', async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3', license: 'MIT' } } });
    const query = vi.fn(async (packages: ReadonlyArray<{ name: string; version: string }>) => {
      expect(packages).toEqual([{ name: 'alpha', version: '1.2.3' }]);
      return [{ ids: [], complete: true }];
    });
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners, advisory: { query } }).run(input([
      { path: 'one/package-lock.json', content: lock },
      { path: 'two/package-lock.json', content: lock },
    ]));
    const coverage = new Map(report.internal?.coverage.map(item => [item.capability, item.state]));
    expect(report.internal?.dependencyInventory?.components).toHaveLength(2);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toEqual([{ name: 'alpha', version: '1.2.3' }]);
    expect(coverage.get('dependency_advisories')).toBe('inspected');
  });

  it('rechecks the same source so a newly published advisory appears on the next report', async () => {
    const id = { current: 'GHSA-1111-1111-1111' };
    const query = vi.fn(async () => [{ ids: [id.current], complete: true, advisories: [{
      id: id.current, affected: [{ package: { ecosystem: 'npm', name: 'alpha' }, symbols: [] }],
    }] }]);
    const run = input([
      { path: 'app.ts', content: 'export const app = true;' },
      { path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3', integrity: 'sha512-fixture', license: 'MIT' } } }) },
    ]);
    const runner = createCustomerAssessmentRunner({ scanners: absentScanners, advisory: { query } });
    const first = await runner.run(run);
    id.current = 'GHSA-2222-2222-2222';
    const second = await runner.run(run);
    expect(query).toHaveBeenCalledTimes(2);
    expect(first.internal?.findings.map(finding => finding.ruleId)).toContain('osv.GHSA-1111-1111-1111');
    expect(second.internal?.findings.map(finding => finding.ruleId)).toContain('osv.GHSA-2222-2222-2222');
    expect(second.internal?.findings.find(finding => finding.ruleId === 'osv.GHSA-2222-2222-2222')?.dependencyAssessment?.reachability.state).toBe('not_found_static');
  });

  it('keeps an affected transitive dependency unknown unless a direct lockfile path is recorded', async () => {
    const run = input([
      { path: 'src/app.ts', content: "import { parse } from 'beta/subpath';\nparse('value');" },
      { path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: { alpha: '^1.0.0' } },
        'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^2.0.0' }, license: 'MIT' },
        'node_modules/alpha/node_modules/beta': { version: '2.1.0', integrity: 'sha512-beta', license: 'MIT' },
      } }) },
    ]);
    const artifacts = {
      async analyze(packages: ReadonlyArray<{ name: string; version: string; integrity: string | null }>) {
        expect(packages).toEqual([{ name: 'beta', version: '2.1.0', integrity: 'sha512-beta' }]);
        return new Map([['beta\u00002.1.0', { analysis: {
          status: 'verified' as const, integrity: 'verified' as const, artifactSha256: 'b'.repeat(64), extractedFileCount: 1, scannedFileCount: 1,
          tools: [], findings: [], limitation: ['Fixture adapter; live registry and scanners not used.'],
        }, evidence: [] }]]);
      },
    };
    const report = await createCustomerAssessmentRunner({
      scanners: absentScanners,
      artifacts,
      advisory: { query: async packages => packages.map(pkg => pkg.name === 'beta' ? {
        ids: ['GHSA-3333-3333-3333'], complete: true,
        advisories: [{ id: 'GHSA-3333-3333-3333', affected: [{ package: { ecosystem: 'npm', name: 'beta' }, symbols: ['parse'] }] }],
      } : { ids: [], complete: true }) },
    }).run(run);
    const beta = report.internal?.dependencyInventory?.components.find(component => component.name === 'beta');
    expect(beta).toMatchObject({ relationship: 'transitive', reachability: { state: 'reachable', dependencyPath: ['pkg:npm/alpha@1.0.0', 'pkg:npm/beta@2.1.0'] }, artifactAnalysis: { status: 'verified' } });
    expect(report.internal?.findings.find(finding => finding.ruleId === 'osv.GHSA-3333-3333-3333')?.dependencyAssessment).toMatchObject({ name: 'beta', reachability: { state: 'reachable' } });
  });
});

describe('CycloneDX 1.5 output', () => {
  it('validates exported inventory against the vendored official schema', async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3', license: 'MIT' } } });
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners }).run(input([{ path: 'package-lock.json', content: lock }, { path: 'go.sum', content: 'module h1:value' }]));
    const bom = buildCycloneDx(report, new Date('2026-10-24T00:00:00.000Z'));
    const rawSchema: unknown = JSON.parse(await readFile(new URL('./fixtures/schema/bom-1.5.schema.json', import.meta.url), 'utf8'));
    const validator = new Validator(rawSchema as Schema, '7');
    const result = validator.validate(bom);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(bom.components[0]).toMatchObject({ 'bom-ref': 'pkg:npm/alpha@1.2.3', purl: 'pkg:npm/alpha@1.2.3', licenses: [{ expression: 'MIT' }] });
    expect(bom.compositions).toEqual([{ aggregate: 'incomplete', assemblies: [`urn:gotchu:application:${report.applicationId}`] }]);
    expect(bom.metadata.properties).toContainEqual({ name: 'gotchu:assessed-snapshot-sha256', value: report.subject.sourceDigest });
  });
});
