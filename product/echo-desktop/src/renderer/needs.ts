import type { PersonImpactStageV1, PersonOpenItemKindV1, PersonOpenItemsDecisionCountV1, PersonOpenItemStateV1, PersonOpenItemsSummaryV1 } from '@echo-brain/organization-api';
import type { ConnectedTool, HomeView, OpenItemView } from '../shared/protocol.js';
import { externalSourceProvider } from './answer.js';

// The words Home, Tell the owners?, Did it land? and a decision's open items
// use for what a decision changes (open items and Home v1, section 8; canvas
// row 9).

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
 * Each item's name for its rows, ticks and buttons ("Done: …", "Open in …",
 * "Pick a person: …"): its title. Where two items would share one (two items
 * you can't open), each adds what the decision requires of it; where they
 * still would, its decision when you can read it and that tells them apart
 * ("· from Pilot planning"); and then where it is among those alike ("(2)").
 */
export function itemNames(items: readonly OpenItemView[]): ReadonlyMap<string, string> {
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
  return new Map(items.map(item => {
    const name = names.get(item.item_id)!;
    if (sharing(item).length < 2) return [item.item_id, name];
    const position = (seen.get(name) ?? 0) + 1;
    seen.set(name, position);
    return [item.item_id, `${name} (${position})`];
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

/** Where an item came from: its decision when you can read it, else who sent it. */
export function itemFrom(item: OpenItemView): string {
  return item.decision?.title ?? item.approver.name;
}

/** An item's stage on a decision's or a project's list. */
export const STAGES: Readonly<Record<PersonOpenItemStateV1, string>> = { unsent: 'Not sent', open: 'Open', done: 'Done', not_relevant: 'Not relevant' };

/** Since when an item has been in its stage. */
export function stageSince(item: OpenItemView): string {
  return item.state === 'unsent' ? item.created_at : item.state === 'open' ? item.sent_at ?? item.created_at : item.state_set_at ?? item.created_at;
}

/**
 * A decision's open items as its Impact line calls them open (R35): the ones
 * not sent yet, and the sent ones whose last check neither landed nor could
 * not read them.
 */
export function openCount(decision: PersonOpenItemsDecisionCountV1): number {
  return decision.unsent + Math.max(0, decision.open - decision.landed - decision.unreadable);
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

/** "1 item", "3 items". */
export function itemCount(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
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
 * today", the sum of its decisions' rows and how many of them have any open;
 * nothing when none is open.
 */
export function projectWords(summary: PersonOpenItemsSummaryV1, now = Date.now()): { count: string; from: string; checked: string | null } | null {
  const rows = summary.by_decision.map(openCount).filter(count => count > 0);
  const open = rows.reduce((total, count) => total + count, 0);
  if (open === 0) return null;
  return {
    count: open === 1 ? '1 open item' : `${open} open items`, from: rows.length === 1 ? 'from 1 decision' : `from ${rows.length} decisions`,
    checked: checkedPart(summary.last_checked_at, now),
  };
}

/**
 * Home's footer (canvas 9.1, 9.5): "2 landed since yesterday · 1 with others
 * · checked 2 h ago". Landed: your open items (sent or owned) whose last
 * check saw them land ("since yesterday" is the canvas's words); with others:
 * open items you sent that wait on someone else. Zero counts are left out;
 * null when nothing is left.
 */
export function footerWords(open: Pick<HomeView, 'landed' | 'waiting' | 'last_checked_at'>, now = Date.now()): string | null {
  const words = joined([
    open.landed > 0 ? `${open.landed} landed since yesterday` : null, open.waiting > 0 ? `${open.waiting} with others` : null, checkedPart(open.last_checked_at, now),
  ]);
  return words === '' ? null : words;
}

/**
 * Did it land? (canvas 9.4): a scope's open items by their last check.
 * Landed; still open (still open, changed, or not checked yet); and couldn't
 * read.
 */
export function landedGroups(items: readonly OpenItemView[]): { landed: OpenItemView[]; open: OpenItemView[]; unreadable: OpenItemView[] } {
  const open = items.filter(item => item.state === 'open');
  return {
    landed: open.filter(item => item.check?.verdict === 'landed'),
    open: open.filter(item => item.check === null || item.check.verdict === 'still_open' || item.check.verdict === 'changed'),
    unreadable: open.filter(item => item.check?.verdict === 'unreadable'),
  };
}

/**
 * What a line of Did it land? says after its item: what it says now when you
 * opened it, then why it is where it is: "— not what was decided", "· not
 * checked yet", "· you don't have access" (your own access refused it now), or
 * "· ECHO could not read it".
 */
export function landedNote(item: OpenItemView): string {
  const details = liveDetails(item);
  const verdict = item.check?.verdict;
  const why = item.check === null ? '· not checked yet' : verdict === 'changed' ? '— not what was decided'
    : verdict === 'unreadable' ? (item.reach === 'no_access' ? '· you don\'t have access' : '· ECHO could not read it') : null;
  return [details === null ? null : `· ${details}`, why].filter((part): part is string => part !== null).join(' ');
}

/** Mark N done: the landed items still ticked (`unticked` names the others) that you may close. */
export function markable(items: readonly OpenItemView[], unticked: Readonly<Record<string, true>>): OpenItemView[] {
  return landedGroups(items).landed.filter(item => item.can.set_state && !unticked[item.item_id]);
}
