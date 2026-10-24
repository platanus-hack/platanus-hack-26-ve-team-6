import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Isolation tests temporarily transfer object ownership, which affects all fixtures in this database.
    fileParallelism: false,
  },
});
