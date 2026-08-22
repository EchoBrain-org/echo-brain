import {
  canonicalJson,
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  searchCleanReadableSearchGenerationV1,
  type CleanReadableSearchResultV1,
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

function unavailable(): never {
  throw new AuthorityOperationError(
    "unavailable",
    "an exact-head readable-search generation is not available",
  );
}

function asResponse(
  result: CleanReadableSearchResultV1,
): CleanPersonRecordSearchResponseV1 {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-search-v1",
    generation_id: result.generation_id,
    record_head: Object.freeze({
      position: result.exact_head.position,
      record_sha256: result.exact_head.record_sha256,
    }),
    items: Object.freeze(
      result.items.map((item) =>
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
): CleanPersonRecordSearchHttpApplicationV1 {
  const search =
    options.search_generation ?? searchCleanReadableSearchGenerationV1;
  return Object.freeze({
    search(input: {
      readonly access_token: string;
      readonly query: string;
      readonly limit?: number;
    }): CleanPersonRecordSearchResponseV1 {
      const authorization = options.sessions.authenticateAccess({
        access_token: input.access_token,
      });
      if (authorization.organization_id !== options.organization_id) {
        throw new AuthorityOperationError(
          "unauthorized",
          "person authentication failed",
        );
      }
      const head = recordHead(options.record);
      const pointer = activeGeneration(options.authority);
      if (
        pointer === null ||
        pointer.organization_id !== options.organization_id ||
        pointer.retrieval_contract_sha256 !==
          options.retrieval_contract_sha256 ||
        !sameHead(pointer, head)
      ) {
        unavailable();
      }
      const result = search({
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
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      if (
        result.generation_id !== pointer.generation_id ||
        result.exact_head.authority_id !== options.authority_id ||
        result.exact_head.organization_id !== options.organization_id ||
        result.exact_head.state_lineage_id !== options.state_lineage_id ||
        result.exact_head.position !== pointer.record_head_position ||
        result.exact_head.record_sha256 !== pointer.record_head_hash ||
        !samePointer(pointer, activeGeneration(options.authority)) ||
        !sameHead(pointer, recordHead(options.record))
      ) {
        unavailable();
      }
      const released = options.sessions.authenticateAccess({
        access_token: input.access_token,
      });
      if (
        !sameReleaseAuthorization(authorization, released) ||
        released.organization_id !== options.organization_id
      ) {
        throw new AuthorityOperationError(
          "unauthorized",
          "person authentication failed",
        );
      }
      const response = asResponse(result);
      options.audit.append({
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
      return response;
    },
  });
}
