import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessFileLock } from '../../src/infrastructure/filesystem/process-file-lock.js';

const directories: string[] = [];

async function temporaryLock(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'echo-brain-lock-'));
  directories.push(directory);
  return join(directory, 'operation.lock');
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('process file lock', () => {
  it('recovers a stale exact owner token left by a dead process', async () => {
    const lock = await temporaryLock();
    const token = '99999999-00000000-0000-4000-8000-000000000000';
    await mkdir(lock, { mode: 0o700 });
    const owner = join(lock, token);
    await writeFile(owner, `${JSON.stringify({ pid: 99999999, token })}\n`, {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(owner, old, old);

    const release = await acquireProcessFileLock(lock, {
      timeoutMs: 500,
      staleMs: 1,
      retryMs: 1,
    });
    await release();

    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a paused initializer join a replacement owner directory', async () => {
    const lock = await temporaryLock();
    let announceCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      announceCreated = resolve;
    });
    let resumeInitializer!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeInitializer = resolve;
    });

    const first = acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
      afterDirectoryCreate: async () => {
        announceCreated();
        await resume;
      },
    });
    await created;

    const secondRelease = await acquireProcessFileLock(lock, {
      timeoutMs: 1_000,
      staleMs: 30_000,
      retryMs: 1,
    });
    let firstAcquired = false;
    void first.then(() => {
      firstAcquired = true;
    });
    resumeInitializer();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(firstAcquired).toBe(false);

    await secondRelease();
    const firstRelease = await first;
    await firstRelease();
  });
});
