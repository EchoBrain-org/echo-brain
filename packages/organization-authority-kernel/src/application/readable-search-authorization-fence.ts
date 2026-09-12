/**
 * The single-process ordering primitive for readable-search authorization.
 *
 * This module intentionally knows nothing about HTTP, SQLite, records, or a
 * caller's Person state. Composition owns the one shared instance and the
 * operation-specific deadline; this class only supplies fair, cancellable
 * reader/writer admission. Once a writer waits, later readers queue behind it
 * so an active stream of searches cannot starve a mutation or publication.
 */

export type ReadableSearchAuthorizationFenceMode = 'read' | 'write';

export interface ReadableSearchAuthorizationFenceAcquireOptions {
  /** Cancel a queued acquisition without changing the state of the fence. */
  readonly signal?: AbortSignal;
  /**
   * The caller's already-chosen request deadline. The fence does not invent a
   * timeout because only composition knows the operation's fixed budget.
   */
  readonly timeout_ms?: number;
}

/** The fixed application classification for a deadline exceeded at the fence. */
export const READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION = 'unavailable' as const;

export class ReadableSearchAuthorizationFenceTimeoutError extends Error {
  readonly classification = READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION;

  constructor() {
    super('readable-search authorization fence acquisition timed out');
    this.name = 'ReadableSearchAuthorizationFenceTimeoutError';
  }
}

/** A caller cancellation is distinct from an operational timeout. */
export class ReadableSearchAuthorizationFenceCancelledError extends Error {
  constructor() {
    super('readable-search authorization fence acquisition was cancelled');
    this.name = 'ReadableSearchAuthorizationFenceCancelledError';
  }
}

/** Incorrect lease lifecycle is a programming error, never an availability outcome. */
export class ReadableSearchAuthorizationFenceMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadableSearchAuthorizationFenceMisuseError';
  }
}

/**
 * The narrow classification seam used by the future route adapter. It maps
 * only a bounded lock deadline to the route's fixed unavailable response;
 * cancellation and misuse must not be mistaken for authorization failures.
 */
export function readableSearchFenceFailureClassification(
  error: unknown,
): typeof READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION | null {
  return error instanceof ReadableSearchAuthorizationFenceTimeoutError
    ? READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION
    : null;
}

export interface ReadableSearchAuthorizationFenceLease {
  readonly mode: ReadableSearchAuthorizationFenceMode;
  release(): void;
}

interface PendingAcquisition {
  readonly mode: ReadableSearchAuthorizationFenceMode;
  readonly resolve: (lease: ReadableSearchAuthorizationFenceLease) => void;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

function assertTimeout(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new ReadableSearchAuthorizationFenceMisuseError(
      'readable-search authorization fence timeout_ms must be a positive safe integer',
    );
  }
}

/**
 * A FIFO asynchronous read/write lock. Releases are synchronous and never
 * await, so `withRead` / `withWrite` can reliably release in `finally` even
 * when an operation rejects or its caller is cancelled after acquisition.
 */
export class ReadableSearchAuthorizationFence {
  private readonly queue: PendingAcquisition[] = [];
  private activeReaders = 0;
  private writerActive = false;

  acquireRead(
    options: ReadableSearchAuthorizationFenceAcquireOptions = {},
  ): Promise<ReadableSearchAuthorizationFenceLease> {
    return this.acquire('read', options);
  }

  acquireWrite(
    options: ReadableSearchAuthorizationFenceAcquireOptions = {},
  ): Promise<ReadableSearchAuthorizationFenceLease> {
    return this.acquire('write', options);
  }

  async withRead<T>(
    operation: () => Promise<T> | T,
    options: ReadableSearchAuthorizationFenceAcquireOptions = {},
  ): Promise<T> {
    return await this.withLease('read', operation, options);
  }

  async withWrite<T>(
    operation: () => Promise<T> | T,
    options: ReadableSearchAuthorizationFenceAcquireOptions = {},
  ): Promise<T> {
    return await this.withLease('write', operation, options);
  }

  /** Test-only visibility; it never identifies callers or exposes leases. */
  pendingCount(): number {
    return this.queue.length;
  }

  private async withLease<T>(
    mode: ReadableSearchAuthorizationFenceMode,
    operation: () => Promise<T> | T,
    options: ReadableSearchAuthorizationFenceAcquireOptions,
  ): Promise<T> {
    if (typeof operation !== 'function') {
      throw new ReadableSearchAuthorizationFenceMisuseError(
        'readable-search authorization fence operation must be a function',
      );
    }
    const lease = await this.acquire(mode, options);
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  private acquire(
    mode: ReadableSearchAuthorizationFenceMode,
    options: ReadableSearchAuthorizationFenceAcquireOptions,
  ): Promise<ReadableSearchAuthorizationFenceLease> {
    try {
      assertTimeout(options.timeout_ms);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new ReadableSearchAuthorizationFenceCancelledError());
    }
    return new Promise<ReadableSearchAuthorizationFenceLease>((resolve, reject) => {
      let pending: PendingAcquisition;
      const cancel = (error: Error): void => {
        if (pending.settled) return;
        pending.settled = true;
        this.removePending(pending);
        this.clearCancellation(pending);
        reject(error);
        this.drain();
      };
      const onAbort =
        options.signal === undefined
          ? undefined
          : (): void => cancel(new ReadableSearchAuthorizationFenceCancelledError());
      pending = {
        mode,
        resolve,
        settled: false,
        timeout: undefined,
        signal: options.signal,
        onAbort,
      };
      if (options.timeout_ms !== undefined) {
        pending.timeout = setTimeout(() => {
          cancel(new ReadableSearchAuthorizationFenceTimeoutError());
        }, options.timeout_ms);
      }
      options.signal?.addEventListener('abort', onAbort!, { once: true });
      this.queue.push(pending);
      this.drain();
    });
  }

  private drain(): void {
    if (this.writerActive) return;
    // Existing readers may admit only adjacent queued readers.  A writer at
    // the head is a fairness barrier: readers arriving after it must wait.
    if (this.activeReaders > 0) {
      while (this.queue[0]?.mode === 'read') {
        this.grant(this.queue.shift()!);
      }
      return;
    }
    const next = this.queue[0];
    if (next === undefined) return;
    if (next.mode === 'write') {
      this.grant(this.queue.shift()!);
      return;
    }
    while (this.queue[0]?.mode === 'read') {
      this.grant(this.queue.shift()!);
    }
  }

  private grant(pending: PendingAcquisition): void {
    if (pending.settled) {
      throw new ReadableSearchAuthorizationFenceMisuseError(
        'readable-search authorization fence attempted to grant a settled acquisition',
      );
    }
    pending.settled = true;
    this.clearCancellation(pending);
    if (pending.mode === 'read') this.activeReaders += 1;
    else this.writerActive = true;
    let released = false;
    pending.resolve(
      Object.freeze({
        mode: pending.mode,
        release: (): void => {
          if (released) {
            throw new ReadableSearchAuthorizationFenceMisuseError(
              'readable-search authorization fence lease was released more than once',
            );
          }
          released = true;
          if (pending.mode === 'read') {
            if (this.activeReaders <= 0) {
              throw new ReadableSearchAuthorizationFenceMisuseError(
                'readable-search authorization fence has no active reader to release',
              );
            }
            this.activeReaders -= 1;
          } else {
            if (!this.writerActive) {
              throw new ReadableSearchAuthorizationFenceMisuseError(
                'readable-search authorization fence has no active writer to release',
              );
            }
            this.writerActive = false;
          }
          this.drain();
        },
      }),
    );
  }

  private removePending(pending: PendingAcquisition): void {
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private clearCancellation(pending: PendingAcquisition): void {
    if (pending.timeout !== undefined) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }
}
