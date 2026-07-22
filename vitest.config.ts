import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'tests/migration/**/*.test.ts',
      'tests/standalone/**/*.test.ts',
      'tests/core/**/*.test.ts',
      'tests/adapters/**/*.test.ts',
      'tests/infrastructure/**/*.test.ts',
      'tests/product/runtime-config.test.ts',
      'tests/product/runtime-isolation.test.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
