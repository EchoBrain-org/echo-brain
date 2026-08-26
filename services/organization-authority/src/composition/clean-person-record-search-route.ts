import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  clearCleanReadableSearchActiveGenerationV1,
  searchCleanReadableSearchGenerationV1,
  type CleanReadableSearchResultItemV1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import type Database from "better-sqlite3";
import { SqliteCleanPersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import type { PersonAccessAuthorization } from "../application/person-identity-sessions.js";
import { AuthorityOperationError } from "../domain/errors.js";
import type {
  CleanPersonRecordSearchHttpApplicationV1,
  CleanPersonRecordSearchResponseV1,
} from "../presentation/clean-person-record-search-http-application.js";

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

type SearchGeneration = typeof searchCleanReadableSearchGenerationV1;

/**
 * In-process Layer 3 input for a bounded Layer 4 retrieval plan. This is not
 * part of the Person HTTP contract: the bearer remains server-side while the
 * caller's plan is executed under one reader tuple and one exact snapshot.
 */
export interface CleanPersonRecordSearchBatchInputV1 {
  readonly access_token: string;
  readonly queries: readonly string[];
  readonly limit?: number;
}

export type CleanPersonRecordSearchReleaseAuthorizationV1 =
  Readonly<PersonAccessAuthorization>;

export interface CleanPersonRecordSearchReleasePointerV1 {
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
export interface CleanPersonRecordSearchBatchReleaseV1 {
  readonly initial_authorization: CleanPersonRecordSearchReleaseAuthorizationV1;
  readonly current_authorization: CleanPersonRecordSearchReleaseAuthorizationV1;
  readonly active_pointer: CleanPersonRecordSearchReleasePointerV1;
  readonly record_read_audit_row_sha256: Sha256Digest;
}

export interface CleanPersonRecordSearchBatchResultV1 {
  readonly response: CleanPersonRecordSearchResponseV1;
  readonly release: CleanPersonRecordSearchBatchReleaseV1;
}

export interface CleanPersonRecordSearchBatchApplicationV1 {
  searchBatch(
    input: CleanPersonRecordSearchBatchInputV1,
  ): CleanPersonRecordSearchBatchResultV1;
  revalidateBatchRelease(input: {
    readonly access_token: string;
    readonly release: CleanPersonRecordSearchBatchReleaseV1;
  }): CleanPersonRecordSearchReleaseAuthorizationV1;
}

export type CleanPersonRecordSearchRouteV1 =
  CleanPersonRecordSearchHttpApplicationV1 &
    CleanPersonRecordSearchBatchApplicationV1;

export interface CreateCleanPersonRecordSearchRouteV1Options {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly retrieval_contract_sha256: Sha256Digest;
  readonly sessions: CurrentPersonSessions;
  readonly authority: Database.Database;
  readonly record: Database.Database;
  readonly audit: SqliteCleanPersonRecordReadAuditV1;
  readonly search_generation?: SearchGeneration;
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
): CleanPersonRecordSearchReleaseAuthorizationV1 {
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
    terms.size <= 16 &&
    [...terms].every((term) => Buffer.byteLength(term, "utf8") <= 64)
  );
}

function assertValidBatch(input: CleanPersonRecordSearchBatchInputV1): void {
  if (
    input.queries.length < 1 ||
    input.queries.length > 4 ||
    new Set(input.queries).size !== input.queries.length ||
    input.queries.some((query) => !validBatchQuery(query)) ||
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
  readonly items: readonly CleanReadableSearchResultItemV1[];
}): CleanPersonRecordSearchResponseV1 {
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

/**
 * Resolves the current Person once, reads only an exact-head immutable Layer 2
 * generation, and commits the same compact release audit used by Layer 1.
 */
export function createCleanPersonRecordSearchRouteV1(
  options: CreateCleanPersonRecordSearchRouteV1Options,
): CleanPersonRecordSearchRouteV1 {
  const search =
    options.search_generation ?? searchCleanReadableSearchGenerationV1;
  const releaseWitnesses = new WeakSet<CleanPersonRecordSearchBatchReleaseV1>();

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
    input: CleanPersonRecordSearchBatchInputV1,
  ): CleanPersonRecordSearchBatchResultV1 {
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
      clearCleanReadableSearchActiveGenerationV1();
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
      if (
        error instanceof Error &&
        error.message ===
          "clean retrieval active-generation handle is unavailable"
      )
        unavailable();
      throw error;
    }
    for (const result of results) {
      if (
        result.generation_id !== pointer.generation_id ||
        result.exact_head.authority_id !== options.authority_id ||
        result.exact_head.organization_id !== options.organization_id ||
        result.exact_head.state_lineage_id !== options.state_lineage_id ||
        result.exact_head.position !== pointer.record_head_position ||
        result.exact_head.record_sha256 !== pointer.record_head_hash
      ) {
        unavailable();
      }
    }
    // Preserve the Layer 4 plan's order while giving every focused query one
    // result per round. This is deterministic breadth without pretending that
    // Layer 3 has a cross-query reranker.
    const merged = new Map<Sha256Digest, CleanReadableSearchResultItemV1>();
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
    const response = asResponse({
      generation_id: pointer.generation_id,
      record_head: head,
      items: [...merged.values()],
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
    const release: CleanPersonRecordSearchBatchReleaseV1 = Object.freeze({
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
    return Object.freeze({ response, release });
  }

  return Object.freeze({
    search(input: {
      readonly access_token: string;
      readonly query: string;
      readonly limit?: number;
    }): CleanPersonRecordSearchResponseV1 {
      return searchBatch({
        access_token: input.access_token,
        queries: [input.query],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).response;
    },
    searchBatch,
    revalidateBatchRelease(input: {
      readonly access_token: string;
      readonly release: CleanPersonRecordSearchBatchReleaseV1;
    }): CleanPersonRecordSearchReleaseAuthorizationV1 {
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
