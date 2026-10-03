import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PersonConnectorReadBindingV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { createSlackChannelLiveEvidenceReaderV1, SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1 } from '../../src/context/slack-channel-live-evidence-reader-v1.js';
import type { SlackContextRequestV1, SlackContextTransportV1 } from '../../src/context/slack-context-transport-v1.js';

const team = 'TTEST123'; const channel = 'CTEST123'; const bot = 'UBOT123';
const ts = '1790966400.123456'; const origin = 'https://echo-test.slack.com';
const binding: PersonConnectorReadBindingV1 = { organization_id: 'org-test', principal_id: 'person-test', membership_id: 'membership-test',
  tool_id: 'slack', external_scope_id: team, external_subject_id: 'UHUMAN123', read_grant_sha256: `sha256:${'a'.repeat(64)}` };
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const message = (extra: Record<string, unknown> = {}) => ({ type: 'message', ts, user: 'UAUTHOR123', text: 'Deployment remains blocked on the review.', ...extra });

function fixture() {
  const state = { messages: [message()] as Record<string, unknown>[], is_private: false, is_member: true, auth_team: team,
    bot, next: '', page_more: false, is_limited: false, origin, failure: false, onRead: (_input: SlackContextRequestV1) => {} };
  const request = vi.fn(async (input: SlackContextRequestV1): Promise<unknown> => {
    state.onRead(input);
    if (state.failure) throw new Error('private provider diagnostics');
    if (input.method === 'auth.test') return { ok: true, team_id: state.auth_team, user_id: state.bot, url: `${state.origin}/` };
    if (input.method === 'conversations.info') return { ok: true, channel: { id: channel, name: 'engineering', context_team_id: team,
      is_member: state.is_member, is_private: state.is_private, is_im: false, is_mpim: false } };
    if (input.method === 'conversations.history') {
      const selected = input.query?.oldest === input.query?.latest
        ? state.messages.filter(item => item.ts === input.query?.oldest) : state.messages;
      return { ok: true, messages: selected.slice(0, Number(input.query?.limit)), has_more: state.page_more, is_limited: state.is_limited, response_metadata: { next_cursor: state.next } };
    }
    return { ok: true, channel, permalink: `${state.origin}/archives/${channel}/p${input.query?.message_ts?.replace('.', '')}` };
  });
  const transport: SlackContextTransportV1 = { binding: { ...binding }, request };
  const reader = createSlackChannelLiveEvidenceReaderV1({ transport, team_id: team, channel_id: channel, expected_bot_user_id: bot,
    now: () => new Date('2026-10-03T00:00:00.000Z') });
  return { reader, request, state, transport };
}

describe('fixed public-channel live evidence', () => {
  it('searches a bounded channel window and releases exact text with an explicit incomplete marker', async () => {
    const f = fixture();
    const result = await f.reader.search({ query: 'deployment review', limit: 5 });
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ text: message().text, visibility: 'team', occurred_at: '2026-10-02',
      citation: { kind: 'slack_message', team_id: team, channel_id: channel, message_ts: ts, text_sha256: digest(message().text) } });
    expect(f.request.mock.calls.filter(([input]) => input.method === 'conversations.history')).toHaveLength(1);
    const history = f.request.mock.calls.find(([input]) => input.method === 'conversations.history')![0];
    expect(history.query).toMatchObject({ channel, limit: '15', inclusive: 'true' });
    expect(history.query?.oldest).toBeDefined();
    expect(history.query?.latest).toBeDefined();
    expect(JSON.stringify(f.request.mock.calls)).not.toContain('deployment review');
  });

  it('lists inventory without message text and opens only a request-issued handle with an exact read', async () => {
    const f = fixture();
    const inventory = await f.reader.list({ container: '#engineering', limit: 2 });
    expect(inventory.items[0]).not.toHaveProperty('text');
    expect(inventory.items[0]!.citation.text_sha256).toBe(digest(''));
    const opened = await f.reader.open({ handle: inventory.items[0]!.handle, limit: 2 });
    expect(opened.items[0]!.text).toBe(message().text);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'conversations.history',
      query: { channel, limit: '1', oldest: ts, latest: ts, inclusive: 'true' } }));
    await expect(f.reader.open({ handle: `https://evil.example/${ts}`, limit: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.reader.list({ container: 'COTHER123', limit: 1 })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.request.mock.calls.every(([input]) => input.query?.channel === undefined || input.query.channel === channel)).toBe(true);
  });

  it.each(['edit', 'delete', 'private', 'membership', 'bot', 'team', 'origin', 'binding'] as const)(
    'fails revalidation after %s drift, including metadata-only inventory', async drift => {
      const f = fixture();
      const inventory = await f.reader.list({ limit: 1 });
      if (drift === 'edit') f.state.messages = [message({ text: 'Changed after the read.' })];
      if (drift === 'delete') f.state.messages = [];
      if (drift === 'private') f.state.is_private = true;
      if (drift === 'membership') f.state.is_member = false;
      if (drift === 'bot') f.state.bot = 'UOTHER123';
      if (drift === 'team') f.state.auth_team = 'TOTHER123';
      if (drift === 'origin') f.state.origin = 'https://other.slack.com';
      if (drift === 'binding') (f.transport as { binding: PersonConnectorReadBindingV1 }).binding = { ...binding, read_grant_sha256: `sha256:${'b'.repeat(64)}` };
      await expect(f.reader.revalidate({ citations: inventory.items.map(item => item.citation) })).rejects.toBeDefined();
    },
  );

  it('revalidates released text exactly and rejects forged or externally supplied citations', async () => {
    const f = fixture();
    const page = await f.reader.search({ query: 'review', limit: 1 });
    const citation = page.items[0]!.citation;
    await expect(f.reader.revalidate({ citations: [citation] })).resolves.toBeUndefined();
    expect(f.reader.validateCitation(citation)).toMatchObject({ tool_id: 'slack', external_scope_id: team,
      coordinates: { object_id: ts, container_id: channel } });
    expect(() => f.reader.validateCitation({ ...citation, text_sha256: digest('forged') })).toThrow();
    f.state.messages = [message({ text: 'Edited content' })];
    await expect(f.reader.revalidate({ citations: [citation] })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('cannot refresh an old inventory citation into edited source content by listing it again', async () => {
    const f = fixture();
    const original = await f.reader.list({ limit: 1 });
    f.state.messages = [message({ text: 'Edited source content.' })];
    await expect(f.reader.list({ limit: 1 })).rejects.toMatchObject({ code: 'stale_access_state' });
    await expect(f.reader.revalidate({ citations: original.items.map(item => item.citation) })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('opening an edited message cannot replace the earlier inventory commitment at the final fence', async () => {
    const f = fixture();
    const original = await f.reader.list({ limit: 1 });
    f.state.messages = [message({ text: 'New text after listing.' })];
    const opened = await f.reader.open({ handle: original.items[0]!.handle, limit: 1 });
    expect(opened.items[0]!.text).toBe('New text after listing.');
    await expect(f.reader.revalidate({ citations: [...original.items, ...opened.items].map(item => item.citation) })).rejects.toMatchObject({ code: 'stale_access_state' });
  });

  it('bounds search to two history pages and rejects repeated cursors', async () => {
    const f = fixture(); f.state.page_more = true; f.state.next = 'page-two';
    f.state.onRead = input => { if (input.query?.cursor === 'page-two') { f.state.messages = [message({ ts: '1790966390.000001' })]; f.state.next = 'page-three'; } };
    const page = await f.reader.search({ query: 'absent', limit: 2 });
    expect(page.items).toEqual([]); expect(page.truncated).toBe(true);
    expect(f.request.mock.calls.filter(([input]) => input.method === 'conversations.history')).toHaveLength(2);
    const repeated = fixture(); repeated.state.page_more = true; repeated.state.next = 'same';
    await expect(repeated.reader.search({ query: 'absent', limit: 2 })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('keeps raw provider cursors private and rejects continuation selection drift', async () => {
    const f = fixture(); f.state.page_more = true; f.state.next = 'private-provider-cursor';
    const first = await f.reader.list({ limit: 1 });
    expect(first.next_cursor).toBeDefined(); expect(first.next_cursor).not.toContain('private-provider');
    await expect(f.reader.list({ limit: 1, cursor: 'private-provider-cursor' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.reader.list({ limit: 1, cursor: first.next_cursor, container: '#other' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('marks provider-limited or partially representable history incomplete even with explicit date bounds', async () => {
    const limited = fixture(); limited.state.is_limited = true;
    expect((await limited.reader.list({ limit: 2, since: '2026-10-01', until: '2026-10-03' })).truncated).toBe(true);
    const skipped = fixture(); skipped.state.messages.push(message({ ts: '1790966300.000001', text: '' }));
    expect((await skipped.reader.list({ limit: 2, since: '2026-10-01' })).truncated).toBe(true);
  });

  it('does not retry provider failures or release after cancellation, and caps all provider requests', async () => {
    const failed = fixture(); failed.state.failure = true;
    await expect(failed.reader.search({ query: 'review', limit: 1 })).rejects.toMatchObject({ code: 'unavailable' });
    expect(failed.request).toHaveBeenCalledOnce();
    const aborted = fixture(); const controller = new AbortController();
    aborted.state.onRead = input => { if (input.method === 'conversations.history') controller.abort(); };
    await expect(aborted.reader.search({ query: 'review', limit: 1, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const bounded = fixture();
    for (let round = 0; round < SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1; round += 1) {
      try { await bounded.reader.revalidate({ citations: [] }); } catch { break; }
    }
    await expect(bounded.reader.revalidate({ citations: [] })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(bounded.request.mock.calls.length).toBeLessThanOrEqual(SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1);
  });

  it('keeps a list-then-open Ask with model and terminal-audit revalidation fences inside its request budget', async () => {
    const f = fixture();
    f.state.messages = [message(), message({ ts: '1790966300.000001' }), message({ ts: '1790966200.000001' })];
    await f.reader.revalidate({ citations: [] });
    const inventory = await f.reader.list({ limit: 8 });
    const citations = inventory.items.map(item => item.citation);
    await f.reader.revalidate({ citations });
    const opened = await f.reader.open({ handle: inventory.items[0]!.handle, limit: 8 });
    citations.push(...opened.items.map(item => item.citation));
    for (let fence = 0; fence < 4; fence += 1) await f.reader.revalidate({ citations });
    expect(inventory.items.length).toBeGreaterThan(0);
    expect(f.request.mock.calls.length).toBeLessThanOrEqual(SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1);
  });

  it('refuses missing public visibility, oversized messages, malformed bounds, and nonpublic configuration', async () => {
    const f = fixture();
    for (const limit of [0, 51, 1.5]) await expect(f.reader.search({ query: 'review', limit })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.reader.list({ since: 'yesterday', limit: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.request).not.toHaveBeenCalled();
    f.state.messages = [message({ text: 'x'.repeat(4096) })];
    const listed = await f.reader.list({ limit: 1 });
    await expect(f.reader.open({ handle: listed.items[0]!.handle, limit: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(() => createSlackChannelLiveEvidenceReaderV1({ transport: f.transport, team_id: team, channel_id: 'GPRIVATE123', expected_bot_user_id: bot })).toThrow();
  });
});
