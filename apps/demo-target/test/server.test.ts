import { afterEach, describe, expect, it } from 'vitest';
import { startDemoTargetServer } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

describe('controlled target over real loopback HTTP', () => {
  it('never serves sources, manifests, extra paths, queries or other HTTP methods', async () => {
    const target = await startDemoTargetServer({ port: 0 });
    cleanups.push(target.close);
    for (const path of ['/vulnerable/store.ts', '/src/fixtures/vulnerable/store.ts', '/vulnerable/package.json', '/corrected/settings.json', '/vulnerable?path=store.ts', '/']) {
      const response = await fetch(`${target.origin}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    expect((await fetch(`${target.origin}/vulnerable`, { method: 'POST', body: 'ignored' })).status).toBe(405);
  });

  it.each(['0.0.0.0', '169.254.169.254', '2130706433'])('rejects a public, wildcard or ambiguous bind address: %s', async (host) => {
    await expect(startDemoTargetServer({ host, port: 0 })).rejects.toThrow();
  });
});
