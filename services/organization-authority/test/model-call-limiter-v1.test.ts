import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelCallLimiterV1, type ModelCallPriorityV1 } from '../src/composition/model-call-limiter-v1.js';

afterEach(() => { vi.useRealTimers(); });
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Calls held open until released: `started` names them in the order the limiter admitted them. */
function held(limiter = createModelCallLimiterV1()) {
  const started: string[] = [];
  const release = new Map<string, (error?: unknown) => void>();
  const call = (name: string, priority: ModelCallPriorityV1, signal?: AbortSignal) => limiter.run(priority, signal, () => {
    started.push(name);
    return new Promise<string>((resolve, reject) => release.set(name, error => error === undefined ? resolve(name) : reject(error)));
  });
  return { limiter, started, release: async (name: string, error?: unknown) => { release.get(name)!(error); await flush(); }, call };
}

describe('model call limiter', () => {
  it('serves queued interactive calls before background ones, and gives them every slot', async () => {
    const f = held();
    for (const name of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']) void f.call(name, 'interactive');
    void f.call('b1', 'background'); void f.call('i7', 'interactive');
    await flush();
    expect(f.started).toEqual(['i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
    await f.release('i1');
    expect(f.started.at(-1)).toBe('i7');
    await f.release('i2');
    expect(f.started.at(-1)).toBe('b1');
  });

  it('runs at most four background calls and keeps the other slots for interactive ones', async () => {
    const f = held();
    for (const name of ['b1', 'b2', 'b3', 'b4', 'b5']) void f.call(name, 'background');
    void f.call('i1', 'interactive'); void f.call('i2', 'interactive'); void f.call('i3', 'interactive');
    await flush();
    expect(f.started).toEqual(['b1', 'b2', 'b3', 'b4', 'i1', 'i2']);
    await f.release('i1');
    expect(f.started.at(-1)).toBe('i3');
    await f.release('b1');
    expect(f.started.at(-1)).toBe('b5');
  });

  it('drops an aborted waiter from the queue with its reason, and frees a slot when a call throws', async () => {
    const f = held();
    for (const name of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']) void f.call(name, 'interactive').catch(() => undefined);
    const controller = new AbortController();
    const aborted = f.call('gone', 'interactive', controller.signal);
    const queued = f.call('next', 'interactive');
    controller.abort(new Error('caller left'));
    await expect(aborted).rejects.toThrow('caller left');
    await f.release('i1', new Error('provider failed'));
    expect(f.started).toEqual(['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'next']);
    await f.release('next');
    await expect(queued).resolves.toBe('next');
  });

  it('pauses background calls after a 429, doubling until a success resets it, and never pauses interactive calls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = held();
    const limited = { diagnostic: { http_status: 429 } };
    void f.call('b1', 'background').catch(() => undefined); await flush();
    await f.release('b1', limited);
    void f.call('b2', 'background').catch(() => undefined); void f.call('i1', 'interactive'); await flush();
    expect(f.started).toEqual(['b1', 'i1']);
    await vi.advanceTimersByTimeAsync(4_999); expect(f.started).not.toContain('b2');
    await vi.advanceTimersByTimeAsync(1); await flush(); expect(f.started).toContain('b2');
    await f.release('b2', { code: 'rate_limited' });
    void f.call('b3', 'background'); await vi.advanceTimersByTimeAsync(9_999); expect(f.started).not.toContain('b3');
    await vi.advanceTimersByTimeAsync(1); await flush(); await f.release('b3');
    void f.call('b4', 'background').catch(() => undefined); await flush(); await f.release('b4', limited);
    void f.call('b5', 'background'); await vi.advanceTimersByTimeAsync(5_000); await flush();
    expect(f.started.at(-1)).toBe('b5');
  });

  it.each([{ diagnostic: { http_status: 503 } }, { code: 'temporarily_unavailable' }, { code: 'timeout' }])('pauses background calls after a provider outage: %o', async (outage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = held();
    void f.call('b1', 'background').catch(() => undefined); await flush();
    await f.release('b1', outage);
    void f.call('b2', 'background'); void f.call('i1', 'interactive'); await flush();
    expect(f.started).toEqual(['b1', 'i1']);
    await vi.advanceTimersByTimeAsync(5_000); await flush();
    expect(f.started).toEqual(['b1', 'i1', 'b2']);
  });

  it('pauses once for concurrent 429s, ignores calls admitted before the pause, and doubles on the next episode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = held();
    const limited = { diagnostic: { http_status: 429 } };
    for (const name of ['b1', 'b2', 'b3']) void f.call(name, 'background').catch(() => undefined);
    await flush();
    await f.release('b1', limited); await f.release('b2', limited);
    await f.release('b3'); // admitted before the pause: its success resets nothing
    void f.call('b4', 'background').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(4_999); expect(f.started).not.toContain('b4');
    await vi.advanceTimersByTimeAsync(1); await flush(); await f.release('b4', limited);
    void f.call('b5', 'background');
    await vi.advanceTimersByTimeAsync(9_999); expect(f.started).not.toContain('b5');
    await vi.advanceTimersByTimeAsync(1); await flush(); expect(f.started.at(-1)).toBe('b5');
  });
});
