import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/migration/**/*.test.ts',
      'tests/standalone/**/*.test.ts',
      'tests/core/**/*.test.ts',
      'tests/adapters/**/*.test.ts',
      'tests/product/end-to-end-synthetic.test.ts',
      'tests/product/runtime-config.test.ts',
      'tests/product/runtime-isolation.test.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
