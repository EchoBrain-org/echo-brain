import { describe, expect, it, vi } from 'vitest';
import { createAtlassianVerificationBatchV1 } from '../src/atlassian-connection-verification-v1.js';

describe('queued Atlassian verification batches', () => {
  it('shares callers queued before I/O starts, without reusing a settled verification', async () => {
    let attempts = 0;
    const verify = vi.fn(async () => ({ attempt: ++attempts }));
    const batch = createAtlassianVerificationBatchV1(verify);
    const calls = [batch(), batch(), batch()];
    expect(verify).not.toHaveBeenCalled();
    const values = await Promise.all(calls);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(values).toEqual([{ attempt: 1 }, { attempt: 1 }, { attempt: 1 }]);
    expect(await batch()).toEqual({ attempt: 2 });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh verification for a fence arriving after remote I/O began', async () => {
    const finish: ((value: number) => void)[] = [];
    const verify = vi.fn(() => new Promise<number>(resolve => { finish.push(resolve); }));
    const batch = createAtlassianVerificationBatchV1(verify);
    const first = batch();
    await Promise.resolve();
    expect(verify).toHaveBeenCalledTimes(1);
    const afterResourceRead = batch();
    await Promise.resolve();
    expect(verify).toHaveBeenCalledTimes(2);
    finish[0]!(1); finish[1]!(2);
    expect(await Promise.all([first, afterResourceRead])).toEqual([1, 2]);
  });

  it('groups only the exact signal object and keeps other cancellation owners independent', async () => {
    const first = new AbortController(); const second = new AbortController();
    const verify = vi.fn(async (signal?: AbortSignal) => signal);
    const batch = createAtlassianVerificationBatchV1(verify);
    expect(await Promise.all([batch(first.signal), batch(first.signal), batch(second.signal), batch(), batch()]))
      .toEqual([first.signal, first.signal, second.signal, undefined, undefined]);
    expect(verify.mock.calls.map(([signal]) => signal)).toEqual([first.signal, second.signal, undefined]);
  });

  it('refuses aborted callers and a queued batch aborted before invocation', async () => {
    const controller = new AbortController();
    const verify = vi.fn(async () => 'verified');
    const batch = createAtlassianVerificationBatchV1(verify);
    const queued = [batch(controller.signal), batch(controller.signal)];
    controller.abort();
    const settled = await Promise.allSettled(queued);
    expect(settled).toEqual([
      { status: 'rejected', reason: controller.signal.reason },
      { status: 'rejected', reason: controller.signal.reason },
    ]);
    await expect(batch(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(verify).not.toHaveBeenCalled();
    await expect(batch()).resolves.toBe('verified');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation after invocation without cancelling a different signal batch', async () => {
    const first = new AbortController(); const second = new AbortController();
    const finish = new Map<AbortSignal, (value: string) => void>();
    const verify = vi.fn((signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      const active = signal!;
      const abort = () => { reject(active.reason); };
      active.addEventListener('abort', abort, { once: true });
      finish.set(active, value => { active.removeEventListener('abort', abort); resolve(value); });
    }));
    const batch = createAtlassianVerificationBatchV1(verify);
    const cancelled = batch(first.signal); const independent = batch(second.signal);
    await Promise.resolve();
    expect(verify).toHaveBeenCalledTimes(2);
    first.abort();
    finish.get(second.signal)!('verified');
    await expect(cancelled).rejects.toBe(first.signal.reason);
    await expect(independent).resolves.toBe('verified');
  });

  it('propagates failure to queued callers and allows a later fresh verification', async () => {
    const failure = new Error('synthetic verification failure');
    const verify = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure).mockResolvedValueOnce('verified');
    const batch = createAtlassianVerificationBatchV1(verify);
    expect(await Promise.allSettled([batch(), batch()])).toEqual([
      { status: 'rejected', reason: failure }, { status: 'rejected', reason: failure },
    ]);
    await expect(batch()).resolves.toBe('verified');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('propagates synchronous verification failures without leaving a queued slot', async () => {
    const failure = new Error('synthetic synchronous failure');
    const verify = vi.fn((): Promise<string> => { throw failure; });
    const batch = createAtlassianVerificationBatchV1(verify);
    await expect(batch()).rejects.toBe(failure);
    await expect(batch()).rejects.toBe(failure);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
