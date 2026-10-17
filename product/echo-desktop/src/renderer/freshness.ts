import type { PersonChangesAreaV1, PersonChangesV1 } from '@echo-brain/organization-api';
// The desktop's one refresh rule (desktop refresh and notifications v1;
// ADR-0036). One loop asks the Authority what moved in this person's own view
// (the change check: a fingerprint per area, never content) and reacts to
// each area that moved: projects read every project you belong to again
// (which also feeds the sidebar), follow-ups read the follow-ups you are
// involved in again (rows only), and what shows that an area feeds is owed a
// quiet read. Coming back to ECHO, a page opened and the machine waking each
// run a check; between them the server sets the pace. A change someone
// else made to a follow-up you are involved in, and being added to a project,
// come as one system notification per check. The store keeps its loaders;
// this module only says when they run.
import type { Expect, Failure, Notice, NoticeTarget, OpenItemView, ProjectSummary } from '../shared/protocol.js';
import { ACCOUNT_GONE, CHANGE_AREAS, NOTICE_ITEMS_MAX, NOTICE_TEXT_MAX, sameExpect } from '../shared/protocol.js';
import { rpc } from './api.js';
import { clip } from './format.js';
import { firstName, followUpCount, itemTitle } from './needs.js';

/** The areas whose move re-reads what a page shows; projects re-read the sidebar. */
export type ScreenArea = Exclude<PersonChangesAreaV1, 'projects'>;

/** After a failed check the wait doubles, up to five minutes. */
const BACKOFF_MAX_MS = 5 * 60_000;
/** An Authority without the change check: its follow-ups are scanned every five minutes instead (R8). */
const FALLBACK_MS = 5 * 60_000;
/** Opening pages asks at most once in this long (R2). */
const NAVIGATION_MS = 10_000;
/** The follow-ups that left your open ones that one check reads by their ids, side by side. */
const LEFT_READS_MAX = 20;
/** Notifications this account may still click: main keeps twenty on screen. */
const TOLD_KEPT = 20;
/** Reads of an item that say you can no longer see it. */
export const NO_LONGER_SEEN: readonly string[] = ['not_found', 'forbidden'];
/**
 * How far back the closed follow-ups read asks when no read ever saw a change: from the start, on the Authority's clock,
 * never this computer's. Nothing involving you was ever open, so there is little to read.
 */
const SINCE_EVER = '1970-01-01T00:00:00.000Z';
const CLOSED = ['done', 'not_relevant'] as const;

/** What the store gives this module: who is signed in, its reads, and its quiet re-reads of what shows. */
export interface Surfaces {
  account(): Expect | null;
  /** The window can be seen: on screen, and not covered by another app. */
  seen(): boolean;
  /** The account read again. */
  status(): Promise<void>;
  /**
   * Every page of your active and archived projects, side by side, feeding the sidebar as many pages as it shows (`first`:
   * it shows none yet, and says so while it reads); null when a page could not be read.
   */
  readProjects(first: boolean): Promise<ReadonlyMap<string, ProjectSummary> | null>;
  /** The sidebar's own quiet read of the pages it shows: on a return without a change check to say whether projects moved. */
  refreshSidebar(): Promise<void>;
  /** Every page of your follow-ups in some states (changed since a time), rows only; null when a page could not be read. */
  readRows(account: Expect, query: { states: readonly OpenItemView['state'][]; changed_since?: string }): Promise<OpenItemView[] | null>;
  /** One follow-up by its id, rows only. */
  readItem(account: Expect, itemId: string): Promise<{ item: OpenItemView } | { failure: Failure }>;
  /**
   * What shows of moved areas (R3), and on a return everything that shows (`back`, R4), owed a quiet read each: the store
   * reads each once it can be seen and nothing of its own is on its way (R6).
   */
  owe(what: { readonly back: boolean; readonly areas: readonly ScreenArea[] }): void;
  /** The follow-up whose page shows, if one does. */
  itemShown(): string | null;
  accountLost(failure: Failure): void;
}

/** Why a check ran. */
type Trigger = 'start' | 'timer' | 'came-back' | 'navigation' | 'wake';
/**
 * How a check went: read and acted on, failed, or there is no change check here (`older`, R8); and, read, the screen areas
 * that moved.
 */
interface Checked { outcome: 'ok' | 'failed' | 'older'; moved: readonly ScreenArea[] }

/** One account's loop, from sign-in (or start) to sign-out or a switch. */
interface Loop {
  readonly account: Expect;
  /**
   * The Authority answered `not_supported`: it has no change check, nor `involved` or `changed_since`, which ship with it.
   * Until the next start, follow-ups are scanned (what you sent or own), and the Yours list reads what you sent or own.
   */
  older: boolean;
  /** Each area's fingerprint as last acted on. An area not here is not learned yet: the next check reacts to it, learning. */
  areas: Partial<Record<PersonChangesAreaV1, string>>;
  /** The read of every project you belong to made at sign-in, for the first check to learn from. */
  projects: Promise<ReadonlyMap<string, ProjectSummary> | null> | null;
  /** Every project you belong to, active and archived, as the last full read had them: null until one learns them. */
  memberships: ReadonlyMap<string, ProjectSummary> | null;
  /** The open follow-ups you are involved in, as last read: null until a read learns them. */
  followed: Map<string, OpenItemView> | null;
  /**
   * Follow-ups that left your open ones whose read by id failed, or waited past the twenty a check reads, as last seen: read
   * at the next check.
   */
  pending: Map<string, OpenItemView>;
  /** The newest change the follow-ups reads have seen, on the Authority's clock; null until one was seen. */
  seenUpTo: string | null;
  /** The follow-ups seen whose newest change is exactly `seenUpTo`, by item and time: the inclusive boundary tells none twice. */
  boundary: Set<string>;
  /** What this account was notified of: keys a click may open, and the rows and projects those notifications were about. */
  told: { keys: string[]; rows: Map<string, OpenItemView>; projects: Map<string, ProjectSummary> };
  /** Projects made on this desktop: being in one you made is never news. */
  created: Set<string>;
  /** Milliseconds between checks, as the server last said (the host checked 15 s to an hour). */
  pace: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<Checked> | null;
  /** A wake during a check needs one fresh read after that pre-wake check finishes. */
  wakePending: boolean;
  /** When the last check began. */
  began: number;
}

let surfaces!: Surfaces;
let loop: Loop | null = null;
/** `changes unsupported` is logged once a run of the app. */
let unsupportedLogged = false;

export function configure(given: Surfaces): void { surfaces = given; }

/** An rpc answered, never thrown: a call that could not be made fails as `failed`. */
async function ask<T>(call: () => Promise<{ ok: true; value: unknown } | { ok: false; failure: Failure }>)
  : Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> {
  try {
    return await call() as { ok: true; value: T } | { ok: false; failure: Failure };
  } catch {
    return { ok: false, failure: { code: 'failed', retryable: true } };
  }
}

/** The latest of some times on the Authority's clock, compared as instants; null for none. */
function latest(...times: readonly (string | null | undefined)[]): string | null {
  let newest: string | null = null;
  for (const at of times) if (at != null && (newest === null || Date.parse(at) > Date.parse(newest))) newest = at;
  return newest;
}

// ---- the loop ---------------------------------------------------------------------

/**
 * Signed in, or switched to another account: a new loop. Every project you belong to is read at once (it also fills the
 * sidebar), and the first check learns where things are, never notifying (R2, N4).
 */
export function start(account: Expect): void {
  stop();
  loop = { account, older: false, areas: {}, projects: surfaces.readProjects(true), memberships: null, followed: null, pending: new Map(),
    seenUpTo: null, boundary: new Set(), told: { keys: [], rows: new Map(), projects: new Map() }, created: new Set(), pace: 60_000, failures: 0,
    timer: null, running: null, wakePending: false, began: Number.NEGATIVE_INFINITY };
  void check('start');
}

/** Signed out, or the account forgotten: no more checks, and what they learned goes. */
export function stop(): void {
  if (loop?.timer) clearTimeout(loop.timer);
  loop = null;
}

/** This account's Authority has no change check, nor `involved` or `changed_since` (R8): lists read what you sent or own. */
export function olderAuthority(): boolean { return loop?.older === true; }

/**
 * A check: the change check's fingerprints, and a reaction to each area that moved or is not learned yet. One runs at a
 * time; another trigger meanwhile joins it, except a wake also queues one fresh check. Its moved screen areas are read
 * again (but a return reads them with the page).
 * On an older Authority (R8), only the timer and a wake scan your follow-ups.
 */
function check(trigger: Trigger): Promise<Checked | null> {
  const run = loop;
  if (!run) return Promise.resolve(null);
  if (run.running) {
    if (trigger === 'wake') run.wakePending = true;
    return run.running;
  }
  if (run.older && trigger !== 'timer' && trigger !== 'wake') return Promise.resolve({ outcome: 'older', moved: [] });
  const running = once(run).then(checked => {
    if (trigger !== 'came-back' && loop === run && checked.moved.length > 0) surfaces.owe({ back: false, areas: checked.moved });
    return checked;
  }).finally(() => {
    run.running = null;
    if (loop === run) {
      if (run.wakePending) { run.wakePending = false; void check('wake'); }
      else schedule(run);
    }
  });
  run.running = running;
  return running;
}

/**
 * The next check: at the server's pace; after failures later, doubling up to five minutes, but never sooner than the pace
 * the server last set; every five minutes on an older Authority.
 */
function schedule(run: Loop): void {
  if (run.timer) clearTimeout(run.timer);
  const delay = run.older ? FALLBACK_MS : run.failures === 0 ? run.pace : Math.max(run.pace, Math.min(BACKOFF_MAX_MS, run.pace * 2 ** run.failures));
  run.timer = setTimeout(() => { run.timer = null; if (loop === run) void check('timer'); }, delay);
}

async function once(run: Loop): Promise<Checked> {
  run.began = Date.now();
  if (run.timer) { clearTimeout(run.timer); run.timer = null; }
  if (run.older) { await scan(run); return { outcome: 'older', moved: [] }; }
  const result = await ask<PersonChangesV1>(() => rpc('changes.read', { expect: run.account }));
  if (loop !== run) return { outcome: 'failed', moved: [] };
  if (!result.ok) {
    if (result.failure.code === 'not_supported') {
      run.older = true;
      if (!unsupportedLogged) { unsupportedLogged = true; void ask(() => rpc('log.changes', { unsupported: true })); }
      await scan(run);
      return { outcome: 'older', moved: [] };
    }
    if (ACCOUNT_GONE.includes(result.failure.code)) surfaces.accountLost(result.failure);
    run.failures += 1;
    return { outcome: 'failed', moved: [] };
  }
  run.failures = 0;
  run.pace = result.value.check_again_after_seconds * 1000;
  const fresh = result.value.areas;
  const known = run.areas;
  // Moved since an area was learned, or not learned yet (the first check, or one whose reaction did not finish).
  const moved = CHANGE_AREAS.filter(area => fresh[area] !== known[area]);
  const news = moved.filter(area => known[area] !== undefined);
  if (news.length > 0) void ask(() => rpc('log.changes', { moved: news }));
  const [adds, events] = await Promise.all([
    moved.includes('projects') ? projectsMoved(run) : Promise.resolve([]),
    // A follow-up whose read by id failed is read again at the next check, moved or not.
    moved.includes('follow_ups') || run.pending.size > 0 ? followUpsMoved(run) : Promise.resolve([]),
  ]);
  if (loop !== run) return { outcome: 'failed', moved: [] };
  // An area is learned once its reaction finished; until then it stays moved, and the next check reacts to it again.
  if (adds !== null) run.areas.projects = fresh.projects;
  if (events !== null) run.areas.follow_ups = fresh.follow_ups;
  run.areas.reviews = fresh.reviews;
  tell(run, events ?? [], adds ?? []);
  return { outcome: 'ok', moved: news.filter((area): area is ScreenArea => area !== 'projects') };
}

/** An older Authority's scan, every five minutes and on a wake: what you sent or own, read rows only, and one notification. */
async function scan(run: Loop): Promise<void> {
  const events = await followUpsMoved(run);
  if (loop === run && events) tell(run, events, []);
}

// ---- triggers ---------------------------------------------------------------------

/**
 * ECHO came back: the window on screen and in front again, on either platform
 * (from another app, the tray, minimized, or covered by other windows). The
 * account is read again and a check runs side by side; then the page on screen
 * is read again quietly, with what the check found moved, once. Without a
 * change check to say whether projects moved, the sidebar is read again too
 * (R4, R8).
 */
export async function cameBack(): Promise<void> {
  const [, checked] = await Promise.all([surfaces.status(), check('came-back')]);
  const sidebar = loop !== null && checked?.outcome !== 'ok' ? surfaces.refreshSidebar() : null;
  surfaces.owe({ back: true, areas: checked?.moved ?? [] });
  await sidebar;
}

/** The machine woke: a check, whose baseline from before the sleep carries on, so what changed meanwhile notifies (N4). */
export function woke(): void { void check('wake'); }

/** A page was opened: a check, at most once in ten seconds (R2, R5). */
export function navigated(): void {
  const run = loop;
  if (!run || run.older || run.running || Date.now() - run.began < NAVIGATION_MS) return;
  void check('navigation');
}

/** A project made on this desktop: never news (N2). */
export function createdHere(projectId: string): void { loop?.created.add(projectId); }

// ---- projects ------------------------------------------------------------------------

/**
 * The projects you were added to: those in the full read (`now`) that were not
 * among every project you belonged to at the last one (`known`), however far
 * past the sidebar's pages they sort; archived ones included, so archiving or
 * restoring one never reads as an add. Not one made on this desktop, nor one
 * you lead that was made after the newest project of the last full read, on
 * the Authority's own clock: yours, made elsewhere. With nothing to measure
 * against (you had no projects), one you lead is told.
 */
function projectAdds(known: ReadonlyMap<string, ProjectSummary>, now: ReadonlyMap<string, ProjectSummary>, made: ReadonlySet<string>): ProjectSummary[] {
  const since = latest(...[...known.values()].map(project => project.created_at));
  return [...now.values()].filter(project => !known.has(project.project_id) && !made.has(project.project_id)
    && !(project.role === 'lead' && since !== null && Date.parse(project.created_at) > Date.parse(since)));
}

/**
 * Projects moved (or are not learned yet): every project you belong to is read
 * in full, which also feeds the sidebar, to tell the ones you were added to;
 * the first time from the read made at sign-in, learning. Null when that read
 * did not finish: it tells nothing and keeps what the last one learned, so the
 * next check reads again and tells them.
 */
async function projectsMoved(run: Loop): Promise<ProjectSummary[] | null> {
  const first = run.projects;
  run.projects = null;
  const read = await (first ?? surfaces.readProjects(false));
  if (loop !== run || read === null) return null;
  const known = run.memberships;
  run.memberships = read;
  return known === null ? [] : projectAdds(known, read, run.created);
}

/** A project a notification was about, as the full read had it: it opens even when the sidebar has not loaded its row. */
export function toldProject(projectId: string): ProjectSummary | null {
  return loop?.told.projects.get(projectId) ?? null;
}

// ---- follow-ups -------------------------------------------------------------------

type Person = OpenItemView['approver'];

/** What someone else did to a follow-up you are involved in (N2). */
type FollowUpEvent =
  | { readonly kind: 'handed_you' | 'done' | 'not_relevant' | 'reopened'; readonly item: OpenItemView; readonly by: Person }
  | { readonly kind: 'handed_on'; readonly item: OpenItemView; readonly by: Person; readonly to: Person };

/**
 * A row's newest change since `before` (any, with no earlier row): its owner
 * set, or its state set, and who did it. A Send that picks the owner sets both
 * at once: the Send is what happened.
 */
function newestChange(row: OpenItemView, before: OpenItemView | null): { what: 'owner' | 'state'; at: string; by: Person } | null {
  const owner = row.owner_set_at !== null && row.owner_set_by !== null && row.owner_set_at !== before?.owner_set_at
    ? { what: 'owner' as const, at: row.owner_set_at, by: row.owner_set_by } : null;
  const state = row.state_set_at !== null && row.state_set_by !== null && row.state_set_at !== before?.state_set_at
    ? { what: 'state' as const, at: row.state_set_at, by: row.state_set_by } : null;
  if (!owner || !state) return owner ?? state;
  return Date.parse(owner.at) > Date.parse(state.at) ? owner : state;
}

/**
 * What happened to a follow-up since you last saw it (`before`, or null when
 * it is new to what you saw), as it is now (`row`), told only when someone
 * else did it (N2, N3): handed to you, a first Send to you included; done or
 * dismissed (not relevant); reopened; or, on one you sent or last handed on,
 * handed on to someone else. Your own changes, from any device, are never told.
 * One new to what you saw is told only when its change is no older than the
 * newest change the last read saw (`since`, the Authority's clock): one that
 * only came into view, changed long ago, is not news.
 */
function followUpEvent(before: OpenItemView | null, row: OpenItemView, me: string, since: string | null = null): FollowUpEvent | null {
  const change = newestChange(row, before);
  if (!change || change.by.membership_id === me) return null;
  if (before === null && since !== null && Date.parse(change.at) < Date.parse(since)) return null;
  const yours = row.owner.membership_id === me;
  if (change.what === 'owner') {
    if (yours) return { kind: 'handed_you', item: row, by: change.by };
    const sentOrHandedOn = row.approver.membership_id === me || before?.owner_set_by?.membership_id === me;
    return sentOrHandedOn ? { kind: 'handed_on', item: row, by: change.by, to: row.owner } : null;
  }
  if (row.state === 'done' || row.state === 'not_relevant') return { kind: row.state, item: row, by: change.by };
  if (row.state !== 'open') return null;
  // Send stamps the time it went with its state: a first Send to you is a handoff; one to someone else was its approver's own.
  if (row.sent_at !== null && row.sent_at === row.state_set_at) return yours ? { kind: 'handed_you', item: row, by: change.by } : null;
  return { kind: 'reopened', item: row, by: change.by };
}

/** When a follow-up last changed (made, sent, or its owner or state set), on the Authority's clock. */
function changedAt(row: OpenItemView): string {
  return latest(row.created_at, row.sent_at, row.owner_set_at, row.state_set_at)!;
}

/** A follow-up as seen at a change: its item, and that change's time, as an instant. */
function seenKey(row: OpenItemView): string {
  return `${row.item_id}|${Date.parse(changedAt(row))}`;
}

/** What the reads saw: the newest change, and the rows at exactly that time (the boundary the next read asks from). */
function learnSeen(run: Loop, rows: readonly OpenItemView[]): void {
  const newest = latest(run.seenUpTo, ...rows.map(changedAt));
  if (newest === null) return;
  const at = Date.parse(newest);
  const boundary = new Set(newest === run.seenUpTo ? run.boundary : []);
  for (const row of rows) if (Date.parse(changedAt(row)) === at) boundary.add(seenKey(row));
  run.seenUpTo = newest;
  run.boundary = boundary;
}

/**
 * Follow-ups moved: your open ones and those closed since the newest change the
 * last read saw are read side by side, rows only, every page (they page oldest
 * first by creation, so a change can be on any page). Each open one is
 * compared with how it was last read. One that left your open ones is settled
 * by the closed read when it is there; otherwise (handed away, or no longer in
 * view) it is read by its id, twenty at most side by side, and one whose read
 * failed is read at the next check. One closed since that you never saw open
 * is told too: sent and closed between two checks. The first read only
 * learns, from your open ones and those closed since their newest change.
 * On an older Authority, none closed are read. Null when a read did not
 * finish: nothing is learned from it.
 */
async function followUpsMoved(run: Loop): Promise<FollowUpEvent[] | null> {
  const account = run.account;
  const before = run.followed;
  const closedSince = (since: string | null) => (run.older ? Promise.resolve([])
    : surfaces.readRows(account, { states: CLOSED, changed_since: new Date(since ?? SINCE_EVER).toISOString() }));
  const [open, closedNow] = await Promise.all([surfaces.readRows(account, { states: ['open'] }), before === null ? [] : closedSince(run.seenUpTo)]);
  if (loop !== run || open === null || closedNow === null) return null;
  const now = new Map(open.map(row => [row.item_id, row]));
  if (before === null) {
    // Learning: what closed since your open ones last changed, so none of it is told later as news.
    const closed = await closedSince(latest(...open.map(changedAt)));
    if (loop !== run || closed === null) return null;
    run.followed = now;
    run.pending = new Map();
    learnSeen(run, [...open, ...closed]);
    return [];
  }
  const me = account.membership_id;
  const since = run.seenUpTo;
  const events: FollowUpEvent[] = [];
  const tellOf = (event: FollowUpEvent | null) => { if (event) events.push(event); };
  for (const row of open) {
    // One that left and came back before it was read is judged from how it was last seen.
    const was = before.get(row.item_id) ?? run.pending.get(row.item_id) ?? null;
    if (was !== null || !run.boundary.has(seenKey(row))) tellOf(followUpEvent(was, row, me, since));
  }
  const left = new Map([...run.pending, ...before].filter(([id]) => !now.has(id)));
  const closed = new Map(closedNow.map(row => [row.item_id, row]));
  for (const row of closedNow) {
    const was = left.get(row.item_id);
    if (was) tellOf(followUpEvent(was, row, me));
    else if (!run.boundary.has(seenKey(row))) tellOf(followUpEvent(null, row, me, since));
  }
  const unexplained = [...left.values()].filter(was => !closed.has(was.item_id));
  const asked = unexplained.slice(0, LEFT_READS_MAX);
  const reads = await Promise.all(asked.map(was => surfaces.readItem(account, was.item_id)));
  if (loop !== run) return null;
  const pending = new Map(unexplained.slice(LEFT_READS_MAX).map(was => [was.item_id, was]));
  const readRows: OpenItemView[] = [];
  reads.forEach((read, index) => {
    const was = asked[index]!;
    if ('item' in read) { readRows.push(read.item); tellOf(followUpEvent(was, read.item, me)); }
    else if (!NO_LONGER_SEEN.includes(read.failure.code)) pending.set(was.item_id, was);
  });
  run.followed = now;
  run.pending = pending;
  learnSeen(run, [...open, ...closedNow, ...readRows]);
  return events;
}

// ---- notifications ------------------------------------------------------------------

/** A name or a title as a notification shows it: one line, clipped as today. */
function line(text: string): string { return clip(text.replace(/\p{Cc}+/gu, ' ').trim(), NOTICE_TEXT_MAX); }
const who = (person: Person) => line(firstName(person.name));

/** One follow-up's line (N5): "Ana handed you Pricing page", "Ana marked Pricing page done", "Ana handed Pricing page to Ben". */
function eventText(event: FollowUpEvent): string {
  const title = line(itemTitle(event.item));
  switch (event.kind) {
    case 'handed_you': return `${who(event.by)} handed you ${title}`;
    case 'done': return `${who(event.by)} marked ${title} done`;
    case 'not_relevant': return `${who(event.by)} marked ${title} not relevant`;
    case 'reopened': return `${who(event.by)} reopened ${title}`;
    case 'handed_on': return `${who(event.by)} handed ${title} to ${who(event.to)}`;
  }
}

/**
 * One check's one notification (N4, N5), or null for nothing to tell. One
 * follow-up says what happened and opens its page; several are counted and
 * open a list of exactly those (at most a hundred). One project add names the
 * project and opens it; several are counted and open the first. Both in one
 * check are counted together and open what the follow-ups would.
 */
function noticeFor(events: readonly FollowUpEvent[], adds: readonly ProjectSummary[]): Notice | null {
  const items = [...new Set(events.map(event => event.item.item_id))].slice(0, NOTICE_ITEMS_MAX);
  const followUps: NoticeTarget | null = items.length === 0 ? null
    : items.length === 1 ? { kind: 'item', item_id: items[0]! } : { kind: 'items', item_ids: items };
  const changed = `${followUpCount(items.length)} changed`;
  if (adds.length === 0) return followUps && { text: items.length === 1 ? eventText(events[0]!) : changed, target: followUps };
  const projects = adds.length === 1 ? '1 project' : `${adds.length} projects`;
  if (followUps) return { text: `${changed} · added to ${projects}`, target: followUps };
  return { text: adds.length === 1 ? `You were added to ${line(adds[0]!.name)}` : `Added to ${projects}`, target: { kind: 'project', project_id: adds[0]!.project_id } };
}

function keyOf(target: NoticeTarget): string {
  return target.kind === 'item' ? `item:${target.item_id}` : target.kind === 'project' ? `project:${target.project_id}` : `items:${target.item_ids.join()}`;
}

/** The newest few entries a click may still use: main keeps twenty notifications. */
function keepNewest<T>(entries: Map<string, T>): void {
  while (entries.size > TOLD_KEPT) entries.delete(entries.keys().next().value!);
}

/**
 * One notification for a check: nothing about the follow-up whose page you are looking at, which the check re-reads
 * instead (N4); with the window hidden or covered, you are not looking, and it is told.
 */
function tell(run: Loop, events: readonly FollowUpEvent[], adds: readonly ProjectSummary[]): void {
  const open = surfaces.seen() ? surfaces.itemShown() : null;
  const untold = events.filter(event => event.item.item_id !== open);
  const notice = noticeFor(untold, adds);
  if (!notice) return;
  const { told } = run;
  const key = keyOf(notice.target);
  told.keys = [...told.keys.filter(entry => entry !== key), key].slice(-TOLD_KEPT);
  for (const event of untold) told.rows.set(event.item.item_id, event.item);
  for (const project of adds) told.projects.set(project.project_id, project);
  keepNewest(told.rows);
  keepNewest(told.projects);
  void ask(() => rpc('notice.show', notice));
}

/** A notification's target this account was told of: only those open, so one from before a sign-out or a switch opens nothing. */
export function wasTold(target: NoticeTarget): boolean {
  return loop !== null && sameExpect(loop.account, surfaces.account()) && loop.told.keys.includes(keyOf(target));
}

/** The row a notification was about, to show at once while its page reads it again. */
export function toldRow(itemId: string): OpenItemView | null {
  return loop?.told.rows.get(itemId) ?? null;
}
