import type { OpenItemView } from '../shared/protocol.js';

/**
 * Home's altitudes (Home altitude v1): what needs attention, each project's
 * health, and the groups an altitude shows, worked out from the follow-ups
 * the server already sends. Nobody types a status.
 */

/** Not sent for more than a day: the approver hasn't sent it. */
const UNSENT_DAYS = 1;
/** Open for more than three days since it was sent or last set. */
const OPEN_DAYS = 3;
/** One waiting longer than this puts its project off track. */
const OFF_TRACK_DAYS = 7;
/** This many needing attention puts a project off track. */
const OFF_TRACK_COUNT = 3;
/** The most of one person's follow-ups their altitude reads live, one by one. */
export const PERSON_LIVE_MAX = 20;
/** How many projects My projects reads at once. */
export const PROJECT_READS_AT_ONCE = 4;

const DAY_MS = 86_400_000;

export type Health = 'on' | 'risk' | 'off';

const waiting = (item: OpenItemView) => item.state === 'unsent' || item.state === 'open';

/** Since when it has waited: an unsent one since it was made, an open one since it was sent or last set; null once closed. */
export function waitingSince(item: OpenItemView): string | null {
  if (item.state === 'unsent') return item.created_at;
  if (item.state !== 'open') return null;
  const moved = [item.sent_at, item.state_set_at].filter((at): at is string => at !== null).sort();
  return moved.at(-1) ?? item.created_at;
}

/** Elapsed waiting time, or null once closed. Thresholds use this before display rounding. */
function waitedMs(item: OpenItemView, now: number): number | null {
  const since = waitingSince(item);
  return since === null ? null : Math.max(0, now - Date.parse(since));
}

/** Whole days it has waited, or null once closed. */
export function waitedDays(item: OpenItemView, now: number): number | null {
  const elapsed = waitedMs(item, now);
  return elapsed === null ? null : Math.floor(elapsed / DAY_MS);
}

/** Nobody can act on it: ECHO found no owner and fell back to the approver, or it waits on the project's leads. */
export function unowned(item: OpenItemView): boolean {
  return item.owner.match === 'approver' || item.waits_on === 'leads';
}

export function needsAttention(item: OpenItemView, now: number): boolean {
  if (!waiting(item)) return false;
  if (unowned(item)) return true;
  const elapsed = waitedMs(item, now)!;
  return elapsed > (item.state === 'unsent' ? UNSENT_DAYS : OPEN_DAYS) * DAY_MS;
}

/** Waiting longer than a week, by the clock: what puts its project off track, and what a follow-ups row marks solid. */
export function overdue(item: OpenItemView, now: number): boolean {
  return (waitedMs(item, now) ?? 0) > OFF_TRACK_DAYS * DAY_MS;
}

/** Someone a row shows as a face, and whether one of theirs needs attention. */
export interface Face { membership_id: string; name: string; needs: boolean }

interface Rollup {
  done: number;
  total: number;
  needs: number;
  health: Health;
  /** Days the oldest waiting follow-up has waited, or null when none waits. */
  oldest: number | null;
  faces: Face[];
  /** Why it is not on track: of those needing attention, the one that has waited longest; null when none needs attention. */
  reason: OpenItemView | null;
}

function faces(rows: readonly OpenItemView[], now: number): Face[] {
  const byId = new Map<string, Face>();
  for (const item of rows) {
    if (unowned(item) || item.state === 'not_relevant') continue;
    const face = byId.get(item.owner.membership_id) ?? { membership_id: item.owner.membership_id, name: item.owner.name, needs: false };
    face.needs ||= needsAttention(item, now);
    byId.set(item.owner.membership_id, face);
  }
  return [...byId.values()].sort((a, b) => Number(b.needs) - Number(a.needs));
}

/**
 * A set of follow-ups at a glance. Done and total come from a counts read when
 * there is one (it covers the done ones a rows read of open work leaves out).
 */
export function rollup(rows: readonly OpenItemView[], counts: { unsent: number; open: number; done: number } | null, now: number): Rollup {
  const kept = rows.filter(item => item.state !== 'not_relevant');
  const flagged = kept.filter(item => needsAttention(item, now));
  const waits = kept.flatMap(item => { const days = waitedDays(item, now); return days === null ? [] : [days]; });
  const late = flagged.some(item => overdue(item, now));
  return {
    done: counts ? counts.done : kept.filter(item => item.state === 'done').length,
    total: counts ? counts.unsent + counts.open + counts.done : kept.length,
    needs: flagged.length,
    health: late || flagged.length >= OFF_TRACK_COUNT ? 'off' : flagged.length > 0 ? 'risk' : 'on',
    oldest: waits.length === 0 ? null : Math.max(...waits),
    faces: faces(kept, now),
    reason: flagged.reduce<OpenItemView | null>((longest, item) => (longest === null || waitedMs(item, now)! > waitedMs(longest, now)! ? item : longest), null),
  };
}

/** One owner's follow-ups in a project; `key` is their membership id, or "none". */
interface OwnerGroup { key: string; name: string; rows: OpenItemView[]; done: number; total: number; needs: number }

/** A project's follow-ups by owner: those needing attention first, most first, then by name. */
export function byOwner(rows: readonly OpenItemView[], now: number): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  for (const item of rows) {
    if (item.state === 'not_relevant') continue;
    const none = unowned(item);
    const key = none ? 'none' : item.owner.membership_id;
    const group = groups.get(key) ?? { key, name: none ? 'No owner' : item.owner.name, rows: [], done: 0, total: 0, needs: 0 };
    group.rows.push(item);
    group.total += 1;
    if (item.state === 'done') group.done += 1;
    if (needsAttention(item, now)) group.needs += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.needs - a.needs || a.name.localeCompare(b.name));
}

/** A decision's follow-ups in a project, at a glance. */
interface DecisionLine { record_sha256: string; title: string; approved_at: string; done: number; total: number; needs: number; faces: Face[] }

/** A project's follow-ups by the decision they came from, newest first; one whose decision you can't read now has none. */
export function byDecision(rows: readonly OpenItemView[], now: number): DecisionLine[] {
  const groups = new Map<string, OpenItemView[]>();
  for (const item of rows) {
    if (!item.decision || item.state === 'not_relevant') continue;
    groups.set(item.decision.record_sha256, [...(groups.get(item.decision.record_sha256) ?? []), item]);
  }
  return [...groups.values()].map(items => {
    const { record_sha256, title, approved_at } = items[0]!.decision!;
    const { done, total, needs, faces: shown } = rollup(items, null, now);
    return { record_sha256, title, approved_at, done, total, needs, faces: shown };
  }).sort((a, b) => b.approved_at.localeCompare(a.approved_at));
}

/** One person's follow-ups, project by project in the order given, leaving out projects where they own none. */
export function byProject(rows: ReadonlyMap<string, readonly OpenItemView[]>, membership_id: string): { project_id: string; rows: OpenItemView[] }[] {
  return [...rows].flatMap(([project_id, items]) => {
    const theirs = items.filter(item => item.owner.membership_id === membership_id && !unowned(item));
    return theirs.length === 0 ? [] : [{ project_id, rows: theirs }];
  });
}
