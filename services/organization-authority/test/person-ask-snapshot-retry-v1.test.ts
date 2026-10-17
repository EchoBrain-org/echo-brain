import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { PERSON_ASK_TERMINAL_GRACE_MS_V1, withPersonAskSnapshotRetryV1 } from '../src/composition/person-ask-snapshot-retry-v1.js';
import { PersonRecordSearchSnapshotChangedV1 } from '../src/composition/person-record-search-route.js';

describe('Ask snapshot restart', () => {
  it('discards a failed attempt and runs a fresh attempt once', async () => {
    const run = vi.fn().mockRejectedValueOnce(new PersonRecordSearchSnapshotChangedV1()).mockResolvedValueOnce({ evidence: ['new-snapshot'] });
    await expect(withPersonAskSnapshotRetryV1({ run })).resolves.toEqual({ evidence: ['new-snapshot'] });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('stops after a second snapshot change', async () => {
    const error = new PersonRecordSearchSnapshotChangedV1();
    const run = vi.fn().mockRejectedValue(error);
    await expect(withPersonAskSnapshotRetryV1({ run })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['unauthorized', 'stale_access_state', 'unavailable'] as const)('does not retry %s', async code => {
    const error = new AuthorityOperationError(code, 'fixture');
    const run = vi.fn().mockRejectedValue(error);
    await expect(withPersonAskSnapshotRetryV1({ run })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('never mixes attempts in a diagnostic capture', async () => {
    const run = vi.fn().mockRejectedValue(new PersonRecordSearchSnapshotChangedV1());
    await expect(withPersonAskSnapshotRetryV1({ capture: true, run })).rejects.toMatchObject({ code: 'unavailable' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('enforces the deadline when a connector ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(() => new Promise<never>(() => {}));
      const checked = expect(withPersonAskSnapshotRetryV1({ run })).rejects.toMatchObject({ name: 'AgenticAskDeadlineErrorV1' });
      await vi.advanceTimersByTimeAsync(90_000 + PERSON_ASK_TERMINAL_GRACE_MS_V1);
      await checked;
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('shares one deadline across attempts and preserves caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      let count = 0;
      const pending = withPersonAskSnapshotRetryV1({ run: async signal => {
        count++;
        if (count === 1) { await new Promise(resolve => setTimeout(resolve, 60_000)); throw new PersonRecordSearchSnapshotChangedV1(); }
        return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } });
      const checked = expect(pending).rejects.toMatchObject({ name: 'AgenticAskDeadlineErrorV1' });
      await vi.advanceTimersByTimeAsync(90_000);
      await checked;
      expect(count).toBe(2);
      const controller = new AbortController();
      const run = vi.fn(async () => { controller.abort(); throw new PersonRecordSearchSnapshotChangedV1(); });
      await expect(withPersonAskSnapshotRetryV1({ signal: controller.signal, run })).rejects.toMatchObject({ name: 'AbortError' });
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
