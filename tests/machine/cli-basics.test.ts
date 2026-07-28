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
    expect(stdout.read()).toContain('echo-brain export');
    expect(stdout.read()).toContain('echo-brain identity-bootstrap commit');
    expect(stdout.read()).toContain('--independent-copy-root <absolute-path>');
    expect(stdout.read()).toContain('--allow-exportable-software-key');
  });

  it('prints the package version without requiring a config', async () => {
    const stdout = output();
    expect(await runProductCli(['--version'], { stdout: stdout.stream })).toBe(
      0,
    );
    expect(stdout.read()).toBe('0.0.0-dev.0\n');
  });
});
