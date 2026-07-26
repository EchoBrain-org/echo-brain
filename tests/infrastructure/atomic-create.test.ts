import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicCreate } from '../../src/infrastructure/filesystem/atomic-create.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('atomic create', () => {
  it('creates exactly once without replacing the winner or leaving temporary files', () => {
    const root = mkdtempSync(join(tmpdir(), 'atomic-create-'));
    roots.push(root);
    const path = join(root, 'slot.json');

    expect(atomicCreate({ filePath: path, content: 'first\n' })).toBe(true);
    expect(atomicCreate({ filePath: path, content: 'second\n' })).toBe(false);

    expect(readFileSync(path, 'utf8')).toBe('first\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['slot.json']);
  });

  it('honors an explicit private file mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'atomic-create-mode-'));
    roots.push(root);
    const path = join(root, 'slot.txt');

    expect(
      atomicCreate({
        filePath: path,
        content: Buffer.from('value'),
        mode: 0o640,
      }),
    ).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });
});
