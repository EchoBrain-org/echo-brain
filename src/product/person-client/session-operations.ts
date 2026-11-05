import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { PersonAuthorityClientError } from './authority-client.js';
import { ensurePrivateDirectory, PERSON_SESSION_OPERATIONS_DIRECTORY, PersonClientSessionUnavailableError } from './session-store.js';

// Files contain no credentials. Their immutable, unique names identify a local
// process and operation, and their owners renew them while the operation runs.
// An entry whose process is gone, or that nobody renews any more, was left by a
// crash: it is removed by its own path, never touching a new owner's entry. A
// file no client wrote is ignored. An unsafe entry fails closed until signing
// in or out clears the directory.
const ENTRY = /^(read|refresh)-(\d+)-[0-9a-f-]{36}$/u;
const WAIT_MS = 25;
const DEADLINE_MS = 11 * 60_000; // Longer than the client's longest (document) transfer.
const RENEW_MS = 30_000;
/**
 * Twenty renewals missed: the entry's owner has stopped, whatever process has its ID now. An owner whose event loop
 * stalls on a slow file is not taken for gone, and a waiting refresh outlives an entry left just before it began.
 */
const STALE_MS = 10 * 60_000;

/** This process's entries, by path, renewed until their operations end. */
const live = new Set<string>();
let renewal: ReturnType<typeof setInterval> | undefined;

function renew(): void {
  const now = new Date();
  for (const path of live) {
    try {
      utimesSync(path, now, now);
    } catch {
      // Signing in or out cleared it; its operation still ends normally.
    }
  }
}

function hold(path: string): void {
  live.add(path);
  if (renewal === undefined) {
    renewal = setInterval(renew, RENEW_MS);
    renewal.unref();
  }
}

function release(path: string): void {
  live.delete(path);
  if (live.size === 0 && renewal !== undefined) {
    clearInterval(renewal);
    renewal = undefined;
  }
}

/**
 * Whether the process that wrote an entry may still run. Only "no such process" (ESRCH) proves it gone: a sandboxed
 * client is refused (EPERM) even a live process of the same user, so that answer leaves the entry to its renewals.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/** Shared by desktop, CLI and SDK clients using this private Person directory. */
export class PersonSessionOperations {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = join(directory, PERSON_SESSION_OPERATIONS_DIRECTORY);
  }

  /**
   * Runs `step` in the operations directory, preparing it again if signing in or out removed it meanwhile. macOS
   * answers a file opened in a directory as it is removed with EINVAL, not ENOENT.
   */
  private prepared<T>(step: () => T): T {
    for (let attempt = 1; ; attempt += 1) {
      try {
        ensurePrivateDirectory(this.directory);
        return step();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'ENOENT' && code !== 'EINVAL') || attempt === 3) throw error;
      }
    }
  }

  private entries(): { name: string; kind: string }[] {
    return this.prepared(() => readdirSync(this.directory)).flatMap(name => {
      const match = ENTRY.exec(name);
      if (match === null) return [];
      const path = join(this.directory, name);
      try {
        const state = lstatSync(path);
        if (!state.isFile() || state.isSymbolicLink() || state.size !== 0 || (state.mode & 0o777) !== 0o600 ||
            (process.getuid !== undefined && state.uid !== process.getuid())) throw new Error('Unsafe Person session operation entry');
        if (live.has(path) || (Date.now() - state.mtimeMs < STALE_MS && running(Number(match[2])))) return [{ name, kind: match[1]! }];
        unlinkSync(path);
        return [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  }

  private enter(kind: 'read' | 'refresh'): string {
    const name = `${kind}-${process.pid}-${randomUUID()}`;
    const path = join(this.directory, name);
    this.prepared(() => {
      closeSync(openSync(path, 'wx', 0o600));
      // Dated by this machine's clock, as renewals are, not by a network file server's.
      const now = new Date();
      utimesSync(path, now, now);
    });
    hold(path);
    return name;
  }

  private leave(name: string): void {
    const path = join(this.directory, name);
    release(path);
    try {
      unlinkSync(path);
    } catch (error) {
      // Signing in or out clears every entry, this one included.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async wait(deadline: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // The session still stands while another operation holds it: ECHO is busy, and nothing was sent.
    if (Date.now() >= deadline) {
      throw new PersonAuthorityClientError('unavailable', null,
        'Person session operations did not finish before refresh; retry when the other operation ends', { unsent: true });
    }
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
    let name = this.enter('refresh');
    const deadline = Date.now() + DEADLINE_MS;
    try {
      while (true) {
        // Signing in or out clears every entry, this intent included, and reads
        // that began since never saw it: register again and wait for them.
        if (!existsSync(join(this.directory, name))) { this.leave(name); name = this.enter('refresh'); }
        if (this.entries().some(entry => entry.kind === 'read')) { await this.wait(deadline, signal); continue; }
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
