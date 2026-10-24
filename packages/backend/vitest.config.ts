import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live files share the global monitor due queue in their single PostgreSQL fixture.
    fileParallelism: false,
  },
});
