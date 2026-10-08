import {
  PERSON_IMPACT_CARD_LIMITS_V1 as LIMITS,
  validatePersonImpactCardV1,
  type PersonAnswerCitationV6,
  type PersonImpactAffectedV1,
  type PersonImpactCardV1,
  type PersonImpactRelationV1,
} from "@echo-brain/organization-api";
import { cleanLine } from "../agentic-ask-v1-model-protocol.js";
import { detailsOfImpactItemV1, ownerOfImpactItemV1, statesImpactDateV1 } from "./impact-card-renderer-v1.js";

/**
 * The impact card as a run keeps it (runs store and impact card v1, section
 * 4, and ADR-0032). A stored card holds ECHO's own judgments and pointers and
 * never a word read from outside ECHO: Slack's API terms forbid persistent
 * copies, and ECHO keeps no Jira or Confluence excerpts. Every view opens each
 * cited item again as the viewer and rebuilds the outside parts from that
 * fresh read.
 */

export interface StoredImpactCardV1 {
  readonly schema_version: 1;
  readonly status: PersonImpactCardV1["status"];
  readonly decided: PersonImpactCardV1["decided"];
  readonly affected: readonly { readonly citation_index: number; readonly relation?: PersonImpactRelationV1;
    readonly date_at_risk?: { readonly date: string; readonly milestone: string }; readonly says_now?: string /* ECHO-local only */ }[];
  readonly unconfirmed: readonly string[];
  readonly citations: readonly unknown[];   // citation pointers only (PersonAnswerCitationV6['citation'])
}

/** An ECHO record or document: the only items whose text a stored card may keep. */
const isLocal = (citation: PersonAnswerCitationV6["citation"]): boolean => citation.kind === "approved_record" || citation.kind === "source_revision";

/** Where each citation lands once the others are dropped: its new index, or -1 for a dropped one. */
function positions(keep: readonly boolean[]): readonly number[] {
  let next = 0;
  return keep.map(kept => (kept ? next++ : -1));
}

/** A note compared by its words: NFC, one space between words, no case. */
const folded = (value: string): string => value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();

/** Removes every word read from outside ECHO. `outsideLabels` are the bundle's labels of non-ECHO items. */
export function storableImpactCardV1(input: PersonImpactCardV1, outsideLabels: readonly string[]): StoredImpactCardV1 {
  const card = validatePersonImpactCardV1(input);
  const local = card.citations.map(entry => isLocal(entry.citation));
  // A decided line comes from the approved record. One citing an outside item is dropped, never kept.
  const decided = card.decided.filter(entry => local[entry.citation_index] === true);
  const used = card.citations.map((_, at) => decided.some(entry => entry.citation_index === at) || card.affected.some(entry => entry.citation_index === at));
  const at = positions(used);

  // A note that names an outside item (by a label the caller gave or one this card cites) becomes one count.
  const labels = [...outsideLabels, ...card.citations.filter((_, index) => !local[index]).map(entry => entry.label)].map(folded).filter(label => label.length > 0);
  const named = (note: string): boolean => labels.some(label => folded(note).includes(label));
  const unread = card.unconfirmed.filter(named).length;
  const countNote = unread === 1 ? "1 item could not be read." : `${unread} items could not be read.`;
  const unconfirmed: string[] = [];
  for (const note of card.unconfirmed) {
    const kept = named(note) ? countNote : note;
    if (!unconfirmed.includes(kept)) unconfirmed.push(kept);
  }

  return Object.freeze({
    schema_version: 1 as const,
    status: card.status,
    decided: Object.freeze(decided.map(entry => Object.freeze({ text: entry.text, citation_index: at[entry.citation_index]! }))),
    affected: Object.freeze(card.affected.map(entry => Object.freeze({
      citation_index: at[entry.citation_index]!,
      ...(entry.relation === undefined ? {} : { relation: entry.relation }),
      ...(entry.date_at_risk === undefined ? {} : { date_at_risk: Object.freeze({ date: entry.date_at_risk.date, milestone: entry.date_at_risk.milestone }) }),
      // What an outside item says is read again on every view; only ECHO's own text is kept.
      ...(local[entry.citation_index] === true ? { says_now: entry.says_now } : {}),
    }))),
    unconfirmed: Object.freeze(unconfirmed),
    citations: Object.freeze(card.citations.filter((_, index) => used[index]).map(entry => entry.citation)),
  });
}

/** One cited item as the viewer can open it now. */
export interface FreshImpactItemV1 {
  readonly citation: PersonAnswerCitationV6;      // as released to this viewer now
  readonly text?: string; readonly label: string;
  readonly attributes?: { readonly owner?: string; readonly due_at?: string; readonly status?: string };
  readonly local: boolean;                        // approved_record or source_revision
}

/** What an outside item says now: the first characters of its current text on one line, else its title and details. */
function currentLine(item: FreshImpactItemV1): string {
  const text = cleanLine(item.text, LIMITS.line_chars);
  return text.length > 0 ? text : detailsOfImpactItemV1(item);
}

/** Rebuilds the viewer's card from the stored form and fresh reads (null = could not open). */
export function refreshImpactCardV1(stored: StoredImpactCardV1, fresh: readonly (FreshImpactItemV1 | null)[]): { readonly card: PersonImpactCardV1; readonly hidden: number } {
  if (fresh.length !== stored.citations.length) throw new Error("refreshing an impact card needs one entry per stored citation");
  for (const entry of [...stored.decided, ...stored.affected]) {
    if (!Number.isSafeInteger(entry.citation_index) || entry.citation_index < 0 || entry.citation_index >= fresh.length) throw new Error("a stored impact card row points at no stored citation");
  }
  // What the viewer can no longer open is hidden with the rows that cite it.
  const opened = fresh.map(item => item !== null);
  const at = positions(opened);
  const item = (index: number): FreshImpactItemV1 => fresh[index]!;

  const decided = stored.decided.filter(entry => opened[entry.citation_index]).map(entry => ({ text: entry.text, citation_index: at[entry.citation_index]! }));
  const affected = stored.affected.filter(entry => opened[entry.citation_index]).map((entry): PersonImpactAffectedV1 => {
    const current = item(entry.citation_index);
    const owner = ownerOfImpactItemV1(current);
    return {
      citation_index: at[entry.citation_index]!,
      says_now: current.local && entry.says_now !== undefined ? entry.says_now : currentLine(current),
      ...(entry.relation === undefined ? {} : { relation: entry.relation }),
      ...(owner === undefined ? {} : { owner }),
      // A date the item no longer states is dropped; the row stays.
      ...(entry.date_at_risk !== undefined && statesImpactDateV1(current, entry.date_at_risk.date) ? { date_at_risk: entry.date_at_risk } : {}),
    };
  });
  const people = new Map<string, number[]>();
  for (const row of affected) if (row.owner !== undefined) people.set(row.owner, [...(people.get(row.owner) ?? []), row.citation_index]);

  // The validator returns the card in its fixed shape, or throws on a bug here.
  const card = validatePersonImpactCardV1({
    decided, affected, unconfirmed: stored.unconfirmed, people: [...people].map(([name, owned]) => ({ name, items: owned })),
    status: stored.status, citations: fresh.flatMap(current => (current === null ? [] : [current.citation])),
  });
  return Object.freeze({ card, hidden: opened.filter(kept => !kept).length });
}
