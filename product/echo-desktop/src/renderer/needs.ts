import type {
  PersonImpactStageV1, PersonOpenItemKindV1, PersonOpenItemStateV1, PersonOpenItemsSummaryV1, PersonOpenItemVerdictV1,
} from '@echo-brain/organization-api';
import type { ConnectedTool, OpenItemView } from '../shared/protocol.js';
import { needsAttention, overdue, waitedDays, waitingSince } from './altitude.js';
import { externalSourceProvider } from './answer.js';
import { clip } from './format.js';

// The words Home, the follow-ups lists and the item page use for what an
// approved meeting set going (open items and Home v1, section 8; follow-ups
// thread v1). One status vocabulary (F7): Not sent, Open, Done, Dismissed.
// "Check" is ECHO's re-read only: "Checked 2 h ago", "Check now".

/** A decided line as a row's title reads, without its closing full stop. */
export function titleLine(line: string): string {
  return line.endsWith('.') && !line.endsWith('..') ? line.slice(0, -1) : line;
}

/** "Oct 6". A date without a time is that day wherever you are. */
export function monthDay(value: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const time = day ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(day ? { timeZone: 'UTC' } : {}) });
}

/** "2 actions", "1 action", or nothing when there are none. */
export function actionCount(count: number): string | null {
  return count === 0 ? null : count === 1 ? '1 action' : `${count} actions`;
}

/** A Send row's count: "1 follow-up to send", "3 follow-ups to send". */
export function toSend(count: number): string {
  return `${followUpCount(count)} to send`;
}

/**
 * People by first name, as the canvas names owners ("Mina, Rafael"). A name
 * whose first word is an initial ("S. Okafor"), or a first name two of them
 * share, stays whole.
 */
export function shortNames(names: readonly string[]): string[] {
  const first = (name: string) => {
    const word = name.trim().split(/\s+/u)[0] ?? '';
    return word.length < 2 || word.endsWith('.') ? name.trim() : word;
  };
  const people = new Map<string, Set<string>>();
  for (const name of names) people.set(first(name), (people.get(first(name)) ?? new Set()).add(name.trim()));
  return names.map(name => (people.get(first(name))?.size ?? 0) > 1 ? name.trim() : first(name));
}

/** A person's first name ("Mina"), or the whole name when its first word is an initial ("S. Okafor"). */
export function firstName(name: string): string {
  return shortNames([name])[0] ?? name;
}

/** What an item is, when its title is not shown. */
const WHAT: Readonly<Record<PersonOpenItemKindV1, string>> = {
  action: 'An action', ticket: 'A Jira ticket', page: 'A page', record: 'A record', document: 'A document',
};

/**
 * An item's title. A meeting's action is its own words (`expected`). Any
 * other item is its title as you opened it now, else what it is and why its
 * title is not shown: "A Jira ticket you can't open" when your access refused
 * it, "A Jira ticket ECHO couldn't read just now" when the read failed
 * otherwise (an outage is not lost access). Not read (yet): what it is and
 * its meeting, from ECHO's own fields, "Jira ticket · Pilot planning", which
 * its live read fills in.
 */
export function itemTitle(item: OpenItemView): string {
  if (item.kind === 'action') return item.expected ?? WHAT.action;
  if (item.current) return item.current.source.label;
  switch (item.reach) {
    case 'unavailable': return `${WHAT[item.kind]} ECHO couldn't read just now`;
    case 'not_read': return item.decision ? `${itemKind(item)} · ${item.decision.title}` : itemKind(item);
    default: return `${WHAT[item.kind]} you can't open`;
  }
}

/** Items by the name they share. */
function alike(items: readonly OpenItemView[], names: ReadonlyMap<string, string>): Map<string, OpenItemView[]> {
  const groups = new Map<string, OpenItemView[]>();
  for (const item of items) {
    const name = names.get(item.item_id)!;
    const group = groups.get(name);
    if (group) group.push(item); else groups.set(name, [item]);
  }
  return groups;
}

/**
 * Each item's name and label, apart from every other item's (R37). Its name,
 * for its tick and its owner ("Owner of …"): its title; where two items would
 * share one (two items you can't open), what the decision requires of each;
 * where they still would, its decision when you can read it and that tells
 * them apart ("· from Pilot planning"); and then where it is among those
 * alike ("(2)"). Its label, as a row shows its title beside what it needs and
 * where it came from (Home, the follow-ups lists): its title, and that "(2)".
 */
export function itemNames(items: readonly OpenItemView[]): ReadonlyMap<string, { name: string; label: string }> {
  const titles = new Map(items.map(item => [item.item_id, itemTitle(item)]));
  const names = new Map(titles);
  const tellApart = [
    // An action's title is already what the decision requires of it.
    (item: OpenItemView) => (item.kind !== 'action' && item.expected ? ` → ${item.expected}` : ''),
    // Only where the decisions differ: one meeting's items gain nothing by it.
    (item: OpenItemView, decisions: number) => (item.decision && decisions > 1 ? ` · from ${item.decision.title}` : ''),
  ];
  for (const words of tellApart) {
    for (const group of alike(items, names).values()) {
      if (group.length < 2) continue;
      const decisions = new Set(group.map(item => item.decision?.title ?? null)).size;
      for (const item of group) names.set(item.item_id, `${names.get(item.item_id)!}${words(item, decisions)}`);
    }
  }
  const sharing = alike(items, names);
  const seen = new Map<string, number>();
  return new Map(items.map(item => {
    const name = names.get(item.item_id)!;
    const title = titles.get(item.item_id)!;
    if (sharing.get(name)!.length < 2) return [item.item_id, { name, label: title }];
    const position = (seen.get(name) ?? 0) + 1;
    seen.set(name, position);
    return [item.item_id, { name: `${name} (${position})`, label: `${title} (${position})` }];
  }));
}

/** Longest quote of what an item says that a row shows. */
const QUOTE_CHARS = 80;

/**
 * What an item says now, as its tool gave it to you just now: its status and
 * due date, "Now: In Review, due Nov 20"; without either, its own words, 'Now:
 * “starts after freeze”'. Nothing when ECHO did not open it for you.
 */
function nowWords(item: OpenItemView): string | null {
  const current = item.current;
  if (!current) return null;
  const facts = [current.status ?? null, current.due_at === undefined ? null : `due ${monthDay(current.due_at) ?? current.due_at}`]
    .filter((fact): fact is string => fact !== null);
  return `Now: ${facts.length > 0 ? facts.join(', ') : `“${clip(current.says_now, QUOTE_CHARS)}”`}`;
}

/** What kind of thing an item is, named by its tool once you can open it: "Jira ticket", "Confluence page", "Meeting action". */
export function itemKind(item: OpenItemView, tools?: readonly ConnectedTool[] | null): string {
  const source = item.current?.source;
  const tool = source && 'permalink' in source ? externalSourceProvider(source, tools) : null;
  switch (item.kind) {
    case 'action': return 'Meeting action';
    case 'ticket': return `${tool ?? 'Jira'} ticket`;
    case 'page': return tool ? `${tool} page` : 'Page';
    case 'record': return 'Record';
    case 'document': return 'Document';
  }
}

/** " meeting" after a meeting's title, unless the title already ends with it ("Approved meeting"; R76). */
export function meetingSuffix(title: string): string {
  return /meeting$/iu.test(title.trimEnd()) ? '' : ' meeting';
}

/**
 * A Home row's second line, in plain words: what the meeting needs of it,
 * what it says now when ECHO opened it for you, and whose it is when it is
 * not yours. "Needs: qualified before DVT-R2 starts Nov 2 · Now: In Review,
 * due Nov 20 · Mina's to update". An action's title is already what the
 * meeting needs. Where it came from is on its page; with nothing else to say,
 * the row says what it is ("Meeting action").
 */
export function itemLine(item: OpenItemView, me: string | null, tools?: readonly ConnectedTool[] | null): string {
  const mine = me === null || item.owner.membership_id === me;
  const line = joined([
    item.kind === 'action' || item.expected === null ? null : `Needs: ${item.expected}`,
    nowWords(item),
    mine ? null : `${firstName(item.owner.name)}'s to update`,
  ]);
  return line === '' ? itemKind(item, tools) : line;
}

/** What an item says now on its page, as its tool gave it to you just now ('“Planned for the end of the month.”'); else why it is not shown. */
export function saysNow(item: OpenItemView): string {
  const current = item.current;
  if (!current) return item.reach === 'unavailable' ? 'ECHO couldn\'t read it just now' : item.reach === 'no_access' ? 'You can\'t open it' : 'Not read';
  return `“${current.says_now}”`;
}

/** A due date as its row or its action shows it: "Due Oct 30". */
export function dueWords(due: string | null): string | null {
  return due === null ? null : `Due ${monthDay(due) ?? due}`;
}

/** The tool's own facts about an item you opened just now, under what it says: "In Progress · Due Oct 30 · Mina Patel", only those it has. */
export function liveFacts(item: OpenItemView): string | null {
  const current = item.current;
  if (!current) return null;
  const facts = joined([current.status ?? null, dueWords(current.due_at ?? null), current.assignee ?? null]);
  return facts === '' ? null : facts;
}

/** What ECHO's last check found, in a few words. */
const VERDICT: Readonly<Record<PersonOpenItemVerdictV1, string>> = {
  landed: 'matches now', still_open: 'not updated yet', changed: 'changed, still doesn\'t match', unreadable: 'couldn\'t read it',
};

/** The item page's one faint line: "Checked 2 h ago · not updated yet", naming no one; nothing when ECHO never checked it. */
export function checkWords(check: OpenItemView['check'], now = Date.now()): string | null {
  return check === null ? null : `Checked ${checkedAgo(check.checked_at, now)} · ${VERDICT[check.verdict]}`;
}

/** A list row's faint word when the item's last check matched what the meeting decided. */
export function matchesNow(item: OpenItemView): string | null {
  return item.check?.verdict === 'landed' ? VERDICT.landed : null;
}

/** A follow-up's status (F7). */
export const STAGES: Readonly<Record<PersonOpenItemStateV1, string>> = { unsent: 'Not sent', open: 'Open', done: 'Done', not_relevant: 'Dismissed' };

/** Who owns an item, as its rows say it: "You", or their first name. */
export function ownerWords(item: OpenItemView, me: string | null | undefined): string {
  return item.owner.membership_id === me ? 'You' : firstName(item.owner.name);
}

/** Not sent, and ECHO found no owner, so it fell back to its approver: every surface says "Pick owner", never the approver's name. */
export function ownerUnmatched(item: OpenItemView): boolean {
  return item.owner.match === 'approver' && item.state === 'unsent';
}

/** A follow-up's one qualifier where an answer cites it: its owner and status, "Mara · Open"; "Pick owner · Not sent" while nobody owns it. */
export function ownerAndStatus(item: OpenItemView, me: string | null | undefined): string {
  return `${ownerUnmatched(item) ? 'Pick owner' : ownerWords(item, me)} · ${STAGES[item.state]}`;
}

/** A follow-ups list's current work, read and shown first: not sent yet, or open. */
export const ACTIVE_STATES = ['unsent', 'open'] as const;
/** Closed follow-ups: each status folded at the end of its list, its rows read once it opens. */
export const CLOSED_STATES = ['done', 'not_relevant'] as const;

/**
 * A follow-ups list's rows in order (One place to look v1, F2): its current
 * work (not sent and open) as one list, those that need attention first, and
 * in each part the longest waiting first; then each closed status, oldest
 * first.
 */
export function followUpOrder(items: readonly OpenItemView[], now: number): Record<'active' | (typeof CLOSED_STATES)[number], OpenItemView[]> {
  const since = (item: OpenItemView) => Date.parse(waitingSince(item) ?? item.created_at);
  const needs = (item: OpenItemView) => Number(needsAttention(item, now));
  const closed = (state: (typeof CLOSED_STATES)[number]) => items.filter(item => item.state === state).sort((left, right) => left.created_at.localeCompare(right.created_at));
  return {
    active: items.filter(item => item.state === 'unsent' || item.state === 'open')
      .sort((left, right) => needs(right) - needs(left) || since(left) - since(right) || left.created_at.localeCompare(right.created_at)),
    done: closed('done'), not_relevant: closed('not_relevant'),
  };
}

/** Whose a follow-ups row is, on its list's owner line: its owner's membership id, or "none" while it waits for one (Pick owner). */
export function ownerKey(item: OpenItemView): string {
  return ownerUnmatched(item) ? 'none' : item.owner.membership_id;
}

/** One face on a follow-ups list's owner line: whose (`key`, as ownerKey says), how many they hold open now, and whether one of theirs needs attention. */
export interface OwnerFace { readonly key: string; readonly name: string; readonly count: number; readonly needs: boolean }

/**
 * A follow-ups list's owner line (K, F3), from the rows read: everyone who
 * owns one, counted by what they hold open now (one not sent yet shows on its
 * row, dimmed, never in a count); those with one needing attention first,
 * then by name; then No owner, counted by the rows that wait for one.
 */
export function ownerLine(items: readonly OpenItemView[], now: number): OwnerFace[] {
  const faces = new Map<string, { key: string; name: string; count: number; needs: boolean }>();
  for (const item of items) {
    const key = ownerKey(item);
    const face = faces.get(key) ?? { key, name: key === 'none' ? 'No owner' : item.owner.name, count: 0, needs: false };
    if (key === 'none' || item.state === 'open') face.count += 1;
    face.needs ||= needsAttention(item, now);
    faces.set(key, face);
  }
  const last = (face: OwnerFace) => Number(face.key === 'none');
  return [...faces.values()].sort((a, b) => last(a) - last(b) || Number(b.needs) - Number(a.needs) || a.name.localeCompare(b.name));
}

/** The owner a list's filter shows: its own while one of the rows read is still theirs; else none, and the list shows everyone's again. */
export function ownerShown(items: readonly OpenItemView[], owner: string | undefined): string | null {
  return owner !== undefined && items.some(item => ownerKey(item) === owner) ? owner : null;
}

/** The rows a list shows under its owner filter: every one of that owner's, open or closed; everyone's with none. */
export function ownerRows<Row extends OpenItemView>(items: readonly Row[], owner: string | undefined): readonly Row[] {
  const shown = ownerShown(items, owner);
  return shown === null ? items : items.filter(item => ownerKey(item) === shown);
}

/**
 * A follow-ups row's state mark (K, F5): its status, which the mark draws by
 * shape (a dashed ring not sent, a ring open, a tick done, a struck ring
 * dismissed), and its tone: orange by Home's rule when it needs attention
 * (`signal`), solid once it waited over a week (`late`). Closed, never orange.
 */
export function followUpMark(item: OpenItemView, now: number): { state: PersonOpenItemStateV1; tone: 'quiet' | 'signal' | 'late' } {
  const tone = !needsAttention(item, now) ? 'quiet' : overdue(item, now) ? 'late' : 'signal';
  return { state: item.state, tone };
}

const DAY_MS = 86_400_000;
/** "under a day", "1 day", "4 days". */
const days = (count: number) => (count === 0 ? 'under a day' : count === 1 ? '1 day' : `${count} days`);
/** "today", "1 day ago", "4 days ago". */
const daysAgo = (count: number) => (count === 0 ? 'today' : `${days(count)} ago`);
/** Whole days since a time, never fewer than none. */
const daysSince = (iso: string, now: number) => Math.floor(Math.max(0, now - Date.parse(iso)) / DAY_MS);

/** What a follow-ups row's state mark says on hover and to a screen reader: "Open · waiting 4 days · needs attention". */
export function markWords(item: OpenItemView, now: number): string {
  const { tone } = followUpMark(item, now);
  const status = item.state === 'unsent' ? (ownerUnmatched(item) ? 'Not sent yet · no owner' : 'Not sent yet')
    : item.state === 'open' ? `Open · waiting ${days(waitedDays(item, now) ?? 0)}` : STAGES[item.state];
  return joined([status, tone === 'late' ? 'over a week' : tone === 'signal' ? 'needs attention' : null]);
}

/** A follow-ups row's age (F5): whole days it has waited, or, closed, since it was made; and the same in words, for its hover. */
export function followUpAge(item: OpenItemView, now: number): { days: number; words: string } {
  const waited = waitedDays(item, now);
  if (waited === null) {
    const made = daysSince(item.created_at, now);
    return { days: made, words: `Made ${daysAgo(made)}` };
  }
  return { days: waited, words: item.state === 'unsent' ? `Not sent for ${days(waited)}` : `Waiting ${days(waited)}` };
}

/**
 * A follow-ups row's hover (K): the long words its marks leave out. What it
 * is, the meeting it came from, where it stands and with whom ("Sent to Mina
 * 4 days ago"; "With Rafael" once it was handed on since), and a match ECHO's
 * last check found. The viewer is "you".
 */
export function followUpHover(item: OpenItemView, me: string | null, now: number, tools?: readonly ConnectedTool[] | null): string {
  const who = (person: { membership_id: string; name: string }) => (person.membership_id === me ? 'you' : firstName(person.name));
  const handedOn = item.owner_set_at !== null && item.sent_at !== null && Date.parse(item.owner_set_at) > Date.parse(item.sent_at);
  const where = item.state === 'unsent' ? (ownerUnmatched(item) ? 'No owner yet' : `For ${who(item.owner)}, not sent yet`)
    : item.state === 'open' ? (item.sent_at === null || handedOn ? `With ${who(item.owner)}` : `Sent to ${who(item.owner)} ${daysAgo(daysSince(item.sent_at, now))}`)
    : item.state === 'done' ? `Done${item.state_set_by === null ? '' : ` by ${who(item.state_set_by)}`}` : STAGES.not_relevant;
  return joined([itemKind(item, tools), item.decision ? `from ${item.decision.title}` : null, where, matchesNow(item)]);
}

/** Follow-ups not closed, as a total counts them (F7): not sent yet, or open. A check's verdict never takes one out. */
export function activeTotal(counts: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open'>): number {
  return counts.unsent + counts.open;
}

/** Every follow-up counted, whatever its status. */
export function summaryTotal(counts: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open' | 'done' | 'not_relevant'>): number {
  return activeTotal(counts) + counts.done + counts.not_relevant;
}

/** A total of follow-ups not closed, as a project's feed row shows it: "4 follow-ups", never "open" (that is one status). */
export function followUpCount(count: number): string {
  return count === 1 ? '1 follow-up' : `${count} follow-ups`;
}

/** Parts of a line that are not empty, joined: "1 open · 4 not sent". */
export function joined(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** "1 open · 4 not sent · 2 done · 1 dismissed": follow-ups counted by status, the empty ones left out. */
export function stateCounts(counts: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open' | 'done' | 'not_relevant'>): string {
  return joined([
    counts.open > 0 ? `${counts.open} open` : null, counts.unsent > 0 ? `${counts.unsent} not sent` : null,
    counts.done > 0 ? `${counts.done} done` : null, counts.not_relevant > 0 ? `${counts.not_relevant} dismissed` : null,
  ]);
}

/**
 * How far follow-ups have come, as a meeting's list and a project's line show
 * it: of every one not dismissed, those sent (open or done) and those done.
 */
export interface FollowUpProgress {
  readonly total: number;
  readonly sent: number;
  readonly open: number;
  readonly done: number;
}

/** A summary's progress. Dismissed follow-ups count in none of it. */
export function followUpProgress(counts: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open' | 'done'>): FollowUpProgress {
  return { total: counts.unsent + counts.open + counts.done, sent: counts.open + counts.done, open: counts.open, done: counts.done };
}

/** "1 of 4 sent · 0 done": a meeting's follow-ups under its title. */
export function progressWords(progress: FollowUpProgress): string {
  return `${progress.sent} of ${progress.total} sent · ${progress.done} done`;
}

/**
 * The words after "Follow-ups" on an approved meeting: its follow-ups by
 * status ("1 open · 4 not sent"); with none, how its check stands: "Not
 * checked yet", "Checking…", "Check failed", or "None".
 */
export function followUpsWords(summary: PersonOpenItemsSummaryV1, stage: PersonImpactStageV1 | null): string {
  const counts = stateCounts(summary);
  if (counts !== '') return counts;
  if (stage === null || stage.state === 'pending') return 'Not checked yet';
  if (stage.state === 'running') return 'Checking…';
  if (stage.state === 'failed') return 'Check failed';
  return 'None';
}

/**
 * When ECHO last checked, as the canvas words it: "just now", "5 min ago",
 * "2 h ago", then for six hours or more the day: "today", "yesterday", "Oct 6".
 */
function checkedAgo(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 6 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const today = new Date(now);
  if (time >= new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) return 'today';
  if (time >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()) return 'yesterday';
  return monthDay(iso) ?? '';
}

/**
 * When ECHO last checked one of yours, as "ECHO checked 2 h ago": the latest
 * of the times reads said (your Follow-ups list's own, and Home's, whichever
 * was read since); null when none knows of one.
 */
export function lastChecked(times: readonly (string | null | undefined)[], now: number): string | null {
  const at = times.filter((time): time is string => typeof time === 'string').sort().at(-1);
  return at === undefined ? null : `ECHO checked ${checkedAgo(at, now)}`;
}

/** One event of a follow-up's history. */
interface HistoryEvent { readonly at: string; readonly words: string }

/**
 * What happened to a follow-up, from its own fields (F4): the latest event of
 * each kind, oldest first. Found (a meeting's action: from the meeting).
 * Send, by its approver: "Sent to Mina by you" when it included the item,
 * "Dismissed by you" when it did not. Its owner set. A later change of its
 * status: an item Send dismissed, opened since, went to its owner then ("Sent
 * to Mina by Ari"); any other opened again is "Reopened". The owner a send
 * went to is named only while no one changed the owner since. The viewer is
 * "you".
 */
export function itemHistory(item: OpenItemView, me: string | null): HistoryEvent[] {
  const who = (person: { membership_id: string; name: string }) => (person.membership_id === me ? 'you' : person.name);
  const by = (person: { membership_id: string; name: string } | null) => (person === null ? '' : ` by ${who(person)}`);
  const sent = (at: string, sender: { membership_id: string; name: string } | null) => {
    const ownerSince = item.owner_set_at !== null && Date.parse(item.owner_set_at) > Date.parse(at);
    return `Sent${ownerSince ? '' : ` to ${who(item.owner)}`}${by(sender)}`;
  };
  const events: HistoryEvent[] = [{ at: item.created_at, words: item.kind === 'action' ? 'From the meeting' : 'Found' }];
  if (item.sent_at !== null) events.push({ at: item.sent_at, words: item.send_included === false ? `Dismissed${by(item.approver)}` : sent(item.sent_at, item.approver) });
  if (item.owner_set_at !== null) events.push({ at: item.owner_set_at, words: `Owner set to ${who(item.owner)}${by(item.owner_set_by)}` });
  if (item.state_set_at !== null && item.state_set_at !== item.sent_at) {
    const words = item.state === 'done' ? `Done${by(item.state_set_by)}` : item.state === 'not_relevant' ? `Dismissed${by(item.state_set_by)}`
      : item.send_included === false ? sent(item.state_set_at, item.state_set_by) : `Reopened${by(item.state_set_by)}`;
    events.push({ at: item.state_set_at, words });
  }
  return events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * What a Send said, in place, on a list or an item page, by first name as the
 * buttons say, and counted only past one: "Sent to Mina", "Sent 2 to Mina",
 * "Sent 2 · 1 kept for you", "Kept for you"; and, dismissed (`include`
 * false), "Dismissed", "Dismissed 2". `owners` are the owners of the items it
 * sent; those that are yours stay with you.
 */
export function sentWords(owners: readonly { membership_id: string; name: string }[], me: string | null, include = true): string {
  const counted = (words: string, count: number) => (count === 1 ? words : `${words} ${count}`);
  if (!include) return counted('Dismissed', owners.length);
  const kept = owners.filter(owner => owner.membership_id === me).length;
  const others = owners.filter(owner => owner.membership_id !== me);
  const to = new Set(others.map(owner => owner.membership_id)).size === 1 ? ` to ${firstName(others[0]!.name)}` : '';
  const sent = others.length === 0 ? null : `${counted('Sent', others.length)}${to}`;
  return joined([sent, kept === 0 ? null : sent === null ? `${counted('Kept', kept)} for you` : `${kept} kept for you`]);
}

/** The button that sends one follow-up: "Send to Mina", or "Keep it myself" when you are its owner. */
export function sendLabel(item: OpenItemView, me: string | null): string {
  return item.owner.membership_id === me ? 'Keep it myself' : `Send to ${firstName(item.owner.name)}`;
}

/**
 * Opening a closed follow-up again sends it, for the first time: Send
 * dismissed it and nothing changed its status since. Then its button says
 * "Send to Mina"; any other reopens it ("Reopen"), as does one you own.
 */
export function reopenSends(item: OpenItemView, me: string | null): boolean {
  return item.state === 'not_relevant' && item.send_included === false && item.state_set_at === item.sent_at && item.owner.membership_id !== me;
}

/** A closed follow-up's button: "Send to Mina" when opening it sends it, else "Reopen". */
export function reopenLabel(item: OpenItemView, me: string | null): string {
  return reopenSends(item, me) ? sendLabel(item, me) : 'Reopen';
}
