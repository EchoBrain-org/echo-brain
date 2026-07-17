import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AtomicWriteError,
  atomicWrite,
  type AtomicWriteErrorCode,
} from '../../src/infrastructure/filesystem/atomic-write.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-atomic-write-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function expectAtomicWriteError(operation: () => void, code: AtomicWriteErrorCode): void {
  try {
    operation();
    throw new Error('expected atomicWrite to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect((error as AtomicWriteError).code).toBe(code);
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('atomicWrite', () => {
  it('creates and replaces a file without leaving staged files behind', () => {
    const directory = temporaryDirectory();
    const destination = join(directory, 'state.json');

    atomicWrite({ filePath: destination, content: '{"version":1}\n' });
    atomicWrite({ filePath: destination, content: Buffer.from('{"version":2}\n') });

    expect(readFileSync(destination, 'utf8')).toBe('{"version":2}\n');
    expect(readdirSync(directory)).toEqual(['state.json']);
  });

  it('preserves an existing regular file mode', () => {
    const destination = join(temporaryDirectory(), 'state.json');
    writeFileSync(destination, 'old');
    chmodSync(destination, 0o640);

    atomicWrite({ filePath: destination, content: 'new' });

    expect(readFileSync(destination, 'utf8')).toBe('new');
    expect(fileMode(destination)).toBe(0o640);
  });

  it('creates and tightens secret-sensitive files to owner-only access', () => {
    const directory = temporaryDirectory();
    const created = join(directory, 'created.json');
    const tightened = join(directory, 'tightened.json');
    writeFileSync(tightened, 'old');
    chmodSync(tightened, 0o644);

    atomicWrite({ filePath: created, content: 'created', secretSensitive: true });
    atomicWrite({ filePath: tightened, content: 'new', secretSensitive: true });

    expect(fileMode(created)).toBe(0o600);
    expect(fileMode(tightened)).toBe(0o600);
  });

  it('refuses a final symlink without changing the link target', () => {
    const directory = temporaryDirectory();
    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    writeFileSync(target, 'unchanged');
    symlinkSync(target, link);

    expectAtomicWriteError(
      () => atomicWrite({ filePath: link, content: 'replacement' }),
      'EEXIST',
    );

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });

  it('refuses a directory target', () => {
    const directory = temporaryDirectory();
    const destination = join(directory, 'target');
    mkdirSync(destination);

    expectAtomicWriteError(
      () => atomicWrite({ filePath: destination, content: 'replacement' }),
      'EISDIR',
    );
  });
});
