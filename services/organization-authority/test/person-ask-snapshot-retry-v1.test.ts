import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { withPersonAskSnapshotRetryV1 } from '../src/composition/person-ask-snapshot-retry-v1.js';
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
  it('has no deadline: an attempt that keeps working past any clock still returns its answer', async () => {
    vi.useFakeTimers();
    try {
      const pending = withPersonAskSnapshotRetryV1({ run: async () => { await new Promise(resolve => setTimeout(resolve, 3_600_000)); return 'answer'; } });
      await vi.advanceTimersByTimeAsync(3_600_000);
      await expect(pending).resolves.toBe('answer');
    } finally { vi.useRealTimers(); }
  });
  it('preserves caller cancellation and does not restart after it', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(); throw new PersonRecordSearchSnapshotChangedV1(); });
    await expect(withPersonAskSnapshotRetryV1({ signal: controller.signal, run })).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
