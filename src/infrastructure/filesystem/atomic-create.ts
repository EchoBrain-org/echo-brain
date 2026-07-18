import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicWriteError } from './atomic-write.js';

export interface AtomicCreateOpts {
  filePath: string;
  content: string | Buffer;
  mode?: number;
}

function errnoOf(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

/**
 * Create a file exactly once, atomically. Returns true when this call created
 * the file and false when the destination already existed. Unlike
 * `atomicWrite`, the destination is never replaced: the content becomes
 * visible via hard-link, which fails on any existing entry, so a crashed
 * writer can never leave a partially written destination behind.
 */
export function atomicCreate(opts: AtomicCreateOpts): boolean {
  const absPath = resolve(opts.filePath);
  const mode = opts.mode ?? 0o600;
  const buffer =
    typeof opts.content === 'string'
      ? Buffer.from(opts.content, 'utf8')
      : opts.content;

  let tempPath = '';
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      tempPath = `${absPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fd = openSync(
          tempPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          mode,
        );
        ownsTemp = true;
        break;
      } catch (err) {
        if (errnoOf(err) !== 'EEXIST' || attempt === 9) throw err;
      }
    }
    if (fd === undefined) {
      throw new AtomicWriteError(
        'EEXIST',
        absPath,
        'could not create a unique temporary file',
      );
    }
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset, offset);
      if (written === 0) {
        throw new AtomicWriteError(
          'UNKNOWN',
          absPath,
          'temp file write made no progress',
        );
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    try {
      linkSync(tempPath, absPath);
    } catch (err) {
      if (errnoOf(err) === 'EEXIST') return false;
      throw err;
    }
  } catch (err) {
    if (err instanceof AtomicWriteError) throw err;
    throw new AtomicWriteError(
      'UNKNOWN',
      absPath,
      `atomic create failed: ${(err as Error).message}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
    if (ownsTemp) bestEffortUnlink(tempPath);
  }

  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(dirname(absPath), 'r');
    fsyncSync(directoryFd);
  } catch (err) {
    throw new AtomicWriteError(
      'UNKNOWN',
      absPath,
      `failed to sync containing directory: ${(err as Error).message}`,
    );
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
  return true;
}
