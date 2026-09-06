import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');

describe('connected offline staging journey', () => {
  it('migrates captured legacy tooling and reaches a real durable card awaiting human approval', () => {
    const result = spawnSync(process.execPath, ['tests/fixtures/staging-release-journey.mjs'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 150_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    expect(result.stdout).toContain('"result":"awaiting_human_slack_approval"');
    expect(result.stdout).toContain('"simulated_boundaries":');
  }, 160_000);
});
