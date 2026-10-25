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

  it('keeps legacy fetches unchanged when optional packages target another platform', async () => {
    const bytes = Buffer.from('darwin package');
    const lock = makeLock({
      'node_modules/darwin-only': packageEntry('darwin-only', bytes, { optional: true, os: ['darwin'] }),
    });
    const result = await fetchNpmDependencies(lock, { fetch: async () => new Response(bytes) });
    expect(result.tarballs.map(({ name }) => name)).toEqual(['node_modules/darwin-only']);
  });

  it('fetches only optional entries compatible with the fixed Linux x64 glibc target and hashes that set', async () => {
    const required = Buffer.from('required');
    const linuxTarget = Buffer.from('linux x64 glibc');
    const darwin = Buffer.from('darwin');
    const linuxArm = Buffer.from('linux arm');
    const notGlibc = Buffer.from('not glibc');
    const payloads = new Map<string, Buffer>([
      ['node_modules/required', required],
      ['node_modules/linux-target', linuxTarget],
      ['node_modules/darwin-only', darwin],
      ['node_modules/linux-arm', linuxArm],
      ['node_modules/not-glibc', notGlibc],
    ]);
    const packages = {
      'node_modules/required': packageEntry('required', required),
      'node_modules/linux-target': packageEntry('linux-target', linuxTarget, { optional: true, os: ['!darwin'], cpu: ['x64', '!arm64'], libc: ['glibc', '!musl'] }),
      'node_modules/darwin-only': packageEntry('darwin-only', darwin, { optional: true, os: ['darwin'] }),
      'node_modules/linux-arm': packageEntry('linux-arm', linuxArm, { optional: true, os: ['linux'], cpu: ['arm64'] }),
      'node_modules/not-glibc': packageEntry('not-glibc', notGlibc, { optional: true, libc: ['!glibc'] }),
    };
    const lock = makeLock(packages);
    const fetched: string[] = [];
    const result = await fetchNpmDependencies(lock, {
      targetPlatform: 'linux-x64-glibc',
      maxTarballBytes: 128 * 1024 * 1024,
      fetch: async (input) => {
        const name = new URL(String(input)).pathname.split('/-/')[0]?.split('/').at(-1);
        const key = `node_modules/${name}`;
        const bytes = payloads.get(key);
        if (!bytes) throw new Error(`Unexpected tarball ${key}`);
        fetched.push(key);
        return new Response(bytes);
      },
    });
    const manifest = result.tarballs.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
    expect(fetched.sort()).toEqual(['node_modules/linux-target', 'node_modules/required']);
    expect(result.lockfileSha256).toBe(createHash('sha256').update(lock).digest('hex'));
    expect(result.tarballSetSha256).toBe(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
  });

  it('fails closed for malformed platform metadata and incompatible required entries', async () => {
    const bytes = Buffer.from('pkg');
    const malformed = makeLock({ 'node_modules/bad': packageEntry('bad', bytes, { optional: true, os: ['!'] }) });
    await expect(fetchNpmDependencies(malformed, { targetPlatform: 'linux-x64-glibc' }))
      .rejects.toMatchObject({ reason: 'invalid-lockfile' });

    const required = makeLock({ 'node_modules/darwin-required': packageEntry('darwin-required', bytes, { os: ['darwin'] }) });
    await expect(fetchNpmDependencies(required, { targetPlatform: 'linux-x64-glibc' }))
      .rejects.toMatchObject({ reason: 'unsupported-dependency' });
  });

  it('keeps aggregate byte accounting strict across concurrent downloads', async () => {
    const bytes = Buffer.from('123');
    const lock = makeLock({
      'node_modules/first': packageEntry('first', bytes),
      'node_modules/second': packageEntry('second', bytes),
    });
    await expect(fetchNpmDependencies(lock, {
      maxBytes: 5,
      concurrency: 2,
      fetch: async () => new Response(bytes),
    })).rejects.toMatchObject({ reason: 'size-limit' });
  });

  it('rejects a configured per-tarball cap above the hard maximum before fetching', async () => {
    const bytes = Buffer.from('pkg');
    const lock = makeLock({ 'node_modules/fixture': packageEntry('fixture', bytes) });
    let fetchCalls = 0;
    await expect(fetchNpmDependencies(lock, {
      maxTarballBytes: 128 * 1024 * 1024 + 1,
      fetch: async () => { fetchCalls += 1; return new Response(bytes); },
    })).rejects.toMatchObject({ reason: 'size-limit' });
    expect(fetchCalls).toBe(0);
  });

  it('enforces the configured per-tarball cap while streaming', async () => {
    const bytes = Buffer.from('too large');
    const lock = makeLock({ 'node_modules/fixture': packageEntry('fixture', bytes) });
    await expect(fetchNpmDependencies(lock, {
      maxTarballBytes: 4,
      fetch: async () => new Response(bytes),
    })).rejects.toMatchObject({ reason: 'size-limit' });
  });
});

function makeLock(packages: Record<string, Record<string, unknown>>): Buffer {
  return Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }));
}

function packageEntry(name: string, bytes: Buffer, metadata: Record<string, unknown> = {}) {
  return {
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    ...metadata,
  };
}
