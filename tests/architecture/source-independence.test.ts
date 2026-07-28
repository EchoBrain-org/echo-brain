// Source independence: no sibling-repository reference, symlink, or submodule
// escape in the tracked product source tree.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const SIBLING_MARKERS = [
  'Project_echo',
  'echo-loop',
  'echo-context',
  'echo-dev-platform',
];

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

describe('source independence', () => {
  it('no tracked entry is a symlink or gitlink (submodule)', () => {
    const lines = git('ls-tree', '-r', 'HEAD').trim().split('\n');
    for (const line of lines) {
      const mode = line.split(/\s+/)[0];
      expect(mode, line).not.toBe('120000'); // symlink
      expect(mode, line).not.toBe('160000'); // gitlink / submodule
    }
  });

  it('has no submodule configuration', () => {
    expect(git('ls-files', '.gitmodules').trim()).toBe('');
  });

  it('no production source module references a sibling repository', () => {
    // This check covers literal sibling references in production source.
    // Import/path escapes are separately enforced by the product boundary check.
    const paths = git('ls-tree', '-r', '--name-only', 'HEAD')
      .trim()
      .split('\n')
      .filter((p) => p.startsWith('src/') && /\.(ts|mts)$/.test(p));
    for (const p of paths) {
      const content = git('show', `HEAD:${p}`);
      for (const marker of SIBLING_MARKERS) {
        expect(content.includes(marker), `${p} references ${marker}`).toBe(
          false,
        );
      }
    }
  });

  it('git object storage has no corruption', () => {
    const r = spawnSync(
      'git',
      ['-C', REPO, 'fsck', '--full', '--no-reflogs', '--no-dangling'],
      { encoding: 'utf8' },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
