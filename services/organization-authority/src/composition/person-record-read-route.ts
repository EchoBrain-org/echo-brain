import {
  canonicalJson,
  canonicalSha256,
} from "@echo-brain/federation-protocol";
import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  PersonReadableRecordV1,
  PersonRecordReaderV1Input,
  RecordApproverProjectorV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { SqlitePersonRecordReadAuditV1 } from "../adapters/persistence/sqlite/person-record-read-audit-v1.js";
import type {
  PersonRecordReadHttpApplicationV1,
  PersonRecordReadResponseV1,
  PersonRecordSourceMetadataV1,
} from "../presentation/person-record-read-http-application.js";

interface CurrentPersonSessions {
  authenticateAccess(input: {
    readonly access_token: string;
  }): PersonAccessAuthorization;
}

interface PersonRecordReader {
  list(
    input: PersonRecordReaderV1Input,
  ): readonly PersonReadableRecordV1[];
}

export interface CreatePersonRecordReadRouteV1Options {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly sessions: CurrentPersonSessions;
  readonly records: PersonRecordReader;
  readonly audit: SqlitePersonRecordReadAuditV1;
  readonly record_approver?: RecordApproverProjectorV1;
  /** Resolves only the actor named by a record already released to this reader. */
  readonly memberships?: {
    membership(id: string): {
      readonly organization_id: string;
      readonly principal_id: string;
      readonly membership_id: string;
      readonly display_name: string;
    } | undefined;
  };
}

function sourceMetadata(
  record: PersonReadableRecordV1,
  options: CreatePersonRecordReadRouteV1Options,
): PersonRecordSourceMetadataV1 {
  const actor = options.record_approver?.(record.envelope);
  if (
    actor === undefined ||
    actor.authority_id !== options.authority_id ||
    actor.organization_id !== options.organization_id ||
    actor.state_lineage_id !== options.state_lineage_id ||
    actor.approval_id !== record.approval_id ||
    typeof actor.principal_id !== "string" ||
    typeof actor.membership_id !== "string"
  ) return Object.freeze({});
  const membership = options.memberships?.membership(actor.membership_id);
  if (
    membership === undefined ||
    membership.organization_id !== options.organization_id ||
    membership.principal_id !== actor.principal_id ||
    membership.membership_id !== actor.membership_id
  ) return Object.freeze({});
  // A revoked membership can still identify a historical approver. It never
  // authorizes this read. Names are current directory labels, not job titles.
  const name = membership.display_name.trim();
  if (name.length === 0 || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    return Object.freeze({});
  }
  return Object.freeze({ record_approved_by: Object.freeze({ display_name: name }) });
}

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

function assertExpectedOrganization(
  authorization: PersonAccessAuthorization,
  organizationId: string,
): void {
  if (authorization.organization_id !== organizationId) {
    throw new Error("Person session belongs to another organization");
  }
}

function asResponse(
  records: readonly PersonReadableRecordV1[],
  metadata?: (record: PersonReadableRecordV1) => PersonRecordSourceMetadataV1,
): PersonRecordReadResponseV1 {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-list-v1",
    records: Object.freeze(
      records.map((record) =>
        Object.freeze({
          position: record.position,
          approval_id: record.approval_id,
          record_sha256: record.record_sha256,
          envelope: record.envelope as JsonObject,
          ...(metadata === undefined ? {} : { source_metadata: metadata(record) }),
        }),
      ),
    ),
  });
}

/**
 * Returns the route seam mounted by the Person HTTP server. The only
 * caller-owned value is the bearer: principal and membership are resolved
 * afresh from it immediately before the immutable V4 response is released.
 */
export function createPersonRecordReadRouteV1(
  options: CreatePersonRecordReadRouteV1Options,
): PersonRecordReadHttpApplicationV1 {
  return Object.freeze({
    list(input: {
      readonly access_token: string;
      readonly limit?: number;
      readonly record_sha256?: Sha256Digest;
      readonly include_source_metadata?: boolean;
    }): PersonRecordReadResponseV1 {
      const admitted = options.sessions.authenticateAccess({
        access_token: input.access_token,
      });
      assertExpectedOrganization(admitted, options.organization_id);

      const initialRows = options.records.list({
        authority_id: options.authority_id,
        organization_id: admitted.organization_id,
        state_lineage_id: options.state_lineage_id,
        principal_id: admitted.principal_id,
        membership_id: admitted.membership_id,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.record_sha256 === undefined
          ? {}
          : { record_sha256: input.record_sha256 }),
      });

      const response = asResponse(initialRows, input.include_source_metadata === true
        ? (record) => sourceMetadata(record, options) : undefined);
      const released = options.sessions.authenticateAccess({
        access_token: input.access_token,
      });
      if (
        !sameReleaseAuthorization(admitted, released) ||
        released.organization_id !== options.organization_id
      ) {
        throw new AuthorityOperationError(
          "unauthorized",
          "person authentication failed",
        );
      }

      // V4 rows are immutable. The initial query may therefore be reused once
      // the exact bearer-derived membership is re-proved at release.
      const response_sha256: Sha256Digest = canonicalSha256(
        JSON.parse(canonicalJson(response)) as JsonObject,
      );
      options.audit.append({
        read_mode: "layer1",
        authority_id: options.authority_id,
        organization_id: released.organization_id,
        state_lineage_id: options.state_lineage_id,
        principal_id: released.principal_id,
        membership_id: released.membership_id,
        session_family_id: released.session_family_id,
        result_count: response.records.length,
        response_sha256,
        checked_at: released.checked_at,
      });
      return response;
    },
  });
}
