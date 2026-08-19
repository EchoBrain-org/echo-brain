import { mkdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessFileLock } from '../../../src/processing/infrastructure/process-file-lock.js';

const directories: string[] = [];
const deadPid = 99999999;
const execFileAsync = promisify(execFile);

async function temporaryLock(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'echo-brain-lock-'));
  directories.push(directory);
  return join(directory, 'operation.lock');
}

async function temporarySocketLock(): Promise<string> {
  // Darwin sockaddr_un leaves room for this root plus the 45-character token.
  const directory = await mkdtemp('/tmp/eb-lock-');
  const state = await stat(directory);
  if (!state.isDirectory() || (state.mode & 0o777) !== 0o700) {
    throw new Error('short socket test root is not private');
  }
  directories.push(directory);
  return join(directory, 'operation.lock');
}

function deadToken(sequence = 0): string {
  return `${deadPid}-${sequence.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

async function writeStaleOwner(lock: string, token = deadToken()): Promise<void> {
  await mkdir(lock, { mode: 0o700 });
  const owner = join(lock, token);
  await writeFile(owner, `${JSON.stringify({ pid: deadPid, token })}\n`, {
    mode: 0o600,
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(owner, old, old);
}

async function writeEmptyStaleOwner(
  lock: string,
  token = deadToken(),
): Promise<void> {
  await mkdir(lock, { mode: 0o700 });
  const owner = join(lock, token);
  await writeFile(owner, '', { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(owner, old, old);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function createUnixSocket(path: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('process file lock', () => {
  it.each([
    ['timeoutMs NaN', { timeoutMs: Number.NaN, staleMs: 1, retryMs: 1 }],
    ['timeoutMs infinity', { timeoutMs: Infinity, staleMs: 1, retryMs: 1 }],
    ['timeoutMs negative', { timeoutMs: -1, staleMs: 1, retryMs: 1 }],
    ['staleMs NaN', { timeoutMs: 1, staleMs: Number.NaN, retryMs: 1 }],
    ['staleMs infinity', { timeoutMs: 1, staleMs: Infinity, retryMs: 1 }],
    ['staleMs negative', { timeoutMs: 1, staleMs: -1, retryMs: 1 }],
    ['retryMs NaN', { timeoutMs: 1, staleMs: 1, retryMs: Number.NaN }],
    ['retryMs infinity', { timeoutMs: 1, staleMs: 1, retryMs: Infinity }],
    ['retryMs negative', { timeoutMs: 1, staleMs: 1, retryMs: -1 }],
  ])('rejects invalid %s before inspecting the filesystem', async (_name, options) => {
    await expect(
      acquireProcessFileLock('/path/that/must/not/be/inspected', options),
    ).rejects.toMatchObject({ code: 'io' });
  });

  it('recovers a stale exact owner token left by a dead process', async () => {
    const lock = await temporaryLock();
    await writeStaleOwner(lock);

    const release = await acquireProcessFileLock(lock, {
      timeoutMs: 500,
      staleMs: 1,
      retryMs: 1,
    });
    await release();

    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a dead stale owner created before any payload could be written', async () => {
    const lock = await temporaryLock();
    await writeEmptyStaleOwner(lock);

    const release = await acquireProcessFileLock(lock, {
      timeoutMs: 500,
      staleMs: 1,
      retryMs: 1,
    });
    await release();
  });

  it('recovers stale and empty directories without waiting when timeout is zero', async () => {
    const staleLock = await temporaryLock();
    await writeStaleOwner(staleLock);
    const staleRelease = await acquireProcessFileLock(staleLock, {
      timeoutMs: 0,
      staleMs: 1,
      retryMs: 1,
    });
    await staleRelease();

    const emptyLock = await temporaryLock();
    await mkdir(emptyLock, { mode: 0o700 });
    const emptyRelease = await acquireProcessFileLock(emptyLock, {
      timeoutMs: 0,
      staleMs: 1,
      retryMs: 1,
    });
    await emptyRelease();
  });

  it('treats an O_EXCL-created owner as busy while its creator is paused', async () => {
    const lock = await temporaryLock();
    const ownerCreated = deferred();
    const resumeCreator = deferred();
    const creator = acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
      afterOwnerCreate: async () => {
        ownerCreated.resolve();
        await resumeCreator.promise;
      },
    });
    await ownerCreated.promise;

    await expect(
      acquireProcessFileLock(lock, {
        timeoutMs: 20,
        staleMs: 30_000,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'busy' });

    resumeCreator.resolve();
    const release = await creator;
    await release();
  });

  it('settles a valid successor after zero-timeout release cleanup', async () => {
    const lock = await temporaryLock();
    let successorRelease: (() => Promise<void>) | undefined;
    const release = await acquireProcessFileLock(lock, {
      timeoutMs: 0,
      staleMs: 30_000,
      retryMs: 1,
      afterOwnerUnlink: async () => {
        successorRelease = await acquireProcessFileLock(lock, {
          timeoutMs: 0,
          staleMs: 30_000,
          retryMs: 1,
        });
      },
    });

    await release();
    expect(successorRelease).toBeTypeOf('function');
    await successorRelease!();
  });

  it('fails closed for a valid-token owner symlink', async () => {
    const lock = await temporaryLock();
    const token = deadToken();
    await mkdir(lock, { mode: 0o700 });
    await symlink('outside-lock', join(lock, token));

    await expect(
      acquireProcessFileLock(lock, {
        timeoutMs: 50,
        staleMs: 1,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('fails closed without blocking for valid-token FIFO and socket owners', async () => {
    const fifoLock = await temporaryLock();
    const fifoToken = deadToken();
    await mkdir(fifoLock, { mode: 0o700 });
    await execFileAsync('mkfifo', [join(fifoLock, fifoToken)]);
    await expect(
      acquireProcessFileLock(fifoLock, {
        timeoutMs: 50,
        staleMs: 1,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'unsafe' });

    const socketLock = await temporarySocketLock();
    const socketToken = deadToken(1);
    await mkdir(socketLock, { mode: 0o700 });
    const server = await createUnixSocket(join(socketLock, socketToken));
    try {
      await expect(
        acquireProcessFileLock(socketLock, {
          timeoutMs: 50,
          staleMs: 1,
          retryMs: 1,
        }),
      ).rejects.toMatchObject({ code: 'unsafe' });
    } finally {
      await closeServer(server);
    }
  });

  it('fails closed for unreadable or non-private directory and owner modes', async () => {
    const unsafeDirectory = await temporaryLock();
    await mkdir(unsafeDirectory, { mode: 0o000 });
    await expect(
      acquireProcessFileLock(unsafeDirectory, {
        timeoutMs: 50,
        staleMs: 1,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'unsafe' });

    const unsafeOwner = await temporaryLock();
    const token = deadToken();
    await mkdir(unsafeOwner, { mode: 0o700 });
    await writeFile(
      join(unsafeOwner, token),
      `${JSON.stringify({ pid: deadPid, token })}\n`,
      { mode: 0o200 },
    );
    await expect(
      acquireProcessFileLock(unsafeOwner, {
        timeoutMs: 50,
        staleMs: 1,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('releases cleanly when its exact unlink races a valid replacement owner', async () => {
    const lock = await temporaryLock();
    const firstCreated = deferred();
    const resumeFirstInitializer = deferred();
    const secondOwnerUnlinked = deferred();
    const resumeSecondRelease = deferred();

    const first = acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
      afterDirectoryCreate: async () => {
        firstCreated.resolve();
        await resumeFirstInitializer.promise;
      },
    });
    await firstCreated.promise;

    const secondRelease = await acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
      afterOwnerUnlink: async () => {
        secondOwnerUnlinked.resolve();
        await resumeSecondRelease.promise;
      },
    });

    resumeFirstInitializer.resolve();
    const secondReleasing = secondRelease();
    await secondOwnerUnlinked.promise;
    const firstRelease = await first;
    resumeSecondRelease.resolve();
    await secondReleasing;
    await firstRelease();
  });

  it('recovers a stale owner without deleting a valid replacement initializer', async () => {
    const lock = await temporaryLock();
    await writeStaleOwner(lock);
    const staleOwnerUnlinked = deferred();
    const resumeRecovery = deferred();
    const successorObserved = deferred();
    const resumeRecoveryAfterObservation = deferred();

    const recovering = acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 1,
      retryMs: 1,
      afterStaleOwnerUnlink: async () => {
        staleOwnerUnlinked.resolve();
        await resumeRecovery.promise;
      },
      afterValidSuccessorObserved: async () => {
        successorObserved.resolve();
        await resumeRecoveryAfterObservation.promise;
      },
    });
    await staleOwnerUnlinked.promise;

    const replacementRelease = await acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
    });
    resumeRecovery.resolve();
    await successorObserved.promise;
    await replacementRelease();
    resumeRecoveryAfterObservation.resolve();
    const recoveredRelease = await recovering;
    await recoveredRelease();
  });

  it('fails closed when junk appears after release has unlinked its owner', async () => {
    const lock = await temporaryLock();
    const release = await acquireProcessFileLock(lock, {
      timeoutMs: 500,
      staleMs: 30_000,
      retryMs: 1,
      afterOwnerUnlink: async () => {
        await writeFile(join(lock, 'unexpected-junk'), 'not an owner\n');
      },
    });

    await expect(release()).rejects.toMatchObject({
      code: 'unsafe',
    });
    await expect(
      acquireProcessFileLock(lock, {
        timeoutMs: 50,
        staleMs: 1,
        retryMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('enforces the deadline while stale ownership churns', async () => {
    const lock = await temporaryLock();
    await writeStaleOwner(lock);
    let sequence = 1;

    await expect(
      acquireProcessFileLock(lock, {
        timeoutMs: 20,
        staleMs: 1,
        retryMs: 0,
        afterStaleOwnerUnlink: async () => {
          const token = deadToken(sequence++);
          await writeFile(
            join(lock, token),
            `${JSON.stringify({ pid: deadPid, token })}\n`,
            { mode: 0o600 },
          );
          const old = new Date(Date.now() - 60_000);
          await utimes(join(lock, token), old, old);
        },
      }),
    ).rejects.toMatchObject({ code: 'busy' });
  });
});
