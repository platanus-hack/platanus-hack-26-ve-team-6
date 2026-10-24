import { afterEach, describe, expect, it } from 'vitest';
import { startDemoTargetServer } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

describe('controlled target over real loopback HTTP', () => {
  it('serves matching vulnerable/corrected headers and a fictional catalog', async () => {
    const target = await startDemoTargetServer({ port: 0 });
    cleanups.push(target.close);
    const vulnerable = await fetch(`${target.origin}/vulnerable`);
    const corrected = await fetch(`${target.origin}/corrected`);
    expect(vulnerable.status).toBe(200);
    expect(vulnerable.headers.get('content-security-policy')).toBeNull();
    expect(corrected.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(vulnerable.headers.get('x-powered-by')).toBe('PaperMoon-Edge/1.0 (fictional)');
    expect(await vulnerable.text()).toBe(await corrected.text());
  });

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

  it.each(['0.0.0.0', '::', 'example.com', '8.8.8.8', '169.254.169.254', '127.1', '2130706433'])('rejects a public, wildcard or ambiguous bind address: %s', async (host) => {
    await expect(startDemoTargetServer({ host, port: 0 })).rejects.toThrow();
  });
});
