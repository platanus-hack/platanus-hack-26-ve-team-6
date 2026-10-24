import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetchNpmDependencies, NpmFetchError } from '../src/npm-cache.js';

describe('npm lockfile fetch phase (unit)', () => {
  it('verifies registry tarballs against lockfile sha512 integrity', async () => {
    const bytes = Buffer.from('fixture tarball');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity } } }));
    const result = await fetchNpmDependencies(lock, { fetch: async () => new Response(bytes) });
    expect(result.tarballs).toHaveLength(1);
    expect(result.tarballs[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.lockfileSha256).toBe(createHash('sha256').update(lock).digest('hex'));
  });

  it.each([
    ['git URL', 'git+https://github.com/example/pkg.git', 'sha512-AAAA'],
    ['HTTP URL', 'http://registry.npmjs.org/fixture/-/fixture.tgz', 'sha512-AAAA'],
  ])('rejects %s before downloading', async (_label, resolved, integrity) => {
    const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/fixture': { resolved, integrity } } }));
    await expect(fetchNpmDependencies(lock)).rejects.toMatchObject({ reason: 'unsupported-dependency' });
  });

  it('rejects a bad integrity value', async () => {
    const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture/-/fixture.tgz', integrity: 'sha512-AAAA' } } }));
    await expect(fetchNpmDependencies(lock, { fetch: async () => new Response('bad') })).rejects.toBeInstanceOf(NpmFetchError);
    await expect(fetchNpmDependencies(lock, { fetch: async () => new Response('bad') })).rejects.toMatchObject({ reason: 'integrity-mismatch' });
  });
});
