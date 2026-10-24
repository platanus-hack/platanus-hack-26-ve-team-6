import { describe, expect, it } from 'vitest';
import { createDockerScanners } from '../src/docker.js';
import { createNpmArtifactAdapter } from '../src/npm-artifacts.js';
import { createNpmArtifactScanner } from '../src/internal.js';

const live = process.env.GOTCHU_TEST_NPM_ARTIFACTS === '1' ? describe : describe.skip;

live('live npm dependency artifact assessment', () => {
  it('verifies, safely extracts and scans the published is-number@7.0.0 tarball', async () => {
    const scanners = createDockerScanners();
    const adapter = createNpmArtifactAdapter(createNpmArtifactScanner(scanners));
    const result = await adapter.analyze([{
      name: 'is-number',
      version: '7.0.0',
      integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
    }], AbortSignal.timeout(50_000));
    const analysis = result.get('is-number\0' + '7.0.0')?.analysis;
    expect(analysis).toMatchObject({ status: 'verified', integrity: 'verified' });
    expect(analysis?.extractedFileCount).toBeGreaterThan(0);
    expect(analysis?.scannedFileCount).toBeGreaterThan(0);
    expect(analysis?.tools.map(tool => tool.name)).toEqual(['semgrep', 'gitleaks']);
  }, 55_000);
});
