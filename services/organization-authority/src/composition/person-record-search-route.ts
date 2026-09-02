import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  clearReadableSearchActiveGenerationV1,
  searchReadableSearchGenerationV1,
  type ReadableSearchActiveGenerationV1,
  type ReadableSearchReaderV1,
  type ReadableSearchResultItemV1,
  type ReadableSearchResultV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import type Database from "better-sqlite3";
import { SqlitePersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/person-record-read-audit-v1.js";
import {
  containsCanonicalReleaseId,
  isCanonicalReleaseId,
} from "../answer-composition/canonical-release-id.js";
import type { PersonAccessAuthorization } from "../application/person-identity-sessions.js";
import { AuthorityOperationError } from "../domain/errors.js";
import type {
  PersonRecordSearchHttpApplicationV1,
  PersonRecordSearchResponseV1,
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

/**
 * The Layer 2 related-atom reader is injected here so the Authority boundary
 * remains independently testable while the disposable relationship plane is
 * rebuilt. Its shape intentionally matches expandReadableSearchRelatedAtomsV1.
 */
export interface ExpandReadableSearchRelatedAtomsV1Input {
  readonly state_directory: string;
  readonly active_generation: ReadableSearchActiveGenerationV1;
  readonly reader: ReadableSearchReaderV1;
  readonly anchor_atom_ids: readonly Sha256Digest[];
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
  /**
   * A canonical release named by the answer question. Layer 3 applies it only
   * after normal authorization has admitted the merged evidence.
   */
  readonly exact_release_id?: string;
  readonly limit?: number;
  /**
   * Server-only answer-composition request for the bounded decision packet.
   * The HTTP search route and direct `searchBatch` callers retain lexical
   * ordering unless Layer 4 explicitly asks for this plan.
   */
  readonly include_related_atom_packet?: true;
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
}

export interface PersonRecordSearchBatchResultV1 {
  readonly response: PersonRecordSearchResponseV1;
  readonly release: PersonRecordSearchBatchReleaseV1;
  /** Ordered per-query result counts, kept server-side for answer auditing only. */
  readonly query_hit_counts: readonly number[];
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

export type PersonRecordSearchRouteV1 =
  PersonRecordSearchHttpApplicationV1 &
    PersonRecordSearchBatchApplicationV1;

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

function asResponse(input: {
  readonly generation_id: Sha256Digest;
  readonly record_head: RecordHead;
  readonly items: readonly ReadableSearchResultItemV1[];
}): PersonRecordSearchResponseV1 {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-search-v1",
    generation_id: input.generation_id,
    record_head: Object.freeze({
      position: input.record_head.position,
      record_sha256: input.record_head.record_sha256,
    }),
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
    const head = recordHead(options.record);
    const pointer = activeGeneration(options.authority);
    if (
      pointer === null ||
      pointer.organization_id !== options.organization_id ||
      pointer.retrieval_contract_sha256 !== options.retrieval_contract_sha256 ||
      !sameHead(pointer, head)
    ) {
      clearReadableSearchActiveGenerationV1();
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
        },
        query,
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
      const anchors = lexicalItems.filter(
        (item) => item.item_kind === "decision",
      ).slice(0, 3);
      if (anchors.length > 0) {
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
            },
            anchor_atom_ids: anchors.map((item) => item.atom_id),
            limit: 13,
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
        const packet = new Map<Sha256Digest, ReadableSearchResultItemV1>();
        for (const item of [
          ...anchors,
          ...related.items.slice(0, 13),
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
    const response = asResponse({
      generation_id: pointer.generation_id,
      record_head: head,
      items:
        input.include_related_atom_packet === true
          ? selectedItems.slice(0, RELATED_ATOM_PACKET_MAX_ITEMS_V1)
          : selectedItems,
    });
    const recordReadAuditRowSha256 = options.audit.append({
      read_mode: "layer2",
      authority_id: options.authority_id,
      organization_id: options.organization_id,
      state_lineage_id: options.state_lineage_id,
      principal_id: released.principal_id,
      membership_id: released.membership_id,
      session_family_id: released.session_family_id,
      result_count: response.items.length,
      response_sha256: canonicalSha256(
        JSON.parse(canonicalJson(response)) as never,
      ),
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
    });
    releaseWitnesses.add(release);
    return Object.freeze({
      response,
      release,
      query_hit_counts: Object.freeze(results.map((result) => result.items.length)),
    });
  }

  return Object.freeze({
    search(input: {
      readonly access_token: string;
      readonly query: string;
      readonly limit?: number;
    }): PersonRecordSearchResponseV1 {
      return searchBatch({
        access_token: input.access_token,
        queries: [input.query],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).response;
    },
    searchBatch,
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
