import { describe, expect, it, vi } from 'vitest';
import { createDockerScanners } from '../src/index.js';
import { input } from './fixtures.js';

describe('development-only scanner release gate', () => {
  it('rejects the outdated Semgrep profile before any Docker operation in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const source = input().source;
      if (!source) throw new Error('Missing test source');
      await expect(createDockerScanners().run('semgrep', source, AbortSignal.timeout(1000))).rejects.toThrow('development_scanner_profile_not_allowed');
    } finally { vi.unstubAllEnvs(); }
  });
});
