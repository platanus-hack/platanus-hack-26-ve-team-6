import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNpmLicenseAdapter, createOsvAdapter, parseLockfile, sourceDigest } from '../src/index.js';

const liveEnabled = process.env.GOTCHU_SCA_LIVE === '1';
const describeLive = describe.skipIf(!liveEnabled);

describeLive('live registry and OSV checks for small npm, pnpm and Yarn lockfiles', () => {
  it('queries exact versions for five lockfile formats without installing or executing them', async () => {
    const project = new URL('./fixtures/live-sca-project/', import.meta.url);
    const paths = ['package.json', 'npm/package-lock.json', 'pnpm-v6/pnpm-lock.yaml', 'pnpm-v9/pnpm-lock.yaml', 'yarn-classic/yarn.lock', 'yarn-berry/yarn.lock'];
    const files = await Promise.all(paths.map(async path => ({ path, content: await readFile(new URL(path, project), 'utf8') })));
    const snapshot = { revision: 'live-fixture', files };
    const parsed = parseLockfile({ ...snapshot, id: 'live-fixture', digest: sourceDigest(snapshot) });
    expect(parsed.complete).toBe(true);
    expect(parsed.inventory.map(({ name, version }) => [name, version])).toHaveLength(5);
    expect(parsed.inventory.every(item => item.name === 'is-number' && item.version === '7.0.0')).toBe(true);

    const signal = AbortSignal.timeout(20_000);
    const packages = [{ name: 'is-number', version: '7.0.0' }];
    const licenses = await createNpmLicenseAdapter().lookup(packages, signal);
    expect(licenses).toHaveLength(1);
    expect(licenses[0]).toMatchObject({ declaredLicense: 'MIT', complete: true });
    const advisories = await createOsvAdapter().query(packages, signal);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.complete).toBe(true);
  }, 30_000);
});
