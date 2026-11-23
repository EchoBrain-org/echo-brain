import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { PERSON_LIST_PAGE_SIZE_V1, type PersonItemRefV1, type PersonListScopeV1 } from "@echo-brain/organization-api";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import { frameCursorV1, unframeCursorV1 } from "../adapters/persistence/sqlite/project-context-cursor-v1.js";
import { isCanonicalUtcMillisTimestampV1 } from "../application/canonical-utc-timestamp-v1.js";

/**
 * Person list and open cursors (ADR-0024), and the reviews list's. Untrusted
 * keysets, not MACs: a forged position only filters rows the caller may read,
 * and a cursor holds nothing but positions the caller already received in this
 * walk. The binding digest refuses replay under another scope, person,
 * membership, organization, ref or operation.
 */

const LIST_VERSION = 2;
const OPEN_VERSION = 3;
const REVIEWS_VERSION = 4;
const APPROVAL = /^apr_[0-9a-f]{64}$/;
const NUMBER = /^(0|[1-9][0-9]{0,7})$/;
const IDS = {
  note: /^(?:ctx|cap)_[0-9a-f]{64}$/,
  document: /^doc_[0-9a-f]{64}$/,
  meeting: /^sha256:[0-9a-f]{64}$/,
} as const;
const SOURCES = ["note", "document", "meeting"] as const;
const DONE = "~";

export type PersonListSourceV1 = (typeof SOURCES)[number];
export type PersonListSourcePositionV1 =
  | Readonly<{ state: "start" }>
  | Readonly<{ state: "after"; added_at: string; id: string }>
  | Readonly<{ state: "done" }>;
export type PersonListPositionsV1 = Readonly<Record<PersonListSourceV1, PersonListSourcePositionV1>>;
export type PersonOpenPositionV1 =
  | Readonly<{ kind: "document"; from_ordinal: number }>
  | Readonly<{ kind: "imported_meeting" | "note"; offset: number }>;
/**
 * A proposal's place in its reviewer's list, as the approval core orders it (its ApprovalProposalPlaceV1): undecided ones
 * lead (rank 0), each part newest first, then by approval id. Restated here, so the list's cursors import no review code.
 */
export type PersonReviewsPositionV1 = Readonly<{ rank: 0 | 1; created_at: string; approval_id: string }>;

export interface PersonListCursorBindingV1 {
  readonly scope: PersonListScopeV1;
  readonly organization_id: string;
  readonly membership_id: string;
}
export interface PersonOpenCursorBindingV1 {
  readonly ref: PersonItemRefV1;
  readonly organization_id: string;
  readonly membership_id: string;
}
/** The reviewer a reviews list is read for: the three ids its query filters by. */
export interface PersonReviewsCursorBindingV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
}

export const PERSON_LIST_START_V1: PersonListPositionsV1 = Object.freeze({
  note: Object.freeze({ state: "start" }), document: Object.freeze({ state: "start" }), meeting: Object.freeze({ state: "start" }),
});

function invalid(): never {
  throw new AuthorityOperationError("invalid_request", "request failed");
}

function digest(value: Readonly<Record<string, unknown>>): Buffer {
  return Buffer.from(canonicalSha256(value).slice("sha256:".length), "hex");
}

function listBinding(binding: PersonListCursorBindingV1): Buffer {
  const scope = binding.scope.kind === "project" ? { kind: "project", project_id: binding.scope.project_id } : { kind: binding.scope.kind };
  return digest({
    schema_version: 1, kind: "echo-person-list-cursor-v1", operation: "person_list", scope,
    page_size: PERSON_LIST_PAGE_SIZE_V1, organization_id: binding.organization_id, membership_id: binding.membership_id,
  });
}

function openBinding(binding: PersonOpenCursorBindingV1): Buffer {
  return digest({
    schema_version: 1, kind: "echo-person-open-cursor-v1", operation: "person_open", ref: binding.ref,
    organization_id: binding.organization_id, membership_id: binding.membership_id,
  });
}

function sourcePosition(source: PersonListSourceV1, first: string, second: string): PersonListSourcePositionV1 {
  if (first === "" && second === "") return Object.freeze({ state: "start" });
  if (first === DONE && second === "") return Object.freeze({ state: "done" });
  if (!isCanonicalUtcMillisTimestampV1(first) || !IDS[source].test(second)) invalid();
  return Object.freeze({ state: "after", added_at: first, id: second });
}

function listPositions(fields: readonly string[]): PersonListPositionsV1 {
  if (fields.length !== 6) invalid();
  const positions = Object.freeze({
    note: sourcePosition("note", fields[0]!, fields[1]!),
    document: sourcePosition("document", fields[2]!, fields[3]!),
    meeting: sourcePosition("meeting", fields[4]!, fields[5]!),
  });
  // A finished walk has no cursor; the route sends next_cursor null instead.
  if (SOURCES.every((source) => positions[source].state === "done")) invalid();
  return positions;
}

function listFields(positions: PersonListPositionsV1): string[] {
  return SOURCES.flatMap((source) => {
    const position = positions[source];
    return position.state === "start" ? ["", ""] : position.state === "done" ? [DONE, ""] : [position.added_at, position.id];
  });
}

function number(value: string, minimum: number, maximum: number): number {
  if (!NUMBER.test(value)) invalid();
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) invalid();
  return parsed;
}

function openPosition(ref: PersonItemRefV1, fields: readonly string[]): PersonOpenPositionV1 {
  const kind = ref.slice(0, ref.indexOf(":"));
  if (kind === "document" && fields.length === 1) return Object.freeze({ kind, from_ordinal: number(fields[0]!, 1, 65_535) });
  if ((kind === "imported_meeting" || kind === "note") && fields.length === 1) return Object.freeze({ kind, offset: number(fields[0]!, 1, 10_000_000) });
  // A meeting is never opened; any other shape is another ref's cursor.
  return invalid();
}

function openFields(position: PersonOpenPositionV1): string[] {
  switch (position.kind) {
    case "document": return [String(position.from_ordinal)];
    case "imported_meeting": case "note": return [String(position.offset)];
  }
}

export function encodePersonListCursorV1(binding: PersonListCursorBindingV1, positions: PersonListPositionsV1): string {
  const fields = listFields(positions);
  listPositions(fields);
  return frameCursorV1(LIST_VERSION, listBinding(binding), fields);
}

export function decodePersonListCursorV1(cursor: string, binding: PersonListCursorBindingV1): PersonListPositionsV1 {
  return listPositions(unframeCursorV1(cursor, LIST_VERSION, listBinding(binding)));
}

export function encodePersonOpenCursorV1(binding: PersonOpenCursorBindingV1, position: PersonOpenPositionV1): string {
  const fields = openFields(position);
  if (openPosition(binding.ref, fields).kind !== position.kind) invalid();
  return frameCursorV1(OPEN_VERSION, openBinding(binding), fields);
}

export function decodePersonOpenCursorV1(cursor: string, binding: PersonOpenCursorBindingV1): PersonOpenPositionV1 {
  return openPosition(binding.ref, unframeCursorV1(cursor, OPEN_VERSION, openBinding(binding)));
}

function reviewsBinding(binding: PersonReviewsCursorBindingV1): Buffer {
  return digest({
    schema_version: 1, kind: "echo-person-reviews-cursor-v1", operation: "reviews",
    organization_id: binding.organization_id, principal_id: binding.principal_id, membership_id: binding.membership_id,
  });
}

function reviewsPosition(fields: readonly string[]): PersonReviewsPositionV1 {
  const [rank, created_at, approval_id] = fields;
  if (fields.length !== 3 || (rank !== "0" && rank !== "1") || !isCanonicalUtcMillisTimestampV1(created_at) || !APPROVAL.test(approval_id!)) invalid();
  return Object.freeze({ rank: rank === "0" ? 0 : 1, created_at, approval_id: approval_id! });
}

/**
 * The place of the last row a reviews page gave (the `reviews` operation of `/v1/person/reviews`): the next page is read
 * after it. It holds that row's rank and approval id and the time its proposal was made, which a row does not show: all
 * the reviewer's own, and only what the list orders on.
 */
export function encodePersonReviewsCursorV1(binding: PersonReviewsCursorBindingV1, position: PersonReviewsPositionV1): string {
  const fields = [String(position.rank), position.created_at, position.approval_id];
  reviewsPosition(fields);
  return frameCursorV1(REVIEWS_VERSION, reviewsBinding(binding), fields);
}

export function decodePersonReviewsCursorV1(cursor: string, binding: PersonReviewsCursorBindingV1): PersonReviewsPositionV1 {
  return reviewsPosition(unframeCursorV1(cursor, REVIEWS_VERSION, reviewsBinding(binding)));
}
