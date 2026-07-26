import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

export type ProcessFileLockErrorCode = 'busy' | 'unsafe' | 'compromised' | 'io';

export class ProcessFileLockError extends Error {
  constructor(
    public readonly code: ProcessFileLockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessFileLockError';
  }
}

export interface ProcessFileLockOptions {
  timeoutMs: number;
  staleMs: number;
  retryMs: number;
  /** Internal deterministic interleaving hook used only by the lock tests. */
  afterDirectoryCreate?: () => Promise<void>;
}

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== 'ESRCH';
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTEMPTY') throw error;
  }
}

/**
 * Acquire a crash-recoverable, cross-process lock.
 *
 * The lock is a directory containing exactly one owner file whose filename is
 * the ownership token. Stale recovery unlinks that exact token before removing
 * the directory. A contender that observed an older owner can therefore never
 * delete a newer owner's token, closing the usual check-then-unlink race.
 */
export async function acquireProcessFileLock(
  lockDirectory: string,
  options: ProcessFileLockOptions,
): Promise<() => Promise<void>> {
  const token = `${process.pid}-${randomUUID()}`;
  const ownerPath = join(lockDirectory, token);
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    let created = false;
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errno(error) !== 'EEXIST') {
        throw new ProcessFileLockError('io', 'cannot create process lock', {
          cause: error,
        });
      }
    }

    if (created) {
      let createdState;
      try {
        createdState = await lstat(lockDirectory);
        if (!createdState.isDirectory() || createdState.isSymbolicLink()) {
          throw new ProcessFileLockError(
            'unsafe',
            'new process lock directory is unsafe',
          );
        }
        await options.afterDirectoryCreate?.();
      } catch (error) {
        if (errno(error) === 'ENOENT') continue;
        if (error instanceof ProcessFileLockError) throw error;
        throw new ProcessFileLockError(
          'io',
          'cannot inspect new process lock',
          {
            cause: error,
          },
        );
      }
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          ownerPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          'utf8',
        );
        await handle.sync();
        await handle.close();
        handle = undefined;

        const currentState = await lstat(lockDirectory);
        const currentEntries = await readdir(lockDirectory);
        if (
          currentState.dev !== createdState.dev ||
          currentState.ino !== createdState.ino ||
          currentEntries.length !== 1 ||
          currentEntries[0] !== token
        ) {
          // The empty initialization directory was replaced or another owner
          // appeared before publication. Remove only our unguessable token;
          // never remove the replacement directory or its owner's token.
          try {
            await unlink(ownerPath);
          } catch {
            // A replacement may already have removed our token.
          }
          continue;
        }

        return async () => {
          try {
            const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
              token?: unknown;
            };
            if (owner.token !== token) {
              throw new ProcessFileLockError(
                'compromised',
                'process lock ownership changed before release',
              );
            }
            await unlink(ownerPath);
            await rmdir(lockDirectory);
          } catch (error) {
            if (error instanceof ProcessFileLockError) throw error;
            throw new ProcessFileLockError(
              'compromised',
              'cannot release process lock cleanly',
              { cause: error },
            );
          }
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        try {
          await unlink(ownerPath);
        } catch {
          // The directory may have been removed while still empty.
        }
        try {
          const currentState = await lstat(lockDirectory);
          if (
            currentState.dev === createdState.dev &&
            currentState.ino === createdState.ino
          ) {
            await removeEmptyDirectory(lockDirectory);
          }
        } catch {
          // The initialization directory was already removed or replaced.
        }
        if (errno(error) === 'ENOENT') continue;
        throw new ProcessFileLockError('io', 'cannot establish process lock', {
          cause: error,
        });
      }
    }

    let lockState;
    try {
      lockState = await lstat(lockDirectory);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw new ProcessFileLockError('io', 'cannot inspect process lock', {
        cause: error,
      });
    }
    if (lockState.isSymbolicLink() || !lockState.isDirectory()) {
      throw new ProcessFileLockError('unsafe', 'process lock path is unsafe');
    }

    let entries: string[];
    try {
      entries = await readdir(lockDirectory);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw new ProcessFileLockError(
        'io',
        'cannot inspect process lock owner',
        {
          cause: error,
        },
      );
    }
    if (entries.length === 0) {
      await removeEmptyDirectory(lockDirectory);
      continue;
    }
    if (entries.length !== 1) {
      throw new ProcessFileLockError(
        'unsafe',
        'process lock contains unexpected entries',
      );
    }
    const match =
      /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(
        entries[0]!,
      );
    if (match === null) {
      throw new ProcessFileLockError(
        'unsafe',
        'process lock owner token is invalid',
      );
    }
    const observedOwnerPath = join(lockDirectory, entries[0]!);
    let ownerState;
    try {
      ownerState = await lstat(observedOwnerPath);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw new ProcessFileLockError(
        'io',
        'cannot inspect process lock owner',
        {
          cause: error,
        },
      );
    }
    if (ownerState.isSymbolicLink() || !ownerState.isFile()) {
      throw new ProcessFileLockError('unsafe', 'process lock owner is unsafe');
    }

    const ownerPid = Number(match[1]);
    if (
      Date.now() - ownerState.mtimeMs > options.staleMs &&
      !processIsAlive(ownerPid)
    ) {
      try {
        // Only the contender that successfully removes this exact token may
        // remove the now-empty directory. Other contenders observe ENOENT and
        // restart without touching a replacement owner's different token.
        await unlink(observedOwnerPath);
      } catch (error) {
        if (errno(error) === 'ENOENT') continue;
        throw new ProcessFileLockError(
          'io',
          'cannot recover stale process lock',
          {
            cause: error,
          },
        );
      }
      try {
        await rmdir(lockDirectory);
      } catch (error) {
        if (errno(error) !== 'ENOENT') {
          throw new ProcessFileLockError(
            'unsafe',
            'stale process lock changed during recovery',
            { cause: error },
          );
        }
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ProcessFileLockError('busy', 'process lock is busy');
    }
    await delay(options.retryMs);
  }
}
