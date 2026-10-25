import type { RunnerJob } from './contracts.js';

export const NODE24_NPM_TEST_PROFILE = {
  artifacts: {
    allowedPaths: ['test-results/**', 'coverage/**'],
    maxCount: 10,
    maxBytes: 256 * 1024,
  },
} as const;

export function isAllowedArtifactPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return NODE24_NPM_TEST_PROFILE.artifacts.allowedPaths.some((pattern) => {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(prefix) && path.length > prefix.length;
  });
}

export const SELECTED_NODE_REPORT_PATH = 'test-results/gotchu-node-selected-v1.json';

export function validateSelectedTestFiles(job: RunnerJob, files: ReadonlyMap<string, Buffer>): void {
  if (job.profile !== 'node24-tsx-selected-v1') return;
  for (const path of job.testSelection.files) {
    if (!files.has(path)) throw new Error(`Selected test is not a regular input archive file: ${path}`);
  }
}
