import { describe, expect, it } from 'vitest';
import { analyzeDependencyReachability } from '../src/reachability.js';
import type { LockedPackage } from '../src/lockfiles.js';
import { input } from './fixtures.js';

const pkg = (name: string, relationship: LockedPackage['relationship'], dependencies: string[] = []): LockedPackage => ({
  name,
  version: '1.2.3',
  purl: `pkg:npm/${name}@1.2.3`,
  location: `package-lock.json:node_modules/${name}`,
  sourceFile: 'package-lock.json',
  relationship,
  dependencies,
  declaredLicense: 'MIT',
  integrity: null,
});

describe('dependency import reachability', () => {
  it('finds literal imports, subpath imports, re-exports, require and referenced advisory symbols', () => {
    const direct = pkg('alpha', 'direct', ['pkg:npm/beta@1.2.3']);
    const transitive = pkg('beta', 'transitive');
    const run = input([
      { path: 'src/app.ts', content: "import { vulnerable as run } from 'alpha/subpath';\nrun();\nconst beta = require('beta/subpath');\nbeta.parse();\nexport { read } from 'beta/re-exports';" },
    ]);
    const source = run.source;
    if (!source) throw new Error('fixture_source_missing');
    const result = analyzeDependencyReachability(source, [direct, transitive], [direct, transitive], new Map([
      ['alpha\u00001.2.3', ['vulnerable']],
      ['beta\u00001.2.3', ['parse', 'read']],
    ]), true);
    expect(result.get(direct.purl)).toMatchObject({ state: 'reachable', symbolEvidence: [{ file: 'src/app.ts', line: 2, symbol: 'vulnerable' }] });
    expect(result.get(transitive.purl)).toMatchObject({ state: 'reachable', dependencyPath: [direct.purl, transitive.purl] });
  });

  it('keeps an import visible when symbol metadata is absent or its symbol is not referenced', () => {
    const direct = pkg('alpha', 'direct');
    const run = input([{ path: 'src/app.js', content: "import 'alpha';\nimport * as alphaApi from 'alpha';\nvoid alphaApi;" }]);
    const source = run.source;
    if (!source) throw new Error('fixture_source_missing');
    const result = analyzeDependencyReachability(source, [direct], [direct], new Map([
      ['alpha\u00001.2.3', ['vulnerable']],
    ]), true);
    expect(result.get(direct.purl)).toMatchObject({ state: 'imported', symbolCoverage: 'not_found_static' });
    expect(result.get(direct.purl)?.importEvidence[0]).toMatchObject({ specifier: 'alpha', file: 'src/app.js', line: 1 });
    const unknownSymbols = analyzeDependencyReachability(source, [direct], [direct], new Map([['alpha\u00001.2.3', []]]), true);
    expect(unknownSymbols.get(direct.purl)).toMatchObject({ state: 'imported', symbolCoverage: 'unknown' });
  });

  it('labels a clean static search not_found_static without calling the package unreachable', () => {
    const direct = pkg('alpha', 'direct');
    const run = input([{ path: 'src/app.ts', content: 'export const start = true;' }]);
    const source = run.source;
    if (!source) throw new Error('fixture_source_missing');
    const result = analyzeDependencyReachability(source, [direct], [direct], new Map([['alpha\u00001.2.3', []]]), true);
    expect(result.get(direct.purl)?.state).toBe('not_found_static');
    expect(result.get(direct.purl)?.limitation.join(' ')).toContain('does not prove unreachability');
  });

  it('returns unknown for computed runtime imports, syntax failures, and transitives without a direct path', () => {
    const direct = pkg('alpha', 'direct');
    const transitive = pkg('beta', 'transitive');
    const dynamicRun = input([{ path: 'src/app.ts', content: 'const name = getPackageName(); require(name);' }]);
    const brokenRun = input([{ path: 'src/app.ts', content: "import { x } from 'alpha';\nconst broken = ;" }]);
    const source = dynamicRun.source;
    const brokenSource = brokenRun.source;
    if (!source || !brokenSource) throw new Error('fixture_source_missing');
    expect(analyzeDependencyReachability(source, [direct], [direct], new Map([['alpha\u00001.2.3', []]]), true).get(direct.purl)?.state).toBe('unknown');
    expect(analyzeDependencyReachability(brokenSource, [direct], [direct], new Map([['alpha\u00001.2.3', []]]), true).get(direct.purl)?.state).toBe('unknown');
    const transitiveRun = input([{ path: 'src/app.ts', content: "import 'beta/subpath';" }]);
    const transitiveSource = transitiveRun.source;
    if (!transitiveSource) throw new Error('fixture_source_missing');
    expect(analyzeDependencyReachability(transitiveSource, [direct, transitive], [transitive], new Map([['beta\u00001.2.3', []]]), false).get(transitive.purl)).toMatchObject({ state: 'unknown', dependencyPath: null });
  });

  it('keeps module.require, createRequire, and framework auto-loading unknown without static imports', () => {
    const direct = pkg('alpha', 'direct');
    const sources = [
      input([{ path: 'app.cjs', content: 'module.require(runtimePackage);' }]).source,
      input([{ path: 'app.mjs', content: "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(runtimePackage);" }]).source,
      input([
        { path: 'package.json', content: '{"dependencies":{"vite":"6.0.0"}}' },
        { path: 'app.ts', content: 'export const start = true;' },
      ]).source,
    ];
    for (const source of sources) {
      if (!source) throw new Error('fixture_source_missing');
      expect(analyzeDependencyReachability(source, [direct], [direct], new Map(), true).get(direct.purl)?.state).toBe('unknown');
    }
  });

  it.each([
    "import type { vulnerable } from 'alpha';\nexport type Result = ReturnType<typeof vulnerable>;",
    "import { type vulnerable } from 'alpha';\nexport type Result = ReturnType<typeof vulnerable>;",
    "export type { vulnerable } from 'alpha';",
    "export { type vulnerable } from 'alpha';",
    "import type alpha = require('alpha');\nexport type Result = typeof alpha;",
  ])('excludes erased type-only package references from runtime evidence: %s', content => {
    const dependency = pkg('alpha', 'direct');
    const source = input([{ path: 'src/app.ts', content }]).source;
    if (!source) throw new Error('fixture_source_missing');
    const result = analyzeDependencyReachability(source, [dependency], [dependency], new Map([['alpha\u00001.2.3', ['vulnerable']]]), true).get(dependency.purl);
    expect(result).toMatchObject({ state: 'not_found_static', importEvidence: [], symbolEvidence: [] });
  });

  it.each([
    "import { type Shape, vulnerable } from 'alpha'; vulnerable();",
    "export { type Shape, vulnerable } from 'alpha';",
  ])('retains value bindings in mixed type/value references: %s', content => {
    const dependency = pkg('alpha', 'direct');
    const source = input([{ path: 'src/app.ts', content }]).source;
    if (!source) throw new Error('fixture_source_missing');
    expect(analyzeDependencyReachability(source, [dependency], [dependency], new Map([['alpha\u00001.2.3', ['vulnerable']]]), true).get(dependency.purl)?.state).toBe('reachable');
  });

  it('keeps an import version unknown when multiple exact versions share the package name', () => {
    const direct = pkg('alpha', 'direct');
    const other = { ...direct, version: '2.0.0', purl: 'pkg:npm/alpha@2.0.0', sourceFile: 'other/package-lock.json' };
    const source = input([{ path: 'src/app.ts', content: "import { vulnerable } from 'alpha'; vulnerable();" }]).source;
    if (!source) throw new Error('fixture_source_missing');
    const results = analyzeDependencyReachability(source, [direct, other], [direct, other], new Map([
      ['alpha\u00001.2.3', ['vulnerable']], ['alpha\u00002.0.0', ['vulnerable']],
    ]), true);
    for (const dependency of [direct, other]) expect(results.get(dependency.purl)?.state).toBe('unknown');
  });

  it.each(['.d.ts', '.d.mts', '.d.cts'])('does not treat declaration-only TypeScript files (%s) as runtime dependency evidence', extension => {
    const dependency = pkg('alpha', 'direct');
    const run = input([{ path: `types/vue-shim${extension}`, content: "import type { Component } from 'alpha';\ndeclare module '*.vue' { const component: Component; export default component; }" }]);
    const source = run.source;
    if (!source) throw new Error('fixture_source_missing');

    const result = analyzeDependencyReachability(source, [dependency], [dependency], new Map(), true).get(dependency.purl);

    expect(result).toMatchObject({ state: 'unknown', importEvidence: [] });
  });
});
