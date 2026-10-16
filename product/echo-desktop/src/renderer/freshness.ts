import type { PersonChangesAreaV1, PersonChangesV1 } from '@echo-brain/organization-api';
// The desktop's one refresh rule (desktop refresh and notifications v1;
// ADR-0036). One loop asks the Authority what moved in this person's own view
// (the change check: a fingerprint per area, never content) and reacts to
// each area that moved: projects read the sidebar again, follow-ups read the
// open follow-ups you are involved in again (rows only), and what shows that
// an area feeds is read again quietly. Coming back to ECHO, the window coming
// forward, a page opened and the machine waking each run a check; between
// them the server sets the pace. A change someone else made to a follow-up
// you are involved in, and being added to a project, come as one system
// notification per check. The store keeps its loaders; this module only says
// when they run.
import type { Expect, Failure, Notice, NoticeTarget, OpenItemsView, OpenItemView, ProjectPage, ProjectSummary, Result } from '../shared/protocol.js';
import { NOTICE_TEXT_MAX } from '../shared/protocol.js';
import { rpc } from './api.js';
import { clip } from './format.js';
import { firstName, itemTitle } from './needs.js';

export type Area = PersonChangesAreaV1;
/** The areas whose move re-reads what a page shows; projects re-read the sidebar. */
export type ScreenArea = Exclude<Area, 'projects'>;
const AREAS: readonly Area[] = ['projects', 'follow_ups', 'reviews'];

/** The pace the server may set, in seconds (PERSON_CHANGES_CHECK_SECONDS_V1): never faster than 15 s, never slower than an hour. */
const PACE_SECONDS = { min: 15, default: 60, max: 3600 } as const;
/** After a failed check the wait doubles, up to five minutes. */
const BACKOFF_MAX_MS = 5 * 60_000;
/** An Authority without the change check: its follow-ups are scanned every five minutes instead (R8). */
const FALLBACK_MS = 5 * 60_000;
/** Opening pages asks at most once in this long (R2). */
const NAVIGATION_MS = 10_000;
/** Coming back and the window coming forward, again within this long, are the same return (R4). */
export const ABSORB_MS = 2_000;
/** The follow-ups that left your open ones that one check reads by their ids, to say what happened to them. */
const LEFT_READS_MAX = 20;
/** Notifications this account may still click: main keeps twenty on screen. */
const TOLD_KEPT = 20;
/** Failures that say the account is gone, not the check. */
const ACCOUNT_GONE = ['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', 'sign_in_required'];

/** What the store gives this module: who is signed in, the sidebar, and its quiet re-reads of what shows. */
export interface Surfaces {
  account(): Expect | null;
  /** Another app is in front and the page is covered. */
  covered(): boolean;
  /** The account read again. */
  status(): Promise<void>;
  /** The quiet multi-page sidebar read, the open project then following its row; false when it did not finish. */
  refreshSidebar(): Promise<boolean>;
  /** The sidebar's last read of a list failed. */
  sidebarFailed(): boolean;
  /** What shows read again quietly: the page on screen (`page`, R4), and what moved areas feed (R3). */
  reread(what: { readonly page: boolean; readonly areas: readonly ScreenArea[] }): void;
  /** The follow-up whose page shows, if one does. */
  itemShown(): string | null;
  accountLost(failure: Failure): void;
}

/** Why a check ran. */
type Trigger = 'start' | 'timer' | 'came-back' | 'navigation' | 'wake';
/** How a check went: read and acted on, failed, or there is no change check here (R8). */
export type Outcome = 'ok' | 'failed' | 'fallback';

/** One account's loop, from sign-in (or start) to sign-out or a switch. */
interface Loop {
  readonly account: Expect;
  /** `fallback` once the Authority answered `not_supported`, until the next start. */
  mode: 'changes' | 'fallback';
  /** Each area's fingerprint as last acted on; null until a check learns them. */
  areas: Record<Area, string> | null;
  /**
   * Every project you belong to, active and archived, as the last full read of your projects had them: null until a full
   * read learns them. Only the first check and a move of `projects` read them all.
   */
  memberships: Map<string, ProjectSummary> | null;
  /** The open follow-ups you are involved in, as last read: null until a read learns them. */
  followed: Map<string, OpenItemView> | null;
  /**
   * Follow-ups that left your open ones and were not read yet to say what happened to them (a read that failed, or past the
   * twenty one check reads), as they were last seen: read again at the next check.
   */
  pending: Map<string, OpenItemView>;
  /** `involved`, or `mine` on an Authority that refuses it. */
  scope: 'involved' | 'mine';
  /** Milliseconds between checks, as the server last said. */
  pace: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<Outcome> | null;
  /** When the last check began. */
  began: number;
}

let surfaces: Surfaces | null = null;
let loop: Loop | null = null;
/** The window is hidden (closed to the tray, or minimized): checks go on, screen re-reads wait (R6). */
let hidden = false;
/** Re-reads owed to what shows, held while the window is hidden or covered: applied once it shows. */
let held: { page: boolean; areas: Set<ScreenArea> } = { page: false, areas: new Set() };
let returnedAt = Number.NEGATIVE_INFINITY;
let returning: Promise<void> | null = null;
/** Projects made on this desktop: being in one you made is never news. */
const created = new Set<string>();
/** What this account was notified of, as keys a click may open, and the rows those notifications were about. */
let told: { account: Expect; keys: string[]; rows: Map<string, OpenItemView>; projects: Map<string, ProjectSummary> } | null = null;
/** `changes unsupported` is logged once a run of the app. */
let unsupportedLogged = false;

export function configure(given: Surfaces): void { surfaces = given; }

function sameAccount(a: Expect | null, b: Expect | null): boolean {
  return a !== null && b !== null && a.authority === b.authority && a.membership_id === b.membership_id;
}

/** An rpc answered, never thrown: a call that could not be made fails as `failed`. */
async function ask<T>(call: () => Promise<Result<unknown>>): Promise<Result<T>> {
  try {
    return await call() as Result<T>;
  } catch {
    return { ok: false, failure: { code: 'failed', retryable: true } };
  }
}

/** The window can be seen: shown, and no other app in front. */
function visible(): boolean { return !hidden && surfaces?.covered() === false; }

// ---- the loop ---------------------------------------------------------------------

/** Signed in, or switched to another account: a new loop, whose first check learns and never notifies (R2, N4). */
export function start(account: Expect): void {
  stop();
  loop = { account, mode: 'changes', areas: null, memberships: null, followed: null, pending: new Map(), scope: 'involved', pace: PACE_SECONDS.default * 1000,
    failures: 0, timer: null, running: null, began: Number.NEGATIVE_INFINITY };
  told = { account, keys: [], rows: new Map(), projects: new Map() };
  void check('start');
}

/** Signed out, or the account forgotten: no more checks, and what they learned goes. */
export function stop(): void {
  if (loop?.timer) clearTimeout(loop.timer);
  loop = null;
  told = null;
  created.clear();
  held = { page: false, areas: new Set() };
}

/**
 * A check: the change check's fingerprints, and a reaction to each area that
 * moved. One runs at a time; another trigger meanwhile joins it. On an
 * Authority without the change check (`fallback`), only the timer and a wake
 * scan your follow-ups (R8).
 */
function check(trigger: Trigger): Promise<Outcome | null> {
  const run = loop;
  if (!run) return Promise.resolve(null);
  if (run.running) return run.running;
  if (run.mode === 'fallback' && trigger !== 'timer' && trigger !== 'wake') return Promise.resolve('fallback');
  const running = once(run).finally(() => {
    run.running = null;
    if (loop === run) schedule(run);
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
  const delay = run.mode === 'fallback' ? FALLBACK_MS
    : run.failures === 0 ? run.pace : Math.max(run.pace, Math.min(BACKOFF_MAX_MS, run.pace * 2 ** run.failures));
  run.timer = setTimeout(() => { run.timer = null; if (loop === run) void check('timer'); }, delay);
}

async function once(run: Loop): Promise<Outcome> {
  run.began = Date.now();
  if (run.timer) { clearTimeout(run.timer); run.timer = null; }
  if (run.mode === 'fallback') { await scan(run); return 'fallback'; }
  const result = await ask<PersonChangesV1>(() => rpc('changes.read', { expect: run.account }));
  if (loop !== run) return 'failed';
  if (!result.ok) {
    if (result.failure.code === 'not_supported') {
      // An older Authority: today's behaviour, until the next start (R8).
      run.mode = 'fallback';
      run.scope = 'mine';
      if (!unsupportedLogged) { unsupportedLogged = true; void ask(() => rpc('log.changes', { unsupported: true })); }
      await scan(run);
      return 'fallback';
    }
    if (ACCOUNT_GONE.includes(result.failure.code)) surfaces?.accountLost(result.failure);
    run.failures += 1;
    return 'failed';
  }
  run.failures = 0;
  const seconds = result.value.check_again_after_seconds;
  run.pace = Math.min(PACE_SECONDS.max, Math.max(PACE_SECONDS.min, Number.isFinite(seconds) ? seconds : PACE_SECONDS.default)) * 1000;
  const fresh = result.value.areas;
  if (run.areas === null) {
    // The first check learns where things are: the fingerprints, every project you belong to, and the follow-ups you are
    // involved in.
    run.areas = { ...fresh };
    await Promise.all([learnMemberships(run), followUpsMoved(run)]);
    return 'ok';
  }
  const known = run.areas;
  const moved = AREAS.filter(area => fresh[area] !== known[area]);
  if (moved.length > 0) void ask(() => rpc('log.changes', { moved }));
  // What a failed first read could not learn is read on every check until a read learns it, moved or not; so is a follow-up
  // that left your open ones and could not be read yet.
  const [projects, events] = await Promise.all([
    moved.includes('projects') ? projectsMoved(run) : run.memberships === null ? learnMemberships(run).then(() => null) : Promise.resolve(null),
    moved.includes('follow_ups') || run.followed === null ? followUpsMoved(run) : run.pending.size > 0 ? readPending(run) : Promise.resolve([]),
  ]);
  if (loop !== run) return 'ok';
  const adds = projects?.adds ?? [];
  // An area whose read did not finish keeps its old fingerprint, so the next check reads it again.
  run.areas = {
    projects: projects !== null && projects.sidebar ? fresh.projects : known.projects,
    follow_ups: events !== null ? fresh.follow_ups : known.follow_ups,
    reviews: fresh.reviews,
  };
  reread(moved.filter((area): area is ScreenArea => area !== 'projects'));
  tell(run, events ?? [], adds);
  return 'ok';
}

/** An older Authority's scan, every five minutes: what you sent or own, read rows only, and one notification. */
async function scan(run: Loop): Promise<void> {
  const events = await followUpsMoved(run);
  if (loop === run && events) tell(run, events, []);
}

/** Moved areas re-read what shows of them, or wait while the window is hidden or covered (R6). */
function reread(areas: readonly ScreenArea[]): void {
  if (areas.length === 0) return;
  for (const area of areas) held.areas.add(area);
  flush();
}

/** What waited on the window showing, read once now that it shows. */
function flush(): void {
  if (!surfaces || !visible() || !surfaces.account()) return;
  const { page, areas } = held;
  if (!page && areas.size === 0) return;
  held = { page: false, areas: new Set() };
  surfaces.reread({ page, areas: [...areas] });
}

// ---- triggers ---------------------------------------------------------------------

/**
 * Coming back to ECHO, or the window coming forward (`shown`), on either
 * platform and with no departure recorded: the account is read again, a check
 * runs, and the page on screen is read again quietly, once it shows. A return
 * within two seconds of the last is the same return. Without a change check to
 * say whether projects moved, the sidebar is read again too (R4, R8). Only the
 * window coming forward ends a hidden window: ECHO can come back in front with
 * its window still in the tray.
 */
export function cameBack(shown: boolean): Promise<void> {
  if (shown) hidden = false;
  const now = Date.now();
  if (now - returnedAt < ABSORB_MS) {
    flush();
    return returning ?? Promise.resolve();
  }
  returnedAt = now;
  held.page = true;
  const work = (async () => {
    await surfaces?.status();
    flush();
    const outcome = await check('came-back');
    // No check to say whether projects moved, or a sidebar whose last read failed: it is read again, as you look at it.
    if (loop !== null && (outcome === 'fallback' || outcome === 'failed' || surfaces?.sidebarFailed())) await surfaces?.refreshSidebar();
  })();
  returning = work;
  return work;
}

/** The window was hidden or minimized: checks and notifications go on; what shows is read again once it shows (R6). */
export function windowHidden(): void { hidden = true; }

/**
 * The window is on screen again without coming forward (macOS: no longer covered by other windows, or back on this Space):
 * what waited on it is read, once. Not a return: no status read, and no check.
 */
export function windowVisible(): void {
  hidden = false;
  flush();
}

/**
 * Another app came in front: the page is covered, and its live reads and polls stop. Uncovered, it is read again, even on a
 * return the last one absorbed.
 */
export function concealed(): void { held.page = true; }

/** The machine woke: a check, whose baseline from before the sleep carries on, so what changed meanwhile notifies (N4). */
export function woke(): Promise<Outcome | null> { return check('wake'); }

/** A page was opened: a check, at most once in ten seconds (R2, R5). */
export function navigated(): void {
  const run = loop;
  if (!run || run.mode !== 'changes' || run.running || Date.now() - run.began < NAVIGATION_MS) return;
  void check('navigation');
}

/** A project made on this desktop: never news (N2). */
export function createdHere(projectId: string): void { created.add(projectId); }

// ---- projects ------------------------------------------------------------------------

/** Every page of your active and archived projects, or null when a page could not be read. Each page is audited: only the first check and a move of `projects` read them. */
async function readMemberships(run: Loop): Promise<Map<string, ProjectSummary> | null> {
  const all = new Map<string, ProjectSummary>();
  for (const status of ['active', 'archived'] as const) {
    let cursor: string | null = null;
    do {
      const page: Result<ProjectPage> = await ask<ProjectPage>(() => rpc('projects.list', { expect: run.account, status, ...(cursor === null ? {} : { cursor }) }));
      if (loop !== run) return null;
      if (!page.ok) {
        if (ACCOUNT_GONE.includes(page.failure.code)) surfaces?.accountLost(page.failure);
        return null;
      }
      for (const project of page.value.items) all.set(project.project_id, project);
      cursor = page.value.next_cursor;
    } while (cursor !== null);
  }
  return all;
}

/** The first check (or the next, after it failed): every project you belong to, learned without a word. */
async function learnMemberships(run: Loop): Promise<void> {
  const read = await readMemberships(run);
  if (loop !== run || read === null) return;
  run.memberships = read;
}

/**
 * The projects you were added to: those in the full read (`now`) that were not
 * among every project you belonged to at the last one (`known`), however far
 * past the sidebar's pages they sort; archived ones included, so archiving or
 * restoring one never reads as an add. Not one made on this desktop, nor one
 * you lead that was made after the newest project of the last full read, on
 * the Authority's own clock: yours, made elsewhere. With nothing to measure
 * against (you had no projects), one you lead is told.
 */
export function projectAdds(known: ReadonlyMap<string, ProjectSummary>, now: ReadonlyMap<string, ProjectSummary>, made: ReadonlySet<string>): ProjectSummary[] {
  const since = [...known.values()].reduce<number | null>((newest, project) => {
    const at = Date.parse(project.created_at);
    return Number.isNaN(at) || (newest !== null && newest >= at) ? newest : at;
  }, null);
  return [...now.values()].filter(project => !known.has(project.project_id) && !made.has(project.project_id)
    && !(project.role === 'lead' && since !== null && Date.parse(project.created_at) > since));
}

/**
 * Projects moved: the sidebar reads again the pages it shows, whatever the
 * window shows, and every project you belong to is read in full, to tell the
 * ones you were added to. A full read that did not finish tells nothing and
 * keeps what the last one learned, so the next move tells them. `sidebar` is
 * whether the sidebar's read finished.
 */
async function projectsMoved(run: Loop): Promise<{ sidebar: boolean; adds: ProjectSummary[] }> {
  const [sidebar, read] = await Promise.all([surfaces?.refreshSidebar() ?? Promise.resolve(false), readMemberships(run)]);
  if (loop !== run || read === null) return { sidebar, adds: [] };
  const known = run.memberships;
  run.memberships = read;
  return { sidebar, adds: known === null ? [] : projectAdds(known, read, created) };
}

/** A project a notification was about, as the full read had it: it opens even when the sidebar has not loaded its row. */
export function toldProject(projectId: string): ProjectSummary | null {
  return told?.projects.get(projectId) ?? null;
}

// ---- follow-ups -------------------------------------------------------------------

type Person = OpenItemView['approver'];

/** What someone else did to a follow-up you are involved in (N2). */
export type FollowUpEvent =
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
  return owner.at > state.at ? owner : state;
}

/**
 * What happened to a follow-up since you last saw it (`before`, or null when
 * it is new to your open ones), as it is now (`row`), told only when someone
 * else did it (N2, N3): handed to you, a first Send to you included; done or
 * dismissed (not relevant); reopened; or, on one you sent or last handed on,
 * handed on to someone else. Your own changes, from any device, are never told.
 * One new to your open ones is told only when its change is newer than the
 * newest change the last read saw (`since`, the Authority's clock): one that
 * only came into view, changed long ago, is not news.
 */
export function followUpEvent(before: OpenItemView | null, row: OpenItemView, me: string, since: string | null = null): FollowUpEvent | null {
  const change = newestChange(row, before);
  if (!change || change.by.membership_id === me) return null;
  if (before === null && since !== null && !(Date.parse(change.at) > Date.parse(since))) return null;
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

/**
 * Every page of the open follow-ups you are involved in, rows only (no tool
 * is read): the items you sent, own or last handed on. Read in the Authority's
 * order, created first, so a change can be on any page: all are read. An
 * Authority without `involved` refuses it; what you sent or own is read
 * instead. Null when a page could not be read.
 */
async function readFollowed(run: Loop): Promise<OpenItemView[] | null> {
  const rows: OpenItemView[] = [];
  let cursor: string | null = null;
  for (;;) {
    const scope = run.scope;
    const result: Result<OpenItemsView> = await ask<OpenItemsView>(() => rpc('runs', { expect: run.account, request: {
      schema_version: 1, operation: 'items', scope, states: ['open'], read: 'rows', ...(cursor === null ? {} : { cursor }),
    } }));
    if (loop !== run) return null;
    if (!result.ok) {
      if (scope === 'involved' && cursor === null && result.failure.code === 'invalid_request') { run.scope = 'mine'; continue; }
      if (ACCOUNT_GONE.includes(result.failure.code)) surfaces?.accountLost(result.failure);
      return null;
    }
    rows.push(...result.value.items);
    cursor = result.value.next_cursor;
    if (cursor === null) return rows;
  }
}

/** The newest change a set of rows shows, on the Authority's clock: when each was made, sent, or had its owner or state set. */
function newestSeen(rows: Iterable<OpenItemView>): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    for (const at of [row.created_at, row.sent_at, row.owner_set_at, row.state_set_at]) {
      if (at !== null && (newest === null || Date.parse(at) > Date.parse(newest))) newest = at;
    }
  }
  return newest;
}

/**
 * Follow-ups moved: your open ones read again, each compared with how it was
 * last read, and each that is no longer among them read by its id (rows only)
 * to say what happened to it: done, dismissed, or handed on. The first read
 * only learns. Null when a read did not finish: nothing is learned from it.
 */
async function followUpsMoved(run: Loop): Promise<FollowUpEvent[] | null> {
  const rows = await readFollowed(run);
  if (rows === null) return null;
  const now = new Map(rows.map(row => [row.item_id, row]));
  const before = run.followed;
  if (before === null) { run.followed = now; run.pending = new Map(); return []; }
  const me = run.account.membership_id;
  const since = newestSeen(before.values());
  const events = rows.flatMap(row => {
    // One that left and came back before it was read is judged from how it was last seen.
    const was = before.get(row.item_id) ?? run.pending.get(row.item_id) ?? null;
    const event = followUpEvent(was, row, me, since);
    return event ? [event] : [];
  });
  const left = new Map([...run.pending, ...before].filter(([id]) => !now.has(id)));
  const read = await readLeft(run, left);
  if (read === null) return null;
  run.followed = now;
  run.pending = read.unread;
  return [...events, ...read.events];
}

/** Follow-ups whose read failed or waited, read again by their ids at the next check, with nothing else moved. */
async function readPending(run: Loop): Promise<FollowUpEvent[] | null> {
  const read = await readLeft(run, run.pending);
  if (read === null) return null;
  run.pending = read.unread;
  return read.events;
}

/**
 * Follow-ups that left your open ones, read by their ids, rows only, to say
 * what happened to each, twenty at most a check. One you no longer see says
 * nothing. One whose read failed, or past the twenty, stays `unread`, to be
 * read next time, so nothing that happened to it is lost. Null when the
 * account changed meanwhile.
 */
async function readLeft(run: Loop, left: ReadonlyMap<string, OpenItemView>): Promise<{ events: FollowUpEvent[]; unread: Map<string, OpenItemView> } | null> {
  const me = run.account.membership_id;
  const events: FollowUpEvent[] = [];
  const unread = new Map<string, OpenItemView>();
  let reads = 0;
  for (const was of left.values()) {
    if (reads >= LEFT_READS_MAX) { unread.set(was.item_id, was); continue; }
    reads += 1;
    const read = await ask<OpenItemView>(() => rpc('runs', { expect: run.account, request: { schema_version: 1, operation: 'item', item_id: was.item_id, read: 'rows' } }));
    if (loop !== run) return null;
    if (!read.ok) {
      if (read.failure.code === 'not_found' || read.failure.code === 'forbidden') continue;
      if (ACCOUNT_GONE.includes(read.failure.code)) surfaces?.accountLost(read.failure);
      unread.set(was.item_id, was);
      continue;
    }
    const event = followUpEvent(was, read.value, me);
    if (event) events.push(event);
  }
  return { events, unread };
}

// ---- notifications ------------------------------------------------------------------

/** A name or a title as a notification shows it: one line, clipped as today. */
function line(text: string): string { return clip(text.replace(/\p{Cc}+/gu, ' ').trim(), NOTICE_TEXT_MAX); }
const who = (person: Person) => line(firstName(person.name));

/** One follow-up's line (N5): "Ana handed you Pricing page", "Ana marked Pricing page done", "Ana handed Pricing page to Ben". */
export function eventText(event: FollowUpEvent): string {
  const title = line(itemTitle(event.item));
  switch (event.kind) {
    case 'handed_you': return `${who(event.by)} handed you ${title}`;
    case 'done': return `${who(event.by)} marked ${title} done`;
    case 'not_relevant': return `${who(event.by)} marked ${title} not relevant`;
    case 'reopened': return `${who(event.by)} reopened ${title}`;
    case 'handed_on': return `${who(event.by)} handed ${title} to ${who(event.to)}`;
  }
}

const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * One check's one notification (N4, N5), or null for nothing to tell. One
 * follow-up says what happened and opens its page; several are counted and
 * open Follow-ups. One project add names the project and opens it; several are
 * counted and open the first. Both in one check are counted together and open
 * Follow-ups.
 */
export function noticeFor(events: readonly FollowUpEvent[], adds: readonly ProjectSummary[]): Notice | null {
  if (events.length === 0 && adds.length === 0) return null;
  if (adds.length === 0) {
    return events.length === 1 ? { text: eventText(events[0]!), target: { kind: 'item', item_id: events[0]!.item.item_id } }
      : { text: `${events.length} follow-ups changed`, target: { kind: 'follow-ups' } };
  }
  const project: NoticeTarget = { kind: 'project', project_id: adds[0]!.project_id };
  if (events.length === 0) return { text: adds.length === 1 ? `You were added to ${line(adds[0]!.name)}` : `Added to ${adds.length} projects`, target: project };
  return { text: `${counted(events.length, 'follow-up')} changed · added to ${counted(adds.length, 'project')}`, target: { kind: 'follow-ups' } };
}

function keyOf(target: NoticeTarget): string {
  return target.kind === 'item' ? `item:${target.item_id}` : target.kind === 'project' ? `project:${target.project_id}` : 'follow-ups';
}

/**
 * One notification for a check: nothing about the follow-up whose page you are looking at, which the check re-reads
 * instead (N4); with the window hidden or covered, you are not looking, and it is told.
 */
function tell(run: Loop, events: readonly FollowUpEvent[], adds: readonly ProjectSummary[]): void {
  const open = visible() ? surfaces?.itemShown() ?? null : null;
  const untold = events.filter(event => event.item.item_id !== open);
  const notice = noticeFor(untold, adds);
  if (!notice || !told || !sameAccount(told.account, run.account)) return;
  told.keys = [...told.keys.filter(key => key !== keyOf(notice.target)), keyOf(notice.target)].slice(-TOLD_KEPT);
  for (const event of untold) told.rows.set(event.item.item_id, event.item);
  while (told.rows.size > TOLD_KEPT) told.rows.delete(told.rows.keys().next().value!);
  for (const project of adds) told.projects.set(project.project_id, project);
  while (told.projects.size > TOLD_KEPT) told.projects.delete(told.projects.keys().next().value!);
  void ask(() => rpc('notice.show', notice));
}

/** A notification's target this account was told of: only those open, so one from before a sign-out or a switch opens nothing. */
export function wasTold(target: NoticeTarget): boolean {
  return told !== null && sameAccount(told.account, surfaces?.account() ?? null) && told.keys.includes(keyOf(target));
}

/** The row a notification was about, to show at once while its page reads it again. */
export function toldRow(itemId: string): OpenItemView | null {
  return told?.rows.get(itemId) ?? null;
}
