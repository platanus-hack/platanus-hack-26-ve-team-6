import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createCustomerAssessmentRunner, createNpmLicenseAdapter, createOsvAdapter } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

const liveEnabled = process.env.GOTCHU_SCA_LIVE === '1';
const describeLive = describe.skipIf(!liveEnabled);

describeLive('live SCA on a small source project with npm, pnpm and Yarn lockfiles', () => {
  it('runs the bounded assessment pipeline against exact package versions without installing or executing source', async () => {
    const project = new URL('./fixtures/live-sca-project/', import.meta.url);
    const paths = ['package.json', 'src/index.js', 'npm/package-lock.json', 'pnpm-v6/pnpm-lock.yaml', 'pnpm-v9/pnpm-lock.yaml', 'yarn-classic/yarn.lock', 'yarn-berry/yarn.lock'];
    const files = await Promise.all(paths.map(async path => ({ path, content: await readFile(new URL(path, project), 'utf8') })));
    const report = await createCustomerAssessmentRunner({ scanners: absentScanners, licenses: createNpmLicenseAdapter(), advisory: createOsvAdapter() }).run(input(files));
    const inventory = report.internal?.dependencyInventory;
    expect(inventory?.complete).toBe(true);
    expect(inventory?.components.map(({ name, version }) => [name, version])).toHaveLength(5);
    expect(inventory?.components.every(item => item.name === 'is-number' && item.version === '7.0.0' && item.declaredLicense === 'MIT' && item.licenseSource === 'registry')).toBe(true);
    const coverage = new Map(report.internal?.coverage.map(item => [item.capability, item.state]));
    expect(coverage.get('license_metadata')).toBe('inspected');
    expect(coverage.get('dependency_advisories')).toBe('inspected');
  }, 30_000);
});
