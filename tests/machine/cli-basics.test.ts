import { describe, expect, it } from 'vitest';
import { runProductCli } from '../../src/product/cli.js';

function output() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => (
        (value += chunk.toString()),
        true
      ),
    },
    read: () => value,
  };
}

describe('standalone CLI basics', () => {
  it('prints help without requiring a config', async () => {
    const stdout = output();
    expect(await runProductCli([], { stdout: stdout.stream })).toBe(0);
    expect(stdout.read()).toContain('Usage:');
    expect(stdout.read()).toContain('echo-brain bootstrap');
    expect(stdout.read()).toContain('echo-brain validate-config');
    expect(stdout.read()).toContain('echo-brain organization enroll');
    expect(stdout.read()).toContain('echo-brain organization recent-decisions');
    expect(stdout.read()).toContain(
      'echo-brain update apply --channel internal-live',
    );
    expect(stdout.read()).toContain('--allow-exportable-software-key');
  });

  it('offers neither the retired founder-provenance nor the removed v1 commands', async () => {
    const stdout = output();
    expect(await runProductCli([], { stdout: stdout.stream })).toBe(0);
    for (const absent of [
      'echo-brain export',
      'identity-bootstrap',
      '--independent-copy-root',
      'echo-brain onboard',
      'echo-brain selftest',
      'echo-brain approve',
      'echo-brain reject',
      'echo-brain run --config',
      'echo-brain identity-check',
      // The launchd child command stays unadvertised.
      'echo-brain service-run',
    ]) {
      expect(stdout.read()).not.toContain(absent);
    }

    for (const argv of [
      ['export', '--config', '/tmp/echo-missing.json'],
      ['identity-bootstrap', 'begin', '--config', '/tmp/echo-missing.json'],
      ['onboard', '--config', '/tmp/echo-missing.json'],
      ['selftest', '--config', '/tmp/echo-missing.json'],
      ['approve', '--config', '/tmp/echo-missing.json'],
      ['reject', '--config', '/tmp/echo-missing.json'],
      ['run', '--config', '/tmp/echo-missing.json'],
      ['identity-check', '--config', '/tmp/echo-missing.json'],
    ]) {
      const stderr = output();
      expect(await runProductCli(argv, { stderr: stderr.stream })).toBe(2);
      expect(stderr.read()).toContain('usage: echo-brain <bootstrap|init|');
      expect(stderr.read()).not.toContain('service-run');
    }
  });

  it('requires an absolute --config for every command', async () => {
    const stderr = output();
    expect(
      await runProductCli(['validate-config', '--config', 'relative.json'], {
        stderr: stderr.stream,
      }),
    ).toBe(2);
    expect(stderr.read()).toContain('--config must be an absolute path');
  });

  it('refuses an option the named command does not accept', async () => {
    const stderr = output();
    expect(
      await runProductCli(
        ['status', '--config', '/tmp/echo-missing.json', '--local-only'],
        { stderr: stderr.stream },
      ),
    ).toBe(2);
    expect(stderr.read()).toContain(
      '--local-only is not valid with `echo-brain status`',
    );
  });

  it('prints the package version without requiring a config', async () => {
    const stdout = output();
    expect(await runProductCli(['--version'], { stdout: stdout.stream })).toBe(
      0,
    );
    expect(stdout.read()).toBe('0.1.0-internal.6\n');
  });
});
