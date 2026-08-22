import { afterEach, describe, expect, it, vi } from 'vitest';
import { SerializedAuthorityMeetingWorker } from '../../../src/processing/live/serialized-authority-meeting-worker.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('serialized Authority meeting worker', () => {
  it('runs immediately and never overlaps a slow cycle', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const worker = new SerializedAuthorityMeetingWorker({
      intervalMs: 1_000,
      runCycle: async () => {
        const index = calls++;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await (index === 0 ? first.promise : second.promise);
        active -= 1;
      },
    });

    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);

    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await worker.close();
  });

  it('reports a failed cycle once and retries even when the callback throws', async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let calls = 0;
    const worker = new SerializedAuthorityMeetingWorker({
      intervalMs: 100,
      runCycle: async () => {
        calls += 1;
        if (calls === 1) throw new Error('cycle failed');
      },
      onError: (error) => {
        errors.push(error.message);
        throw new Error('observer failed');
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(errors).toEqual(['cycle failed']);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await worker.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it('aborts and awaits in-flight cleanup before close resolves', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let calls = 0;
    let capturedSignal: AbortSignal | undefined;
    const worker = new SerializedAuthorityMeetingWorker({
      intervalMs: 100,
      runCycle: async (signal) => {
        calls += 1;
        capturedSignal = signal;
        events.push('started');
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              events.push('aborted');
              setTimeout(() => {
                events.push('cleaned');
                resolve();
              }, 50);
            },
            { once: true },
          );
        });
      },
    });

    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(events).toEqual(['started', 'aborted']);

    await vi.advanceTimersByTimeAsync(49);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(events).toEqual(['started', 'aborted', 'cleaned']);
    expect(closed).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await worker.close();
  });
});
