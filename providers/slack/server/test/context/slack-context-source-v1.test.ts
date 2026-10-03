import { describe, expect, it, vi } from 'vitest';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { assertContextCaptureEnvelopeV1 } from '@echo-brain/organization-processing/core';
import { createSlackContextSourceV1 } from '../../src/context/slack-context-source-v1.js';
import type { SlackContextRequestV1, SlackContextTransportV1 } from '../../src/context/slack-context-transport-v1.js';

const team = 'TTEST123';
const channel = 'CTEST123';
const bot = 'UBOT123';
const ts = '1790966400.123456';
const origin = 'https://echo-test.slack.com';
const binding: PersonConnectorReadBindingV1 = Object.freeze({
  organization_id: 'org-test', principal_id: 'person-test', membership_id: 'membership-test',
  tool_id: 'slack', external_scope_id: team, external_subject_id: 'UHUMAN123', read_grant_sha256: `sha256:${'a'.repeat(64)}`,
});
const identity = { kind: 'source' as const, adapter_id: 'slack-context-capture', version: '1.0.0', instance_id: `slack:${team}:channel:${channel}` };
const message = (extra: Record<string, unknown> = {}) => ({ type: 'message', ts, user: 'UAUTHOR123', text: 'Private text must not enter pointer captures.', ...extra });
const pointer = (stamp = ts) => `${origin}/archives/${channel}/p${stamp.replace('.', '')}`;

function fixture(options: { message?: unknown; page?: unknown; auth?: unknown; channel?: unknown; permalink?: unknown; public_channel_only?: true; now?: () => Date; current?: () => void | Promise<void>; onRead?: (input: SlackContextRequestV1) => void } = {}) {
  const request = vi.fn(async (input: SlackContextRequestV1): Promise<unknown> => {
    options.onRead?.(input);
    if (input.method === 'auth.test') return options.auth ?? { ok: true, team_id: team, user_id: bot, url: `${origin}/` };
    if (input.method === 'conversations.info') return { ok: true, channel: options.channel ?? { id: channel, context_team_id: team, is_member: true } };
    if (input.method === 'conversations.history') return options.page ?? { ok: true, messages: [options.message ?? message()], has_more: false, response_metadata: { next_cursor: '' } };
    if (input.method === 'chat.getPermalink') return options.permalink ?? { ok: true, channel, permalink: pointer(input.query?.message_ts) };
    throw new Error('Unexpected method');
  });
  const transport: SlackContextTransportV1 = { binding, request };
  const requireCurrent = vi.fn(async () => { await options.current?.(); });
  const source = createSlackContextSourceV1({
    transport, read_grant_fence: { requireCurrent }, team_id: team, channel_id: channel,
    expected_bot_user_id: bot, identity, representation: 'pointer',
    ...(options.public_channel_only === undefined ? {} : { public_channel_only: options.public_channel_only }),
    now: options.now ?? (() => new Date('2026-10-03T00:00:00.000Z')),
  });
  return { source, transport, request, requireCurrent };
}

describe('Slack context source V1', () => {
  it('normalizes one configured channel page into shared pointer context without message bodies or identity claims', async () => {
    const f = fixture({ message: message({ edited: { user: 'UEDITOR123', ts: '1790966401.654321' }, thread_ts: '1790966300.000001' }),
      permalink: { ok: true, channel, permalink: `${pointer()}?thread_ts=1790966300.000001&cid=${channel}` } });
    const result = await f.source.pull({ limit: 2 });
    expect(f.requireCurrent).toHaveBeenCalledTimes(2);
    expect(f.requireCurrent).toHaveBeenCalledWith({ binding, signal: undefined });
    expect(f.request).toHaveBeenCalledWith({ method: 'conversations.history', query: { channel, limit: '2' }, signal: undefined });
    expect(result.sources).toHaveLength(1);
    const capture = result.sources[0]!;
    assertContextCaptureEnvelopeV1(capture, identity);
    expect(capture).toMatchObject({ item: { external_id: `message:${ts}` }, content: {
      provenance: { origin_ref: `${pointer()}?thread_ts=1790966300.000001&cid=${channel}`, source_updated_at: '2026-10-02T18:40:01.654Z' },
      payload: { kind: 'message', channel_ref: `slack:team:${team}:channel:${channel}`, sent_at: '2026-10-02T18:40:00.123Z',
        author_ref: `slack:team:${team}:user:UAUTHOR123`, thread_ref: `slack:team:${team}:channel:${channel}:message:1790966300.000001` },
      representation: { kind: 'pointer', pointer: `${pointer()}?thread_ts=1790966300.000001&cid=${channel}` },
    } });
    expect(JSON.stringify(capture)).not.toContain('Private text');
    expect(capture.revision).not.toHaveProperty('contributor');
    expect(result.next_cursor).toBeUndefined();
  });

  it('uses provider source times only and preserves source/revision identity across polling', async () => {
    const first = (await fixture().source.pull({ limit: 1 })).sources[0]!;
    const replay = (await fixture({ now: () => new Date('2026-10-04T00:00:00.000Z') }).source.pull({ limit: 1 })).sources[0]!;
    const edited = (await fixture({ message: message({ edited: { user: 'UAUTHOR123', ts: '1790966401.000001' } }) }).source.pull({ limit: 1 })).sources[0]!;
    expect(first.content.provenance).not.toHaveProperty('source_updated_at');
    expect(replay.item.source_id).toBe(first.item.source_id);
    expect(replay.revision.revision_id).toBe(first.revision.revision_id);
    expect(replay.revision.captured_at).not.toBe(first.revision.captured_at);
    expect(edited.item.source_id).toBe(first.item.source_id);
    expect(edited.revision.revision_id).not.toBe(first.revision.revision_id);
  });

  it('returns a bounded continuation without following additional history pages or provider links', async () => {
    const f = fixture({ page: { ok: true, messages: [message()], has_more: true, response_metadata: { next_cursor: 'next-page==' } } });
    const result = await f.source.pull({ limit: 1, cursor: 'first-page==' });
    expect(result.next_cursor).toBe('next-page==');
    expect(f.request.mock.calls.filter(([input]) => input.method === 'conversations.history')).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith({ method: 'conversations.history', query: { channel, limit: '1', cursor: 'first-page==' }, signal: undefined });
  });

  it.each([
    { ok: true, messages: [message(), message()], has_more: false },
    { ok: true, messages: [message(), message({ ts: '1790966402.000001' })], has_more: false },
    { ok: true, messages: [], has_more: true },
    { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: 'unexpected' } },
    { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'repeated' } },
    { ok: true, messages: [], has_more: 'false' },
  ])('rejects oversized, duplicate or inconsistent history pagination', async page => {
    await expect(fixture({ page }).source.pull({ limit: 1, cursor: 'repeated' })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it.each([
    message({ channel: 'COTHER123' }), message({ team: 'TOTHER123' }), message({ type: 'other' }), message({ ts: '1e9.000000' }),
    message({ user: '../forged-person' }), message({ thread_ts: '1790966402.000000' }),
    message({ edited: { ts: '1790966300.000000', user: 'UAUTHOR123' } }), message({ edited: { ts: 'bad', user: 'UAUTHOR123' } }),
  ])('rejects malformed message metadata and inconsistent source coordinates', async raw => {
    await expect(fixture({ message: raw }).source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it.each([
    `https://evil.example/archives/${channel}/p${ts.replace('.', '')}`,
    `${origin}/archives/COTHER123/p${ts.replace('.', '')}`,
    `${origin}/archives/${channel}/p1790966401999999`,
    `${pointer()}#fragment`, `${pointer()}?token=unexpected`, `${pointer()}?thread_ts=1790966300.000001&cid=${channel}`,
  ])('refuses provider permalinks that do not match verified workspace, channel and message', async permalink => {
    await expect(fixture({ permalink: { ok: true, channel, permalink } }).source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('rejects a mismatched bot, workspace or channel before reading history', async () => {
    for (const f of [fixture({ auth: { ok: true, team_id: 'TOTHER123', user_id: bot, url: `${origin}/` } }),
      fixture({ auth: { ok: true, team_id: team, user_id: 'UOTHER123', url: `${origin}/` } }),
      fixture({ channel: { id: 'COTHER123', is_member: true } }), fixture({ channel: { id: channel, is_member: false } }),
      fixture({ channel: { id: channel, is_member: true, context_team_id: 'TOTHER123' } })]) {
      await expect(f.source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'conversations.history' }));
    }
  });

  it('requires positive public-channel evidence when the selected capability is public only', async () => {
    for (const isPrivate of [true, undefined, null, 'false']) {
      const f = fixture({ public_channel_only: true, channel: { id: channel, is_member: true, is_private: isPrivate } });
      await expect(f.source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'conversations.history' }));
    }
    const f = fixture({ public_channel_only: true, channel: { id: channel, is_member: true, is_private: false } });
    expect((await f.source.pull({ limit: 1 })).sources).toHaveLength(1);
  });

  it('does not release fetched context after grant revocation or cancellation', async () => {
    let checks = 0;
    const revoked = fixture({ current() { if (++checks === 2) throw new Error('revoked'); } });
    await expect(revoked.source.pull({ limit: 1 })).rejects.toThrow('revoked');
    expect(revoked.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'chat.getPermalink' }));
    const controller = new AbortController();
    const cancelled = fixture({ onRead(input) { if (input.method === 'conversations.history') controller.abort(); } });
    await expect(cancelled.source.pull({ limit: 1 }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'chat.getPermalink' }));
  });

  it('validates bounds before provider calls and detects mutable authorization bindings', async () => {
    const f = fixture();
    for (const limit of [0, -1, 16, 1.5]) await expect(f.source.pull({ limit })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.source.pull({ limit: 1, cursor: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    (f.transport as { binding: PersonConnectorReadBindingV1 }).binding = { ...binding, external_scope_id: 'TOTHER123' };
    await expect(f.source.pull({ limit: 1 })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('allows optional opaque author metadata and does not interpret message content or attachments', async () => {
    const result = await fixture({ message: { type: 'message', ts, bot_id: 'BBOT123', attachments: [{ private: 'not retained' }] } }).source.pull({ limit: 1 });
    expect(result.sources[0]!.content.payload).toMatchObject({ author_ref: `slack:team:${team}:bot:BBOT123` });
    expect(JSON.stringify(result)).not.toContain('not retained');
  });
});
