import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/experimental/**/*.test.ts'],
    setupFiles: ['tests/product/setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
