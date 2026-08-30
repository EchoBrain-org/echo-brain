import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'tests/person-client/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
