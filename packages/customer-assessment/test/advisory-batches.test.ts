import { expect, it, vi } from 'vitest';
import { createCustomerAssessmentRunner } from '../src/index.js';
import { absentScanners, input } from './fixtures.js';

function project(count: number) {
  return input([{ path: 'package-lock.json', content: JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, ...Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `node_modules/p${index}`, { version: '1.0.0', license: 'MIT' },
    ])) },
  }) }]);
}

it.each([
  { count: 226, batches: [200, 26], state: 'inspected' },
  { count: 501, batches: [200, 200, 100], state: 'unavailable' },
])('covers bounded advisory batches for $count unique versions', async ({ count, batches, state }) => {
  const query = vi.fn(async (packages: ReadonlyArray<{ name: string; version: string }>) =>
    packages.map(() => ({ ids: [], complete: true })));
  const report = await createCustomerAssessmentRunner({ scanners: absentScanners, advisory: { query } }).run(project(count));
  expect(query.mock.calls.map(call => call[0].length)).toEqual(batches);
  expect(new Set(query.mock.calls.flatMap(call => call[0].map(pkg => pkg.name))).size).toBe(Math.min(count, 500));
  expect(report.internal?.coverage.find(item => item.capability === 'dependency_advisories')?.state).toBe(state);
});

it('does not call a failed later advisory batch complete', async () => {
  const query = vi.fn(async (packages: ReadonlyArray<{ name: string; version: string }>) => {
    if (query.mock.calls.length === 2) throw new Error('fixture_second_batch_unavailable');
    return packages.map(() => ({ ids: [], complete: true }));
  });
  const report = await createCustomerAssessmentRunner({ scanners: absentScanners, advisory: { query } }).run(project(226));
  expect(report.internal?.coverage.find(item => item.capability === 'dependency_advisories')?.state).toBe('unavailable');
});
