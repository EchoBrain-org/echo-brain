import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AtomicWriteErrorCode =
  | 'EACCES'
  | 'ENOSPC'
  | 'ENOTDIR'
  | 'ENOENT'
  | 'EISDIR'
  | 'EROFS'
  | 'EEXIST'
  | 'ELOOP'
  | 'UNKNOWN';

export class AtomicWriteError extends Error {
  constructor(
    public readonly code: AtomicWriteErrorCode,
    public readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

export interface AtomicWriteOpts {
  filePath: string;
  content: string | Buffer;
  secretSensitive?: boolean;
}

function errnoCode(err: unknown): AtomicWriteErrorCode {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'EACCES' ||
      code === 'ENOSPC' ||
      code === 'ENOTDIR' ||
      code === 'ENOENT' ||
      code === 'EISDIR' ||
      code === 'EROFS' ||
      code === 'EEXIST' ||
      code === 'ELOOP'
    ) {
      return code;
    }
  }
  return 'UNKNOWN';
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function atomicWrite(opts: AtomicWriteOpts): void {
  const absPath = resolve(opts.filePath);
  const secretSensitive = opts.secretSensitive === true;

  let existingMode: number | undefined;
  const writePath = absPath;

  try {
    const lst = lstatSync(absPath);
    if (lst.isSymbolicLink()) {
      throw new AtomicWriteError(
        'EEXIST',
        absPath,
        `refusing to write through symlink at ${absPath}`,
      );
    } else if (lst.isDirectory()) {
      throw new AtomicWriteError('EISDIR', absPath, `target is a directory: ${absPath}`);
    } else if (!lst.isFile()) {
      throw new AtomicWriteError(
        'EEXIST',
        absPath,
        `target is not a regular file: ${absPath}`,
      );
    } else {
      existingMode = lst.mode & 0o777;
    }
  } catch (err) {
    if (err instanceof AtomicWriteError) throw err;
    const code = errnoCode(err);
    if (code !== 'ENOENT') {
      throw new AtomicWriteError(code, absPath, `lstat failed: ${(err as Error).message}`);
    }
  }

  let mode: number;
  let lockTo600 = false;
  if (existingMode !== undefined) {
    if (secretSensitive && (existingMode & 0o077) !== 0) {
      mode = 0o600;
      lockTo600 = true;
    } else {
      mode = existingMode;
    }
  } else if (secretSensitive) {
    mode = 0o600;
    lockTo600 = true;
  } else {
    mode = 0o666;
  }

  let tempPath = '';
  let fd: number | undefined;
  let ownsTemp = false;
  const exclusiveWriteFlags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      tempPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fd = openSync(tempPath, exclusiveWriteFlags, mode);
        ownsTemp = true;
        break;
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST' || attempt === 9) throw err;
      }
    }
    if (fd === undefined) {
      throw new AtomicWriteError(
        'EEXIST',
        writePath,
        'could not create a unique temporary file',
      );
    }
    const buffer =
      typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (written === 0) {
        throw new AtomicWriteError(
          'UNKNOWN',
          writePath,
          'temp file write made no progress',
        );
      }
      offset += written;
    }
    if (lockTo600) {
      fchmodSync(fd, 0o600);
    } else if (existingMode !== undefined) {
      // Re-apply existing mode in case the process umask stripped bits.
      fchmodSync(fd, existingMode);
    }
    fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
      fd = undefined;
    }
    if (ownsTemp) bestEffortUnlink(tempPath);
    if (err instanceof AtomicWriteError) throw err;
    const code = errnoCode(err);
    throw new AtomicWriteError(
      code,
      writePath,
      `failed to write temp file: ${(err as Error).message}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }

  try {
    renameSync(tempPath, writePath);
    ownsTemp = false;
  } catch (err) {
    if (ownsTemp) bestEffortUnlink(tempPath);
    const code = errnoCode(err);
    throw new AtomicWriteError(
      code,
      writePath,
      `rename to ${writePath} failed: ${(err as Error).message}`,
    );
  }

  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(dirname(writePath), 'r');
    fsyncSync(directoryFd);
  } catch (err) {
    const code = errnoCode(err);
    throw new AtomicWriteError(
      code,
      writePath,
      `failed to sync containing directory: ${(err as Error).message}`,
    );
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
