import { describe, expect, it, vi } from 'vitest';
import type { ContextCaptureContentV1, SourceAdapterV1, SourceBatchV1 } from '@echo-brain/organization-processing/core';
import { createContextSourceIntakeV1 } from '../src/composition/context-source-intake-v1.js';
import { CONTEXT_CAPTURE_IDENTITY_V1, CONTEXT_CAPTURE_SCOPE_V1, contextCaptureV1 } from './fixtures/context-capture-v1.js';

function source(pull: SourceAdapterV1<ContextCaptureContentV1>['pull']): SourceAdapterV1<ContextCaptureContentV1> {
  return {
    identity: CONTEXT_CAPTURE_IDENTITY_V1,
    validateConfig: () => ({ ok: true, errors: [] }),
    healthCheck: async () => ({ status: 'healthy', checked_at: '2026-10-01T00:00:00.000Z' }),
    pull,
  };
}

function intake(adapter: SourceAdapterV1<ContextCaptureContentV1>, requireRead = async () => {}) {
  return createContextSourceIntakeV1({
    source: adapter, identity: CONTEXT_CAPTURE_IDENTITY_V1,
    organization_id: CONTEXT_CAPTURE_SCOPE_V1.organization_id,
    require_read_current: requireRead,
    retention: { disposition: 'request_only' },
    authority: {
      select: () => ({ disposition: 'request_only', scope: CONTEXT_CAPTURE_SCOPE_V1, permitted_representations: ['full_snapshot'] }),
      requireCurrent: () => {},
    },
  });
}

describe('configured context source intake', () => {
  it('owns provider bytes and cursor before an asynchronous read-grant fence yields', async () => {
    const capture = contextCaptureV1();
    const expected = structuredClone(capture);
    const batch = { sources: [capture], next_cursor: 'page-2' };
    let checks = 0;
    const pipeline = intake(source(async () => batch), async () => {
      checks++;
      if (checks === 2) {
        // The provider may still hold mutable references to its returned data.
        Object.assign(capture.content, { label: 'changed after pull' });
        batch.next_cursor = 'forged-later-cursor';
        await Promise.resolve();
      }
    });
    const result = await pipeline.pull();
    expect(result.captures[0]?.source).toEqual(expected);
    expect(result.next_cursor).toBe('page-2');
    expect(Object.isFrozen(result.captures[0]?.source.content)).toBe(true);
  });

  it('serializes pulls and lets a failed pull retry from the caller-owned cursor', async () => {
    let resolve!: (batch: SourceBatchV1<ContextCaptureContentV1>) => void;
    const pull = vi.fn<SourceAdapterV1<ContextCaptureContentV1>['pull']>()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue({ sources: [contextCaptureV1()], next_cursor: 'page-2' });
    const pipeline = intake(source(pull));
    const first = pipeline.pull({ cursor: 'page-1', limit: 1 });
    await Promise.resolve();
    await expect(pipeline.pull({ cursor: 'page-1' })).rejects.toThrow('already has a pull');
    resolve({ sources: [contextCaptureV1(), contextCaptureV1({ external_id: 'extra' })], next_cursor: 'page-2' });
    await expect(first).rejects.toThrow('invalid batch');
    await expect(pipeline.pull({ cursor: 'page-1', limit: 1 })).resolves.toMatchObject({ next_cursor: 'page-2' });
    expect(pull.mock.calls.map(call => call[0].cursor)).toEqual(['page-1', 'page-1']);
  });

  it('rejects adapter identity drift and cancellation during a provider read before admission', async () => {
    const abort = new AbortController();
    const adapter = source(async () => {
      abort.abort(new Error('request ended'));
      return { sources: [contextCaptureV1()], next_cursor: 'page-2' };
    });
    await expect(intake(adapter).pull({}, { signal: abort.signal })).rejects.toThrow('request ended');

    const drifting = source(async () => {
      Object.assign(drifting, { identity: { ...CONTEXT_CAPTURE_IDENTITY_V1, instance_id: 'other-installation' } });
      return { sources: [contextCaptureV1()], next_cursor: 'page-2' };
    });
    await expect(intake(drifting).pull()).rejects.toThrow('configured adapter');
  });
});
