import { PersonRecordSearchSnapshotChangedV1 } from './person-record-search-route.js';

/**
 * Restart once with a completely new desk, evidence and model state when the evidence snapshot changed under the first
 * attempt. There is no whole-Ask deadline: the run stops itself when something it waits on stalls, and the caller's
 * signal stops it when the person cancels.
 */
export async function withPersonAskSnapshotRetryV1<T>(input: {
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const signal = input.signal ?? new AbortController().signal;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const value = await input.run(signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt > 0 || !(error instanceof PersonRecordSearchSnapshotChangedV1)) throw error;
    }
  }
}
