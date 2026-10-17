import type { AnswerSource, ItemRef } from '../shared/protocol.js';

/**
 * Where an item opens that Ask cites, or names while it works (Ask progress
 * and internal links v1): what Ask's side panel shows, beside an Ask that
 * keeps running, and the full page its Open goes to once the answer came.
 * One mapping serves the live rows, the receipt and the answer's sources, so
 * a new kind of item joins by naming its opener here, as follow-ups did.
 */
export interface Opener {
  /**
   * What the panel shows: the meeting's approved record with the cited items
   * lit (`record`), a meeting read by its ref (`meeting`, a transcript's),
   * the cited passages (`passages`), a follow-up's title, owner, status and
   * latest check (`follow_up`), or Open in its own app (`external`).
   */
  readonly pane: 'record' | 'meeting' | 'passages' | 'follow_up' | 'external';
  /** The meeting `meeting` reads, by its record digest. */
  readonly meeting?: string;
  /** The full page Open goes to, or null for an item that opens only in its own app. */
  readonly page: FullPage | null;
}

/** A full page in the app: the reader, on one item by its ref, or a follow-up's item page, by its id. */
export type FullPage = { readonly kind: 'reader'; readonly ref: ItemRef } | { readonly kind: 'follow_up'; readonly item_id: string };

const reader = (ref: ItemRef): FullPage => ({ kind: 'reader', ref });
const EXTERNAL: Opener = { pane: 'external', page: null };

const OPENERS: { readonly [K in AnswerSource['kind']]: (source: Extract<AnswerSource, { kind: K }>) => Opener } = {
  // A meeting's decision, action or rationale: its meeting, scrolled to the item.
  record: source => ({ pane: 'record', page: reader({ kind: 'meeting', id: source.record.record_sha256 }) }),
  // There is no transcript reader: a transcript opens its meeting.
  transcript: source => ({ pane: 'meeting', meeting: source.meeting, page: reader({ kind: 'meeting', id: source.meeting }) }),
  // A document, note or imported meeting: its cited passages, and the reader by the Authority's ref.
  original: source => ({ pane: 'passages', page: source.item === undefined ? null : reader(source.item) }),
  // A follow-up: what it is now beside Ask, and its item page (openFollowUp), where it is read again as Home shows it.
  follow_up: source => ({ pane: 'follow_up', page: { kind: 'follow_up', item_id: source.item_id } }),
  // Jira, Confluence and Slack open in their own apps, through the checked link.
  ticket: () => EXTERNAL,
  page: () => EXTERNAL,
  slack: () => EXTERNAL,
};

export function openerOf(source: AnswerSource): Opener {
  return (OPENERS[source.kind] as (value: AnswerSource) => Opener)(source);
}

/** One item's identity among sources, so Ask names it once: its record item, passage, transcript passage, follow-up or link. */
export function sourceKey(source: AnswerSource): string {
  if (source.kind === 'record') return `record:${source.atom_id}`;
  if (source.kind === 'follow_up') return `follow_up:${source.item_id}`;
  if (source.kind === 'original' || source.kind === 'transcript') {
    const { ref } = source;
    return `${source.kind}:${ref.source_id}:${ref.revision_id}:${ref.representation_sha256}:${ref.anchor_sha256}`;
  }
  return `${source.kind}:${source.tool_id}:${source.permalink}`;
}
