import type {
  PersonImpactStageV1, PersonOpenItemDecisionV1, PersonOpenItemKindV1, PersonOpenItemsDecisionCountV1, PersonOpenItemStateV1, PersonOpenItemsSummaryV1,
  PersonOpenItemVerdictV1,
} from '@echo-brain/organization-api';
import type { ConnectedTool, HomeView, OpenItemView } from '../shared/protocol.js';
import { externalSourceProvider } from './answer.js';

// The words Home, Tell the owners?, an item's card, Your open items and a
// decision's open items use for what a decision changes (open items and Home
// v1, section 8; canvas row 9; the founder's rulings of 2026-10-09, R63–R70).
// "Check" is ECHO's re-read only: "ECHO checked 2 h ago", "Check now".

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

/** A Send row's count: "2 tickets need updating", "1 page needs updating", "3 items need updating". */
export function needUpdating(count: number, kinds: readonly PersonOpenItemKindV1[]): string {
  const noun = kinds.length === 1 && kinds[0] === 'ticket' ? 'ticket' : kinds.length === 1 && kinds[0] === 'page' ? 'page' : 'item';
  return count === 1 ? `1 ${noun} needs updating` : `${count} ${noun}s need updating`;
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
function firstName(name: string): string {
  return shortNames([name])[0] ?? name;
}

/** A phrase made to start a line: "Says …", "Due Oct 30", "Decision needs: …". */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Mina", "Mina and Rafael", "Mina, Rafael and S. Okafor". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What an item is, when its title is not shown. */
const WHAT: Readonly<Record<PersonOpenItemKindV1, string>> = {
  ticket: 'A Jira ticket', page: 'A page', slack_message: 'A Slack message', record: 'A record', document: 'A document',
};

/**
 * An item's title as you opened it now, else what it is and why its title is
 * not shown: "A Jira ticket you can't open" when your access refused it, "A
 * Jira ticket ECHO couldn't read just now" when the read failed otherwise (an
 * outage is not lost access), and "A Jira ticket" when it was not read.
 */
export function itemTitle(item: OpenItemView): string {
  if (item.current) return item.current.source.label;
  switch (item.reach) {
    case 'unavailable': return `${WHAT[item.kind]} ECHO couldn't read just now`;
    case 'not_read': return WHAT[item.kind];
    default: return `${WHAT[item.kind]} you can't open`;
  }
}

/**
 * Each item's name, and where it is among items alike when nothing else
 * tells them apart: its title; where two items would share one (two items you
 * can't open), what the decision requires of each; where they still would,
 * its decision when you can read it and that tells them apart ("· from Pilot
 * planning"); and then where it is among those alike.
 */
function namesApart(items: readonly OpenItemView[]): ReadonlyMap<string, { name: string; position: number | null }> {
  let names = new Map(items.map(item => [item.item_id, itemTitle(item)]));
  /** The items that share each name. */
  const alike = () => {
    const groups = new Map<string, OpenItemView[]>();
    for (const item of items) groups.set(names.get(item.item_id)!, [...(groups.get(names.get(item.item_id)!) ?? []), item]);
    return (item: OpenItemView) => groups.get(names.get(item.item_id)!)!;
  };
  const decided = (item: OpenItemView) => item.decision?.title ?? null;
  const tellApart = [
    (item: OpenItemView) => (item.expected ? ` → ${item.expected}` : ''),
    // Only where the decisions differ: one decision's items (one Tell the owners? card) gain nothing by it.
    (item: OpenItemView, others: readonly OpenItemView[]) => (item.decision && others.some(other => decided(other) !== item.decision!.title) ? ` · from ${item.decision.title}` : ''),
  ];
  for (const words of tellApart) {
    const sharing = alike();
    names = new Map(items.map(item => {
      const name = names.get(item.item_id)!;
      const others = sharing(item);
      return [item.item_id, others.length > 1 ? `${name}${words(item, others)}` : name];
    }));
  }
  const sharing = alike();
  const seen = new Map<string, number>();
  return new Map(items.map((item): [string, { name: string; position: number | null }] => {
    const name = names.get(item.item_id)!;
    if (sharing(item).length < 2) return [item.item_id, { name, position: null }];
    const position = (seen.get(name) ?? 0) + 1;
    seen.set(name, position);
    return [item.item_id, { name, position }];
  }));
}

/**
 * Each item's name for its ticks and buttons ("Mark updated: …", "Open in …",
 * "Pick a person: …", "Close: …"), apart from every other item's (R37): its
 * title, then what tells it apart from items alike ("→ order six weeks
 * ahead", "· from Pilot planning", "(2)").
 */
export function itemNames(items: readonly OpenItemView[]): ReadonlyMap<string, string> {
  return new Map([...namesApart(items)].map(([id, { name, position }]) => [id, position === null ? name : `${name} (${position})`]));
}

/**
 * Each item's title as a line shows it beside what the decision needs and
 * where it came from (Home's rows, Your open items): its title, and where it
 * is among items alike ("(2)") only when nothing else on the line tells them
 * apart.
 */
export function itemLabels(items: readonly OpenItemView[]): ReadonlyMap<string, string> {
  const apart = namesApart(items);
  return new Map(items.map(item => {
    const position = apart.get(item.item_id)!.position;
    return [item.item_id, position === null ? itemTitle(item) : `${itemTitle(item)} (${position})`];
  }));
}

/** Longest quote of what an item says that a row shows. */
const QUOTE_CHARS = 80;

/** What an item says now, in a few words: "due Oct 30", else its status, else what its text says. Nothing when you cannot open it. */
export function liveDetails(item: OpenItemView): string | null {
  const current = item.current;
  if (!current) return null;
  if (current.due_at !== undefined) return `due ${monthDay(current.due_at) ?? current.due_at}`;
  if (current.status !== undefined) return current.status;
  const says = [...current.says_now];
  return `says "${says.length > QUOTE_CHARS ? `${says.slice(0, QUOTE_CHARS - 1).join('')}…` : current.says_now}"`;
}

/** What an item says now, then what the decision requires of it: "due Oct 30 → launch next week". Parts that are missing are left out. */
export function itemChange(item: OpenItemView): string {
  return [liveDetails(item), item.expected ? `→ ${item.expected}` : null].filter((part): part is string => part !== null).join(' ');
}

/**
 * An item and what the decision requires of it, on one line: its title, or
 * the name `itemNames` gave it, then "· due Oct 30 → launch next week" (live
 * details → `expected`), leaving `expected` out when the name already says it.
 */
export function itemParts(item: OpenItemView, name = itemTitle(item)): { title: string; change: string } {
  const details = liveDetails(item);
  const expected = item.expected !== null && !name.includes(`→ ${item.expected}`) ? `→ ${item.expected}` : null;
  return { title: name, change: [details === null ? null : `· ${details}`, expected].filter((part): part is string => part !== null).join(' ') };
}

/** What kind of thing an item is, named by its tool once you can open it: "Jira ticket", "Confluence page". */
export function itemKind(item: OpenItemView, tools?: readonly ConnectedTool[] | null): string {
  const source = item.current?.source;
  const tool = source && 'permalink' in source ? externalSourceProvider(source, tools) : null;
  switch (item.kind) {
    case 'ticket': return `${tool ?? 'Jira'} ticket`;
    case 'page': return tool ? `${tool} page` : 'Page';
    case 'slack_message': return 'Slack message';
    case 'record': return 'Record';
    case 'document': return 'Document';
  }
}

/**
 * A decision as an open item names it: "Pilot planning meeting, approved Oct
 * 6" (or "· approved Oct 6" on the item's card). Every decision with open
 * items is a meeting someone approved, named as its Approve row named it.
 */
export function approvedMeeting(decision: Pick<PersonOpenItemDecisionV1, 'title' | 'approved_at'>, separator: ', ' | ' · ' = ', '): string {
  const day = monthDay(decision.approved_at);
  return `${decision.title} meeting${day === null ? '' : `${separator}approved ${day}`}`;
}

/** Where an item came from: its decision when you can read it, else who sent it ("sent by Mina"). */
export function whereFrom(item: OpenItemView): string {
  return item.decision ? approvedMeeting(item.decision) : `sent by ${firstName(item.approver.name)}`;
}

/** A Home row's title: "<item> doesn't match the decision yet", or, for an item the check did not assess, "<item> may need updating". */
export function itemHeadline(item: OpenItemView, label: string): string {
  return item.relation === null ? `${label} may need updating` : `${label} doesn't match the decision yet`;
}

/**
 * What an item says now, then what the decision needs: 'Says "starts after
 * freeze" → decision needs: pilot starts next week'. What it says now only
 * when ECHO opened it for you; parts that are missing are left out.
 */
export function itemNeeds(item: OpenItemView): string | null {
  const parts = [liveDetails(item), item.expected === null ? null : `decision needs: ${item.expected}`].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : capitalized(parts.join(' → '));
}

/** An item card's "Now": what the item says now ('Says "starts after freeze"', "Due Oct 30"), else its title, which says why it is not shown. */
export function itemNow(item: OpenItemView): string {
  const details = liveDetails(item);
  return details === null ? itemTitle(item) : capitalized(details);
}

/** Whose an item is to update: "yours to update", or "Mina's to update" when you are not its owner (you sent it, or it fell back to you). */
export function itemWhose(item: OpenItemView, me: string | null): string {
  return me === null || item.owner.membership_id === me ? 'yours to update' : `${firstName(item.owner.name)}'s to update`;
}

/**
 * A Home row's muted line: what the item is, where it came from, and why it is
 * back. "Confluence page · Pilot planning meeting, approved Oct 6 · changed
 * since you got it, still doesn't match" for its owner; "Mina's to update ·
 * changed since you sent it" on its approver's Review row. An item that is
 * not yours (it fell back to you) is named as its owner's, never as yours.
 */
export function itemWhy(item: OpenItemView, me: string | null, tools?: readonly ConnectedTool[] | null): string {
  const changed = item.check?.verdict === 'changed';
  const owner = me === null || item.owner.membership_id === me;
  const since = !changed ? null : owner ? 'changed since you got it, still doesn\'t match'
    : item.approver.membership_id === me ? 'changed since you sent it' : 'changed since it was sent';
  return joined([itemKind(item, tools), whereFrom(item), owner ? null : itemWhose(item, me), since]);
}

/** What ECHO saw when it last checked an item, naming no one; nothing when it never checked it. */
export function checkLine(check: OpenItemView['check'], now = Date.now()): string | null {
  if (check === null) return null;
  const at = `ECHO checked ${checkedAgo(check.checked_at, now)}`;
  switch (check.verdict) {
    case 'changed': return `${at}: it changed since it was sent, but still doesn't match.`;
    case 'still_open': return `${at}: not updated yet.`;
    case 'landed': return `${at}: it matches the decision now.`;
    case 'unreadable': return `${at} but couldn't read it.`;
  }
}

/** An item's stage on a decision's or a project's list. */
export const STAGES: Readonly<Record<PersonOpenItemStateV1, string>> = { unsent: 'Not sent', open: 'Open', done: 'Done', not_relevant: 'Not relevant' };

/** Since when an item has been in its stage. */
export function stageSince(item: OpenItemView): string {
  return item.state === 'unsent' ? item.created_at : item.state === 'open' ? item.sent_at ?? item.created_at : item.state_set_at ?? item.created_at;
}

/**
 * A decision's (or a scope's) open items as its Impact line calls them open
 * (R35): the ones not sent yet, and the sent ones whose last check neither
 * matched the decision nor could not read them.
 */
export function openCount(counts: Pick<PersonOpenItemsDecisionCountV1, 'unsent' | 'open' | 'landed' | 'unreadable'>): number {
  return counts.unsent + Math.max(0, counts.open - counts.landed - counts.unreadable);
}

/** Parts of a line that are not empty, joined: "1 open · 1 handled". */
function joined(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/**
 * When ECHO last checked, as the canvas words it: "just now", "5 min ago",
 * "2 h ago", then for six hours or more the day: "today", "yesterday", "Oct 6".
 */
export function checkedAgo(iso: string, now = Date.now()): string {
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

/** "checked 2 h ago", when anything was checked. */
function checkedPart(at: string | null, now: number): string | null {
  return at === null ? null : `checked ${checkedAgo(at, now)}`;
}

/**
 * The words after "Impact" on an approved decision (canvas 9.6), its items
 * counted once each: "1 open · 1 handled · 1 couldn't read · checked just
 * now". Open items that neither landed nor went unread are open; closed and
 * landed ones are handled; unsent ones are "not sent". With no item, how its
 * check stands: "Not checked yet", "Checking…", "Check failed", or "Nothing
 * to change".
 */
export function impactWords(summary: PersonOpenItemsSummaryV1, stage: PersonImpactStageV1 | null, now = Date.now()): string {
  const open = Math.max(0, summary.open - summary.landed - summary.unreadable);
  const handled = summary.done + summary.not_relevant + summary.landed;
  const counts = joined([
    open > 0 ? `${open} open` : null, summary.unsent > 0 ? `${summary.unsent} not sent` : null, handled > 0 ? `${handled} handled` : null,
    summary.unreadable > 0 ? `${summary.unreadable} couldn't read` : null,
  ]);
  if (counts !== '') return joined([counts, checkedPart(summary.last_checked_at, now)]);
  if (stage === null || stage.state === 'pending') return 'Not checked yet';
  if (stage.state === 'running') return 'Checking…';
  if (stage.state === 'failed') return 'Check failed';
  return 'Nothing to change';
}

/**
 * A project's line (canvas 9.7): "4 open items · from 2 decisions · checked
 * today". The total is the whole project's, from its summary, as its rows
 * count (R35): in project scope it is the sum of the rows, and it stays exact
 * past the 100 decisions a summary lists. "From" counts the listed decisions
 * with any open. While any item is unsent or open the line stays, so Check
 * now and the way to the project's items never go (R72): when everything left
 * matched or could not be read, it counts what is not closed (Part 1's
 * words). Nothing when nothing is unsent or open.
 */
export function projectWords(summary: PersonOpenItemsSummaryV1, now = Date.now()): { count: string; from: string; checked: string | null } | null {
  const left = (counts: Pick<PersonOpenItemsDecisionCountV1, 'unsent' | 'open'>) => counts.unsent + counts.open;
  if (left(summary) === 0) return null;
  const count = openCount(summary) > 0 ? openCount : left;
  const open = count(summary);
  const decisions = summary.by_decision.filter(decision => count(decision) > 0).length;
  return {
    count: open === 1 ? '1 open item' : `${open} open items`, from: decisions === 0 ? '' : decisions === 1 ? 'from 1 decision' : `from ${decisions} decisions`,
    checked: checkedPart(summary.last_checked_at, now),
  };
}

/**
 * Home's footer (canvas 9.1, 9.5; R69): "1 matches its decision now · 2
 * waiting on others · ECHO checked 2 h ago". Matching: your open items (sent
 * or owned) whose last check found them as decided; waiting on others: open
 * items you sent that wait on someone else. Zero counts are left out; null
 * when nothing is left.
 */
export function homeFooter(open: Pick<HomeView, 'landed' | 'waiting' | 'last_checked_at'>, now = Date.now()): string | null {
  const words = joined([
    open.landed === 0 ? null : open.landed === 1 ? '1 matches its decision now' : `${open.landed} match their decision now`,
    open.waiting > 0 ? `${open.waiting} waiting on others` : null, open.last_checked_at === null ? null : `ECHO checked ${checkedAgo(open.last_checked_at, now)}`,
  ]);
  return words === '' ? null : words;
}

/** An open item's status on Your open items: its last check's verdict, or not checked yet. */
export type ItemStatusKey = PersonOpenItemVerdictV1 | 'unchecked';

/** The words for each status (R68). Where your own access refused the item, its title already says so. */
export const STATUS: Readonly<Record<ItemStatusKey, string>> = {
  landed: 'Matches now', still_open: 'Not updated yet', changed: 'Changed, still doesn\'t match', unreadable: 'ECHO couldn\'t read it', unchecked: 'Not checked yet',
};

export function statusOf(item: OpenItemView): ItemStatusKey {
  return item.check?.verdict ?? 'unchecked';
}

/** Matches first, then not updated or changed, then couldn't read or not checked. */
const STATUS_ORDER: Readonly<Record<ItemStatusKey, number>> = { landed: 0, still_open: 1, changed: 1, unreadable: 2, unchecked: 2 };

/** A scope's open items in status order, each part in the order it came. */
export function byStatus(items: readonly OpenItemView[]): OpenItemView[] {
  return items.filter(item => item.state === 'open').sort((left, right) => STATUS_ORDER[statusOf(left)] - STATUS_ORDER[statusOf(right)]);
}

/**
 * Your open items as one list, or, for your own items from more than one
 * decision, under a small header per decision ("Pilot planning meeting,
 * approved Oct 6"; "Sent by Mina Patel" for a decision you cannot read),
 * each in status order.
 */
export function statusGroups(items: readonly OpenItemView[], scope: 'mine' | 'record' | 'project'): { key: string; header: string | null; items: OpenItemView[] }[] {
  const open = items.filter(item => item.state === 'open');
  const groups = new Map<string, { key: string; header: string; items: OpenItemView[] }>();
  for (const item of open) {
    const key = item.decision ? item.decision.record_sha256 : `sent:${item.approver.membership_id}`;
    const group = groups.get(key) ?? { key, header: item.decision ? approvedMeeting(item.decision) : `Sent by ${item.approver.name}`, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  if (scope !== 'mine' || groups.size < 2) return [{ key: 'all', header: null, items: byStatus(open) }];
  return [...groups.values()].map(group => ({ ...group, items: byStatus(group.items) }));
}

/** The matching items you may close: "Close" on each line, and "Close all N that match". */
export function closable(items: readonly OpenItemView[]): OpenItemView[] {
  return items.filter(item => item.state === 'open' && item.check?.verdict === 'landed' && item.can.set_state);
}

/** Under Your open items' heading: "3 open · ECHO checked 2 h ago". */
export function statusSubline(open: number, checkedAt: string | null, now = Date.now()): string {
  return joined([`${open} open`, checkedAt === null ? null : `ECHO checked ${checkedAgo(checkedAt, now)}`]);
}
