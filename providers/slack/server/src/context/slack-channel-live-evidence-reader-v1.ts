import { createHash, randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { PERSON_EVIDENCE_TEXT_MAX_BYTES_V1, type PersonSlackMessageCitationV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonConnectorReadBindingV1, PersonLiveEvidenceListInputV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { SlackContextRequestV1, SlackContextTransportV1 } from './slack-context-transport-v1.js';
import { parseSlackContextMessageV1 } from './slack-context-payload-v1.js';
import { copySlackContextBindingV1, requireSlackContextResponseV1, slackContextArrayV1, slackContextFailureV1,
  slackContextRecordV1, slackContextStringV1, slackContextTimestampIsoV1, slackContextTimestampMicrosV1,
  slackContextWorkspaceOriginV1, SLACK_CONTEXT_MAX_CURSOR_BYTES_V1, SLACK_CONTEXT_MAX_PAGE_V1,
  SLACK_CONTEXT_TEAM_V1, SLACK_CONTEXT_TS_V1, SLACK_CONTEXT_USER_V1 } from './slack-context-validation-v1.js';

export const SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1 = 48;
export const SLACK_LIVE_EVIDENCE_MAX_SCANNED_MESSAGES_V1 = 120;
export const SLACK_LIVE_EVIDENCE_SEARCH_WINDOW_DAYS_V1 = 7;
const MAX_ISSUED = 32;
// Leave room for every model and terminal-audit revalidation fence within the hard request budget.
const MAX_RELEASE = 2;
const DAY_MS = 86_400_000;
type Citation = PersonSlackMessageCitationV1;
type Page = PersonLiveEvidencePageV1<Citation>;
interface Window { readonly oldest: string; readonly latest: string }
interface Cursor extends Window { readonly selection: string; readonly token: string; readonly tokens: ReadonlySet<string>; readonly ids: ReadonlySet<string> }
interface CurrentChannel { readonly origin: string; readonly name: string }
interface Issued { readonly citation: Citation; readonly source_digest: string; readonly label: string; readonly occurred_at: string }
export interface SlackChannelLiveEvidenceReaderOptionsV1 {
  readonly transport: SlackContextTransportV1;
  readonly team_id: string;
  readonly channel_id: string;
  readonly expected_bot_user_id: string;
  readonly now?: () => Date;
}
function textDigest(text: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`; }
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) slackContextFailureV1('invalid_request');
  return Math.min(value, MAX_RELEASE);
}
function date(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) slackContextFailureV1('invalid_request');
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) slackContextFailureV1('invalid_request');
  return milliseconds;
}
function timestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000_000_000) slackContextFailureV1('invalid_request');
  return `${Math.floor(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, '0')}000`;
}

/** Request-owned, fixed public-channel reads under an explicit Authority grant, never a person's Slack token. */
export class SlackChannelLiveEvidenceReaderV1 implements PersonLiveEvidenceReaderV1<Citation> {
  readonly binding: PersonConnectorReadBindingV1;
  private readonly transport: SlackContextTransportV1;
  private readonly request: SlackContextTransportV1['request'];
  private readonly team: string;
  private readonly channel: string;
  private readonly bot: string;
  private readonly window: Window;
  private readonly now: number;
  private origin?: string;
  private requests = 0;
  private scanned = 0;
  private readonly handles = new Map<string, Issued>();
  private readonly issued = new Map<string, Issued>();
  private readonly cursors = new Map<string, Cursor>();

  constructor(options: SlackChannelLiveEvidenceReaderOptionsV1) {
    this.binding = copySlackContextBindingV1(options.transport.binding);
    this.team = slackContextStringV1(options.team_id, 31, SLACK_CONTEXT_TEAM_V1);
    this.channel = slackContextStringV1(options.channel_id, 31, /^C[A-Z0-9]{2,30}$/);
    this.bot = slackContextStringV1(options.expected_bot_user_id, 64, SLACK_CONTEXT_USER_V1);
    if (this.binding.external_scope_id !== this.team || typeof options.transport.request !== 'function') slackContextFailureV1('unauthorized');
    this.transport = options.transport; this.request = options.transport.request.bind(options.transport);
    const now = (options.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) slackContextFailureV1('invalid_request');
    this.now = now.getTime();
    this.window = Object.freeze({ oldest: timestamp(this.now - SLACK_LIVE_EVIDENCE_SEARCH_WINDOW_DAYS_V1 * DAY_MS), latest: timestamp(this.now) });
  }

  validateCitation(value: unknown) {
    const raw = slackContextRecordV1(value);
    const keys = ['kind', 'team_id', 'channel_id', 'message_ts', 'permalink', 'text_sha256', ...(raw.thread_ts === undefined ? [] : ['thread_ts'])];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key)) ||
      raw.kind !== 'slack_message' || raw.team_id !== this.team || raw.channel_id !== this.channel ||
      typeof raw.message_ts !== 'string' || !SLACK_CONTEXT_TS_V1.test(raw.message_ts) || typeof raw.permalink !== 'string' ||
      typeof raw.text_sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.text_sha256) ||
      (raw.thread_ts !== undefined && (typeof raw.thread_ts !== 'string' || !SLACK_CONTEXT_TS_V1.test(raw.thread_ts)))) slackContextFailureV1('invalid_output');
    const remembered = this.issued.get(canonicalSha256(raw));
    if (remembered === undefined) slackContextFailureV1('unauthorized');
    return Object.freeze({ citation: remembered.citation, tool_id: 'slack', external_scope_id: this.team,
      coordinates: Object.freeze({ object_id: remembered.citation.message_ts, container_id: this.channel }) });
  }

  async search(input: { readonly query: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<Page> {
    const maximum = limit(input.limit);
    if (typeof input.query !== 'string' || input.query.trim() === '' || Buffer.byteLength(input.query, 'utf8') > 512 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.query)) slackContextFailureV1('invalid_request');
    const terms = input.query.normalize('NFC').toLowerCase().trim().split(/\s+/u);
    const current = await this.verify(input.signal);
    const selected: PersonLiveEvidenceValueV1<Citation>[] = [];
    let continuation: Cursor | undefined;
    for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
      const page = await this.history(this.window, SLACK_CONTEXT_MAX_PAGE_V1, continuation, input.signal);
      for (const raw of page.messages) {
        const body = this.message(raw);
        if (body === undefined || !terms.every(term => (body.text as string).toLowerCase().includes(term))) continue;
        if (Buffer.byteLength(body.text as string, 'utf8') > PERSON_EVIDENCE_TEXT_MAX_BYTES_V1) continue;
        selected.push(await this.value(body, current, false, input.signal));
        if (selected.length === maximum) break;
      }
      if (selected.length === maximum || page.next === undefined) break;
      continuation = { ...this.window, selection: '', token: page.next, tokens: page.tokens, ids: page.ids };
    }
    await this.verify(input.signal);
    // Search covers only this fixed channel's recent bounded window, never a workspace-wide corpus.
    return Object.freeze({ items: Object.freeze(selected), truncated: true });
  }

  async list(input: PersonLiveEvidenceListInputV1): Promise<Page> {
    const maximum = limit(input.limit);
    if (input.container !== undefined && (typeof input.container !== 'string' || !/^#?[a-zA-Z0-9_-]{1,80}$/.test(input.container))) slackContextFailureV1('invalid_request');
    const oldest = input.since === undefined ? this.window.oldest : timestamp(date(input.since));
    const latest = input.until === undefined ? this.window.latest : timestamp(Math.min(date(input.until) + DAY_MS - 1, this.now));
    if (slackContextTimestampMicrosV1(oldest) > slackContextTimestampMicrosV1(latest)) slackContextFailureV1('invalid_request');
    const selection = canonicalSha256({ container: input.container ?? null, since: input.since ?? null, until: input.until ?? null });
    const continuation = input.cursor === undefined ? undefined : this.cursors.get(input.cursor);
    if (input.cursor !== undefined && (continuation === undefined || continuation.selection !== selection)) slackContextFailureV1('invalid_request');
    const current = await this.verify(input.signal);
    if (input.container !== undefined && ![this.channel, current.name, `#${current.name}`].includes(input.container)) slackContextFailureV1('unauthorized');
    const page = await this.history(continuation ?? { oldest, latest }, maximum, continuation, input.signal);
    const selected: PersonLiveEvidenceValueV1<Citation>[] = [];
    for (const raw of page.messages) {
      const body = this.message(raw);
      if (body !== undefined) selected.push(await this.value(body, current, true, input.signal));
    }
    await this.verify(input.signal);
    let next_cursor: string | undefined;
    if (page.next !== undefined) {
      if (this.cursors.size >= MAX_ISSUED) slackContextFailureV1('quota_exceeded');
      next_cursor = `slack_cursor_${randomUUID()}`;
      this.cursors.set(next_cursor, { oldest, latest, selection, token: page.next, tokens: page.tokens, ids: page.ids });
    }
    return Object.freeze({ items: Object.freeze(selected), truncated: page.next !== undefined || page.limited || selected.length < page.messages.length || input.since === undefined,
      ...(next_cursor === undefined ? {} : { next_cursor }) });
  }

  async open(input: { readonly handle: string; readonly limit: number; readonly signal?: AbortSignal }): Promise<Page> {
    limit(input.limit);
    const remembered = this.handles.get(input.handle);
    if (remembered === undefined) slackContextFailureV1('not_found');
    const current = await this.verify(input.signal);
    const message = await this.exact(remembered.citation.message_ts, input.signal);
    const item = await this.value(message, current, false, input.signal);
    await this.verify(input.signal);
    return Object.freeze({ items: Object.freeze([item]), truncated: false });
  }

  async revalidate(input: { readonly citations: readonly Citation[]; readonly signal?: AbortSignal }): Promise<void> {
    const remembered = new Map<string, Issued>();
    for (const raw of slackContextArrayV1(input.citations, MAX_ISSUED)) {
      const citation = this.validateCitation(raw).citation;
      remembered.set(canonicalSha256(citation), this.issued.get(canonicalSha256(citation))!);
    }
    const current = await this.verify(input.signal);
    if (remembered.size === 0) return;
    const checked = new Map<string, Issued>();
    for (const item of remembered.values()) {
      let fresh = checked.get(item.citation.message_ts);
      if (fresh === undefined) {
        fresh = (await this.parsed(await this.exact(item.citation.message_ts, input.signal), current, true, input.signal, item.citation)).stored;
        checked.set(item.citation.message_ts, fresh);
      }
      if (fresh.source_digest !== item.source_digest || fresh.label !== item.label || fresh.citation.permalink !== item.citation.permalink ||
        fresh.citation.thread_ts !== item.citation.thread_ts) slackContextFailureV1('stale_access_state');
    }
    await this.verify(input.signal);
  }

  private async verify(signal?: AbortSignal): Promise<CurrentChannel> {
    const auth = await this.read({ method: 'auth.test', signal });
    if (auth.team_id !== this.team || auth.user_id !== this.bot) slackContextFailureV1('unauthorized');
    const origin = slackContextWorkspaceOriginV1(auth.url);
    if (this.origin !== undefined && origin !== this.origin) slackContextFailureV1('stale_access_state');
    this.origin = origin;
    const channel = slackContextRecordV1((await this.read({ method: 'conversations.info', query: { channel: this.channel }, signal })).channel);
    if (channel.id !== this.channel || channel.is_member !== true || channel.is_private !== false || channel.is_im === true || channel.is_mpim === true ||
      (channel.context_team_id !== undefined && channel.context_team_id !== this.team)) slackContextFailureV1('unauthorized');
    const name = slackContextStringV1(channel.name, 80, /^[a-z0-9_-]+$/);
    return { origin, name };
  }

  private async history(window: Window, maximum: number, cursor?: Cursor, signal?: AbortSignal) {
    this.reserveMessageCapacity(maximum);
    const page = await this.read({ method: 'conversations.history', query: { channel: this.channel, limit: String(maximum),
      oldest: window.oldest, latest: window.latest, inclusive: 'true', ...(cursor === undefined ? {} : { cursor: cursor.token }) }, signal });
    const messages = slackContextArrayV1(page.messages, maximum);
    if (typeof page.has_more !== 'boolean') slackContextFailureV1('invalid_output');
    if (page.is_limited !== undefined && typeof page.is_limited !== 'boolean') slackContextFailureV1('invalid_output');
    const rawNext = page.response_metadata === undefined ? undefined : slackContextRecordV1(page.response_metadata).next_cursor;
    const next = rawNext === undefined || rawNext === '' ? undefined : slackContextStringV1(rawNext, SLACK_CONTEXT_MAX_CURSOR_BYTES_V1);
    if ((page.has_more ? next === undefined : next !== undefined)) slackContextFailureV1('invalid_output');
    const tokens = new Set(cursor?.tokens); const ids = new Set(cursor?.ids);
    if (next !== undefined) { if (tokens.has(next)) slackContextFailureV1('invalid_output'); tokens.add(next); }
    for (const raw of messages) {
      const ts = slackContextStringV1(slackContextRecordV1(raw).ts, 19, SLACK_CONTEXT_TS_V1);
      const micros = slackContextTimestampMicrosV1(ts);
      if (ids.has(ts) || micros < slackContextTimestampMicrosV1(window.oldest) || micros > slackContextTimestampMicrosV1(window.latest)) slackContextFailureV1('invalid_output');
      ids.add(ts);
    }
    return { messages, next, tokens, ids, limited: page.is_limited === true };
  }

  private message(raw: unknown): Record<string, unknown> | undefined {
    const value = slackContextRecordV1(raw);
    if (value.type !== 'message' || value.hidden === true || value.subtype === 'message_deleted' || value.subtype === 'message_changed' || value.text === undefined || value.text === '') return undefined;
    if (typeof value.text !== 'string' || value.text !== value.text.normalize('NFC') || Buffer.byteLength(value.text, 'utf8') > 40_000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.text)) slackContextFailureV1('invalid_output');
    return value.text.trim() === '' ? undefined : value;
  }

  private async exact(ts: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    // Slack documents inclusive timestamp bounds and limit=1 for an exact archived message.
    this.reserveMessageCapacity(1);
    const page = await this.read({ method: 'conversations.history', query: { channel: this.channel, limit: '1', oldest: ts, latest: ts, inclusive: 'true' }, signal });
    const messages = slackContextArrayV1(page.messages, 1);
    const body = messages.length === 1 ? this.message(messages[0]) : undefined;
    if (body === undefined || body.ts !== ts) slackContextFailureV1('not_found');
    return body;
  }

  private async parsed(body: Record<string, unknown>, current: CurrentChannel, inventory: boolean, signal?: AbortSignal, previouslyValidated?: Citation) {
    const ts = slackContextStringV1(body.ts, 18, /^[0-9]{9,11}\.[0-9]{6}$/);
    const text = body.text as string;
    if (!inventory && Buffer.byteLength(text, 'utf8') > PERSON_EVIDENCE_TEXT_MAX_BYTES_V1) slackContextFailureV1('invalid_output');
    // A permalink is immutable message addressing, not an access check. Revalidation reuses only our own
    // validated address; exact history plus fresh auth/channel reads proves current content and visibility.
    const permalink = previouslyValidated === undefined
      ? await this.read({ method: 'chat.getPermalink', query: { channel: this.channel, message_ts: ts }, signal })
      : { ok: true, channel: this.channel, permalink: previouslyValidated.permalink };
    const normalized = parseSlackContextMessageV1(body, { team_id: this.team, channel_id: this.channel, workspace_origin: current.origin, permalink });
    const pointer = normalized.content.provenance.origin_ref;
    if (pointer === undefined || pointer.length > 512) slackContextFailureV1('invalid_output');
    const citation: Citation = Object.freeze({ kind: 'slack_message', team_id: this.team, channel_id: this.channel, message_ts: ts,
      ...(body.thread_ts === undefined ? {} : { thread_ts: body.thread_ts as string }), permalink: pointer, text_sha256: textDigest(inventory ? '' : text) });
    const label = `Slack message ${ts} in #${current.name}`;
    const occurred_at = slackContextTimestampIsoV1(ts).slice(0, 10);
    const source_digest = canonicalSha256({ text_sha256: textDigest(text), content: normalized.content });
    return { stored: Object.freeze({ citation, source_digest, label, occurred_at }), ...(inventory ? {} : { text }) };
  }

  private async value(body: Record<string, unknown>, current: CurrentChannel, inventory: boolean, signal?: AbortSignal): Promise<PersonLiveEvidenceValueV1<Citation>> {
    if (this.handles.size >= MAX_ISSUED) slackContextFailureV1('quota_exceeded');
    const parsed = await this.parsed(body, current, inventory, signal);
    const key = canonicalSha256(parsed.stored.citation);
    const previous = this.issued.get(key);
    // Inventory citations hash empty released text. Never overwrite their original source commitment after an edit.
    if (previous !== undefined && (previous.source_digest !== parsed.stored.source_digest || previous.label !== parsed.stored.label)) slackContextFailureV1('stale_access_state');
    const handle = `slack_item_${randomUUID()}`;
    this.handles.set(handle, parsed.stored); this.issued.set(key, parsed.stored);
    return Object.freeze({ handle, citation: parsed.stored.citation, label: parsed.stored.label, visibility: 'team',
      occurred_at: parsed.stored.occurred_at, ...(parsed.text === undefined ? {} : { text: parsed.text }) });
  }

  private reserveMessageCapacity(maximum: number): void {
    // Reserve the worst-case page size before I/O, including concurrent calls and failed responses.
    if (this.scanned + maximum > SLACK_LIVE_EVIDENCE_MAX_SCANNED_MESSAGES_V1) slackContextFailureV1('quota_exceeded');
    this.scanned += maximum;
  }

  private async read(input: SlackContextRequestV1): Promise<Record<string, unknown>> {
    input.signal?.throwIfAborted();
    const assertBinding = () => { if (canonicalSha256(copySlackContextBindingV1(this.transport.binding)) !== canonicalSha256(this.binding)) slackContextFailureV1('stale_access_state'); };
    assertBinding();
    if (this.requests >= SLACK_LIVE_EVIDENCE_MAX_REQUESTS_V1) slackContextFailureV1('quota_exceeded');
    this.requests += 1;
    try {
      const value = await this.request(input);
      input.signal?.throwIfAborted(); assertBinding();
      return requireSlackContextResponseV1(value);
    } catch (error) {
      input.signal?.throwIfAborted();
      slackContextFailureV1(error instanceof AuthorityOperationError ? error.code : 'unavailable');
    }
  }
}

export function createSlackChannelLiveEvidenceReaderV1(options: SlackChannelLiveEvidenceReaderOptionsV1): SlackChannelLiveEvidenceReaderV1 {
  return new SlackChannelLiveEvidenceReaderV1(options);
}
