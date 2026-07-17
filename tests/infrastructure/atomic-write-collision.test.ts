import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const generated = vi.hoisted(() => ({
  uuid: '00000000-0000-4000-8000-000000000000' as `${string}-${string}-${string}-${string}-${string}`,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => generated.uuid };
});

import {
  AtomicWriteError,
  atomicWrite,
} from '../../src/infrastructure/filesystem/atomic-write.js';

const directory = mkdtempSync(join(tmpdir(), 'echo-atomic-collision-'));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('atomicWrite temporary-file collision handling', () => {
  it('does not unlink a foreign file when exclusive creation reports EEXIST', () => {
    const destination = join(directory, 'state.json');
    const foreignTemp = `${destination}.${process.pid}.${generated.uuid}.tmp`;
    writeFileSync(destination, 'destination');
    writeFileSync(foreignTemp, 'foreign');

    try {
      atomicWrite({ filePath: destination, content: 'replacement' });
      throw new Error('expected atomicWrite to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicWriteError);
      expect((error as AtomicWriteError).code).toBe('EEXIST');
    }

    expect(readFileSync(destination, 'utf8')).toBe('destination');
    expect(readFileSync(foreignTemp, 'utf8')).toBe('foreign');
  });
});
