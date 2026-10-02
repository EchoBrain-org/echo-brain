import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { buildContextCaptureEnvelopeV1, type ContextCaptureEnvelopeV1 } from '@echo-brain/organization-processing/core';
import { describe, expect, it, vi } from 'vitest';
import {
  runContextCaptureRehearsalV1,
  type ContextCaptureRehearsalPullPortV1,
} from '../src/application/context-capture-rehearsal-v1.js';

const identity = {
  kind: 'source' as const,
  adapter_id: 'fixture-context-capture',
  instance_id: 'private-fixture-instance',
  version: '1.0.0',
};

function capture(external_id: string): ContextCaptureEnvelopeV1 {
  return buildContextCaptureEnvelopeV1({
    identity,
    external_id,
    captured_at: '2026-10-01T00:00:00.000Z',
    content: {
      schema_version: 1,
      kind: 'echo-context-capture-v1',
      source_type: 'ticket',
      truth_status: 'source_observation',
      label: 'Private release ticket',
      provenance: { origin_ref: 'https://provider.example.test/private/123' },
      payload: { schema_version: 1, kind: 'ticket', key: 'PRIVATE-123', status: 'Open', labels: [] },
      representation: { kind: 'pointer', pointer: 'https://provider.example.test/private/123' },
      observations: [],
    },
  });
}

function intake(result: Awaited<ReturnType<ContextCaptureRehearsalPullPortV1['pull']>>): ContextCaptureRehearsalPullPortV1 {
  return { pull: vi.fn(async () => result) };
}

describe('context capture rehearsal V1', () => {
  it('runs one small pull and emits only safe immutable capture commitments', async () => {
    const source = capture('private-provider-object-123');
    const port = intake({
      captures: [
        { source, admission: 'admitted' },
        { source, admission: 'request_only' },
      ],
      next_cursor: 'private-provider-cursor',
    });

    const receipt = await runContextCaptureRehearsalV1({
      intake: port,
      expected_source_identity_sha256: canonicalSha256(identity),
      limit: 2,
      cursor: 'private-input-cursor',
      timeout_ms: 1_000,
    });

    expect(port.pull).toHaveBeenCalledWith({ limit: 2, cursor: 'private-input-cursor' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(receipt).toEqual({
      schema_version: 1,
      kind: 'echo-context-capture-rehearsal-receipt-v1',
      source_identity_sha256: canonicalSha256(identity),
      captures: [
        { source_type: 'ticket', admission: 'admitted', source_id_sha256: canonicalSha256(source.item.source_id), revision_id_sha256: canonicalSha256(source.revision.revision_id), content_sha256: source.revision.content_sha256 },
        { source_type: 'ticket', admission: 'request_only', source_id_sha256: canonicalSha256(source.item.source_id), revision_id_sha256: canonicalSha256(source.revision.revision_id), content_sha256: source.revision.content_sha256 },
      ],
      counts: { captured: 2, admitted: 1, duplicate: 0, request_only: 1 },
    });
    const output = JSON.stringify(receipt);
    for (const secret of ['private-fixture-instance', 'private-provider-object-123', 'Private release ticket', 'PRIVATE-123', 'provider.example.test', 'private-input-cursor', 'private-provider-cursor', source.revision.revision_id]) {
      expect(output).not.toContain(secret);
    }
  });

  it('rejects invalid bounds before provider work and never prints a partial receipt', async () => {
    const pull = vi.fn();
    const port: ContextCaptureRehearsalPullPortV1 = { pull };
    await expect(runContextCaptureRehearsalV1({ intake: port, expected_source_identity_sha256: 'sha256:not-a-digest', limit: 1, timeout_ms: 1_000 })).rejects.toThrow('source identity digest is invalid');
    await expect(runContextCaptureRehearsalV1({ intake: port, expected_source_identity_sha256: canonicalSha256(identity), limit: 0, timeout_ms: 1_000 })).rejects.toThrow('limit must be from 1 to 5');
    await expect(runContextCaptureRehearsalV1({ intake: port, expected_source_identity_sha256: canonicalSha256(identity), limit: 1, cursor: 'x'.repeat(16 * 1024 + 1), timeout_ms: 1_000 })).rejects.toThrow('cursor exceeds its bound');
    await expect(runContextCaptureRehearsalV1({ intake: port, expected_source_identity_sha256: canonicalSha256(identity), limit: 1, timeout_ms: 30_001 })).rejects.toThrow('deadline must be from 1 to 30000');
    expect(pull).not.toHaveBeenCalled();

    const rejected: ContextCaptureRehearsalPullPortV1 = { pull: vi.fn(async () => { throw new Error('provider body: private issue text'); }) };
    const error = await runContextCaptureRehearsalV1({ intake: rejected, expected_source_identity_sha256: canonicalSha256(identity), limit: 1, timeout_ms: 1_000 }).catch(error => error);
    expect(error).toMatchObject({ message: 'Context capture rehearsal failed' });
    expect(String(error)).not.toContain('private issue text');
  });

  it('passes host cancellation to the one pull and does not continue after cancellation', async () => {
    const abort = new AbortController();
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const port: ContextCaptureRehearsalPullPortV1 = {
      pull: async (_request, context) => {
        started();
        await new Promise<void>((_resolve, reject) => context!.signal.addEventListener('abort', () => reject(context!.signal.reason), { once: true }));
        throw new Error('unreachable');
      },
    };
    const run = runContextCaptureRehearsalV1({ intake: port, expected_source_identity_sha256: canonicalSha256(identity), limit: 1, signal: abort.signal, timeout_ms: 1_000 });
    await begun;
    abort.abort(new Error('private abort reason'));
    const error = await run.catch(error => error);
    expect(error).toMatchObject({ name: 'AbortError', message: 'Context capture rehearsal was cancelled' });
    expect(String(error)).not.toContain('private abort reason');
  });


  it('uses the caller identity commitment for an empty receipt and suppresses arbitrary revision text', async () => {
    const empty = await runContextCaptureRehearsalV1({
      intake: intake({ captures: [] }),
      expected_source_identity_sha256: canonicalSha256(identity),
      limit: 1,
      timeout_ms: 1_000,
    });
    expect(empty).toMatchObject({ source_identity_sha256: canonicalSha256(identity), captures: [], counts: { captured: 0 } });

    const source = capture('private-provider-object-123');
    const maliciousRevision = { ...source, revision: { ...source.revision, revision_id: 'private-provider-revision-id' } };
    const receipt = await runContextCaptureRehearsalV1({
      intake: intake({ captures: [{ source: maliciousRevision, admission: 'admitted' }] }),
      expected_source_identity_sha256: canonicalSha256(identity),
      limit: 1,
      timeout_ms: 1_000,
    });
    expect(receipt.captures[0]!.revision_id_sha256).toBe(canonicalSha256('private-provider-revision-id'));
    expect(JSON.stringify(receipt)).not.toContain('private-provider-revision-id');
  });

  it('fails with a fixed error if the source identity differs from the trusted caller commitment', async () => {
    const otherIdentity = { ...identity, instance_id: 'other-private-instance' };
    const source = buildContextCaptureEnvelopeV1({
      identity: otherIdentity, external_id: 'private-object', captured_at: '2026-10-01T00:00:00.000Z',
      content: {
        schema_version: 1, kind: 'echo-context-capture-v1', source_type: 'note', truth_status: 'source_observation',
        label: 'Private', provenance: { origin_ref: 'private:origin' },
        payload: { schema_version: 1, kind: 'note', format: 'plain_text' },
        representation: { kind: 'pointer', pointer: 'private:origin' }, observations: [],
      },
    });
    const error = await runContextCaptureRehearsalV1({
      intake: intake({ captures: [{ source, admission: 'request_only' }] }),
      expected_source_identity_sha256: canonicalSha256(identity),
      limit: 1, timeout_ms: 1_000,
    }).catch(error => error);
    expect(error).toMatchObject({ message: 'Context capture rehearsal failed' });
    expect(String(error)).not.toContain('other-private-instance');
  });

  // The real ContextSourceIntakeV1 rejects a source over-batch before admission;
  // this receipt-only wrapper cannot roll back a malicious upstream port.
  it('fails closed when an intake returns more than the requested single page', async () => {
    const source = capture('private-provider-object-123');
    await expect(runContextCaptureRehearsalV1({
      intake: intake({ captures: [{ source, admission: 'admitted' }, { source, admission: 'duplicate' }] }),
      expected_source_identity_sha256: canonicalSha256(identity),
      limit: 1,
      timeout_ms: 1_000,
    })).rejects.toThrow('Context capture rehearsal failed');
  });
});
