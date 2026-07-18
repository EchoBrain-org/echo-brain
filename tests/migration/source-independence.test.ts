// AC7 — source independence: no source-repo, sibling, absolute-path, symlink, or
// submodule escape in the tracked target tree.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const SIBLING_MARKERS = ['Project_echo', 'echo-loop', 'echo-context', 'echo-dev-platform'];

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
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

  it('no extracted production source module references the source or a sibling repository', () => {
    // The escape guarantee is about the shipped product closure. Target-only audit
    // tooling (tools/**), provenance records, this test's own marker list, and the
    // byte-identical parity-leaf tests legitimately NAME the source/siblings; the
    // production src/ tree must not. Import/path escapes are separately enforced by
    // check-dependencies.mjs.
    const paths = git('ls-tree', '-r', '--name-only', 'HEAD')
      .trim()
      .split('\n')
      .filter((p) => p.startsWith('src/') && /\.(ts|mts)$/.test(p));
    for (const p of paths) {
      const content = git('show', `HEAD:${p}`);
      for (const marker of SIBLING_MARKERS) {
        expect(content.includes(marker), `${p} references ${marker}`).toBe(false);
      }
    }
  });

  it('git fsck is clean with no dangling or unreachable objects', () => {
    const r = spawnSync('git', ['-C', REPO, 'fsck', '--full', '--no-reflogs', '--unreachable'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim() + r.stderr.replace(/^Checking.*$/gm, '').trim()).toBe('');
  });
});
