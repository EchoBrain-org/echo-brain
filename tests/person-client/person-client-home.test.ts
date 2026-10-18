import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it, vi } from 'vitest';
import { runPersonClientCli as runCommands } from '../../src/product/person-client/commands.js';
import { runPersonClientCli as runShipped } from '../../src/product/person-client/composition.js';
import { personSessionStorePaths } from '../../src/product/person-client/session-store.js';

describe('Person client home', () => {
  it.each([
    ['commands', runCommands],
    ['the shipped composition', runShipped],
  ])('%s refuses a call without an explicit home before any output, session or network', async (_name, run) => {
    const network = vi.fn<typeof fetch>();
    let output = '';
    const write = { write: (value: string) => { output += value; return true; } };
    for (const argv of [['status'], ['status', '--help'], ['logout']]) {
      // @ts-expect-error home_directory is required; the runtime check backs the type.
      await expect(run(argv, { fetch: network, stdout: write, stderr: write }), argv.join(' ')).rejects.toThrow('explicit home_directory');
      // @ts-expect-error the dependencies, and so the home, are required.
      await expect(run(argv), argv.join(' ')).rejects.toThrow('explicit home_directory');
    }
    expect(output).toBe('');
    expect(network).not.toHaveBeenCalled();
  });

  it('runs every root test against the run\'s temporary home, never the real one', () => {
    const home = inject('isolated_home');
    expect(home).not.toBe(userInfo().homedir);
    expect(process.env.HOME).toBe(home);
    expect(homedir()).toBe(home);
    expect(process.env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'));
    expect(personSessionStorePaths(homedir()).directory).toBe(join(home, '.local', 'share', 'echo-brain', 'person'));
  });
});
