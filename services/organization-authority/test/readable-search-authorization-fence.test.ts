import { describe, expect, it } from 'vitest';
import {
  READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION,
  ReadableSearchAuthorizationFence,
  ReadableSearchAuthorizationFenceCancelledError,
  ReadableSearchAuthorizationFenceMisuseError,
  ReadableSearchAuthorizationFenceTimeoutError,
  readableSearchFenceFailureClassification,
} from '../src/application/readable-search-authorization-fence.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReadableSearchAuthorizationFence', () => {
  it('admits a later reader while active readers hold no writer barrier', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const first = await fence.acquireRead();
    const second = await fence.acquireRead();
    second.release();
    first.release();
  });

  it('admits concurrent readers but excludes a queued writer until all release', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const first = await fence.acquireRead();
    const second = await fence.acquireRead();
    let writerAcquired = false;
    const writer = fence.acquireWrite().then((lease) => {
      writerAcquired = true;
      return lease;
    });

    await flush();
    expect(writerAcquired).toBe(false);
    first.release();
    await flush();
    expect(writerAcquired).toBe(false);
    second.release();
    const writerLease = await writer;
    expect(writerAcquired).toBe(true);
    writerLease.release();
  });

  it('is FIFO fair: readers arriving after a writer cannot barge ahead of it', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const firstReader = await fence.acquireRead();
    const order: string[] = [];
    const writer = fence.acquireWrite().then((lease) => {
      order.push('writer');
      return lease;
    });
    const laterReader = fence.acquireRead().then((lease) => {
      order.push('later-reader');
      return lease;
    });

    expect(fence.pendingCount()).toBe(2);
    firstReader.release();
    const writerLease = await writer;
    await flush();
    expect(order).toEqual(['writer']);
    writerLease.release();
    const laterReaderLease = await laterReader;
    expect(order).toEqual(['writer', 'later-reader']);
    laterReaderLease.release();
  });

  it('admits an adjacent reader batch together after the preceding writer', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const firstWriter = await fence.acquireWrite();
    const entered: string[] = [];
    const firstReader = fence.acquireRead().then((lease) => {
      entered.push('first');
      return lease;
    });
    const secondReader = fence.acquireRead().then((lease) => {
      entered.push('second');
      return lease;
    });

    firstWriter.release();
    const [firstLease, secondLease] = await Promise.all([firstReader, secondReader]);
    expect(entered).toEqual(['first', 'second']);
    firstLease.release();
    secondLease.release();
  });

  it('releases a lease in finally when a protected operation throws', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    await expect(
      fence.withWrite(() => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    const reader = await fence.acquireRead();
    reader.release();
  });

  it('releases after an async rejection and never leaves a writer held', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const operation = deferred<void>();
    const protectedOperation = fence.withRead(() => operation.promise);
    await flush();
    const writer = fence.acquireWrite();
    operation.reject(new Error('cancelled work'));
    await expect(protectedOperation).rejects.toThrow('cancelled work');
    const writerLease = await writer;
    writerLease.release();
  });

  it('does not release an acquired lease when its caller aborts mid-operation', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const controller = new AbortController();
    const entered = deferred<void>();
    const finish = deferred<void>();
    const reader = fence.withRead(
      async () => {
        entered.resolve();
        await finish.promise;
      },
      { signal: controller.signal },
    );
    await entered.promise;
    let writerAcquired = false;
    const writer = fence.acquireWrite().then((lease) => {
      writerAcquired = true;
      return lease;
    });

    controller.abort();
    await flush();
    expect(writerAcquired).toBe(false);
    finish.resolve();
    await reader;
    const writerLease = await writer;
    writerLease.release();
  });

  it('removes a cancelled queued acquisition without delaying later work', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const writer = await fence.acquireWrite();
    const controller = new AbortController();
    const cancelled = fence.acquireRead({ signal: controller.signal });
    const laterWriter = fence.acquireWrite();
    controller.abort();

    await expect(cancelled).rejects.toBeInstanceOf(
      ReadableSearchAuthorizationFenceCancelledError,
    );
    expect(fence.pendingCount()).toBe(1);
    writer.release();
    const laterWriterLease = await laterWriter;
    laterWriterLease.release();
  });

  it('rejects an already-aborted acquisition without queueing it', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fence.acquireRead({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(ReadableSearchAuthorizationFenceCancelledError);
    expect(fence.pendingCount()).toBe(0);
  });

  it('maps only a lock deadline to the fixed unavailable classification', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    const writer = await fence.acquireWrite();
    let failure: unknown;
    try {
      await fence.acquireRead({ timeout_ms: 10 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReadableSearchAuthorizationFenceTimeoutError);
    expect(readableSearchFenceFailureClassification(failure)).toBe(
      READABLE_SEARCH_FENCE_TIMEOUT_CLASSIFICATION,
    );
    expect(readableSearchFenceFailureClassification(new Error('other'))).toBeNull();
    expect(
      readableSearchFenceFailureClassification(
        new ReadableSearchAuthorizationFenceCancelledError(),
      ),
    ).toBeNull();
    expect(fence.pendingCount()).toBe(0);
    writer.release();
  });

  it('rejects invalid timeouts and double release as programmer misuse', async () => {
    const fence = new ReadableSearchAuthorizationFence();
    await expect(fence.acquireRead({ timeout_ms: 0 })).rejects.toBeInstanceOf(
      ReadableSearchAuthorizationFenceMisuseError,
    );
    await expect(
      fence.withRead(null as unknown as () => void),
    ).rejects.toBeInstanceOf(ReadableSearchAuthorizationFenceMisuseError);
    const lease = await fence.acquireRead();
    lease.release();
    expect(() => lease.release()).toThrow(ReadableSearchAuthorizationFenceMisuseError);
  });
});
