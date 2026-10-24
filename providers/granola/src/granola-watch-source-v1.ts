import { canonicalJson } from '@echo-brain/federation-protocol';
import type { AdapterConfig, AdapterOperationContext, MeetingDocument, MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import type { GranolaPersonConnectionV1 } from './granola-person-connection-v1.js';
import { GRANOLA_ID_V1, GRANOLA_PERSON_PROVIDER_V1, GRANOLA_TIMESTAMP_V1, granolaMcpMeetingContentV1, granolaMeetingUnreadableV1 } from './granola-mcp-v1.js';
import { normalizeGranolaMeetingV1 } from './granola-meeting-normalizer-v1.js';

/** What a personal Granola source watches: nothing, the meetings its person captured, or one folder. */
export type GranolaWatchModeV1 = 'off' | 'mine' | 'folder';
/** A watch as the Authority stores it; `folder_id` is set exactly for `folder`. */
export interface GranolaWatchV1 { readonly watch: GranolaWatchModeV1; readonly folder_id: string | null }
export interface GranolaCheckpointV1 {
  readonly mode: GranolaWatchModeV1; readonly folder: string | null; readonly baseline: boolean;
  /** When the watch last changed, as a UTC instant (null before any change): the first pass records only what is older. */
  readonly since: string | null;
  /**
   * Each meeting of the window by id: its `updated_at` as a UTC instant, or its content revision when Granola gives none
   * (UNREADABLE while that content cannot be read).
   */
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
/** Unreadable meetings one pull passes over before it stops; the next pull goes on from there. */
const MAX_PASSED_OVER = 5;
const MARK = /^sha256:[a-f0-9]{64}$/;
/** The mark of a meeting without `updated_at` whose content cannot be read: never a real revision, so a readable one imports. */
const UNREADABLE = `sha256:${'0'.repeat(64)}`;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isInstant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** A Granola time as a UTC instant, so a changed time zone is no edit; undefined when it is missing or unreadable. */
function instant(value: string | undefined): string | undefined {
  const time = value !== undefined && GRANOLA_TIMESTAMP_V1.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
export function readGranolaCheckpointV1(cursor: string): GranolaCheckpointV1 {
  const fail: () => never = () => GRANOLA_PERSON_PROVIDER_V1.failure('invalid_request');
  if (!cursor.startsWith(prefix) || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) fail();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(prefix.length)); } catch { fail(); }
  const row = GRANOLA_PERSON_PROVIDER_V1.record(value);
  if (Object.keys(row).sort().join(',') !== 'baseline,folder,manual,mode,seen,since' || !['off', 'mine', 'folder'].includes(row.mode as string) || typeof row.baseline !== 'boolean'
    || (row.mode === 'folder' ? typeof row.folder !== 'string' || !GRANOLA_ID_V1.test(row.folder) : row.folder !== null) || (row.mode === 'off' && row.baseline)
    || (row.since !== null && !isInstant(row.since))) fail();
  const manual = GRANOLA_PERSON_PROVIDER_V1.array(row.manual, 50);
  if (manual.some(id => typeof id !== 'string' || !GRANOLA_ID_V1.test(id)) || new Set(manual).size !== manual.length) fail();
  const seen = Object.entries(GRANOLA_PERSON_PROVIDER_V1.record(row.seen));
  if (seen.length > MAX_SEEN || seen.some(([key, mark]) => !GRANOLA_ID_V1.test(key) || !(isInstant(mark) || (typeof mark === 'string' && MARK.test(mark))))
    || (!row.baseline && seen.length !== 0)) fail();
  return row as unknown as GranolaCheckpointV1;
}
export function writeGranolaCheckpointV1(checkpoint: GranolaCheckpointV1): string { const cursor = prefix + canonicalJson(checkpoint); readGranolaCheckpointV1(cursor); return cursor; }
export function granolaWatchInitialCursorV1(watch: GranolaWatchV1 = { watch: 'off', folder_id: null }): string {
  return writeGranolaCheckpointV1({ mode: watch.watch, folder: watch.folder_id, baseline: false, since: null, seen: {}, manual: [] });
}
/**
 * The personal intake's codec: a changed watch restarts change detection from the time it changed, and the first pass
 * after it marks automatic import active.
 */
export const GRANOLA_PERSONAL_CHECKPOINT_CODEC_V1 = Object.freeze({
  read: readGranolaCheckpointV1, write: writeGranolaCheckpointV1, initial: () => granolaWatchInitialCursorV1(),
  watch: (checkpoint: GranolaCheckpointV1, watch: GranolaWatchV1, at: string): GranolaCheckpointV1 => ({ ...checkpoint, mode: watch.watch, folder: watch.folder_id, baseline: false, since: at, seen: {} }),
  ready: (checkpoint: GranolaCheckpointV1): boolean => checkpoint.baseline,
});
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
/** The days a watch lists at `now`: the last 7, through tomorrow, so that today's meetings are in it in any time zone. */
export function granolaWatchWindowV1(now: number): { readonly from_date: string; readonly to_date: string } {
  return { from_date: day(now - WINDOW_DAYS * DAY_MS), to_date: day(now + DAY_MS) };
}
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

/**
 * One meeting per shared processing cycle: a queued import first, else the oldest new or changed meeting of the watch's
 * rolling window that has settled. A meeting Granola cannot give in a readable form is passed over, so it never holds up
 * the ones after it. The durable checkpoint contains no meeting text.
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
      // A queued import is never passed over: a failed read is not deletion evidence (ADR-0030), and its person can cancel it.
      const meeting = await this.read(session, manual, operation);
      await session.verify(); this.requireCurrent();
      return { meetings: [meeting], next_cursor: writeGranolaCheckpointV1({ ...checkpoint, manual: checkpoint.manual.slice(1) }) };
    }
    if (checkpoint.mode === 'off') return { meetings: [] };
    const now = this.now();
    // Granola lists newest first; the oldest goes first.
    const listed = [...await session.window({ mode: checkpoint.mode, folder: checkpoint.folder, ...granolaWatchWindowV1(now) })].reverse();
    this.requireCurrent();
    const seen: Record<string, string> = {};
    let selected: MeetingDocument | undefined;
    if (!checkpoint.baseline) {
      // The first pass after a watch change imports nothing (ADR-0030): it records what the window held when the watch
      // changed. A meeting changed since then stays unrecorded, so a later pass imports it once it settles.
      const since = checkpoint.since === null ? Number.POSITIVE_INFINITY : Date.parse(checkpoint.since);
      for (const meeting of listed) {
        const at = instant(meeting.updated_at);
        if (at === undefined) seen[meeting.id] = (await this.attempt(session, meeting.id, operation))?.provenance.canonical_revision ?? UNREADABLE;
        else if (Date.parse(at) < since) seen[meeting.id] = at;
      }
    } else {
      // A meeting that left the window, or the folder, is forgotten; one that comes back is new again.
      for (const meeting of listed) { const mark = checkpoint.seen[meeting.id]; if (mark !== undefined) seen[meeting.id] = mark; }
      let passedOver = 0;
      for (const meeting of listed) {
        if (passedOver === MAX_PASSED_OVER) break;
        const at = instant(meeting.updated_at);
        if (at !== undefined && (seen[meeting.id] === at || Date.parse(at) > now - SETTLE_MS)) continue;
        // Without a readable updated_at, only the content tells an edit apart; such a meeting counts as settled.
        const read = await this.attempt(session, meeting.id, operation);
        const mark = at ?? read?.provenance.canonical_revision ?? UNREADABLE;
        if (seen[meeting.id] === mark) continue;
        // An unreadable meeting is recorded too: at its listed updated_at, so only a later edit tries it again; without
        // one, as UNREADABLE, which a later pass replaces once its content reads.
        seen[meeting.id] = mark;
        if (read === undefined) { passedOver++; continue; }
        selected = read; break;
      }
    }
    await session.verify(); this.requireCurrent();
    return { meetings: selected === undefined ? [] : [selected],
      next_cursor: writeGranolaCheckpointV1({ mode: checkpoint.mode, folder: checkpoint.folder, baseline: true, since: checkpoint.since, seen, manual: [] }) };
  }
  /** The meeting, or undefined when Granola's answer for it can never be read (an outage or changed access still fails the pull). */
  private async attempt(session: GranolaWatchReadSessionV1, meetingId: string, operation?: AdapterOperationContext): Promise<MeetingDocument | undefined> {
    try { return await this.read(session, meetingId, operation); }
    catch (error) { if (granolaMeetingUnreadableV1(error)) return undefined; throw error; }
  }
  private async read(session: GranolaWatchReadSessionV1, meetingId: string, operation?: AdapterOperationContext): Promise<MeetingDocument> {
    this.requireCurrent(); operation?.signal.throwIfAborted();
    const detail = await session.api.meeting(meetingId, operation?.signal);
    const transcript = await session.api.transcript(meetingId, operation?.signal);
    return normalizeGranolaMeetingV1(granolaMcpMeetingContentV1(detail, transcript), this.identity, new Date(this.now()).toISOString());
  }
}
