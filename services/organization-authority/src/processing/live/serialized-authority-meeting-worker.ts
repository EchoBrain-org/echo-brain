export const DEFAULT_AUTHORITY_MEETING_WORKER_INTERVAL_MS = 30_000;

export interface SerializedAuthorityMeetingWorkerOptions {
  readonly runCycle: (signal: AbortSignal) => Promise<void>;
  readonly intervalMs?: number;
  /** A cycle failure notification; callback failures never stop the worker. */
  readonly onError?: (error: Error) => void;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Runs one meeting cycle immediately, then waits a fixed delay after each
 * completion. The single loop is the serialization guarantee: no second cycle
 * can start while the first is in flight.
 */
export class SerializedAuthorityMeetingWorker {
  private readonly controller = new AbortController();
  private readonly intervalMs: number;
  private readonly loop: Promise<void>;
  /**
   * The worker is also the one in-process exclusion boundary for bounded
   * operator work. This prevents a rehearsal from racing source polling or
   * approval observation without creating a second runtime or database owner.
   */
  private tail: Promise<void> = Promise.resolve();
  private exclusiveActive = false;

  constructor(
    private readonly options: SerializedAuthorityMeetingWorkerOptions,
  ) {
    this.intervalMs =
      options.intervalMs ?? DEFAULT_AUTHORITY_MEETING_WORKER_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('authority meeting worker interval must be a positive integer');
    }
    this.loop = this.run();
  }

  /** Aborts the active cycle or delay and resolves only after it has stopped. */
  async close(): Promise<void> {
    this.controller.abort();
    await this.loop;
    await this.tail;
  }

  /**
   * Runs one bounded operation through the same single-file gate as the
   * periodic worker. The worker abort signal also terminates it during close.
   */
  runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      this.controller.signal.throwIfAborted();
      return operation(this.controller.signal);
    };
    let task: Promise<T>;
    if (this.exclusiveActive) {
      task = this.tail.then(start);
    } else {
      this.exclusiveActive = true;
      try {
        task = Promise.resolve(start());
      } catch (error) {
        task = Promise.reject(error);
      }
    }
    const completion = task.then(
      () => undefined,
      () => undefined,
    );
    this.tail = completion;
    void completion.then(() => {
      if (this.tail === completion) this.exclusiveActive = false;
    });
    return task;
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        await this.runExclusive((exclusiveSignal) =>
          this.options.runCycle(exclusiveSignal),
        );
      } catch (failure) {
        if (!signal.aborted) this.report(failure);
      }
      if (signal.aborted) return;
      await pause(this.intervalMs, signal);
    }
  }

  private report(failure: unknown): void {
    try {
      this.options.onError?.(errorFrom(failure));
    } catch {
      // Error reporting is observational and cannot become worker control flow.
    }
  }
}
