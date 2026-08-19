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
  close(): Promise<void> {
    this.controller.abort();
    return this.loop;
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        await this.options.runCycle(signal);
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
