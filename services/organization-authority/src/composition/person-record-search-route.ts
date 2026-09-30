import { annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
  type JsonObject,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { HUMAN_ACT_RECORD_INPUT_CODECS_V4, validateOrganizationRecordEnvelopeV4, type OrganizationRecordDecisionBriefV1, type RecordInputCodecRegistryV4 } from "@echo-brain/organization-protocol";
import {
  PERSON_LIST_TEXT_MAX_BYTES_V1,
  PERSON_OPEN_ATOMS_BUDGET_BYTES_V1,
  PERSON_OPEN_ATOMS_MAX_V1,
  type PersonOpenMeetingAtomV1,
  type ProjectIdV1,
} from "@echo-brain/organization-api";
import { PersonRecordReaderV1, type RecordApproverProjectorV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import {
  clearReadableSearchActiveGenerationV1,
  listReadableSearchGenerationRecordsV1,
  listReadableSearchGenerationV1,
  readReadableSearchGenerationAtomsV1,
  searchReadableSearchGenerationV1,
  type ReadableSearchActiveGenerationV1,
  type ReadableSearchGenerationRecordV1,
  type ReadableSearchReaderV1,
  type ReadableSearchResultItemV1,
  type ReadableSearchResultV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type Database from "better-sqlite3";
import { captureRecordProjectsV1, type CaptureRecordProjectsV1, type RecordProjectAuthorizationV1 } from "./person-record-project-scope-v1.js";
import { boundedTextV1 } from "./person-item-text-v1.js";
import {
  RecordMetadataCacheV1,
  approverDisplayNameV1,
  approverTupleV1,
  confirmedOwners,
  meetingAtomsV1,
  meetingDateV1,
  meetingDetailV1,
  type ApproverMembershipsV1,
  type RecordMetadataV1,
} from "./person-meeting-items-v1.js";
import type {
  PersonItemPositionV1,
  PersonMeetingCollectionV1,
  PersonMeetingItemsPortV1,
  PersonMeetingPartPositionV1,
  PersonStoreHandleV1,
  PersonStoreMeetingRowV1,
  PersonStoreReleaseV1,
  PersonStoreVisibilityV1,
  PersonTranscriptProbeV1,
} from "../application/ports/person-list-v1.js";
import type { PersonAskScopeV2 } from "../application/ports/person-original-context-retrieval-v1.js";
import { SqlitePersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/person-record-read-audit-v1.js";
import {
  containsCanonicalReleaseId,
  isCanonicalReleaseId,
} from "@echo-brain/organization-authority-kernel/shared/canonical-release-id";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type {
  PersonRecordSearchHttpApplicationV1,
  PersonRecordSearchResponseV2,
} from "../presentation/person-record-search-http-application.js";

interface CurrentPersonSessions {
  authenticateAccess(input: {
    readonly access_token: string;
  }): PersonAccessAuthorization;
}

interface ActiveGenerationRow {
  readonly organization_id: string;
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly record_head_position: number;
  readonly record_head_hash: Sha256Digest | null;
}

interface RecordHead {
  readonly position: number;
  readonly record_sha256: Sha256Digest | null;
}

type SearchGeneration = typeof searchReadableSearchGenerationV1;
const RELATED_ATOM_PACKET_MAX_ITEMS_V1 = 16;
const EVIDENCE_DESK_MAX_ITEM_UTF8_BYTES_V1 = 3_072;

/** Only an observed head/pointer lag may put the request in originals-only mode. */
export class PersonRecordSearchIndexLagV1 extends AuthorityOperationError {
  constructor() { super("unavailable", "an exact-head readable-search generation is not available"); }
}

/**
 * The Layer 2 related-atom reader is injected here so the Authority boundary
 * remains independently testable while the disposable relationship plane is
 * rebuilt. Its shape intentionally matches expandReadableSearchRelatedAtomsV1.
 */
export interface ExpandReadableSearchRelatedAtomsV1Input {
  readonly state_directory: string;
  readonly active_generation: ReadableSearchActiveGenerationV1;
  readonly reader: ReadableSearchReaderV1;
  readonly project_id?: string;
  readonly anchor_atom_ids: readonly Sha256Digest[];
  readonly include_anchor_records?: true;
  readonly limit: number;
  /** Authority-derived record narrowing (mine); never client input. */
  readonly record_sha256s?: readonly Sha256Digest[];
}

export type ExpandReadableSearchRelatedAtomsV1 = (
  input: ExpandReadableSearchRelatedAtomsV1Input,
) => ReadableSearchResultV1;

/**
 * In-process Layer 3 input for a bounded answer-composition retrieval plan. This is not
 * part of the Person HTTP contract: the bearer remains server-side while the
 * caller's plan is executed under one reader tuple and one exact snapshot.
 */
export interface PersonRecordSearchBatchInputV1 {
  readonly access_token: string;
  readonly queries: readonly string[];
  /** Authority-checked project scope; association never replaces audience. */
  readonly project_id?: string;
  /** Records whose final approver is the caller (ADR-0023); exclusive with project_id. */
  readonly mine?: true;
  /**
   * A canonical release named by the answer question. Layer 3 applies it only
   * after normal authorization has admitted the merged evidence.
   */
  readonly exact_release_id?: string;
  readonly limit?: number;
  /** Desk-only result kind narrowing, applied by Layer 2 before its cap. */
  readonly kinds?: readonly ReadableSearchResultItemV1["item_kind"][];
  /** Internal desk release: bind immutable presentation metadata into audit. */
  readonly desk?: true;
  /**
   * Server-only answer-composition request for the bounded decision packet.
   * The HTTP search route and direct `searchBatch` callers retain lexical
   * ordering unless Layer 4 explicitly asks for this plan.
   */
  readonly include_related_atom_packet?: true;
  /**
   * Request-bound callers may require the pointer captured by an earlier
   * release.  A changed active generation is unavailable rather than silently
   * mixing evidence from two record heads.
   */
  readonly expected_pointer?: PersonRecordSearchReleasePointerV1;
  /** Internal, fail-open seam used to close the Ask authorization stage. */
  readonly on_authorized?: () => void;
}

export type PersonRecordSearchReleaseAuthorizationV1 =
  Readonly<PersonAccessAuthorization>;

export interface PersonRecordSearchReleasePointerV1 {
  readonly generation_id: Sha256Digest;
  readonly manifest_sha256: Sha256Digest;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly record_head: Readonly<{
    position: number;
    record_sha256: Sha256Digest | null;
  }>;
}

/**
 * A route-local release witness. Its fields may be inspected, but only the
 * originating route instance accepts its object identity. It has no bearer
 * token or secret.
 */
export interface PersonRecordSearchBatchReleaseV1 {
  readonly initial_authorization: PersonRecordSearchReleaseAuthorizationV1;
  readonly current_authorization: PersonRecordSearchReleaseAuthorizationV1;
  readonly active_pointer: PersonRecordSearchReleasePointerV1;
  readonly record_read_audit_row_sha256: Sha256Digest;
  readonly project_authorization?: RecordProjectAuthorizationV1;
  readonly project_id?: string;
  /** Every later open from this release stays narrowed to the caller's approvals. */
  readonly mine?: true;
}

export interface PersonRecordSearchBatchResultV1 {
  readonly response: PersonRecordSearchResponseV2;
  readonly release: PersonRecordSearchBatchReleaseV1;
  /** Ordered per-query result counts, kept server-side for answer auditing only. */
  readonly query_hit_counts: readonly number[];
  /** Private desk projection of immutable V4 meeting metadata. */
  readonly desk_items?: readonly PersonRecordDeskItemV1[];
  readonly truncated?: boolean;
}

export interface PersonRecordDeskItemV1 {
  readonly atom_id: Sha256Digest;
  readonly record_sha256: Sha256Digest;
  readonly item_kind: ReadableSearchResultItemV1["item_kind"];
  readonly text: string;
  readonly policy_id: ReadableSearchResultItemV1["policy_id"];
  readonly record_position: number;
  readonly envelope_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly audience_project_count: number;
  readonly label: string;
  readonly visibility: "team" | "project" | "projects" | "approver_only";
  readonly attributes?: Readonly<{ owner?: string; due_at?: string; status?: string }>;
}

export interface PersonRecordSearchBatchApplicationV1 {
  searchBatch(
    input: PersonRecordSearchBatchInputV1,
  ): PersonRecordSearchBatchResultV1;
  revalidateBatchRelease(input: {
    readonly access_token: string;
    readonly release: PersonRecordSearchBatchReleaseV1;
  }): PersonRecordSearchReleaseAuthorizationV1;
}

/**
 * The V3 evidence desk has no compatibility mode.  Keep its complete
 * request-bound surface separate from the record-search batch contract, whose
 * callers intentionally do not need inventory or bounded-open operations.
 */
export interface PersonEvidenceDeskRecordsV1 extends Pick<
  PersonRecordSearchBatchApplicationV1,
  "searchBatch" | "revalidateBatchRelease"
> {
  openDeskBatch(input: {
    readonly access_token: string;
    readonly release: PersonRecordSearchBatchReleaseV1;
    readonly anchor: Pick<ReadableSearchResultItemV1, "atom_id" | "record_sha256" | "record_position" | "envelope_sha256" | "atom_order" | "audience_project_count" | "item_kind" | "text" | "policy_id">;
  }): PersonRecordSearchBatchResultV1;
  listDeskBatch(input: {
    readonly access_token: string;
    readonly project_id?: string;
    readonly mine?: true;
    readonly expected_pointer?: PersonRecordSearchReleasePointerV1;
    readonly limit?: number;
    readonly kinds?: readonly ReadableSearchResultItemV1["item_kind"][];
  }): PersonRecordSearchBatchResultV1;
  initializeDesk(input: {
    readonly access_token: string;
    readonly project_id?: string;
    readonly mine?: true;
  }): PersonRecordSearchBatchResultV1;
  openDeskCitation(input: {
    readonly access_token: string;
    readonly project_id?: string;
    readonly mine?: true;
    readonly atom_id: Sha256Digest;
    readonly record_sha256: Sha256Digest;
    readonly policy_id: ReadableSearchResultItemV1["policy_id"];
  }): PersonRecordSearchBatchResultV1;
}

export type PersonRecordSearchRouteV1 =
  PersonRecordSearchHttpApplicationV1 &
    PersonRecordSearchBatchApplicationV1 &
    PersonEvidenceDeskRecordsV1 &
    PersonMeetingItemsPortV1;

export interface CreatePersonRecordSearchRouteV1Options {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly sessions: CurrentPersonSessions;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly audit: SqlitePersonRecordReadAuditV1;
  readonly capture_projects?: CaptureRecordProjectsV1;
  readonly search_generation?: SearchGeneration;
  /** Optional until the Layer 2 related-atom projector is installed. */
  readonly expand_related_atoms?: ExpandReadableSearchRelatedAtomsV1;
  /** The Authority's record codecs; Slack-approved records need them to parse. */
  readonly record_input_codecs?: RecordInputCodecRegistryV4;
  /** The composed approver projectors. Mine needs them; without them mine is unavailable, never global. */
  readonly record_approver?: RecordApproverProjectorV1;
  /** Resolves only the approver named by a record already released to this reader. */
  readonly memberships?: ApproverMembershipsV1;
  /** Content-free: whether the reader may open an admitted record's shared transcript now. */
  readonly transcript_probe?: PersonTranscriptProbeV1;
}

function activeGeneration(
  authority: Database.Database,
): ActiveGenerationRow | null {
  return (
    (authority
      .prepare(
        `SELECT organization_id, generation_id, manifest_sha256,
                retrieval_contract_sha256, record_head_position,
                record_head_hash
           FROM authority_readable_search_active_generation
          WHERE singleton = 1`,
      )
      .get() as ActiveGenerationRow | undefined) ?? null
  );
}

function recordHead(record: Database.Database): RecordHead {
  const row = record
    .prepare(
      `SELECT position, record_sha256
         FROM organization_record_log
        ORDER BY position DESC
        LIMIT 1`,
    )
    .get() as
    | { readonly position: number; readonly record_sha256: Sha256Digest }
    | undefined;
  return row === undefined
    ? Object.freeze({ position: 0, record_sha256: null })
    : Object.freeze({ ...row });
}

function sameHead(pointer: ActiveGenerationRow, head: RecordHead): boolean {
  return (
    pointer.record_head_position === head.position &&
    pointer.record_head_hash === head.record_sha256
  );
}

function isVerifiedIndexLag(
  record: Database.Database,
  pointer: ActiveGenerationRow | null,
  head: RecordHead,
  options: Pick<CreatePersonRecordSearchRouteV1Options, "organization_id" | "retrieval_contract_sha256">,
): boolean {
  if (pointer === null) return true;
  if (pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256) return false;
  if (pointer.record_head_position >= head.position || pointer.record_head_position < 0) return false;
  const row = record.prepare("SELECT record_sha256 FROM organization_record_log WHERE position=?").get(pointer.record_head_position) as { readonly record_sha256: Sha256Digest } | undefined;
  return row !== undefined && row.record_sha256 === pointer.record_head_hash;
}

function samePointer(
  left: ActiveGenerationRow,
  right: ActiveGenerationRow | null,
): boolean {
  return (
    right !== null &&
    left.organization_id === right.organization_id &&
    left.generation_id === right.generation_id &&
    left.manifest_sha256 === right.manifest_sha256 &&
    left.retrieval_contract_sha256 === right.retrieval_contract_sha256 &&
    left.record_head_position === right.record_head_position &&
    left.record_head_hash === right.record_head_hash
  );
}

function matchesReleasePointer(
  pointer: ActiveGenerationRow,
  expected: PersonRecordSearchReleasePointerV1,
): boolean {
  return pointer.generation_id === expected.generation_id &&
    pointer.manifest_sha256 === expected.manifest_sha256 &&
    pointer.retrieval_contract_sha256 === expected.retrieval_contract_sha256 &&
    pointer.record_head_position === expected.record_head.position &&
    pointer.record_head_hash === expected.record_head.record_sha256;
}

/**
 * The immutable generation may be searched with the admission tuple, but it
 * may only leave Layer 3 after that exact bearer-derived tuple is still
 * current. Keep this aligned with the Layer 1 record route: a membership,
 * session, credential, or Person-state change while retrieval is running is a
 * non-disclosing denial, not a stale release.
 */
function sameReleaseAuthorization(
  initial: PersonAccessAuthorization,
  current: PersonAccessAuthorization,
): boolean {
  return (
    initial.organization_id === current.organization_id &&
    initial.principal_id === current.principal_id &&
    initial.membership_id === current.membership_id &&
    initial.membership_type === current.membership_type &&
    initial.identity_binding_id === current.identity_binding_id &&
    initial.session_family_id === current.session_family_id &&
    initial.access_credential_sha256 === current.access_credential_sha256 &&
    initial.person_state_sha256 === current.person_state_sha256 &&
    initial.session_state_sha256 === current.session_state_sha256
  );
}

function releaseAuthorization(
  authorization: PersonAccessAuthorization,
): PersonRecordSearchReleaseAuthorizationV1 {
  return Object.freeze({ ...authorization });
}

function validBatchQuery(query: string): boolean {
  const terms = new Set(
    (query.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
      term.toLowerCase().normalize("NFC"),
    ),
  );
  return (
    query.length > 0 &&
    query === query.normalize("NFC") &&
    query.trim() === query &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(query) &&
    [...query].length <= 240 &&
    terms.size >= 1 &&
    terms.size <= 32 &&
    [...terms].every((term) => Buffer.byteLength(term, "utf8") <= 64)
  );
}

/** Mine narrows to the caller's own approvals; it is never combined with a project. */
function assertValidMine(input: { readonly mine?: unknown; readonly project_id?: unknown }): void {
  if ((input.mine !== undefined && input.mine !== true) || (input.mine === true && input.project_id !== undefined)) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
}

function assertValidBatch(input: PersonRecordSearchBatchInputV1): void {
  assertValidMine(input);
  if (
    input.queries.length < 1 ||
    input.queries.length > 4 ||
    new Set(input.queries).size !== input.queries.length ||
    input.queries.some((query) => !validBatchQuery(query)) ||
    (input.kinds !== undefined && (!Array.isArray(input.kinds) || input.kinds.length < 1 || new Set(input.kinds).size !== input.kinds.length || input.kinds.some((kind) => kind !== "decision" && kind !== "action" && kind !== "rationale"))) ||
    (input.exact_release_id !== undefined &&
      !isCanonicalReleaseId(input.exact_release_id)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 10))
  ) {
    throw new AuthorityOperationError("invalid_request", "request is invalid");
  }
}

function unavailable(): never {
  throw new AuthorityOperationError(
    "unavailable",
    "an exact-head readable-search generation is not available",
  );
}

function indexLagUnavailable(): never {
  throw new PersonRecordSearchIndexLagV1();
}

function asResponse(input: {
  readonly items: readonly ReadableSearchResultItemV1[];
}): PersonRecordSearchResponseV2 {
  return Object.freeze({
    schema_version: 2,
    kind: "echo-clean-person-record-search-v2",
    items: Object.freeze(
      input.items.map((item) =>
        Object.freeze({
          atom_id: item.atom_id,
          record_sha256: item.record_sha256,
          kind: item.item_kind,
          text: item.text,
          policy_id: item.policy_id,
        }),
      ),
    ),
  });
}

function deskLabel(title: string | undefined, time: { readonly scheduled_start_at?: string; readonly actual_start_at?: string; readonly scheduled_end_at?: string; readonly actual_end_at?: string } | undefined): string {
  const date = time?.actual_start_at ?? time?.scheduled_start_at ?? time?.actual_end_at ?? time?.scheduled_end_at;
  const value = `${title === undefined ? "Approved meeting" : title}${date === undefined ? "" : ` (${date.slice(0, 10)})`}`;
  if (Buffer.byteLength(value, "utf8") <= 1024) return value;
  let prefix = "";
  for (const scalar of value) {
    if (Buffer.byteLength(prefix + scalar, "utf8") > 1021) break;
    prefix += scalar;
  }
  return `${prefix}...`;
}

/** Store-raw: only the list route collapses these tokens (ADR-0023). */
function recordVisibility(policy_id: ReadableSearchResultItemV1["policy_id"], audience_project_count: number): Exclude<PersonStoreVisibilityV1, "only_me"> {
  if (policy_id === "project-members-readable-person-v1" && audience_project_count < 1) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
  return policy_id === "restricted-reviewer-person-v2" ? "approver_only" : policy_id === "project-members-readable-person-v1" ? (audience_project_count === 1 ? "project" : "projects") : "team";
}

function deskItems(record: Database.Database, items: readonly ReadableSearchResultItemV1[], codecs: RecordInputCodecRegistryV4 = HUMAN_ACT_RECORD_INPUT_CODECS_V4): readonly PersonRecordDeskItemV1[] {
  const statement = record.prepare(`SELECT canonical_envelope, envelope_sha256, record_sha256 FROM organization_record_log WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'`);
  return Object.freeze(items.map((item) => {
    const row = statement.get(item.record_position, item.record_sha256) as { readonly canonical_envelope: string; readonly envelope_sha256: Sha256Digest; readonly record_sha256: Sha256Digest } | undefined;
    if (row === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    let envelope: ReturnType<typeof validateOrganizationRecordEnvelopeV4>;
    try { envelope = validateOrganizationRecordEnvelopeV4(parseCanonicalJson(row.canonical_envelope), codecs); } catch { throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable"); }
    if (row.envelope_sha256 !== item.envelope_sha256 || sha256Digest(row.canonical_envelope) !== row.envelope_sha256 || envelope.record_sha256 !== item.record_sha256 || envelope.body.event.kind !== "approved") throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const brief = envelope.body.event.approved_snapshot.approved_payload.brief;
    if (item.atom_order === undefined || item.audience_project_count === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const signal = [...brief.decisions, ...brief.actions, ...brief.rationales][item.atom_order];
    const owner = signal?.kind === "action" ? confirmedOwners(envelope.body.human_act_resolution_ref).get(signal.id) : undefined;
    const indexedText = signal === undefined ? undefined : owner === undefined ? signal.text : `${signal.text} Owner: ${owner}.`;
    if (signal === undefined || signal.kind !== item.item_kind || indexedText !== item.text) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const attributes = signal.kind === "decision" ? { status: signal.status } : signal.kind === "action" ? { ...(owner === undefined ? {} : { owner }), ...(signal.due_at === null ? {} : { due_at: signal.due_at }) } : undefined;
    const visibility = recordVisibility(item.policy_id, item.audience_project_count);
    return Object.freeze({ atom_id: item.atom_id, record_sha256: item.record_sha256, item_kind: item.item_kind, text: item.text, policy_id: item.policy_id, record_position: item.record_position, envelope_sha256: item.envelope_sha256, atom_order: item.atom_order, audience_project_count: item.audience_project_count, label: deskLabel(brief.meeting.title, brief.meeting.time), visibility, ...(attributes === undefined || Object.keys(attributes).length === 0 ? {} : { attributes: Object.freeze(attributes) }) });
  }));
}

function boundedDeskItems(items: readonly ReadableSearchResultItemV1[]): readonly ReadableSearchResultItemV1[] {
  return items.filter((item) =>
    Buffer.byteLength(item.text, "utf8") <= EVIDENCE_DESK_MAX_ITEM_UTF8_BYTES_V1,
  );
}

function approvedRecordAtomCount(record: Database.Database, position: number, recordSha256: Sha256Digest, codecs: RecordInputCodecRegistryV4 = HUMAN_ACT_RECORD_INPUT_CODECS_V4): number {
  const row = record.prepare(`SELECT canonical_envelope FROM organization_record_log WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'`).get(position, recordSha256) as { readonly canonical_envelope: string } | undefined;
  if (row === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
  let envelope: ReturnType<typeof validateOrganizationRecordEnvelopeV4>;
  try { envelope = validateOrganizationRecordEnvelopeV4(parseCanonicalJson(row.canonical_envelope), codecs); } catch { throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable"); }
  if (envelope.record_sha256 !== recordSha256 || envelope.body.event.kind !== "approved") throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
  const brief = envelope.body.event.approved_snapshot.approved_payload.brief;
  return brief.decisions.length + brief.actions.length + brief.rationales.length;
}

function hasExpectedGenerationIdentity(input: {
  readonly result: Pick<ReadableSearchResultV1, "generation_id" | "exact_head">;
  readonly pointer: ActiveGenerationRow;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
}): boolean {
  return (
    input.result.generation_id === input.pointer.generation_id &&
    input.result.exact_head.authority_id === input.authority_id &&
    input.result.exact_head.organization_id === input.organization_id &&
    input.result.exact_head.state_lineage_id === input.state_lineage_id &&
    input.result.exact_head.position === input.pointer.record_head_position &&
    input.result.exact_head.record_sha256 === input.pointer.record_head_hash
  );
}

function isUnavailableGenerationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.endsWith("active-generation handle is unavailable")
  );
}

const MEETING_COLLECT_MAX = 26;
const MEETING_PART_MAX = 65_535;
const RECORD_SHA256 = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type MeetingCollectionState = {
  readonly authorization: PersonRecordSearchReleaseAuthorizationV1;
  readonly grants_sha256: Sha256Digest;
  readonly scope: PersonAskScopeV2;
  readonly rows: readonly PersonStoreMeetingRowV1[];
  consumed: boolean;
};
type MeetingReleaseWitness = {
  readonly initial: PersonRecordSearchReleaseAuthorizationV1;
  readonly current: PersonRecordSearchReleaseAuthorizationV1;
  readonly grants_sha256: Sha256Digest;
};
/** An admitted approved record, validated; the parsed envelope feeds only the approver projectors. */
type ApprovedRecordV1 = {
  readonly envelope: JsonObject;
  readonly brief: OrganizationRecordDecisionBriefV1;
  readonly reference: unknown;
  readonly policy_id: string;
  readonly added_at: string;
};

function invalidRequest(): never {
  throw new AuthorityOperationError("invalid_request", "request is invalid");
}

function itemNotFound(): never {
  throw new AuthorityOperationError("not_found", "item is not available");
}

function personDenied(): never {
  throw new AuthorityOperationError("unauthorized", "person authentication failed");
}

function metadataUnavailable(): never {
  throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
}

/** A compile error when a scope kind is added; a closed failure at run time. */
function unknownScope(scope: never): never {
  throw new AuthorityOperationError("invalid_request", `scope ${String((scope as { readonly kind?: unknown }).kind)} is invalid`);
}

/** The records half of a list scope: mine is the caller's own approvals, never global. */
function meetingScope(scope: PersonAskScopeV2): Readonly<{ project_id?: string; mine: boolean }> {
  switch (scope.kind) {
    case "global": return { mine: false };
    case "project": return { project_id: scope.project_id, mine: false };
    case "mine": return { mine: true };
    default: return unknownScope(scope);
  }
}

function meetingPosition(value: PersonItemPositionV1 | null | undefined): PersonItemPositionV1 | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || typeof value.added_at !== "string" || !CANONICAL_TIME.test(value.added_at) ||
    !Number.isFinite(Date.parse(value.added_at)) || new Date(value.added_at).toISOString() !== value.added_at ||
    typeof value.id !== "string" || !RECORD_SHA256.test(value.id)) invalidRequest();
  return Object.freeze({ added_at: value.added_at, id: value.id });
}

function partPosition(value: PersonMeetingPartPositionV1): PersonMeetingPartPositionV1 {
  if (value === null || typeof value !== "object" ||
    !Number.isSafeInteger(value.atom_order) || value.atom_order < 0 || value.atom_order > MEETING_PART_MAX ||
    !Number.isSafeInteger(value.part) || value.part < 1 || value.part > MEETING_PART_MAX) invalidRequest();
  return Object.freeze({ atom_order: value.atom_order, part: value.part });
}

/** Newest first, then the record digest ascending (binary): meetings' list order. */
function newestFirst(left: PersonItemPositionV1, right: PersonItemPositionV1): number {
  if (left.added_at !== right.added_at) return left.added_at > right.added_at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isRecordPolicy(value: unknown): value is ReadableSearchResultItemV1["policy_id"] {
  return value === "restricted-reviewer-person-v2" || value === "organization-member-readable-person-v2" || value === "project-members-readable-person-v1";
}

/** The signed receipt's issue time, as a canonical list time. */
function receiptTime(value: unknown): string {
  try {
    if (typeof value === "string") return new Date(value).toISOString();
  } catch {
    // An invalid stored time is an integrity failure, below.
  }
  return metadataUnavailable();
}

/**
 * Resolves the current Person once, reads only an exact-head immutable Layer 2
 * generation, and commits the same compact release audit used by Layer 1.
 */
export function createPersonRecordSearchRouteV1(
  options: CreatePersonRecordSearchRouteV1Options,
): PersonRecordSearchRouteV1 {
  const search =
    options.search_generation ?? searchReadableSearchGenerationV1;
  const releaseWitnesses = new WeakSet<PersonRecordSearchBatchReleaseV1>();
  const metadata = new RecordMetadataCacheV1();
  const meetingCollections = new WeakMap<PersonStoreHandleV1, MeetingCollectionState>();
  const meetingReleases = new WeakMap<PersonStoreReleaseV1, MeetingReleaseWitness>();

  function activeGenerationAt(pointer: ActiveGenerationRow): ReadableSearchActiveGenerationV1 {
    return {
      generation_id: pointer.generation_id,
      manifest_sha256: pointer.manifest_sha256,
      retrieval_contract_sha256: pointer.retrieval_contract_sha256,
      exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: pointer.record_head_position, record_sha256: pointer.record_head_hash },
    };
  }

  function readerOf(authorization: PersonAccessAuthorization, projects: RecordProjectAuthorizationV1): ReadableSearchReaderV1 {
    return { principal_id: authorization.principal_id, membership_id: authorization.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }) };
  }

  /** The stored approved row of a record already admitted to this reader, bound to its digests. */
  function envelopeRow(position: number, recordSha256: Sha256Digest, envelopeSha256?: Sha256Digest): { readonly canonical_envelope: string; readonly receipt_issued_at: string } {
    const row = options.record.prepare("SELECT canonical_envelope, envelope_sha256, receipt_issued_at FROM organization_record_log WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'").get(position, recordSha256) as
      | { readonly canonical_envelope: string; readonly envelope_sha256: Sha256Digest; readonly receipt_issued_at: string }
      | undefined;
    if (row === undefined || sha256Digest(row.canonical_envelope) !== row.envelope_sha256 || (envelopeSha256 !== undefined && row.envelope_sha256 !== envelopeSha256)) metadataUnavailable();
    return row;
  }

  function approvedRecord(position: number, recordSha256: Sha256Digest, envelopeSha256?: Sha256Digest): ApprovedRecordV1 {
    const row = envelopeRow(position, recordSha256, envelopeSha256);
    let parsed: JsonObject;
    let envelope: ReturnType<typeof validateOrganizationRecordEnvelopeV4>;
    try {
      parsed = parseCanonicalJson(row.canonical_envelope) as JsonObject;
      envelope = validateOrganizationRecordEnvelopeV4(parsed, options.record_input_codecs ?? HUMAN_ACT_RECORD_INPUT_CODECS_V4);
    } catch { metadataUnavailable(); }
    const event = envelope.body.event;
    if (envelope.record_sha256 !== recordSha256 || event.kind !== "approved") metadataUnavailable();
    return { envelope: parsed, brief: event.approved_snapshot.approved_payload.brief, reference: envelope.body.human_act_resolution_ref, policy_id: event.policy_id, added_at: receiptTime(row.receipt_issued_at) };
  }

  /** Whether the caller is this admitted record's final approver. The tuple never leaves the server. */
  function approvedByCaller(record: ReadableSearchGenerationRecordV1, authorization: PersonAccessAuthorization): boolean {
    let approver = metadata.get(record.record_sha256, record.envelope_sha256)?.approver;
    if (approver === undefined) {
      const row = envelopeRow(record.record_position, record.record_sha256, record.envelope_sha256);
      let envelope: JsonObject;
      try { envelope = parseCanonicalJson(row.canonical_envelope) as JsonObject; } catch { metadataUnavailable(); }
      approver = approverTupleV1(envelope, record.approval_id, options, options.record_approver) ?? null;
      metadata.merge(record.record_sha256, record.envelope_sha256, { approver, added_at: receiptTime(row.receipt_issued_at) });
    }
    return approver !== null && approver.principal_id === authorization.principal_id && approver.membership_id === authorization.membership_id;
  }

  function generationRecords(authorization: PersonAccessAuthorization, projects: RecordProjectAuthorizationV1, pointer: ActiveGenerationRow, projectId?: string): readonly ReadableSearchGenerationRecordV1[] {
    let listed: ReturnType<typeof listReadableSearchGenerationRecordsV1>;
    try {
      listed = listReadableSearchGenerationRecordsV1({ state_directory: options.state_directory, active_generation: activeGenerationAt(pointer), reader: readerOf(authorization, projects), ...(projectId === undefined ? {} : { project_id: projectId }) });
    } catch (error) { if (isUnavailableGenerationError(error)) unavailable(); throw error; }
    if (!hasExpectedGenerationIdentity({ result: listed, pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
    return listed.records;
  }

  /**
   * The caller's own approvals in this exact generation, sorted. It is a pure
   * function of (generation, tuple), so a release's revalidation is unchanged.
   */
  function mineRecordSet(authorization: PersonAccessAuthorization, projects: RecordProjectAuthorizationV1, pointer: ActiveGenerationRow): readonly Sha256Digest[] {
    if (options.record_approver === undefined) throw new AuthorityOperationError("unavailable", "record evidence is unavailable");
    return Object.freeze(generationRecords(authorization, projects, pointer)
      .filter((record) => approvedByCaller(record, authorization))
      .map((record) => record.record_sha256)
      .sort());
  }

  /** Receipt times of admitted records: cached, else one batched read bound to both digests. */
  function addedAtOf(records: readonly ReadableSearchGenerationRecordV1[]): ReadonlyMap<Sha256Digest, string> {
    const result = new Map<Sha256Digest, string>();
    const missing: ReadableSearchGenerationRecordV1[] = [];
    for (const record of records) {
      const cached = metadata.get(record.record_sha256, record.envelope_sha256)?.added_at;
      if (cached === undefined) missing.push(record); else result.set(record.record_sha256, cached);
    }
    if (missing.length === 0) return result;
    const rows = options.record.prepare("SELECT position, record_sha256, envelope_sha256, receipt_issued_at FROM organization_record_log WHERE event_kind = 'approved' AND position IN (SELECT CAST(value AS INTEGER) FROM json_each(?))")
      .all(JSON.stringify(missing.map((record) => record.record_position))) as readonly { readonly position: number; readonly record_sha256: Sha256Digest; readonly envelope_sha256: Sha256Digest; readonly receipt_issued_at: string }[];
    const byPosition = new Map(rows.map((row) => [row.position, row]));
    for (const record of missing) {
      const row = byPosition.get(record.record_position);
      if (row === undefined || row.record_sha256 !== record.record_sha256 || row.envelope_sha256 !== record.envelope_sha256) metadataUnavailable();
      const added_at = receiptTime(row.receipt_issued_at);
      metadata.merge(record.record_sha256, record.envelope_sha256, { added_at });
      result.set(record.record_sha256, added_at);
    }
    return result;
  }

  function presentationOf(record: ReadableSearchGenerationRecordV1): NonNullable<RecordMetadataV1["presentation"]> {
    const cached = metadata.get(record.record_sha256, record.envelope_sha256)?.presentation;
    if (cached !== undefined) return cached;
    const approved = approvedRecord(record.record_position, record.record_sha256, record.envelope_sha256);
    const meeting_date = meetingDateV1(approved.brief.meeting.time);
    const presentation = Object.freeze({ title: approved.brief.meeting.title ?? null, ...(meeting_date === undefined ? {} : { meeting_date }) });
    metadata.merge(record.record_sha256, record.envelope_sha256, { presentation, added_at: approved.added_at });
    return presentation;
  }

  /** Association ∩ the caller's current grants; an unjoined project id never leaves this query. */
  function recordAssociations(records: readonly Pick<ReadableSearchGenerationRecordV1, "record_position" | "record_sha256">[], projectIds: readonly string[]): ReadonlyMap<Sha256Digest, readonly ProjectIdV1[]> {
    const result = new Map<Sha256Digest, ProjectIdV1[]>();
    if (records.length === 0 || projectIds.length === 0) return result;
    const granted = new Set(projectIds);
    const digests = new Map(records.map((record) => [record.record_position, record.record_sha256]));
    const rows = options.record.prepare("SELECT record_position, record_sha256, project_id FROM organization_record_project_association_v1 WHERE record_position IN (SELECT CAST(value AS INTEGER) FROM json_each(?))")
      .all(JSON.stringify([...digests.keys()])) as readonly { readonly record_position: number; readonly record_sha256: Sha256Digest; readonly project_id: ProjectIdV1 }[];
    for (const row of rows) {
      if (digests.get(row.record_position) !== row.record_sha256) metadataUnavailable();
      if (granted.has(row.project_id)) result.set(row.record_sha256, [...(result.get(row.record_sha256) ?? []), row.project_id]);
    }
    for (const ids of result.values()) ids.sort();
    return result;
  }

  /** The Layer 1 exact read with current grants: the only admission for open. */
  function admittedRecord(authorization: PersonAccessAuthorization, projects: RecordProjectAuthorizationV1, recordSha256: Sha256Digest) {
    const rows = new PersonRecordReaderV1(options.record).list({
      authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
      principal_id: authorization.principal_id, membership_id: authorization.membership_id,
      ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }),
      record_sha256: recordSha256, limit: 1,
    });
    if (rows.length !== 1 || rows[0]!.record_sha256 !== recordSha256) itemNotFound();
    return rows[0]!;
  }

  function meetingCollection(authorization: PersonAccessAuthorization, projects: RecordProjectAuthorizationV1, scope: PersonAskScopeV2, rows: readonly PersonStoreMeetingRowV1[]): PersonMeetingCollectionV1 {
    const handle: PersonStoreHandleV1 = Object.freeze({});
    meetingCollections.set(handle, { authorization: releaseAuthorization(authorization), grants_sha256: projects.grants_sha256, scope: Object.freeze({ ...scope }), rows: Object.freeze([...rows]), consumed: false });
    return Object.freeze({ status: "ok" as const, rows: Object.freeze([...rows]), handle });
  }

  /** Current tuple and grants, as when the rows were read, or nothing is released. */
  function fencedMeetingRelease(accessToken: string, admitted: PersonRecordSearchReleaseAuthorizationV1, grantsSha256: Sha256Digest): PersonRecordSearchReleaseAuthorizationV1 {
    const released = options.sessions.authenticateAccess({ access_token: accessToken });
    if (!sameReleaseAuthorization(admitted, released) || released.organization_id !== options.organization_id ||
      captureRecordProjectsV1(options.capture_projects, released).grants_sha256 !== grantsSha256) personDenied();
    return releaseAuthorization(released);
  }

  function assertExpectedOrganization(
    authorization: PersonAccessAuthorization,
  ): void {
    if (authorization.organization_id !== options.organization_id) {
      throw new AuthorityOperationError(
        "unauthorized",
        "person authentication failed",
      );
    }
  }

  function searchBatch(
    input: PersonRecordSearchBatchInputV1,
  ): PersonRecordSearchBatchResultV1 {
    assertValidBatch(input);
    const authorization = options.sessions.authenticateAccess({
      access_token: input.access_token,
    });
    assertExpectedOrganization(authorization);
    const projects = captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
    try {
      input.on_authorized?.();
    } catch {
      // Observability cannot alter authorization or retrieval behavior.
    }
    const head = recordHead(options.record);
    const pointer = activeGeneration(options.authority);
    if (
      pointer === null ||
      pointer.organization_id !== options.organization_id ||
      pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 ||
      !sameHead(pointer, head)
    ) {
      annotateCoreRuntimeV1({ result: "unavailable", counts: { current_head: head.position, published_head: pointer?.record_head_position ?? null }, ...(pointer === null ? {} : { generation: pointer.generation_id }) });
      clearReadableSearchActiveGenerationV1();
      unavailable();
    }
    if (input.expected_pointer !== undefined && !matchesReleasePointer(pointer, input.expected_pointer)) {
      unavailable();
    }
    const mine = input.mine === true ? mineRecordSet(authorization, projects, pointer) : undefined;
    let results;
    try {
      results = input.queries.map((query) =>
        search({
        state_directory: options.state_directory,
        active_generation: {
          generation_id: pointer.generation_id,
          manifest_sha256: pointer.manifest_sha256,
          retrieval_contract_sha256: pointer.retrieval_contract_sha256,
          exact_head: {
            authority_id: options.authority_id,
            organization_id: options.organization_id,
            state_lineage_id: options.state_lineage_id,
            position: pointer.record_head_position,
            record_sha256: pointer.record_head_hash,
          },
        },
        reader: {
          principal_id: authorization.principal_id,
          membership_id: authorization.membership_id,
          ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }),
        },
        ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
        ...(mine === undefined ? {} : { record_sha256s: mine }),
        query,
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      );
    } catch (error) {
      if (isUnavailableGenerationError(error))
        unavailable();
      throw error;
    }
    for (const result of results) {
      if (
        !hasExpectedGenerationIdentity({
          result,
          pointer,
          authority_id: options.authority_id,
          organization_id: options.organization_id,
          state_lineage_id: options.state_lineage_id,
        })
      ) {
        unavailable();
      }
    }
    // Preserve the answer-composition plan's order while giving every focused query one
    // result per round. This is deterministic breadth without pretending that
    // the Layer 3 boundary has a cross-query reranker.
    const merged = new Map<Sha256Digest, ReadableSearchResultItemV1>();
    const longestResult = Math.max(
      ...results.map((result) => result.items.length),
    );
    for (let itemIndex = 0; itemIndex < longestResult; itemIndex += 1) {
      for (const result of results) {
        const item = result.items[itemIndex];
        if (item !== undefined && !merged.has(item.atom_id)) {
          merged.set(item.atom_id, item);
        }
      }
    }
    const lexicalItems = [...merged.values()];
    let items = lexicalItems;
    if (
      input.include_related_atom_packet === true &&
      options.expand_related_atoms !== undefined
    ) {
      // Cover distinct matching records, preferring a decision when available.
      // An action can identify a source whose decision missed every top ten.
      const decisions = lexicalItems.filter((item) => item.item_kind === "decision");
      const support = new Map<Sha256Digest, number>();
      for (const item of lexicalItems) {
        support.set(item.record_sha256, (support.get(item.record_sha256) ?? 0) + 1);
      }
      const records = new Set<Sha256Digest>();
      const recordAnchors = [...decisions, ...lexicalItems].filter((item) => {
        if (records.has(item.record_sha256)) return false;
        records.add(item.record_sha256);
        return true;
      });
      // Prefer records supported by multiple distinct lexical hits over an
      // isolated matching decision (for example, an unrelated dated launch),
      // after retaining the best lexical decision/record as a packet anchor.
      recordAnchors.sort((left, right) =>
        support.get(right.record_sha256)! - support.get(left.record_sha256)!,
      );
      const primaryAnchor = decisions[0] ?? lexicalItems[0];
      const anchors = [
        ...new Set([
          ...(primaryAnchor === undefined ? [] : [primaryAnchor]),
          ...recordAnchors,
          ...decisions,
        ]),
      ].slice(0, 3);
      if (anchors.length > 0) {
        const relatedLimit = RELATED_ATOM_PACKET_MAX_ITEMS_V1 - anchors.length;
        let related: ReadableSearchResultV1;
        try {
          related = options.expand_related_atoms({
            state_directory: options.state_directory,
            active_generation: {
              generation_id: pointer.generation_id,
              manifest_sha256: pointer.manifest_sha256,
              retrieval_contract_sha256: pointer.retrieval_contract_sha256,
              exact_head: {
                authority_id: options.authority_id,
                organization_id: options.organization_id,
                state_lineage_id: options.state_lineage_id,
                position: pointer.record_head_position,
                record_sha256: pointer.record_head_hash,
              },
            },
            reader: {
              principal_id: authorization.principal_id,
              membership_id: authorization.membership_id,
              ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }),
            },
            ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
            ...(mine === undefined ? {} : { record_sha256s: mine }),
            anchor_atom_ids: anchors.map((item) => item.atom_id),
            limit: relatedLimit,
            include_anchor_records: true,
          });
        } catch (error) {
          if (isUnavailableGenerationError(error))
            unavailable();
          throw error;
        }
        if (
          !hasExpectedGenerationIdentity({
            result: related,
            pointer,
            authority_id: options.authority_id,
            organization_id: options.organization_id,
            state_lineage_id: options.state_lineage_id,
          })
        ) {
          unavailable();
        }
        // Expansion is bounded to three anchors, not three relevant records.
        // Give independent lexical evidence a turn before related facts fill
        // the packet. Reuse the multiple-hit support preference above so an
        // isolated incidental match does not reserve space for every record.
        const anchorRecords = new Set(anchors.map((item) => item.record_sha256));
        const independent = lexicalItems.filter((item) =>
          !anchorRecords.has(item.record_sha256) && support.get(item.record_sha256)! > 1,
        );
        const supplements: ReadableSearchResultItemV1[] = [];
        const relatedItems = related.items.slice(0, relatedLimit);
        for (let index = 0; index < Math.max(relatedItems.length, independent.length); index += 1) {
          const relatedItem = relatedItems[index];
          const lexicalItem = independent[index];
          if (relatedItem !== undefined) supplements.push(relatedItem);
          if (lexicalItem !== undefined) supplements.push(lexicalItem);
        }
        const packet = new Map<Sha256Digest, ReadableSearchResultItemV1>();
        for (const item of [
          ...anchors,
          ...supplements,
          ...lexicalItems,
        ]) {
          if (!packet.has(item.atom_id)) packet.set(item.atom_id, item);
        }
        items = [...packet.values()];
      }
    }
    const released = options.sessions.authenticateAccess({
      access_token: input.access_token,
    });
    if (
      !samePointer(pointer, activeGeneration(options.authority)) ||
      !sameHead(pointer, recordHead(options.record))
    ) {
      unavailable();
    }
    if (
      !sameReleaseAuthorization(authorization, released) ||
      captureRecordProjectsV1(options.capture_projects, released, input.project_id).grants_sha256 !== projects.grants_sha256 ||
      released.organization_id !== options.organization_id
    ) {
      throw new AuthorityOperationError(
        "unauthorized",
        "person authentication failed",
      );
    }
    // This selector is a relevance narrowing only. It runs after the existing
    // generation, head, and second current-Person checks, and falls back to
    // the complete authorized result set when no exact evidence exists.
    const exactReleaseId = input.exact_release_id;
    const exactItems =
      exactReleaseId === undefined
        ? []
        : items.filter((item) =>
            containsCanonicalReleaseId(item.text, exactReleaseId),
          );
    const selectedItems = exactItems.length === 0 ? items : exactItems;
    const responseItems = input.include_related_atom_packet === true
      ? selectedItems.slice(0, RELATED_ATOM_PACKET_MAX_ITEMS_V1)
      : selectedItems;
    const deskSourceItems = input.desk === true
      ? boundedDeskItems(responseItems)
      : undefined;
    const response = asResponse({ items: deskSourceItems ?? responseItems });
    const deskProjection = deskSourceItems === undefined
      ? undefined
      : deskItems(options.record, deskSourceItems, options.record_input_codecs);
    const recordReadAuditRowSha256 = options.audit.append({
      read_mode: "layer2",
      authority_id: options.authority_id,
      organization_id: options.organization_id,
      state_lineage_id: options.state_lineage_id,
      principal_id: released.principal_id,
      membership_id: released.membership_id,
      session_family_id: released.session_family_id,
      result_count: response.items.length,
      response_sha256: canonicalSha256(JSON.parse(canonicalJson(deskProjection === undefined ? response : { response, desk_items: deskProjection })) as never),
      checked_at: released.checked_at,
    });
    const release: PersonRecordSearchBatchReleaseV1 = Object.freeze({
      initial_authorization: releaseAuthorization(authorization),
      current_authorization: releaseAuthorization(released),
      active_pointer: Object.freeze({
        generation_id: pointer.generation_id,
        manifest_sha256: pointer.manifest_sha256,
        retrieval_contract_sha256: pointer.retrieval_contract_sha256,
        record_head: Object.freeze({
          position: pointer.record_head_position,
          record_sha256: pointer.record_head_hash,
        }),
      }),
      record_read_audit_row_sha256: recordReadAuditRowSha256,
      project_authorization: projects,
      ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
      ...(input.mine === true ? { mine: true as const } : {}),
    });
    releaseWitnesses.add(release);
    return Object.freeze({
      response,
      release,
      query_hit_counts: Object.freeze(results.map((result) => result.items.length)),
      ...(deskProjection === undefined ? {} : { desk_items: deskProjection }),
      truncated: results.some((result) => result.truncated === true) ||
        (deskSourceItems !== undefined && deskSourceItems.length !== responseItems.length),
    });
  }

  function finalizeDeskOpen(input: {
    readonly access_token: string;
    readonly current: PersonRecordSearchReleaseAuthorizationV1;
    readonly pointer: ActiveGenerationRow;
    readonly projects: RecordProjectAuthorizationV1;
    readonly initial_authorization: PersonRecordSearchReleaseAuthorizationV1;
    readonly project_id?: string;
    readonly mine?: true;
    readonly anchor: Pick<ReadableSearchResultItemV1, "atom_id" | "record_sha256" | "record_position" | "envelope_sha256" | "atom_order" | "audience_project_count" | "item_kind" | "text" | "policy_id">;
  }): PersonRecordSearchBatchResultV1 {
    if (options.expand_related_atoms === undefined) unavailable();
    const mine = input.mine === true ? mineRecordSet(input.current, input.projects, input.pointer) : undefined;
    let resolvedAnchor: ReadableSearchResultItemV1 | undefined;
    try {
      const anchors = readReadableSearchGenerationAtomsV1({
        state_directory: options.state_directory,
        active_generation: {
          generation_id: input.pointer.generation_id,
          manifest_sha256: input.pointer.manifest_sha256,
          retrieval_contract_sha256: input.pointer.retrieval_contract_sha256,
          exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: input.pointer.record_head_position, record_sha256: input.pointer.record_head_hash },
        },
        reader: { principal_id: input.current.principal_id, membership_id: input.current.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: input.projects.project_ids }) },
        ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
        ...(mine === undefined ? {} : { record_sha256s: mine }),
        atom_ids: [input.anchor.atom_id],
      });
      if (!hasExpectedGenerationIdentity({ result: anchors, pointer: input.pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
      resolvedAnchor = anchors.items[0];
    } catch (error) {
      if (isUnavailableGenerationError(error)) unavailable();
      throw error;
    }
    if (resolvedAnchor === undefined ||
      resolvedAnchor.record_sha256 !== input.anchor.record_sha256 ||
      resolvedAnchor.record_position !== input.anchor.record_position ||
      resolvedAnchor.envelope_sha256 !== input.anchor.envelope_sha256 ||
      resolvedAnchor.atom_order !== input.anchor.atom_order ||
      resolvedAnchor.audience_project_count !== input.anchor.audience_project_count ||
      resolvedAnchor.item_kind !== input.anchor.item_kind ||
      resolvedAnchor.text !== input.anchor.text ||
      resolvedAnchor.policy_id !== input.anchor.policy_id) unavailable();
    let related: ReadableSearchResultV1;
    try {
      related = options.expand_related_atoms({
        state_directory: options.state_directory,
        active_generation: {
          generation_id: input.pointer.generation_id,
          manifest_sha256: input.pointer.manifest_sha256,
          retrieval_contract_sha256: input.pointer.retrieval_contract_sha256,
          exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: input.pointer.record_head_position, record_sha256: input.pointer.record_head_hash },
        },
        reader: { principal_id: input.current.principal_id, membership_id: input.current.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: input.projects.project_ids }) },
        ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
        ...(mine === undefined ? {} : { record_sha256s: mine }),
        anchor_atom_ids: [resolvedAnchor.atom_id],
        include_anchor_records: true,
        limit: 9,
      });
    } catch (error) {
      if (isUnavailableGenerationError(error)) unavailable();
      throw error;
    }
    if (!hasExpectedGenerationIdentity({ result: related, pointer: input.pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
    const items = [resolvedAnchor, ...related.items.filter((item) => item.record_sha256 === resolvedAnchor.record_sha256)].slice(0, 10);
    const released = options.sessions.authenticateAccess({ access_token: input.access_token });
    if (!sameReleaseAuthorization(input.current, released) || captureRecordProjectsV1(options.capture_projects, released, input.project_id).grants_sha256 !== input.projects.grants_sha256 || !samePointer(input.pointer, activeGeneration(options.authority)) || !sameHead(input.pointer, recordHead(options.record))) throw new AuthorityOperationError("unauthorized", "person authentication failed");
    const deskSourceItems = boundedDeskItems(items);
    const response = asResponse({ items: deskSourceItems });
    const projection = deskItems(options.record, deskSourceItems, options.record_input_codecs);
    const receipt = options.audit.append({ read_mode: "layer2", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: response.items.length, response_sha256: canonicalSha256(JSON.parse(canonicalJson({ response, desk_items: projection })) as never), checked_at: released.checked_at });
    const release: PersonRecordSearchBatchReleaseV1 = Object.freeze({ initial_authorization: input.initial_authorization, current_authorization: releaseAuthorization(released), active_pointer: Object.freeze({ generation_id: input.pointer.generation_id, manifest_sha256: input.pointer.manifest_sha256, retrieval_contract_sha256: input.pointer.retrieval_contract_sha256, record_head: Object.freeze({ position: input.pointer.record_head_position, record_sha256: input.pointer.record_head_hash }) }), record_read_audit_row_sha256: receipt, project_authorization: input.projects, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), ...(input.mine === true ? { mine: true as const } : {}) });
    releaseWitnesses.add(release);
    return Object.freeze({ response, release, query_hit_counts: Object.freeze([]), desk_items: projection, truncated: approvedRecordAtomCount(options.record, resolvedAnchor.record_position, resolvedAnchor.record_sha256, options.record_input_codecs) > 10 || deskSourceItems.length !== items.length });
  }

  return Object.freeze({
    search(input: {
      readonly access_token: string;
      readonly query: string;
      readonly limit?: number;
    }): PersonRecordSearchResponseV2 {
      return searchBatch({
        access_token: input.access_token,
        queries: [input.query],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).response;
    },
    searchBatch,
    initializeDesk(input: {
      readonly access_token: string;
      readonly project_id?: string;
      readonly mine?: true;
    }): PersonRecordSearchBatchResultV1 {
      assertValidMine(input);
      // Authenticate and capture scope before testing the only failure which
      // can legitimately select originals-only mode: an index behind the log.
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer === null) indexLagUnavailable();
      if (pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256) unavailable();
      if (!sameHead(pointer, head)) {
        if (isVerifiedIndexLag(options.record, pointer, head, options)) indexLagUnavailable();
        unavailable();
      }
      // A one-item inventory both fixes the immutable release and ensures the
      // warmed generation can actually be opened. Any later error is terminal.
      return this.listDeskBatch({ access_token: input.access_token, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), ...(input.mine === true ? { mine: true as const } : {}), limit: 1 });
    },
    listDeskBatch(input: {
      readonly access_token: string;
      readonly project_id?: string;
      readonly mine?: true;
      readonly expected_pointer?: PersonRecordSearchReleasePointerV1;
      readonly limit?: number;
      readonly kinds?: readonly ReadableSearchResultItemV1["item_kind"][];
    }): PersonRecordSearchBatchResultV1 {
      assertValidMine(input);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AuthorityOperationError("invalid_request", "request is invalid");
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer === null || pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 || !sameHead(pointer, head) || (input.expected_pointer !== undefined && !matchesReleasePointer(pointer, input.expected_pointer))) unavailable();
      const mine = input.mine === true ? mineRecordSet(authorization, projects, pointer) : undefined;
      let inventory: ReadableSearchResultV1;
      try {
        inventory = listReadableSearchGenerationV1({
          state_directory: options.state_directory,
          active_generation: { generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: pointer.record_head_position, record_sha256: pointer.record_head_hash } },
          reader: { principal_id: authorization.principal_id, membership_id: authorization.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }) },
          ...(input.project_id === undefined ? {} : { project_id: input.project_id }), limit,
          ...(mine === undefined ? {} : { record_sha256s: mine }),
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        });
      } catch (error) { if (isUnavailableGenerationError(error)) unavailable(); throw error; }
      if (!hasExpectedGenerationIdentity({ result: inventory, pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
      const released = options.sessions.authenticateAccess({ access_token: input.access_token });
      if (!sameReleaseAuthorization(authorization, released) || captureRecordProjectsV1(options.capture_projects, released, input.project_id).grants_sha256 !== projects.grants_sha256 || !samePointer(pointer, activeGeneration(options.authority)) || !sameHead(pointer, recordHead(options.record))) throw new AuthorityOperationError("unauthorized", "person authentication failed");
      const deskSourceItems = boundedDeskItems(inventory.items);
      const response = asResponse({ items: deskSourceItems });
      const projection = deskItems(options.record, deskSourceItems, options.record_input_codecs);
      const receipt = options.audit.append({ read_mode: "layer2", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: response.items.length, response_sha256: canonicalSha256(JSON.parse(canonicalJson({ response, desk_items: projection })) as never), checked_at: released.checked_at });
      const release: PersonRecordSearchBatchReleaseV1 = Object.freeze({ initial_authorization: releaseAuthorization(authorization), current_authorization: releaseAuthorization(released), active_pointer: Object.freeze({ generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, record_head: Object.freeze({ position: pointer.record_head_position, record_sha256: pointer.record_head_hash }) }), record_read_audit_row_sha256: receipt, project_authorization: projects, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), ...(input.mine === true ? { mine: true as const } : {}) });
      releaseWitnesses.add(release);
      return Object.freeze({ response, release, query_hit_counts: Object.freeze([]), desk_items: projection, truncated: inventory.truncated === true || deskSourceItems.length !== inventory.items.length });
    },
    openDeskCitation(input: {
      readonly access_token: string;
      readonly project_id?: string;
      readonly mine?: true;
      readonly atom_id: Sha256Digest;
      readonly record_sha256: Sha256Digest;
      readonly policy_id: ReadableSearchResultItemV1["policy_id"];
    }): PersonRecordSearchBatchResultV1 {
      assertValidMine(input);
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer === null || pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 || !sameHead(pointer, head)) unavailable();
      const mine = input.mine === true ? mineRecordSet(authorization, projects, pointer) : undefined;
      let found: ReadableSearchResultV1;
      try {
        found = readReadableSearchGenerationAtomsV1({ state_directory: options.state_directory, active_generation: { generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: pointer.record_head_position, record_sha256: pointer.record_head_hash } }, reader: { principal_id: authorization.principal_id, membership_id: authorization.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }) }, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), ...(mine === undefined ? {} : { record_sha256s: mine }), atom_ids: [input.atom_id] });
      } catch (error) { if (isUnavailableGenerationError(error)) unavailable(); throw error; }
      if (!hasExpectedGenerationIdentity({ result: found, pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
      const anchor = found.items[0];
      if (anchor === undefined || anchor.record_sha256 !== input.record_sha256 || anchor.policy_id !== input.policy_id) throw new AuthorityOperationError("not_found", "record evidence is not available");
      const released = options.sessions.authenticateAccess({ access_token: input.access_token });
      if (!sameReleaseAuthorization(authorization, released) || captureRecordProjectsV1(options.capture_projects, released, input.project_id).grants_sha256 !== projects.grants_sha256 || !samePointer(pointer, activeGeneration(options.authority)) || !sameHead(pointer, recordHead(options.record))) throw new AuthorityOperationError("unauthorized", "person authentication failed");
      // Resolving a citation is an internal lookup, not a content release.
      // `finalizeDeskOpen` performs the sole audit after the expanded packet
      // and its metadata have passed the final Person and snapshot fence.
      return finalizeDeskOpen({
        access_token: input.access_token,
        current: releaseAuthorization(released),
        pointer,
        projects,
        initial_authorization: releaseAuthorization(authorization),
        ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
        ...(input.mine === true ? { mine: true as const } : {}),
        anchor,
      });
    },
    openDeskBatch(input: {
      readonly access_token: string;
      readonly release: PersonRecordSearchBatchReleaseV1;
      readonly anchor: Pick<ReadableSearchResultItemV1, "atom_id" | "record_sha256" | "record_position" | "envelope_sha256" | "atom_order" | "audience_project_count" | "item_kind" | "text" | "policy_id">;
    }): PersonRecordSearchBatchResultV1 {
      // First prove the original release still binds the current person and
      // exact head.  An anchor is accepted only from the caller's retained
      // desk state; this method never turns a model string into a search.
      const current = this.revalidateBatchRelease({ access_token: input.access_token, release: input.release });
      const pointer = activeGeneration(options.authority);
      if (pointer === null || !matchesReleasePointer(pointer, input.release.active_pointer)) unavailable();
      const projects = captureRecordProjectsV1(options.capture_projects, current, input.release.project_id);
      return finalizeDeskOpen({
        access_token: input.access_token,
        current,
        pointer,
        projects,
        initial_authorization: input.release.initial_authorization,
        ...(input.release.project_id === undefined ? {} : { project_id: input.release.project_id }),
        ...(input.release.mine === true ? { mine: true as const } : {}),
        anchor: input.anchor,
      });
    },
    collectMeetings(input: Parameters<PersonMeetingItemsPortV1["collectMeetings"]>[0]): PersonMeetingCollectionV1 {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MEETING_COLLECT_MAX) invalidRequest();
      const after = meetingPosition(input.after);
      const scope = meetingScope(input.scope);
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization, scope.project_id);
      // Mine without the approver projectors fails closed; it never lists global.
      if (scope.mine && options.record_approver === undefined) unavailable();
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer !== null && (pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256)) unavailable();
      if (pointer === null || !sameHead(pointer, head)) {
        if (!isVerifiedIndexLag(options.record, pointer, head, options)) unavailable();
        // Hold only for a record this reader can read after the published head.
        // An approval the reader cannot see never changes what the reader sees.
        const newest = new PersonRecordReaderV1(options.record).list({
          authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
          principal_id: authorization.principal_id, membership_id: authorization.membership_id,
          ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }),
          ...(scope.project_id === undefined ? {} : { project_id: scope.project_id }), limit: 1,
        })[0];
        if (newest !== undefined && newest.position > (pointer?.record_head_position ?? 0)) return Object.freeze({ status: "held" as const });
        if (pointer === null) return meetingCollection(authorization, projects, input.scope, []);
      }
      const listed = generationRecords(authorization, projects, pointer, scope.project_id);
      const candidates = scope.mine ? listed.filter((record) => approvedByCaller(record, authorization)) : listed;
      const added = addedAtOf(candidates);
      const taken = candidates
        .map((record) => ({ record, position: { added_at: added.get(record.record_sha256)!, id: record.record_sha256 } }))
        .filter(({ position }) => after === null || newestFirst(after, position) < 0)
        .sort((left, right) => newestFirst(left.position, right.position))
        .slice(0, input.limit);
      const associations = recordAssociations(taken.map(({ record }) => record), projects.project_ids);
      const rows = taken.map(({ record, position }): PersonStoreMeetingRowV1 => {
        const presentation = presentationOf(record);
        return Object.freeze({
          kind: "meeting" as const, id: record.record_sha256, title: presentation.title, added_at: position.added_at,
          visibility: recordVisibility(record.policy_id, record.audience_project_count),
          association_project_ids: Object.freeze(associations.get(record.record_sha256) ?? []),
          ...(presentation.meeting_date === undefined ? {} : { meeting_date: presentation.meeting_date }),
        });
      });
      return meetingCollection(authorization, projects, input.scope, rows);
    },
    commitMeetings(input: Parameters<PersonMeetingItemsPortV1["commitMeetings"]>[0]): PersonStoreReleaseV1 {
      const state = meetingCollections.get(input.handle);
      if (state === undefined || state.consumed) personDenied();
      if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > state.rows.length) invalidRequest();
      state.consumed = true;
      // A page that emits no meetings writes no audit row, so it has no receipt.
      if (input.count === 0) {
        const empty: PersonStoreReleaseV1 = Object.freeze({});
        meetingReleases.set(empty, { initial: state.authorization, current: state.authorization, grants_sha256: state.grants_sha256 });
        return empty;
      }
      // No pointer or head check: a concurrent approval must not fail a page.
      const released = fencedMeetingRelease(input.access_token, state.authorization, state.grants_sha256);
      const receipt = options.audit.append({
        read_mode: "person_list", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
        principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: input.count,
        response_sha256: canonicalSha256({ schema_version: 1, kind: "echo-person-list-meetings-release-v1", scope: state.scope, rows: state.rows.slice(0, input.count) }),
        checked_at: released.checked_at,
      });
      const release: PersonStoreReleaseV1 = Object.freeze({ receipt });
      meetingReleases.set(release, { initial: state.authorization, current: released, grants_sha256: state.grants_sha256 });
      return release;
    },
    openMeeting(input: Parameters<PersonMeetingItemsPortV1["openMeeting"]>[0]): ReturnType<PersonMeetingItemsPortV1["openMeeting"]> {
      if (typeof input.record_sha256 !== "string" || !RECORD_SHA256.test(input.record_sha256)) itemNotFound();
      const from = input.from === undefined ? undefined : partPosition(input.from);
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization);
      const admitted = admittedRecord(authorization, projects, input.record_sha256);
      const record = approvedRecord(admitted.position, admitted.record_sha256);
      const parts = meetingAtomsV1(record.brief, confirmedOwners(record.reference));
      // A cursor is checked only after admission, so a guessed position on an
      // unreadable record is the same miss as the record itself.
      const start = from === undefined ? 0 : parts.findIndex((part) => part.atom_order === from.atom_order && part.part_index === from.part);
      if (start < 0) itemNotFound();
      const atoms: PersonOpenMeetingAtomV1[] = [];
      let index = start;
      while (index < parts.length && atoms.length < PERSON_OPEN_ATOMS_MAX_V1) {
        const candidate = parts[index]!.atom;
        if (atoms.length > 0 && Buffer.byteLength(canonicalJson([...atoms, candidate])) > PERSON_OPEN_ATOMS_BUDGET_BYTES_V1) break;
        atoms.push(candidate);
        index += 1;
      }
      const following = parts[index];
      const next = following === undefined ? null : Object.freeze({ atom_order: following.atom_order, part: following.part_index });
      if (!isRecordPolicy(record.policy_id)) metadataUnavailable();
      const audience = (options.record.prepare("SELECT count(*) AS count FROM organization_record_project_members_readable_person_record_fact WHERE record_position = ? AND record_sha256 = ?")
        .get(admitted.position, admitted.record_sha256) as { readonly count: number }).count;
      const meeting_date = meetingDateV1(record.brief.meeting.time);
      const row: PersonStoreMeetingRowV1 = Object.freeze({
        kind: "meeting" as const, id: admitted.record_sha256, title: record.brief.meeting.title ?? null, added_at: record.added_at,
        visibility: recordVisibility(record.policy_id, audience),
        association_project_ids: Object.freeze(recordAssociations([{ record_position: admitted.position, record_sha256: admitted.record_sha256 }], projects.project_ids).get(admitted.record_sha256) ?? []),
        ...(meeting_date === undefined ? {} : { meeting_date }),
      });
      const meeting = from === undefined
        ? meetingDetailV1(record.brief, boundedTextV1(approverDisplayNameV1(record.envelope, admitted.approval_id, options, options.record_approver, options.memberships), PERSON_LIST_TEXT_MAX_BYTES_V1))
        : undefined;
      const transcript_shared = from === undefined && options.transcript_probe?.({ actor: authorization, approval_id: admitted.approval_id, record_sha256: admitted.record_sha256 }) === true;
      const released = fencedMeetingRelease(input.access_token, releaseAuthorization(authorization), projects.grants_sha256);
      const receipt = options.audit.append({
        read_mode: "person_open", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id,
        principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: atoms.length,
        response_sha256: canonicalSha256({ schema_version: 1, kind: "echo-person-open-meeting-release-v1", record_sha256: admitted.record_sha256, row, ...(meeting === undefined ? {} : { meeting }), atoms, next }),
        checked_at: released.checked_at,
      });
      const release: PersonStoreReleaseV1 = Object.freeze({ receipt });
      meetingReleases.set(release, { initial: releaseAuthorization(authorization), current: released, grants_sha256: projects.grants_sha256 });
      return Object.freeze({ row, ...(meeting === undefined ? {} : { meeting, transcript_shared }), atoms: Object.freeze(atoms), next, release });
    },
    admitMeeting(input: Parameters<PersonMeetingItemsPortV1["admitMeeting"]>[0]): void {
      if (typeof input.record_sha256 !== "string" || !RECORD_SHA256.test(input.record_sha256)) itemNotFound();
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      admittedRecord(authorization, captureRecordProjectsV1(options.capture_projects, authorization), input.record_sha256);
    },
    revalidateMeetingRelease(input: Parameters<PersonMeetingItemsPortV1["revalidateMeetingRelease"]>[0]): void {
      const witness = meetingReleases.get(input.release);
      if (witness === undefined) personDenied();
      const current = options.sessions.authenticateAccess({ access_token: input.access_token });
      if (!sameReleaseAuthorization(current, witness.initial) || !sameReleaseAuthorization(current, witness.current) ||
        current.organization_id !== options.organization_id ||
        captureRecordProjectsV1(options.capture_projects, current).grants_sha256 !== witness.grants_sha256) personDenied();
    },
    revalidateBatchRelease(input: {
      readonly access_token: string;
      readonly release: PersonRecordSearchBatchReleaseV1;
    }): PersonRecordSearchReleaseAuthorizationV1 {
      if (!releaseWitnesses.has(input.release)) {
        throw new AuthorityOperationError(
          "unauthorized",
          "person authentication failed",
        );
      }
      const current = options.sessions.authenticateAccess({
        access_token: input.access_token,
      });
      const pointer = activeGeneration(options.authority);
      const head = recordHead(options.record);
      if (
        captureRecordProjectsV1(options.capture_projects, current, input.release.project_id).grants_sha256 !== input.release.project_authorization?.grants_sha256 ||
        !sameReleaseAuthorization(
          current,
          input.release.initial_authorization,
        ) ||
        !sameReleaseAuthorization(
          current,
          input.release.current_authorization,
        ) ||
        current.organization_id !== options.organization_id ||
        pointer === null ||
        pointer.organization_id !== options.organization_id ||
        pointer.retrieval_contract_sha256 !==
          options.retrieval_contract_sha256 ||
        pointer.generation_id !== input.release.active_pointer.generation_id ||
        pointer.manifest_sha256 !==
          input.release.active_pointer.manifest_sha256 ||
        pointer.retrieval_contract_sha256 !==
          input.release.active_pointer.retrieval_contract_sha256 ||
        pointer.record_head_position !==
          input.release.active_pointer.record_head.position ||
        pointer.record_head_hash !==
          input.release.active_pointer.record_head.record_sha256 ||
        head.position !== input.release.active_pointer.record_head.position ||
        head.record_sha256 !==
          input.release.active_pointer.record_head.record_sha256
      ) {
        throw new AuthorityOperationError(
          "unauthorized",
          "person authentication failed",
        );
      }
      return releaseAuthorization(current);
    },
  });
}
