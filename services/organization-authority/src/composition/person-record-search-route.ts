import { annotateCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { validateOrganizationRecordEnvelopeV4 } from "@echo-brain/organization-protocol";
import {
  clearReadableSearchActiveGenerationV1,
  listReadableSearchGenerationV1,
  readReadableSearchGenerationAtomsV1,
  searchReadableSearchGenerationV1,
  type ReadableSearchActiveGenerationV1,
  type ReadableSearchReaderV1,
  type ReadableSearchResultItemV1,
  type ReadableSearchResultV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type Database from "better-sqlite3";
import { captureRecordProjectsV1, type CaptureRecordProjectsV1, type RecordProjectAuthorizationV1 } from "./person-record-project-scope-v1.js";
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
 * request-bound surface separate from the V1/V2 batch contract, whose
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
    readonly expected_pointer?: PersonRecordSearchReleasePointerV1;
    readonly limit?: number;
    readonly kinds?: readonly ReadableSearchResultItemV1["item_kind"][];
  }): PersonRecordSearchBatchResultV1;
  initializeDesk(input: {
    readonly access_token: string;
    readonly project_id?: string;
  }): PersonRecordSearchBatchResultV1;
  openDeskCitation(input: {
    readonly access_token: string;
    readonly project_id?: string;
    readonly atom_id: Sha256Digest;
    readonly record_sha256: Sha256Digest;
    readonly policy_id: ReadableSearchResultItemV1["policy_id"];
  }): PersonRecordSearchBatchResultV1;
}

export type PersonRecordSearchRouteV1 =
  PersonRecordSearchHttpApplicationV1 &
    PersonRecordSearchBatchApplicationV1 &
    PersonEvidenceDeskRecordsV1;

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

function assertValidBatch(input: PersonRecordSearchBatchInputV1): void {
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

function deskItems(record: Database.Database, items: readonly ReadableSearchResultItemV1[]): readonly PersonRecordDeskItemV1[] {
  const statement = record.prepare(`SELECT canonical_envelope, envelope_sha256, record_sha256 FROM organization_record_log WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'`);
  return Object.freeze(items.map((item) => {
    const row = statement.get(item.record_position, item.record_sha256) as { readonly canonical_envelope: string; readonly envelope_sha256: Sha256Digest; readonly record_sha256: Sha256Digest } | undefined;
    if (row === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    let envelope: ReturnType<typeof validateOrganizationRecordEnvelopeV4>;
    try { envelope = validateOrganizationRecordEnvelopeV4(parseCanonicalJson(row.canonical_envelope)); } catch { throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable"); }
    if (row.envelope_sha256 !== item.envelope_sha256 || sha256Digest(row.canonical_envelope) !== row.envelope_sha256 || envelope.record_sha256 !== item.record_sha256 || envelope.body.event.kind !== "approved") throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const brief = envelope.body.event.approved_snapshot.approved_payload.brief;
    if (item.atom_order === undefined || item.audience_project_count === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const signal = [...brief.decisions, ...brief.actions, ...brief.rationales][item.atom_order];
    if (signal === undefined || signal.kind !== item.item_kind || signal.text !== item.text) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    const attributes = signal.kind === "decision" ? { status: signal.status } : signal.kind === "action" ? { ...(signal.owner === null ? {} : { owner: signal.owner }), ...(signal.due_at === null ? {} : { due_at: signal.due_at }) } : undefined;
    const visibility = item.policy_id === "restricted-reviewer-person-v2" ? "approver_only" : item.policy_id === "project-members-readable-person-v1" ? (item.audience_project_count === 1 ? "project" : "projects") : "team";
    if (item.policy_id === "project-members-readable-person-v1" && item.audience_project_count < 1) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
    return Object.freeze({ atom_id: item.atom_id, record_sha256: item.record_sha256, item_kind: item.item_kind, text: item.text, policy_id: item.policy_id, record_position: item.record_position, envelope_sha256: item.envelope_sha256, atom_order: item.atom_order, audience_project_count: item.audience_project_count, label: deskLabel(brief.meeting.title, brief.meeting.time), visibility, ...(attributes === undefined || Object.keys(attributes).length === 0 ? {} : { attributes: Object.freeze(attributes) }) });
  }));
}

function boundedDeskItems(items: readonly ReadableSearchResultItemV1[]): readonly ReadableSearchResultItemV1[] {
  return items.filter((item) =>
    Buffer.byteLength(item.text, "utf8") <= EVIDENCE_DESK_MAX_ITEM_UTF8_BYTES_V1,
  );
}

function approvedRecordAtomCount(record: Database.Database, position: number, recordSha256: Sha256Digest): number {
  const row = record.prepare(`SELECT canonical_envelope FROM organization_record_log WHERE position = ? AND record_sha256 = ? AND event_kind = 'approved'`).get(position, recordSha256) as { readonly canonical_envelope: string } | undefined;
  if (row === undefined) throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
  let envelope: ReturnType<typeof validateOrganizationRecordEnvelopeV4>;
  try { envelope = validateOrganizationRecordEnvelopeV4(parseCanonicalJson(row.canonical_envelope)); } catch { throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable"); }
  if (envelope.record_sha256 !== recordSha256 || envelope.body.event.kind !== "approved") throw new AuthorityOperationError("unavailable", "record evidence metadata is unavailable");
  const brief = envelope.body.event.approved_snapshot.approved_payload.brief;
  return brief.decisions.length + brief.actions.length + brief.rationales.length;
}

function hasExpectedGenerationIdentity(input: {
  readonly result: ReadableSearchResultV1;
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
      : deskItems(options.record, deskSourceItems);
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
    readonly anchor: Pick<ReadableSearchResultItemV1, "atom_id" | "record_sha256" | "record_position" | "envelope_sha256" | "atom_order" | "audience_project_count" | "item_kind" | "text" | "policy_id">;
  }): PersonRecordSearchBatchResultV1 {
    if (options.expand_related_atoms === undefined) unavailable();
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
    const projection = deskItems(options.record, deskSourceItems);
    const receipt = options.audit.append({ read_mode: "layer2", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: response.items.length, response_sha256: canonicalSha256(JSON.parse(canonicalJson({ response, desk_items: projection })) as never), checked_at: released.checked_at });
    const release: PersonRecordSearchBatchReleaseV1 = Object.freeze({ initial_authorization: input.initial_authorization, current_authorization: releaseAuthorization(released), active_pointer: Object.freeze({ generation_id: input.pointer.generation_id, manifest_sha256: input.pointer.manifest_sha256, retrieval_contract_sha256: input.pointer.retrieval_contract_sha256, record_head: Object.freeze({ position: input.pointer.record_head_position, record_sha256: input.pointer.record_head_hash }) }), record_read_audit_row_sha256: receipt, project_authorization: input.projects, ...(input.project_id === undefined ? {} : { project_id: input.project_id }) });
    releaseWitnesses.add(release);
    return Object.freeze({ response, release, query_hit_counts: Object.freeze([]), desk_items: projection, truncated: approvedRecordAtomCount(options.record, resolvedAnchor.record_position, resolvedAnchor.record_sha256) > 10 || deskSourceItems.length !== items.length });
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
    }): PersonRecordSearchBatchResultV1 {
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
      return this.listDeskBatch({ access_token: input.access_token, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), limit: 1 });
    },
    listDeskBatch(input: {
      readonly access_token: string;
      readonly project_id?: string;
      readonly expected_pointer?: PersonRecordSearchReleasePointerV1;
      readonly limit?: number;
      readonly kinds?: readonly ReadableSearchResultItemV1["item_kind"][];
    }): PersonRecordSearchBatchResultV1 {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AuthorityOperationError("invalid_request", "request is invalid");
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer === null || pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 || !sameHead(pointer, head) || (input.expected_pointer !== undefined && !matchesReleasePointer(pointer, input.expected_pointer))) unavailable();
      let inventory: ReadableSearchResultV1;
      try {
        inventory = listReadableSearchGenerationV1({
          state_directory: options.state_directory,
          active_generation: { generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: pointer.record_head_position, record_sha256: pointer.record_head_hash } },
          reader: { principal_id: authorization.principal_id, membership_id: authorization.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }) },
          ...(input.project_id === undefined ? {} : { project_id: input.project_id }), limit,
          ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        });
      } catch (error) { if (isUnavailableGenerationError(error)) unavailable(); throw error; }
      if (!hasExpectedGenerationIdentity({ result: inventory, pointer, authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id })) unavailable();
      const released = options.sessions.authenticateAccess({ access_token: input.access_token });
      if (!sameReleaseAuthorization(authorization, released) || captureRecordProjectsV1(options.capture_projects, released, input.project_id).grants_sha256 !== projects.grants_sha256 || !samePointer(pointer, activeGeneration(options.authority)) || !sameHead(pointer, recordHead(options.record))) throw new AuthorityOperationError("unauthorized", "person authentication failed");
      const deskSourceItems = boundedDeskItems(inventory.items);
      const response = asResponse({ items: deskSourceItems });
      const projection = deskItems(options.record, deskSourceItems);
      const receipt = options.audit.append({ read_mode: "layer2", authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, principal_id: released.principal_id, membership_id: released.membership_id, session_family_id: released.session_family_id, result_count: response.items.length, response_sha256: canonicalSha256(JSON.parse(canonicalJson({ response, desk_items: projection })) as never), checked_at: released.checked_at });
      const release: PersonRecordSearchBatchReleaseV1 = Object.freeze({ initial_authorization: releaseAuthorization(authorization), current_authorization: releaseAuthorization(released), active_pointer: Object.freeze({ generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, record_head: Object.freeze({ position: pointer.record_head_position, record_sha256: pointer.record_head_hash }) }), record_read_audit_row_sha256: receipt, project_authorization: projects, ...(input.project_id === undefined ? {} : { project_id: input.project_id }) });
      releaseWitnesses.add(release);
      return Object.freeze({ response, release, query_hit_counts: Object.freeze([]), desk_items: projection, truncated: inventory.truncated === true || deskSourceItems.length !== inventory.items.length });
    },
    openDeskCitation(input: {
      readonly access_token: string;
      readonly project_id?: string;
      readonly atom_id: Sha256Digest;
      readonly record_sha256: Sha256Digest;
      readonly policy_id: ReadableSearchResultItemV1["policy_id"];
    }): PersonRecordSearchBatchResultV1 {
      const authorization = options.sessions.authenticateAccess({ access_token: input.access_token });
      assertExpectedOrganization(authorization);
      const projects = captureRecordProjectsV1(options.capture_projects, authorization, input.project_id);
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (pointer === null || pointer.organization_id !== options.organization_id || pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 || !sameHead(pointer, head)) unavailable();
      let found: ReadableSearchResultV1;
      try {
        found = readReadableSearchGenerationAtomsV1({ state_directory: options.state_directory, active_generation: { generation_id: pointer.generation_id, manifest_sha256: pointer.manifest_sha256, retrieval_contract_sha256: pointer.retrieval_contract_sha256, exact_head: { authority_id: options.authority_id, organization_id: options.organization_id, state_lineage_id: options.state_lineage_id, position: pointer.record_head_position, record_sha256: pointer.record_head_hash } }, reader: { principal_id: authorization.principal_id, membership_id: authorization.membership_id, ...(options.capture_projects === undefined ? {} : { project_ids: projects.project_ids }) }, ...(input.project_id === undefined ? {} : { project_id: input.project_id }), atom_ids: [input.atom_id] });
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
        anchor: input.anchor,
      });
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
