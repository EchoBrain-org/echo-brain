import type { PersonImpactStageV1, PersonOpenItemKindV1, PersonOpenItemStateV1, PersonOpenItemsSummaryV1 } from '@echo-brain/organization-api';
import type { ConnectedTool, OpenItemView } from '../shared/protocol.js';
import { externalSourceProvider } from './answer.js';

// The words Home, Tell the owners? and a decision's open items use for what a
// decision changes (open items and Home v1, section 8; canvas row 9).

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
 * Each item's name for its buttons ("Done: …", "Open in …", "Pick a
 * person: …"): its title, and where two items would share one (two items you
 * can't open), what the decision requires of it, as its row shows it.
 */
export function itemNames(items: readonly OpenItemView[]): ReadonlyMap<string, string> {
  const titles = new Map(items.map(item => [item.item_id, itemTitle(item)]));
  const counts = new Map<string, number>();
  for (const title of titles.values()) counts.set(title, (counts.get(title) ?? 0) + 1);
  return new Map(items.map(item => {
    const title = titles.get(item.item_id)!;
    return [item.item_id, counts.get(title)! > 1 && item.expected ? `${title} → ${item.expected}` : title];
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
 * An item and what the decision requires of it, on one line: its title, then
 * "· due Oct 30 → launch next week" (live details → `expected`).
 */
export function itemParts(item: OpenItemView): { title: string; change: string } {
  const change = itemChange(item);
  return { title: itemTitle(item), change: change !== '' && liveDetails(item) !== null ? `· ${change}` : change };
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

/** Items not closed: the ones still found, and the ones sent and open. */
export function openCount(summary: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open'>): number {
  return summary.unsent + summary.open;
}

/**
 * The words after "Impact" on an approved decision: "2 open · 1 not sent",
 * "Not checked yet", "Checking…", "Check failed", or "Nothing to change".
 */
export function impactWords(summary: PersonOpenItemsSummaryV1, stage: PersonImpactStageV1 | null): string {
  const handled = summary.done + summary.not_relevant;
  const parts = [
    summary.open > 0 ? `${summary.open} open` : null, summary.unsent > 0 ? `${summary.unsent} not sent` : null, handled > 0 ? `${handled} handled` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(' · ');
  if (stage === null || stage.state === 'pending') return 'Not checked yet';
  if (stage.state === 'running') return 'Checking…';
  if (stage.state === 'failed') return 'Check failed';
  return 'Nothing to change';
}

/** A project's line: "4 open items · from 2 decisions", or nothing when none is open. */
export function projectWords(summary: PersonOpenItemsSummaryV1): { count: string; from: string } | null {
  const open = openCount(summary);
  if (open === 0) return null;
  const decisions = summary.by_decision.filter(decision => openCount(decision) > 0).length;
  return { count: open === 1 ? '1 open item' : `${open} open items`, from: decisions === 0 ? '' : decisions === 1 ? 'from 1 decision' : `from ${decisions} decisions` };
}
