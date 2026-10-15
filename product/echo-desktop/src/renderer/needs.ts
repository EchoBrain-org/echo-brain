import type {
  PersonImpactStageV1, PersonOpenItemDecisionV1, PersonOpenItemKindV1, PersonOpenItemStateV1, PersonOpenItemsSummaryV1, PersonOpenItemVerdictV1,
} from '@echo-brain/organization-api';
import type { ConnectedTool, HomeView, OpenItemView } from '../shared/protocol.js';
import { externalSourceProvider } from './answer.js';

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
  return count === 1 ? '1 follow-up to send' : `${count} follow-ups to send`;
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

/** A phrase made to start a line: "Says …", "Due Oct 30", "Decision needs: …". */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What an item is, when its title is not shown. */
const WHAT: Readonly<Record<PersonOpenItemKindV1, string>> = {
  action: 'An action', ticket: 'A Jira ticket', page: 'A page', slack_message: 'A Slack message', record: 'A record', document: 'A document',
};

/**
 * An item's title. A meeting's action is its own words (`expected`). Any
 * other item is its title as you opened it now, else what it is and why its
 * title is not shown: "A Jira ticket you can't open" when your access refused
 * it, "A Jira ticket ECHO couldn't read just now" when the read failed
 * otherwise (an outage is not lost access), and "A Jira ticket" when it was
 * not read.
 */
export function itemTitle(item: OpenItemView): string {
  if (item.kind === 'action') return item.expected ?? WHAT.action;
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
    // An action's title is already what the decision requires of it.
    (item: OpenItemView) => (item.kind !== 'action' && item.expected ? ` → ${item.expected}` : ''),
    // Only where the decisions differ: one meeting's items gain nothing by it.
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
 * Each item's name for its tick and its owner ("Owner of …"), apart from
 * every other item's (R37): its title, then what tells it apart from items
 * alike ("→ order six weeks ahead", "· from Pilot planning", "(2)").
 */
export function itemNames(items: readonly OpenItemView[]): ReadonlyMap<string, string> {
  return new Map([...namesApart(items)].map(([id, { name, position }]) => [id, position === null ? name : `${name} (${position})`]));
}

/**
 * Each item's title as a row shows it beside what it needs and where it came
 * from (Home, the follow-ups lists): its title, and where it is among items
 * alike ("(2)") only when nothing else on the row tells them apart.
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
function liveDetails(item: OpenItemView): string | null {
  const current = item.current;
  if (!current) return null;
  if (current.due_at !== undefined) return `due ${monthDay(current.due_at) ?? current.due_at}`;
  if (current.status !== undefined) return current.status;
  const says = [...current.says_now];
  return `says "${says.length > QUOTE_CHARS ? `${says.slice(0, QUOTE_CHARS - 1).join('')}…` : current.says_now}"`;
}

/** What kind of thing an item is, named by its tool once you can open it: "Jira ticket", "Confluence page", "Meeting action". */
export function itemKind(item: OpenItemView, tools?: readonly ConnectedTool[] | null): string {
  const source = item.current?.source;
  const tool = source && 'permalink' in source ? externalSourceProvider(source, tools) : null;
  switch (item.kind) {
    case 'action': return 'Meeting action';
    case 'ticket': return `${tool ?? 'Jira'} ticket`;
    case 'page': return tool ? `${tool} page` : 'Page';
    case 'slack_message': return 'Slack message';
    case 'record': return 'Record';
    case 'document': return 'Document';
  }
}

/**
 * A meeting as a follow-up names it: "Pilot planning meeting, approved Oct
 * 6". Every meeting with follow-ups is one someone approved, named as its
 * Approve row named it.
 */
function approvedMeeting(decision: Pick<PersonOpenItemDecisionV1, 'title' | 'approved_at'>): string {
  const day = monthDay(decision.approved_at);
  return `${decision.title}${meetingSuffix(decision.title)}${day === null ? '' : `, approved ${day}`}`;
}

/** " meeting" after a meeting's title, unless the title already ends with it ("Approved meeting"; R76). */
export function meetingSuffix(title: string): string {
  return /meeting$/iu.test(title.trimEnd()) ? '' : ' meeting';
}

/** Where an item came from: its meeting when you can read it, else who sent it ("sent by Mina"). */
function whereFrom(item: OpenItemView): string {
  return item.decision ? approvedMeeting(item.decision) : `sent by ${firstName(item.approver.name)}`;
}

/**
 * A document's second line on Home: what it says now, then what the meeting
 * needs: 'Says "starts after freeze" → decision needs: pilot starts next
 * week'. What it says now only when ECHO opened it for you; parts that are
 * missing are left out. Nothing for a meeting's action: its title says it.
 */
export function itemNeeds(item: OpenItemView): string | null {
  if (item.kind === 'action') return null;
  const parts = [liveDetails(item), item.expected === null ? null : `decision needs: ${item.expected}`].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : capitalized(parts.join(' → '));
}

/** Whose an item is to update: "yours to update", or "Mina's to update" when you are not its owner (you sent it, or it fell back to you). */
function itemWhose(item: OpenItemView, me: string | null): string {
  return me === null || item.owner.membership_id === me ? 'yours to update' : `${firstName(item.owner.name)}'s to update`;
}

/**
 * A Home row's muted line: what the item is, where it came from, and whose it
 * is when it is not yours. "Confluence page · Pilot planning meeting,
 * approved Oct 6"; "Jira ticket · Pilot planning meeting, approved Oct 6 ·
 * Mina's to update" on its approver's Review row.
 */
export function itemWhy(item: OpenItemView, me: string | null, tools?: readonly ConnectedTool[] | null): string {
  const owner = me === null || item.owner.membership_id === me;
  return joined([itemKind(item, tools), whereFrom(item), owner ? null : itemWhose(item, me)]);
}

/** What an item says now on its page, as its tool gave it to you just now ('“Planned for the end of the month.”'); else why it is not shown. */
export function saysNow(item: OpenItemView): string {
  const current = item.current;
  if (!current) return item.reach === 'unavailable' ? 'ECHO couldn\'t read it just now' : item.reach === 'no_access' ? 'You can\'t open it' : 'Not read';
  return `“${current.says_now}”`;
}

/** The tool's own facts about an item you opened just now, under what it says: "In Progress · Due Oct 30 · Mina Patel", only those it has. */
export function liveFacts(item: OpenItemView): string | null {
  const current = item.current;
  if (!current) return null;
  const facts = joined([current.status ?? null, current.due_at === undefined ? null : `Due ${monthDay(current.due_at) ?? current.due_at}`, current.assignee ?? null]);
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

/** The order of a follow-ups list's groups. */
const GROUPS: readonly PersonOpenItemStateV1[] = ['unsent', 'open', 'done', 'not_relevant'];

/**
 * A follow-ups list's groups, in order (Not sent, Open, Done, Dismissed), the
 * empty ones left out; in each, the meeting's actions first, then documents,
 * then oldest first.
 */
export function itemGroups(items: readonly OpenItemView[]): { state: PersonOpenItemStateV1; items: OpenItemView[] }[] {
  const rank = (item: OpenItemView) => (item.kind === 'action' ? 0 : 1);
  return GROUPS.map(state => ({
    state, items: items.filter(item => item.state === state).sort((left, right) => rank(left) - rank(right) || left.created_at.localeCompare(right.created_at)),
  })).filter(group => group.items.length > 0);
}

/** Follow-ups not closed, as a total counts them (F7): not sent yet, or open. A check's verdict never takes one out. */
export function activeTotal(counts: Pick<PersonOpenItemsSummaryV1, 'unsent' | 'open'>): number {
  return counts.unsent + counts.open;
}

/** A total of follow-ups not closed, as a project's feed row shows it: "4 follow-ups", never "open" (that is one status). */
export function followUpCount(count: number): string {
  return count === 1 ? '1 follow-up' : `${count} follow-ups`;
}

/** Parts of a line that are not empty, joined: "1 open · 4 not sent". */
function joined(parts: readonly (string | null)[]): string {
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
function checkedAgo(iso: string, now = Date.now()): string {
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
 * Home's footer (F9): "2 waiting on others · ECHO checked 2 h ago": open
 * items you sent that wait on someone else, and when ECHO last checked one of
 * yours. Zero counts are left out; null when nothing is left.
 */
export function homeFooter(open: Pick<HomeView, 'waiting' | 'last_checked_at'>, now = Date.now()): string | null {
  const words = joined([
    open.waiting > 0 ? `${open.waiting} waiting on others` : null, open.last_checked_at === null ? null : `ECHO checked ${checkedAgo(open.last_checked_at, now)}`,
  ]);
  return words === '' ? null : words;
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
 * What a list's Send said, in place, by first name as the buttons say: "Sent
 * 1 to Mina", "Sent 2 · 1 kept for you", "Kept 1 for you". `owners` are the
 * owners of the items it sent; those that are yours stay with you.
 */
export function sentWords(owners: readonly { membership_id: string; name: string }[], me: string | null): string {
  const kept = owners.filter(owner => owner.membership_id === me).length;
  const others = owners.filter(owner => owner.membership_id !== me);
  const people = new Set(others.map(owner => owner.membership_id));
  const sent = others.length === 0 ? null : `Sent ${others.length}${people.size === 1 && kept === 0 ? ` to ${firstName(others[0]!.name)}` : ''}`;
  return joined([sent, kept === 0 ? null : sent === null ? `Kept ${kept} for you` : `${kept} kept for you`]);
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
  return reopenSends(item, me) ? `Send to ${firstName(item.owner.name)}` : 'Reopen';
}
