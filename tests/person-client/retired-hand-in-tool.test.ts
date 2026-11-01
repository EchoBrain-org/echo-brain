import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPersonClientCli } from '../../src/product/person-client/composition.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function client() {
  const home = mkdtempSync(join(tmpdir(), 'echo-retired-hand-in-')); homes.push(home);
  let output = '', errors = '';
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    fetch, output: () => output, errors: () => errors,
    run: (argv: readonly string[]) => runPersonClientCli(argv, { home_directory: home, fetch,
      stdout: { write: value => { output += value; } }, stderr: { write: value => { errors += value; } } }),
  };
}

describe('retired hand-in CLI', () => {
  it('does not advertise pasted meeting intake while keeping the staging operator command', async () => {
    const cli = client();
    expect(await cli.run(['--help'])).toBe(0);
    expect(await cli.run(['tools', 'meetings', '--help'])).toBe(0);
    expect(cli.output()).not.toMatch(/hand-in|tools submit|--notes-file|--transcript-file/);
    expect(cli.output()).toContain('--tool synthetic');
    expect(cli.output()).toContain('--meeting-file');
    expect(cli.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['submit', '--meeting-title', 'Retired input', '--notes-file', '/does-not-exist/notes.txt', '--retain'],
    ['meetings', '--request', '{"schema_version":2,"tool_id":"hand-in","operation":"reviews"}'],
  ])('refuses the retired %s command as usage before authentication or transport', async (...args) => {
    const cli = client();
    expect(await cli.run(['tools', args[0]!, '--tool', 'hand-in', ...args.slice(1)])).toBe(2);
    expect(cli.output()).toBe('');
    expect(cli.errors()).not.toContain('Retired input');
    expect(cli.fetch).not.toHaveBeenCalled();
  });
});
