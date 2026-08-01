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
    expect(stdout.read()).toContain('echo-brain selftest');
    expect(stdout.read()).toContain('echo-brain identity-check');
    expect(stdout.read()).toContain('echo-brain organization enroll');
    expect(stdout.read()).toContain('--allow-exportable-software-key');
  });

  it('no longer offers the retired founder-provenance commands', async () => {
    const stdout = output();
    expect(await runProductCli([], { stdout: stdout.stream })).toBe(0);
    expect(stdout.read()).not.toContain('echo-brain export');
    expect(stdout.read()).not.toContain('identity-bootstrap');
    expect(stdout.read()).not.toContain('--independent-copy-root');

    for (const argv of [
      ['export', '--config', '/tmp/echo-missing.json'],
      ['identity-bootstrap', 'begin', '--config', '/tmp/echo-missing.json'],
    ]) {
      const stderr = output();
      expect(await runProductCli(argv, { stderr: stderr.stream })).toBe(2);
      expect(stderr.read()).toContain('usage: echo-brain <onboard|');
    }
  });

  it('prints the package version without requiring a config', async () => {
    const stdout = output();
    expect(await runProductCli(['--version'], { stdout: stdout.stream })).toBe(
      0,
    );
    expect(stdout.read()).toBe('0.0.0-dev.0\n');
  });
});
