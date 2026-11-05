import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { ensurePrivateDirectory, PERSON_SESSION_OPERATIONS_DIRECTORY, PersonClientSessionUnavailableError } from './session-store.js';

// Files contain no credentials. Their immutable, unique names identify a local
// process and operation. An entry whose process is gone, or that is older than
// any operation runs, was left by a crash: it is removed by its own path, never
// touching a new owner's entry. A file no client wrote is ignored. An unsafe
// entry fails closed until signing in or out clears the directory.
const ENTRY = /^(read|refresh)-(\d+)-[0-9a-f-]{36}$/u;
const WAIT_MS = 25;
const DEADLINE_MS = 11 * 60_000; // Longer than the client's longest (document) transfer.
/** Longer than any entry's operation runs, so whatever has the entry's process ID now did not write it. */
const STALE_MS = DEADLINE_MS + 60_000;

/**
 * Whether the process that wrote an entry may still run. Entries are this user's own files, so a process ID that now
 * belongs to another user (EPERM) was reused after its writer ended, as one with no process at all (ESRCH) was.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/** Shared by desktop, CLI and SDK clients using this private Person directory. */
export class PersonSessionOperations {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = join(directory, PERSON_SESSION_OPERATIONS_DIRECTORY);
  }

  private entries(): { name: string; kind: string }[] {
    ensurePrivateDirectory(this.directory);
    return readdirSync(this.directory).flatMap(name => {
      const match = ENTRY.exec(name);
      if (match === null) return [];
      const path = join(this.directory, name);
      try {
        const state = lstatSync(path);
        if (!state.isFile() || state.isSymbolicLink() || state.size !== 0 || (state.mode & 0o777) !== 0o600 ||
            (process.getuid !== undefined && state.uid !== process.getuid())) throw new Error('Unsafe Person session operation entry');
        if (Date.now() - state.mtimeMs < STALE_MS && running(Number(match[2]))) return [{ name, kind: match[1]! }];
        unlinkSync(path);
        return [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  }

  private enter(kind: 'read' | 'refresh'): string {
    ensurePrivateDirectory(this.directory);
    const name = `${kind}-${process.pid}-${randomUUID()}`;
    closeSync(openSync(join(this.directory, name), 'wx', 0o600));
    return name;
  }

  private leave(name: string): void {
    try {
      unlinkSync(join(this.directory, name));
    } catch (error) {
      // Signing in or out clears every entry, this one included.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async wait(deadline: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new PersonClientSessionUnavailableError('Person session operations did not finish before refresh; retry when the other operation ends');
    await setTimeout(WAIT_MS, undefined, { signal });
  }

  async read<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + DEADLINE_MS;
    while (true) {
      signal?.throwIfAborted();
      if (this.entries().some(entry => entry.kind === 'refresh')) { await this.wait(deadline, signal); continue; }
      const name = this.enter('read');
      try {
        // Register before checking again: a refresh either sees this reader,
        // or this reader sees its intent before acquiring any credential.
        if (!this.entries().some(entry => entry.kind === 'refresh')) return await operation();
      } finally { this.leave(name); }
      await this.wait(deadline, signal);
    }
  }

  async refresh<C, R>(claim: () => C | undefined, operation: (claimed: C) => Promise<R>, signal?: AbortSignal): Promise<R> {
    signal?.throwIfAborted();
    const name = this.enter('refresh');
    const deadline = Date.now() + DEADLINE_MS;
    try {
      while (this.entries().some(entry => entry.kind === 'read')) await this.wait(deadline, signal);
      while (true) {
        signal?.throwIfAborted();
        const claimed = claim();
        if (claimed !== undefined) return await operation(claimed);
        // Only an unclaimed attempt waits. A token already submitted is never
        // replayed. A crashed/interrupted store claim keeps its existing
        // fail-closed sign-in requirement.
        if (!this.entries().some(entry => entry.kind === 'refresh' && entry.name !== name)) {
          throw new PersonClientSessionUnavailableError('Person session refresh was interrupted; sign in again');
        }
        await this.wait(deadline, signal);
      }
    } finally { this.leave(name); }
  }
}
