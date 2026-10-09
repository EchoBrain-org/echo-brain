import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

const reportDir = process.env.ECHO_CI_REPORT_DIR;

export default defineConfig({
  test: {
    ...(reportDir ? {
      reporters: ['default', 'json'],
      outputFile: { json: join(reportDir, 'vitest.json') },
    } : {}),
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'providers/**/test/**/*.test.ts',
      'tests/person-client/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Keep process-heavy architecture fixtures bounded while other files run.
    maxWorkers: 2,
  },
});
