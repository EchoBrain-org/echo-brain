import { canonicalJson } from "@echo-brain/federation-protocol";
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

/** What a stored line says in place of an outside item's title. */
const CITED_ITEM = "a cited item";
/** A renderer note cut short by `cleanLine` still carries this many leading characters of the title it names. */
const LABEL_PREFIX_CHARS = 200;

/** Finds, and removes, the titles of outside items in a line of ECHO's own writing. */
interface LabelScreen {
  /** The line names an outside item. */
  readonly names: (line: string) => boolean;
  /** The line with each named title replaced by "a cited item". */
  readonly scrub: (line: string) => string;
}

/**
 * Titles match whatever their case, spacing or Unicode form, whole or by their
 * first 200 characters (a note cut short by `cleanLine` keeps no more than
 * that). A blank title matches nothing.
 */
function screenFor(labels: readonly string[]): LabelScreen {
  const parts = new Map<string, { readonly length: number; readonly needsTrailingBoundary: boolean }>();
  for (const raw of labels) {
    const label = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (label.length === 0) continue;
    const characters = [...label];
    const variants = characters.length > LABEL_PREFIX_CHARS
      ? [{ value: label, needsTrailingBoundary: true }, { value: characters.slice(0, LABEL_PREFIX_CHARS).join("").trim(), needsTrailingBoundary: false }]
      : [{ value: label, needsTrailingBoundary: true }];
    for (const variant of variants) {
      const pattern = variant.value.split(" ").map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
      parts.set(`${variant.needsTrailingBoundary ? 'full:' : 'prefix:'}${pattern}`, { length: characters.length, needsTrailingBoundary: variant.needsTrailingBoundary });
    }
  }
  if (parts.size === 0) return { names: () => false, scrub: line => line };
  // A longer title is tried first, so a whole title wins over its own prefix.
  const source = [...parts].sort((left, right) => right[1].length - left[1].length).map(([key, variant]) => {
    const pattern = key.slice(key.indexOf(':') + 1);
    return `(?<![\\p{L}\\p{N}])${pattern}${variant.needsTrailingBoundary ? '(?![\\p{L}\\p{N}])' : ''}`;
  }).join("|");
  const find = new RegExp(source, "iu");
  const every = new RegExp(source, "giu");
  return {
    names: line => find.test(line.normalize("NFC")),
    scrub: line => {
      const text = line.normalize("NFC");
      return find.test(text) ? cleanLine(text.replace(every, CITED_ITEM), LIMITS.line_chars) : line;
    },
  };
}

/** Removes every word read from outside ECHO. `outsideLabels` are the bundle's labels of non-ECHO items. */
export function storableImpactCardV1(input: PersonImpactCardV1, outsideLabels: readonly string[]): StoredImpactCardV1 {
  const card = validatePersonImpactCardV1(input);
  const local = card.citations.map(entry => isLocal(entry.citation));
  // A decided line comes from the approved record. One citing an outside item is dropped, never kept.
  const decided = card.decided.filter(entry => local[entry.citation_index] === true);
  const used = card.citations.map((_, at) => decided.some(entry => entry.citation_index === at) || card.affected.some(entry => entry.citation_index === at));
  const at = positions(used);

  // Every line a model wrote is screened against the titles of outside items: the caller's, and those this card cites.
  const screen = screenFor([...outsideLabels, ...card.citations.filter((_, index) => !local[index]).map(entry => entry.label)]);
  // A note that names an outside item becomes one count.
  const unread = card.unconfirmed.filter(screen.names).length;
  const countNote = unread === 1 ? "1 item could not be read." : `${unread} items could not be read.`;
  const unconfirmed: string[] = [];
  for (const note of card.unconfirmed) {
    const kept = screen.names(note) ? countNote : note;
    if (!unconfirmed.includes(kept)) unconfirmed.push(kept);
  }

  return Object.freeze({
    schema_version: 1 as const,
    status: card.status,
    decided: Object.freeze(decided.map(entry => Object.freeze({ text: screen.scrub(entry.text), citation_index: at[entry.citation_index]! }))),
    affected: Object.freeze(card.affected.map(entry => Object.freeze({
      citation_index: at[entry.citation_index]!,
      ...(entry.relation === undefined ? {} : { relation: entry.relation }),
      // A milestone that names an outside item loses its date; the row stays.
      ...(entry.date_at_risk === undefined || screen.names(entry.date_at_risk.milestone) ? {} : { date_at_risk: Object.freeze({ date: entry.date_at_risk.date, milestone: entry.date_at_risk.milestone }) }),
      // What an outside item says is read again on every view; only ECHO's own text is kept.
      ...(local[entry.citation_index] === true ? { says_now: screen.scrub(entry.says_now) } : {}),
    }))),
    unconfirmed: Object.freeze(unconfirmed),
    citations: Object.freeze(card.citations.filter((_, index) => used[index]).map(entry => entry.citation)),
  });
}

/** One cited item as the viewer can open it now. Whether it is ECHO's own is read from its citation. */
export interface FreshImpactItemV1 {
  readonly citation: PersonAnswerCitationV6;      // as released to this viewer now
  readonly text?: string; readonly label: string;
  readonly attributes?: { readonly owner?: string; readonly due_at?: string; readonly status?: string };
}

/** The fields that name the item a pointer opens, per kind. A section or a version may move on; the item may not. */
const PRIMARY_ID: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ticket: ["tool_id", "external_scope_id", "ticket_id"],
  page: ["tool_id", "external_scope_id", "page_id"],
  slack_message: ["team_id", "channel_id", "message_ts"],
  approved_record: ["atom_id", "record_sha256"],
  source_revision: ["source_id", "revision_id"],
});

/** The item a citation names: its kind and primary id, or undefined for a pointer that names none. */
function itemOf(citation: unknown): string | undefined {
  if (typeof citation !== "object" || citation === null) return undefined;
  const pointer = citation as Readonly<Record<string, unknown>>;
  const fields = typeof pointer.kind === "string" && Object.hasOwn(PRIMARY_ID, pointer.kind) ? PRIMARY_ID[pointer.kind]! : undefined;
  if (fields === undefined || fields.some(field => typeof pointer[field] !== "string")) return undefined;
  return JSON.stringify([pointer.kind, ...fields.map(field => pointer[field])]);
}

/** What an outside item says now: the first characters of its current text on one line, else its title and details. */
function currentLine(item: FreshImpactItemV1): string {
  const text = cleanLine(item.text, LIMITS.line_chars);
  return text.length > 0 ? text : detailsOfImpactItemV1(item);
}

/**
 * Rebuilds the viewer's card from the stored form and fresh reads (null = could not open).
 * A read that opened a different item than its stored pointer names, or one
 * that opened the same pointer as an earlier row, counts as one that could not
 * be opened: it is hidden and counted in `hidden`.
 */
export function refreshImpactCardV1(stored: StoredImpactCardV1, fresh: readonly (FreshImpactItemV1 | null)[]): { readonly card: PersonImpactCardV1; readonly hidden: number } {
  if (fresh.length !== stored.citations.length) throw new Error("refreshing an impact card needs one entry per stored citation");
  for (const entry of [...stored.decided, ...stored.affected]) {
    if (!Number.isSafeInteger(entry.citation_index) || entry.citation_index < 0 || entry.citation_index >= fresh.length) throw new Error("a stored impact card row points at no stored citation");
  }
  // What the viewer can no longer open is hidden with the rows that cite it.
  const shown = new Set<string>();
  const opened = fresh.map((item, index) => {
    if (item === null) return false;
    const named = itemOf(stored.citations[index]);
    if (named === undefined || named !== itemOf(item.citation.citation)) return false;
    const pointer = canonicalJson(item.citation.citation as never);
    if (shown.has(pointer)) return false;
    shown.add(pointer);
    return true;
  });
  const at = positions(opened);
  const item = (index: number): FreshImpactItemV1 => fresh[index]!;

  const decided = stored.decided.filter(entry => opened[entry.citation_index]).map(entry => ({ text: entry.text, citation_index: at[entry.citation_index]! }));
  const affected = stored.affected.filter(entry => opened[entry.citation_index]).map((entry): PersonImpactAffectedV1 => {
    const current = item(entry.citation_index);
    const owner = ownerOfImpactItemV1(current);
    return {
      citation_index: at[entry.citation_index]!,
      says_now: isLocal(current.citation.citation) && entry.says_now !== undefined ? entry.says_now : currentLine(current),
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
    status: stored.status, citations: fresh.flatMap((current, index) => (opened[index] ? [current!.citation] : [])),
  });
  return Object.freeze({ card, hidden: opened.filter(kept => !kept).length });
}
