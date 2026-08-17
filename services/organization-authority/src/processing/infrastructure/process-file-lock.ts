import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
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
  /** Internal deterministic interleaving hook used only by the lock tests. */
  afterOwnerCreate?: () => Promise<void>;
  /** Internal deterministic interleaving hook used only by the lock tests. */
  afterOwnerUnlink?: () => Promise<void>;
  /** Internal deterministic interleaving hook used only by the lock tests. */
  afterStaleOwnerUnlink?: () => Promise<void>;
  /** Internal deterministic interleaving hook used only by the lock tests. */
  afterValidSuccessorObserved?: () => Promise<void>;
}

const OWNER_TOKEN =
  /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ObservedOwner {
  pid: number;
  token: string;
  state: Awaited<ReturnType<typeof lstat>>;
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

function busy(): ProcessFileLockError {
  return new ProcessFileLockError('busy', 'process lock is busy');
}

/** Invalid caller configuration is an operational error, not lock corruption. */
function assertValidOptions(options: ProcessFileLockOptions): void {
  for (const [name, value] of Object.entries({
    timeoutMs: options.timeoutMs,
    staleMs: options.staleMs,
    retryMs: options.retryMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProcessFileLockError(
        'io',
        `process lock ${name} must be a nonnegative safe integer`,
      );
    }
  }
}

async function retryBefore(
  deadline: number,
  retryMs: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw busy();
  await delay(Math.min(Math.max(0, retryMs), remaining));
  if (Date.now() >= deadline) throw busy();
}

function assertSafeDirectory(state: Awaited<ReturnType<typeof lstat>>): void {
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new ProcessFileLockError('unsafe', 'process lock path is unsafe');
  }
  assertPrivateOwnedState(state, 0o700, 'process lock directory');
}

function assertPrivateOwnedState(
  state: Awaited<ReturnType<typeof lstat>>,
  expectedMode: number,
  description: string,
): void {
  if ((Number(state.mode) & 0o777) !== expectedMode) {
    throw new ProcessFileLockError('unsafe', `${description} mode is unsafe`);
  }
  if (
    typeof process.getuid === 'function' &&
    Number(state.uid) !== process.getuid()
  ) {
    throw new ProcessFileLockError('unsafe', `${description} owner is unsafe`);
  }
}

/**
 * Read and validate the owner record through a no-follow descriptor. The
 * syntactically valid token filename is the complete atomic owner record: its
 * O_EXCL directory entry is publication. File contents are intentionally
 * ignored for compatibility with older JSON-filled owners and so a crash
 * between creation and a payload write cannot create an invalid half-owner.
 */
async function readOwner(
  ownerPath: string,
  token: string,
): Promise<ObservedOwner> {
  const match = OWNER_TOKEN.exec(token);
  if (match === null) {
    throw new ProcessFileLockError(
      'unsafe',
      'process lock owner token is invalid',
    );
  }

  let handle: FileHandle | undefined;
  try {
    const pathState = await lstat(ownerPath);
    if (pathState.isSymbolicLink() || !pathState.isFile()) {
      throw new ProcessFileLockError('unsafe', 'process lock owner is unsafe');
    }
    assertPrivateOwnedState(pathState, 0o600, 'process lock owner');
    handle = await open(
      ownerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const state = await handle.stat();
    if (!state.isFile()) {
      throw new ProcessFileLockError('unsafe', 'process lock owner is unsafe');
    }
    assertPrivateOwnedState(state, 0o600, 'process lock owner');
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProcessFileLockError(
        'unsafe',
        'process lock owner token is invalid',
      );
    }
    return { pid, token, state };
  } catch (error) {
    if (error instanceof ProcessFileLockError) throw error;
    if (errno(error) === 'ELOOP' || errno(error) === 'ENXIO') {
      throw new ProcessFileLockError('unsafe', 'process lock owner is unsafe', {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The directory has only two legal states: empty while it is being
 * initialized, or exactly one validated owner token.  This is deliberately
 * stricter than treating ENOTEMPTY as a successful cleanup: lock parents can
 * be shared-writable, so arbitrary entries are an integrity failure.
 */
async function inspectLockDirectory(
  lockDirectory: string,
): Promise<ObservedOwner | undefined> {
  const directoryState = await lstat(lockDirectory);
  assertSafeDirectory(directoryState);
  const entries = await readdir(lockDirectory);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) {
    throw new ProcessFileLockError(
      'unsafe',
      'process lock contains unexpected entries',
    );
  }
  return await readOwner(join(lockDirectory, entries[0]!), entries[0]!);
}

/**
 * Remove a directory only while it is proved empty.  Once our exact owner
 * token has been unlinked, another initializer may publish a successor before
 * rmdir.  We accept only that fully validated successor; any other ENOTEMPTY
 * is unsafe, rather than a successful release or recovery.
 */
async function removeOnlyProvenEmptyDirectory(
  lockDirectory: string,
  deadline: number,
  afterValidSuccessorObserved?: () => Promise<void>,
): Promise<boolean> {
  let successorValidationAfterDeadlineAvailable = true;
  for (;;) {
    let owner: ObservedOwner | undefined;
    try {
      owner = await inspectLockDirectory(lockDirectory);
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
    if (owner !== undefined) {
      await afterValidSuccessorObserved?.();
      return false;
    }

    try {
      await rmdir(lockDirectory);
      return true;
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      if (errno(error) !== 'ENOTEMPTY') throw error;
      // A contender changed the directory after our empty observation.  The
      // next inspection validates a real successor or fails closed on junk.
      if (Date.now() >= deadline) {
        if (!successorValidationAfterDeadlineAvailable) throw busy();
        successorValidationAfterDeadlineAvailable = false;
      }
    }
  }
}

async function removeExactOwnerAndSettle(
  lockDirectory: string,
  ownerPath: string,
  deadline: number,
): Promise<boolean> {
  let ownerRemoved = false;
  try {
    await unlink(ownerPath);
    ownerRemoved = true;
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  return (
    (await removeOnlyProvenEmptyDirectory(lockDirectory, deadline)) ||
    ownerRemoved
  );
}

/**
 * Acquire a crash-recoverable, cross-process lock.
 *
 * A directory contains exactly one owner file.  Ownership begins when that
 * file is created with O_EXCL and ends when that exact token is unlinked.
 * Directory removal is only opportunistic cleanup, never a lock transition:
 * it may remove a proved-empty initialization generation, but it cannot
 * remove a successor owner or silently bless unexpected directory contents.
 */
export async function acquireProcessFileLock(
  lockDirectory: string,
  options: ProcessFileLockOptions,
): Promise<() => Promise<void>> {
  assertValidOptions(options);
  const token = `${process.pid}-${randomUUID()}`;
  const ownerPath = join(lockDirectory, token);
  const deadline = Date.now() + options.timeoutMs;
  let attempted = false;
  let immediateAttemptAfterProgress = false;

  for (;;) {
    let usingImmediateAttemptAfterProgress = false;
    if (
      attempted &&
      Date.now() >= deadline &&
      !immediateAttemptAfterProgress
    ) {
      throw busy();
    }
    if (attempted && Date.now() >= deadline) {
      immediateAttemptAfterProgress = false;
      usingImmediateAttemptAfterProgress = true;
    }
    attempted = true;

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
      let createdState: Awaited<ReturnType<typeof lstat>>;
      try {
        createdState = await lstat(lockDirectory);
        assertSafeDirectory(createdState);
        await options.afterDirectoryCreate?.();
      } catch (error) {
        if (errno(error) === 'ENOENT') {
          await retryBefore(deadline, options.retryMs);
          continue;
        }
        if (error instanceof ProcessFileLockError) throw error;
        throw new ProcessFileLockError(
          'io',
          'cannot inspect new process lock',
          { cause: error },
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
        await options.afterOwnerCreate?.();
        await handle.close();
        handle = undefined;

        const currentState = await lstat(lockDirectory);
        assertSafeDirectory(currentState);
        if (
          currentState.dev !== createdState.dev ||
          currentState.ino !== createdState.ino
        ) {
          // The initialization directory was replaced or a successor won
          // publication.  Our token is still exact, so it is the only entry
          // this contender is allowed to unlink.
          await removeExactOwnerAndSettle(lockDirectory, ownerPath, deadline);
          await retryBefore(deadline, options.retryMs);
          continue;
        }

        const owner = await inspectLockDirectory(lockDirectory);
        if (
          owner === undefined ||
          owner.pid !== process.pid ||
          owner.token !== token
        ) {
          await removeExactOwnerAndSettle(lockDirectory, ownerPath, deadline);
          await retryBefore(deadline, options.retryMs);
          continue;
        }

        return async () => {
          try {
            const releaseDeadline = Date.now() + options.timeoutMs;
            const owner = await readOwner(ownerPath, token);
            if (owner.pid !== process.pid) {
              throw new ProcessFileLockError(
                'compromised',
                'process lock ownership changed before release',
              );
            }
            await unlink(ownerPath);
            await options.afterOwnerUnlink?.();
            await removeOnlyProvenEmptyDirectory(
              lockDirectory,
              releaseDeadline,
              options.afterValidSuccessorObserved,
            );
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
          await removeExactOwnerAndSettle(lockDirectory, ownerPath, deadline);
        } catch (cleanupError) {
          if (cleanupError instanceof ProcessFileLockError) throw cleanupError;
          throw new ProcessFileLockError(
            'io',
            'cannot clean up process lock initialization',
            { cause: cleanupError },
          );
        }
        if (error instanceof ProcessFileLockError) throw error;
        if (errno(error) === 'ENOENT' || errno(error) === 'EEXIST') {
          await retryBefore(deadline, options.retryMs);
          continue;
        }
        throw new ProcessFileLockError('io', 'cannot establish process lock', {
          cause: error,
        });
      }
    }

    let owner: ObservedOwner | undefined;
    try {
      owner = await inspectLockDirectory(lockDirectory);
    } catch (error) {
      if (errno(error) === 'ENOENT') {
        await retryBefore(deadline, options.retryMs);
        continue;
      }
      if (error instanceof ProcessFileLockError) throw error;
      throw new ProcessFileLockError('io', 'cannot inspect process lock', {
        cause: error,
      });
    }

    if (owner === undefined) {
      let directoryRemoved: boolean;
      try {
        directoryRemoved = await removeOnlyProvenEmptyDirectory(
          lockDirectory,
          deadline,
          options.afterValidSuccessorObserved,
        );
      } catch (error) {
        if (error instanceof ProcessFileLockError) throw error;
        throw new ProcessFileLockError('io', 'cannot clean process lock', {
          cause: error,
        });
      }
      if (
        directoryRemoved &&
        Date.now() >= deadline &&
        !usingImmediateAttemptAfterProgress
      ) {
        immediateAttemptAfterProgress = true;
        continue;
      }
      await retryBefore(deadline, options.retryMs);
      continue;
    }

    if (
      Date.now() - Number(owner.state.mtimeMs) > options.staleMs &&
      !processIsAlive(owner.pid)
    ) {
      const observedOwnerPath = join(
        lockDirectory,
        owner.token,
      );
      let ownerRemoved = false;
      try {
        // Recovery unlinks the exact observed token. A concurrent recovery
        // can only produce ENOENT; it can never name a successor token. Node
        // has no descriptor-relative unlink, so a same-identity actor that
        // can mutate this private directory out of band remains outside this
        // cooperative local-filesystem threat model.
        await unlink(observedOwnerPath);
        ownerRemoved = true;
        await options.afterStaleOwnerUnlink?.();
        await removeOnlyProvenEmptyDirectory(
          lockDirectory,
          deadline,
          options.afterValidSuccessorObserved,
        );
      } catch (error) {
        if (errno(error) === 'ENOENT') {
          await retryBefore(deadline, options.retryMs);
          continue;
        }
        if (error instanceof ProcessFileLockError) throw error;
        throw new ProcessFileLockError(
          'io',
          'cannot recover stale process lock',
          { cause: error },
        );
      }
      if (
        ownerRemoved &&
        Date.now() >= deadline &&
        !usingImmediateAttemptAfterProgress
      ) {
        immediateAttemptAfterProgress = true;
        continue;
      }
      await retryBefore(deadline, options.retryMs);
      continue;
    }

    await retryBefore(deadline, options.retryMs);
  }
}
