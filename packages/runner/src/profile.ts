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
