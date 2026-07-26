import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
      'tests/machine/**/*.test.ts',
      'tests/core/**/*.test.ts',
      'tests/adapters/**/*.test.ts',
      'tests/infrastructure/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['tests/machine/target/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
