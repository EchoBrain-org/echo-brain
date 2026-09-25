import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 2,
  reporter: [['list']],
});
