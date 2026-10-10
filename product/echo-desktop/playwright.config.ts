import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const reportDir = process.env.ECHO_CI_REPORT_DIR;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 2,
  reporter: reportDir ? [['list'], ['json', { outputFile: join(reportDir, 'desktop-e2e.json') }]] : [['list']],
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
});
