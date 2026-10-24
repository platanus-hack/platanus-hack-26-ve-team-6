import { describe, expect, it } from 'vitest';
import { parseLockfile } from '../src/lockfiles.js';
import { input } from './fixtures.js';

describe('dependency lockfile integrity', () => {
  it('retains the exact npm SHA-512 field for registry artifact verification', () => {
    const run = input([{ path: 'package-lock.json', content: JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { alpha: '^1.0.0' } }, 'node_modules/alpha': { version: '1.2.3', integrity: 'sha512-exact-lock-value', license: 'MIT' } },
    }) }]);
    if (!run.source) throw new Error('fixture_source_missing');
    expect(parseLockfile(run.source).inventory[0]?.integrity).toBe('sha512-exact-lock-value');
  });
});
