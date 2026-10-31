import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const reportDir = process.env.ECHO_CI_REPORT_DIR;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  // CI records a trace with snapshots and its runners start Electron cold: the first window can take past the default 5 s to
  // show its first read, so an assertion there waits 10 s. Locally the default stands.
  expect: { timeout: process.env.CI ? 10_000 : 5_000 },
  workers: 2,
  // A stray test.only must fail CI rather than silently skip the rest.
  forbidOnly: !!process.env.CI,
  reporter: reportDir ? [['list'], ['json', { outputFile: join(reportDir, 'desktop-e2e.json') }]] : [['list']],
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
});
