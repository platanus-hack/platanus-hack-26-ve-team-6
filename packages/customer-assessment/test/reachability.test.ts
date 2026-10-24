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
});
