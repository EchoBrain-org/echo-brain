import { canonicalJson } from '@echo-brain/federation-protocol';
import type { AdapterOperationContext, MeetingDocument, MeetingSourceAdapter } from '@echo-brain/organization-processing/core';
import type { AdmittedMeetingSourceCursorPolicyV1 } from '@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-source-cursor-policy-v1';
import type { GranolaPersonConnectionV1 } from './granola-person-connection-v1.js';
import { GRANOLA_ID_V1, GRANOLA_PERSON_PROVIDER_V1, GRANOLA_TIMESTAMP_V1, granolaMcpMeetingContentV1, granolaMeetingUnreadableV1, granolaTranscriptPendingV1 } from './granola-mcp-v1.js';
import { granolaLegacyWatchRevisionV1, normalizeGranolaMeetingV1 } from './granola-meeting-normalizer-v1.js';

/** What a personal Granola source watches: nothing, the meetings its person captured, or one folder. */
type GranolaWatchModeV1 = 'off' | 'mine' | 'folder';
/** A watch as the Authority stores it; `folder_id` is set exactly for `folder`. */
export interface GranolaWatchV1 { readonly watch: GranolaWatchModeV1; readonly folder_id: string | null }
export interface GranolaCheckpointV1 {
  readonly mode: GranolaWatchModeV1; readonly folder: string | null; readonly baseline: boolean;
  /** When the watch last changed, as a UTC instant (null before any change): the first pass records only what is older. */
  readonly since: string | null;
  /**
   * Each meeting of the window by id: its `updated_at` as a UTC instant, or its content revision when Granola gives none
   * (UNREADABLE for an unresolved historical baseline).
   */
  readonly seen: Readonly<Record<string, string>>;
  readonly manual: readonly string[];
  readonly retry_after?: Readonly<Record<string, string>>;
}
const prefix = 'granola-watch-v1:';
/**
 * The days a watch lists on each pass. A window is needed: each pass lists the whole window, and its seen-set records
 * one mark per meeting in it, so an unbounded window would list and store a person's whole history every pass. It holds
 * any number of meetings; the cursor column has no length of its own.
 */
const WINDOW_DAYS = 30;
/** A queued import is one id per person's request; the queue keeps 50 at a time. */
const MAX_MANUAL = 50;
/** A meeting changed this recently may still be recording; a later pull takes it. */
const SETTLE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Unreadable meetings one pull passes over before it stops; the next pull goes on from there. */
const MAX_PASSED_OVER = 5;
const MARK = /^sha256:[a-f0-9]{64}$/;
/** An unreadable historical baseline has no known revision against which to prove an edit. */
const UNREADABLE = `sha256:${'0'.repeat(64)}`;
const RETRY_MS = 10 * 60_000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isInstant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** A Granola time as a UTC instant, so a changed time zone is no edit; undefined when it is missing or unreadable. */
function instant(value: string | undefined): string | undefined {
  const time = value !== undefined && GRANOLA_TIMESTAMP_V1.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
export function readGranolaCheckpointV1(cursor: string): GranolaCheckpointV1 {
  const fail: () => never = () => GRANOLA_PERSON_PROVIDER_V1.failure('invalid_request');
  if (!cursor.startsWith(prefix)) fail();
  let value: unknown;
  try { value = JSON.parse(cursor.slice(prefix.length)); } catch { fail(); }
  const row = GRANOLA_PERSON_PROVIDER_V1.record(value);
  if (!['baseline,folder,manual,mode,seen,since', 'baseline,folder,manual,mode,retry_after,seen,since'].includes(Object.keys(row).sort().join(',')) || !['off', 'mine', 'folder'].includes(row.mode as string) || typeof row.baseline !== 'boolean'
    || (row.mode === 'folder' ? typeof row.folder !== 'string' || !GRANOLA_ID_V1.test(row.folder) : row.folder !== null) || (row.mode === 'off' && row.baseline)
    || (row.since !== null && !isInstant(row.since))) fail();
  const manual = GRANOLA_PERSON_PROVIDER_V1.array(row.manual, MAX_MANUAL);
  if (manual.some(id => typeof id !== 'string' || !GRANOLA_ID_V1.test(id)) || new Set(manual).size !== manual.length) fail();
  const seen = Object.entries(GRANOLA_PERSON_PROVIDER_V1.record(row.seen));
  if (seen.some(([key, mark]) => !GRANOLA_ID_V1.test(key) || !(isInstant(mark) || (typeof mark === 'string' && MARK.test(mark))))
    || (!row.baseline && seen.length !== 0)) fail();
  if (row.retry_after !== undefined) {
    const retry = Object.entries(GRANOLA_PERSON_PROVIDER_V1.record(row.retry_after));
    if (retry.some(([key, time]) => !GRANOLA_ID_V1.test(key) || !isInstant(time))) fail();
  }
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
  watch: (checkpoint: GranolaCheckpointV1, watch: GranolaWatchV1, at: string): GranolaCheckpointV1 => ({ mode: watch.watch, folder: watch.folder_id, baseline: false, since: at, seen: {}, manual: checkpoint.manual }),
  forgetCancelled(checkpoint: GranolaCheckpointV1, cancelled: readonly string[]): GranolaCheckpointV1 {
    const { retry_after, ...rest } = checkpoint;
    const retry = Object.fromEntries(Object.entries(retry_after ?? {}).filter(([id]) => !cancelled.includes(id)));
    return { ...rest, ...(Object.keys(retry).length === 0 ? {} : { retry_after: retry }) };
  },
  acquisitionStatus(checkpoint: GranolaCheckpointV1): string | null {
    const waiting = Object.keys(checkpoint.retry_after ?? {}).length;
    if (waiting === 0) return null;
    return `Granola could not give ${waiting === 1 ? '1 meeting' : `${waiting} meetings`} yet. ECHO tries again within 10 minutes.`;
  },
  ready: (checkpoint: GranolaCheckpointV1): boolean => checkpoint.baseline,
});
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
/** The days a watch lists at `now`: the last 30, through tomorrow, so that today's meetings are in it in any time zone. */
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
  /** Called again by Authority inside the existing source-custody transaction. */
  requireCurrent(): void {
    this.requireMapping();
    if (this.fence === undefined) throw new Error('Granola observation has not been authorized');
    this.fence();
  }
  async pull(request: Parameters<MeetingSourceAdapter['pull']>[0], operation?: AdapterOperationContext): ReturnType<MeetingSourceAdapter['pull']> {
    this.requireMapping();
    const checkpoint = readGranolaCheckpointV1(request.cursor ?? granolaWatchInitialCursorV1(this.watch));
    if (checkpoint.mode !== this.watch.watch || checkpoint.folder !== this.watch.folder_id) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    const session = await this.open(operation?.signal);
    if (session.identity.adapter_id !== this.identity.adapter_id || session.identity.version !== this.identity.version ||
        (session.identity.instance_id !== this.identity.instance_id && !this.identity.instance_id.startsWith(session.identity.instance_id + '-'))) GRANOLA_PERSON_PROVIDER_V1.failure('stale_access_state');
    this.fence = session.current;
    const now = this.now();
    const { retry_after, ...previous } = checkpoint;
    const retry: Record<string, string> = { ...retry_after };
    let failed = 0;
    const readEligible = async (id: string, previousMark?: string) => {
      if (failed >= MAX_PASSED_OVER || Date.parse(retry[id] ?? '') > now) return undefined;
      const read = await this.attempt(session, id, operation, previousMark);
      if (read === undefined) {
        retry[id] = new Date(now + RETRY_MS).toISOString();
        failed++;
      } else delete retry[id];
      return read;
    };
    const finish = async (state: GranolaCheckpointV1, meeting?: MeetingDocument) => {
      await session.verify(); this.requireCurrent();
      return { meetings: meeting === undefined ? [] : [meeting], next_cursor: writeGranolaCheckpointV1({
        ...state, ...(Object.keys(retry).length === 0 ? {} : { retry_after: retry }),
      }) };
    };
    const priority = (id: string) => retry[id] === undefined ? 0 : Date.parse(retry[id]!);
    for (const id of [...checkpoint.manual].sort((a, b) => priority(a) - priority(b))) {
      if (checkpoint.mode !== 'off' && failed >= MAX_PASSED_OVER - 1) break;
      const meeting = await readEligible(id);
      if (meeting !== undefined) return finish({ ...previous, manual: checkpoint.manual.filter(other => other !== id) }, meeting.document);
    }
    if (checkpoint.mode === 'off') {
      for (const id of Object.keys(retry)) if (!checkpoint.manual.includes(id)) delete retry[id];
      return checkpoint.manual.length || retry_after ? finish(previous) : { meetings: [] };
    }
    // Granola lists newest first; the oldest goes first.
    const listed = [...await session.window({ mode: checkpoint.mode, folder: checkpoint.folder, ...granolaWatchWindowV1(now) })].reverse();
    this.requireCurrent();
    const eligible = new Set([...checkpoint.manual, ...listed.map(meeting => meeting.id)]);
    for (const id of Object.keys(retry)) if (!eligible.has(id)) delete retry[id];
    const seen: Record<string, string> = {};
    let selected: MeetingDocument | undefined;
    if (!checkpoint.baseline) {
      // The first pass after a watch change imports nothing (ADR-0030): it records what the window held when the watch
      // changed. A meeting changed since then stays unrecorded, so a later pass imports it once it settles.
      const since = checkpoint.since === null ? Number.POSITIVE_INFINITY : Date.parse(checkpoint.since);
      for (const meeting of listed) {
        const at = instant(meeting.updated_at);
        if (at === undefined) {
          const created = instant(meeting.created_at);
          if (created !== undefined && Date.parse(created) >= since) continue;
          const read = await readEligible(meeting.id);
          seen[meeting.id] = read?.document.provenance.canonical_revision ?? UNREADABLE;
        }
        else if (Date.parse(at) < since) seen[meeting.id] = at;
      }
    } else {
      // A meeting that left the window, or the folder, is forgotten; one that comes back is new again.
      for (const meeting of listed) { const mark = checkpoint.seen[meeting.id]; if (mark !== undefined) seen[meeting.id] = mark; }

      for (const meeting of listed.sort((a, b) => priority(a.id) - priority(b.id))) {
        if (failed >= MAX_PASSED_OVER) break;
        if (checkpoint.manual.includes(meeting.id)) continue;
        const at = instant(meeting.updated_at);
        if (at !== undefined && (seen[meeting.id] === at || Date.parse(at) > now - SETTLE_MS)) continue;
        // Without a readable updated_at, only the content tells an edit apart; such a meeting counts as settled.
        const read = await readEligible(meeting.id, seen[meeting.id]);
        if (read === undefined) continue;
        const mark = at ?? read.document.provenance.canonical_revision;
        const previousMark = seen[meeting.id];
        seen[meeting.id] = mark;
        // An unreadable historical baseline becomes known without acquiring that history.
        // A provider timestamp proving a later edit still qualifies for intake.
        if (read.unchanged || previousMark === read.document.provenance.canonical_revision || previousMark === mark || (previousMark === UNREADABLE &&
          (at === undefined || checkpoint.since === null || at < checkpoint.since))) continue;
        selected = read.document; break;
      }
    }
    return finish({ ...previous, baseline: true, seen }, selected);
  }
  /** Only a meeting-specific acquisition failure can be deferred. Revocation and service outages fail the pull. */
  private async attempt(session: GranolaWatchReadSessionV1, id: string, operation?: AdapterOperationContext, previousMark?: string) {
    try {
      this.requireCurrent(); operation?.signal.throwIfAborted();
      const detail = await session.api.meeting(id, operation?.signal);
      const transcript = await session.api.transcript(id, operation?.signal);
      const input = granolaMcpMeetingContentV1(detail, transcript);
      const document = normalizeGranolaMeetingV1(input, this.identity, new Date(this.now()).toISOString());
      // Older cursors compare the old projection once. Upgrading the mapper cannot count as an edit by the person.
      const unchanged = previousMark !== undefined && previousMark !== document.provenance.canonical_revision && previousMark !== UNREADABLE &&
        MARK.test(previousMark) && previousMark === granolaLegacyWatchRevisionV1(input);
      return { document, unchanged };
    } catch (error) {
      if (granolaTranscriptPendingV1(error) || granolaMeetingUnreadableV1(error)) return undefined;
      throw error;
    }
  }
}
