import { canonicalJson } from '@echo-brain/federation-protocol';
import type { AdapterConfig, AdapterOperationContext, MeetingDocument, MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import type { GranolaPersonConnectionV1 } from './granola-person-connection-v1.js';
import { GRANOLA_ID_V1, GRANOLA_PERSON_PROVIDER_V1, GRANOLA_TIMESTAMP_V1, granolaMcpMeetingContentV1, type GranolaMeetingV1 } from './granola-mcp-v1.js';
import { normalizeGranolaMeetingV1 } from './granola-meeting-normalizer-v1.js';

/** What a personal Granola source watches: nothing, the meetings its person captured, or one folder. */
export type GranolaWatchModeV1 = 'off' | 'mine' | 'folder';
/** A watch as the Authority stores it; `folder_id` is set exactly for `folder`. */
export interface GranolaWatchV1 { readonly watch: GranolaWatchModeV1; readonly folder_id: string | null }
export interface GranolaCheckpointV1 {
  readonly mode: GranolaWatchModeV1; readonly folder: string | null; readonly baseline: boolean;
  /** Each meeting of the window by id: its `updated_at`, or its content revision when Granola gives none. */
  readonly seen: Readonly<Record<string, string>>;
  readonly manual: readonly string[];
}
const prefix = 'granola-watch-v1:';
/** The Authority's cursor column holds 65,536 characters; a full window and queue use far less. */
const MAX_CURSOR_BYTES = 65_536;
const MAX_SEEN = 200;
const WINDOW_DAYS = 7;
/** A meeting changed this recently may still be recording; a later pull takes it. */
const SETTLE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const MARK = /^sha256:[a-f0-9]{64}$/;
export function readGranolaCheckpointV1(cursor: string): GranolaCheckpointV1 {
  const fail: () => never = () => GRANOLA_PERSON_PROVIDER_V1.failure('invalid_request');
  if (!cursor.startsWith(prefix) || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) fail();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(prefix.length)); } catch { fail(); }
  const row = GRANOLA_PERSON_PROVIDER_V1.record(value);
  if (Object.keys(row).sort().join(',') !== 'baseline,folder,manual,mode,seen' || !['off', 'mine', 'folder'].includes(row.mode as string) || typeof row.baseline !== 'boolean'
    || (row.mode === 'folder' ? typeof row.folder !== 'string' || !GRANOLA_ID_V1.test(row.folder) : row.folder !== null) || (row.mode === 'off' && row.baseline)) fail();
  const manual = GRANOLA_PERSON_PROVIDER_V1.array(row.manual, 50);
  if (manual.some(id => typeof id !== 'string' || !GRANOLA_ID_V1.test(id)) || new Set(manual).size !== manual.length) fail();
  const seen = Object.entries(GRANOLA_PERSON_PROVIDER_V1.record(row.seen));
  if (seen.length > MAX_SEEN || seen.some(([key, mark]) => !GRANOLA_ID_V1.test(key) || typeof mark !== 'string' || mark.length > 71
    || !(GRANOLA_TIMESTAMP_V1.test(mark) || MARK.test(mark))) || (!row.baseline && seen.length !== 0)) fail();
  return row as unknown as GranolaCheckpointV1;
}
export function writeGranolaCheckpointV1(checkpoint: GranolaCheckpointV1): string { const cursor = prefix + canonicalJson(checkpoint); readGranolaCheckpointV1(cursor); return cursor; }
export function granolaWatchInitialCursorV1(watch: GranolaWatchV1 = { watch: 'off', folder_id: null }): string {
  return writeGranolaCheckpointV1({ mode: watch.watch, folder: watch.folder_id, baseline: false, seen: {}, manual: [] });
}
/** The personal intake's codec: a changed watch restarts change detection, and the first pass after it marks automatic import active. */
export const GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1 = Object.freeze({
  read: readGranolaCheckpointV1, write: writeGranolaCheckpointV1, initial: () => granolaWatchInitialCursorV1(),
  watch: (checkpoint: GranolaCheckpointV1, watch: GranolaWatchV1): GranolaCheckpointV1 => ({ ...checkpoint, mode: watch.watch, folder: watch.folder_id, baseline: false, seen: {} }),
  ready: (checkpoint: GranolaCheckpointV1): boolean => checkpoint.baseline,
});
export const GRANOLA_WATCH_CURSOR_POLICY_V1: AdmittedMeetingSourceCursorPolicyV1 = Object.freeze({
  source_adapter_id: 'granola-person-mcp', assert_live_cursor(cursor: string) { readGranolaCheckpointV1(cursor); },
});
type FullSession = Awaited<ReturnType<GranolaPersonConnectionV1['open']>>;
export interface GranolaWatchReadSessionV1 {
  readonly identity: MeetingSourceAdapter['identity'];
  readonly api: Pick<FullSession['api'], 'meeting' | 'transcript'>;
  current(): void;
  verify(): Promise<unknown>;
  window: FullSession['window'];
}
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * One meeting per shared processing cycle: a queued import first, else the oldest new or changed meeting of the watch's
 * rolling window that has settled. The durable checkpoint contains no meeting text.
 */
export class GranolaWatchSourceV1 implements MeetingSourceAdapter {
  private fence: (() => void) | undefined;
  constructor(readonly identity: MeetingSourceAdapter['identity'], private readonly watch: GranolaWatchV1,
    private readonly open: (signal?: AbortSignal) => Promise<GranolaWatchReadSessionV1>, private readonly requireMapping: () => void,
    /** The clock that dates the window and settles meetings. */
    private readonly now: () => number = Date.now) {
    granolaWatchInitialCursorV1(watch);
  }
  validateConfig(config: AdapterConfig) {
    const ok = config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id;
    return { ok, errors: ok ? [] : ['Granola source identity differs'] };
  }
  async healthCheck(context?: AdapterOperationContext) {
    const checked_at = new Date().toISOString();
    try { this.requireMapping(); await this.open(context?.signal); return { status: 'healthy' as const, checked_at }; }
    catch { return { status: 'unavailable' as const, checked_at, message: 'Granola connection needs attention' }; }
  }
  /** Called again by Authority inside the existing source-custody transaction. */
  requireCurrent(): void {
    this.requireMapping();
    if (this.fence === undefined) throw new Error('Granola observation has not been authorized');
    this.fence();
  }
  async pull(request: Parameters<MeetingSourceAdapter['pull']>[0], operation?: AdapterOperationContext) {
    this.requireMapping();
    const checkpoint = readGranolaCheckpointV1(request.cursor ?? granolaWatchInitialCursorV1(this.watch));
    if (checkpoint.mode !== this.watch.watch || checkpoint.folder !== this.watch.folder_id) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    const session = await this.open(operation?.signal);
    if (session.identity.adapter_id !== this.identity.adapter_id || session.identity.version !== this.identity.version ||
        (session.identity.instance_id !== this.identity.instance_id && !this.identity.instance_id.startsWith(session.identity.instance_id + '-'))) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    this.fence = session.current;
    const manual = checkpoint.manual[0];
    if (manual !== undefined) {
      const meeting = await this.read(session, manual, operation);
      await session.verify(); this.requireCurrent();
      return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...checkpoint, manual: checkpoint.manual.slice(1) }) };
    }
    if (checkpoint.mode === 'off') return { meetings: [] };
    const now = this.now();
    // The window ends tomorrow, so today's meetings are in it in any time zone. Granola lists newest first; the oldest goes first.
    const listed = [...await session.window({ mode: checkpoint.mode, folder: checkpoint.folder, from_date: day(now - WINDOW_DAYS * DAY_MS), to_date: day(now + DAY_MS) })].reverse();
    this.requireCurrent();
    const seen: Record<string, string> = {};
    let selected: MeetingDocument | undefined;
    if (!checkpoint.baseline) {
      // The first pass after a watch change imports nothing (ADR-0030): it records what the window already holds.
      for (const meeting of listed) seen[meeting.id] = meeting.updated_at ?? (await this.read(session, meeting.id, operation)).provenance.canonical_revision;
    } else {
      // A meeting that left the window, or the folder, is forgotten; one that comes back is new again.
      for (const meeting of listed) { const mark = checkpoint.seen[meeting.id]; if (mark !== undefined) seen[meeting.id] = mark; }
      for (const meeting of listed) {
        if (meeting.updated_at !== undefined) {
          if (seen[meeting.id] === meeting.updated_at || this.unsettled(meeting, now)) continue;
          selected = await this.read(session, meeting.id, operation); seen[meeting.id] = meeting.updated_at; break;
        }
        // Without updated_at, only the content tells an edit apart; such a meeting counts as settled.
        const read = await this.read(session, meeting.id, operation);
        if (seen[meeting.id] === read.provenance.canonical_revision) continue;
        selected = read; seen[meeting.id] = read.provenance.canonical_revision; break;
      }
    }
    await session.verify(); this.requireCurrent();
    return { meetings: selected === undefined ? [] : [selected],
      next_cursor: writeGranolaCheckpointV1({ mode: checkpoint.mode, folder: checkpoint.folder, baseline: true, seen, manual: [] }) };
  }
  private unsettled(meeting: GranolaMeetingV1, now: number): boolean { return Date.parse(meeting.updated_at!) > now - SETTLE_MS; }
  private async read(session: GranolaWatchReadSessionV1, meetingId: string, operation?: AdapterOperationContext): Promise<MeetingDocument> {
    this.requireCurrent(); operation?.signal.throwIfAborted();
    const detail = await session.api.meeting(meetingId, operation?.signal);
    const transcript = await session.api.transcript(meetingId, operation?.signal);
    return normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(detail, transcript), this.identity, new Date(this.now()).toISOString());
  }
}
