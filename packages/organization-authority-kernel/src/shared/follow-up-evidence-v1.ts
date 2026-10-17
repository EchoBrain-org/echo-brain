import {
  personFollowUpRefV1,
  type PersonFollowUpCitationV1,
  type PersonFollowUpEvidenceV1,
  type PersonFollowUpRefV1,
  type PersonOpenItemKindV1,
  type PersonOpenItemStateV1,
  type PersonOpenItemVerdictV1,
} from '@echo-brain/organization-api';
import type { EvidenceDeskAttributesV1 } from './evidence-desk-v1.js';
import type { PersonLiveSourceDescriptorV2 } from './evidence-desk-v2.js';

/**
 * ECHO's shared follow-ups as an Ask source (ADR-0040): the kernel-facing
 * names and the one projection from a follow-up to desk fields. The source
 * itself, its visibility and its live reads are server composition.
 */

/** The desk item kind of a follow-up. */
export const FOLLOW_UP_EVIDENCE_KIND_V1 = 'follow_up' as const;
/** The source id and the selector the research model uses. */
export const FOLLOW_UPS_SOURCE_ID_V1 = 'follow_ups' as const;
export const FOLLOW_UPS_SELECTOR_V1 = 'follow_ups' as const;
/** The first Ask response version whose citations admit a follow-up; trigger research (V6) never reads them. */
export const FOLLOW_UPS_MINIMUM_RESPONSE_VERSION_V1 = 7 as const;
/** A status group a follow-ups list takes. */
export type FollowUpListStatusV1 = 'open' | 'done';
/**
 * Per-request bounds: the hits one search returns, the rows one list page
 * returns, and the distinct follow-ups read live in their tools in one
 * request (each at most once). Past the last, a follow-up is released with
 * ECHO-held text only.
 */
export const FOLLOW_UPS_LIMITS_V1 = Object.freeze({ search_hits: 5, list_page: 10, live_reads: 20 });

/**
 * The descriptor of ECHO's follow-ups. Request-bound like a connected tool's,
 * but with no tool: words a follow-up takes from a tool are that tool's live
 * releases. Its list is not metadata only, since a follow-up carries its
 * fields as text, and it needs no channel and has no default age.
 */
export interface FollowUpsSourceDescriptorV1 extends Omit<PersonLiveSourceDescriptorV2, 'source_id' | 'kind' | 'selector' | 'tool_id' | 'requires_channel' | 'default_since_days'> {
  readonly source_id: typeof FOLLOW_UPS_SOURCE_ID_V1;
  readonly kind: typeof FOLLOW_UP_EVIDENCE_KIND_V1;
  readonly selector: typeof FOLLOW_UPS_SELECTOR_V1;
}

/** How a desk that bound follow-ups advertises them in `live_sources`, and so how they appear in the source catalog. */
export const FOLLOW_UPS_SOURCE_DESCRIPTOR_V1: FollowUpsSourceDescriptorV1 = Object.freeze({
  source_id: FOLLOW_UPS_SOURCE_ID_V1,
  kind: FOLLOW_UP_EVIDENCE_KIND_V1,
  selector: FOLLOW_UPS_SELECTOR_V1,
  description: "Shared follow-ups of approved decisions: what a decision asked of a ticket, page, record or meeting action, with its owner, status, due date, latest check and decision. Search matches the decision's title and first line, the expected change, a ticket key and the owner's name, never words inside a ticket or page. List takes owner (a person's name) and status (open or done).",
  metadata_only_list: false,
});

const STATUS_TEXT: Readonly<Record<PersonOpenItemStateV1, string>> = Object.freeze({ unsent: 'not sent yet', open: 'open', done: 'done', not_relevant: 'not relevant' });
const VERDICT_TEXT: Readonly<Record<PersonOpenItemVerdictV1, string>> = Object.freeze({ landed: 'landed', still_open: 'still open', changed: 'changed', unreadable: 'could not be read' });
const KIND_TEXT: Readonly<Record<PersonOpenItemKindV1, string>> = Object.freeze({ action: 'meeting action', ticket: 'ticket', page: 'page', slack_message: 'Slack message', record: 'ECHO meeting record', document: 'ECHO document' });

/** The desk fields of one follow-up. The source adds its desk id, visibility and release receipt. */
export interface FollowUpDeskFieldsV1 {
  readonly kind: typeof FOLLOW_UP_EVIDENCE_KIND_V1;
  readonly citation: PersonFollowUpCitationV1;
  readonly ref: PersonFollowUpRefV1;
  readonly label: string;
  readonly attributes: EvidenceDeskAttributesV1;
  readonly text: string;
}

/**
 * One follow-up as the desk carries it: its title as the label; owner, status
 * and due date as attributes; and as text, what it is on, what the decision
 * expects of it, its latest check and its decision. Every value comes from the
 * already-shaped evidence, so nothing the asker may not see can enter here.
 */
export function followUpDeskFieldsV1(evidence: PersonFollowUpEvidenceV1): FollowUpDeskFieldsV1 {
  const citation: PersonFollowUpCitationV1 = Object.freeze({ kind: FOLLOW_UP_EVIDENCE_KIND_V1, item_id: evidence.item_id });
  const lines = [
    `On: ${KIND_TEXT[evidence.kind]}`,
    ...(evidence.expected === undefined ? [] : [`Expected: ${evidence.expected}`]),
    evidence.check === undefined ? 'Latest check: none yet' : `Latest check: ${VERDICT_TEXT[evidence.check.verdict]} on ${evidence.check.checked_at.slice(0, 10)}`,
    ...(evidence.decision === undefined ? [] : [`Decision: ${evidence.decision.title}`, ...(evidence.decision.first_line === undefined ? [] : [`Decided: ${evidence.decision.first_line}`])]),
  ];
  return Object.freeze({
    kind: FOLLOW_UP_EVIDENCE_KIND_V1, citation, ref: personFollowUpRefV1(citation), label: evidence.title,
    attributes: Object.freeze({ owner: evidence.owner, status: STATUS_TEXT[evidence.status], ...(evidence.due_at === undefined ? {} : { due_at: evidence.due_at }) }),
    text: lines.join('\n'),
  });
}

/** A follow-up state in a list's status group: `open` is open, `done` is done; not sent and not relevant are in neither. */
export function followUpInStatusV1(state: PersonOpenItemStateV1, status: FollowUpListStatusV1): boolean {
  return state === status;
}

/** A name's whole Unicode words, lower case, as follow-up search reads ECHO-held text. */
function nameWords(value: string): readonly string[] {
  return value.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether an owner filter names this owner: case-insensitive, a leading `@`
 * ignored, and every word of the filter one whole word of the owner's display
 * name, so "Ari" never names "Maria Gomez".
 */
export function followUpOwnerMatchesV1(owner: string, filter: string): boolean {
  const recorded = new Set(nameWords(owner));
  const wanted = nameWords(filter.trim().replace(/^@/u, ''));
  return wanted.length > 0 && wanted.every(word => recorded.has(word));
}
