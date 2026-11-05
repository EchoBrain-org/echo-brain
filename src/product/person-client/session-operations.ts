import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { ensurePrivateDirectory, PersonClientSessionUnavailableError } from './session-store.js';

// Files contain no credentials. Their immutable, unique names identify a local
// process and operation. Dead processes can be removed without touching a new
// owner's entry at the same path. An unknown or unsafe entry fails closed.
const ENTRY = /^(read|refresh)-(\d+)-[0-9a-f-]{36}$/u;
const WAIT_MS = 25;
const DEADLINE_MS = 11 * 60_000; // Longer than the client's longest (document) transfer.

/** Shared by desktop, CLI and SDK clients using this private Person directory. */
export class PersonSessionOperations {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = join(directory, 'operations');
  }

  private entries(): { name: string; kind: string }[] {
    ensurePrivateDirectory(this.directory);
    return readdirSync(this.directory).flatMap(name => {
      const match = ENTRY.exec(name);
      if (match === null) throw new Error('Invalid Person session operation entry');
      const path = join(this.directory, name);
      try {
        const state = lstatSync(path);
        if (!state.isFile() || state.isSymbolicLink() || state.size !== 0 || (state.mode & 0o777) !== 0o600 ||
            (process.getuid !== undefined && state.uid !== process.getuid())) throw new Error('Unsafe Person session operation entry');
        try { process.kill(Number(match[2]), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          unlinkSync(path);
          return [];
        }
        return [{ name, kind: match[1]! }];
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

  private leave(name: string): void { unlinkSync(join(this.directory, name)); }

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
