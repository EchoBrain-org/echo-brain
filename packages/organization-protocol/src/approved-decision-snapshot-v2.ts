import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import type { OrganizationRecordApprovalPayloadV1 } from "./contracts.js";
import {
  assertOrganizationRecordApprovalPayload,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
} from "./record-payload.js";
import { assertDigest, assertText, exactObject } from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const APPROVED_DECISION_SNAPSHOT_V2_KIND =
  "echo-approved-decision-snapshot-v2" as const;

const APPROVED_DECISION_SNAPSHOT_KEYS = [
  "schema_version",
  "kind",
  "approval_id",
  "staged_content_sha256",
  "final_content_sha256",
  "payload_contract_id",
  "approved_payload",
] as const;

/**
 * The approved decision snapshot v2 has always accepted any number in its
 * plain JSON check and left NaN and Infinity for canonicalSnapshot to reject.
 */
const REQUIRE_FINITE_JSON_NUMBERS = false;

/** The frozen meeting decision a reviewer approved; approval-decision records carry it. */
export interface ApprovedDecisionSnapshotV2 {
  readonly schema_version: 2;
  readonly kind: typeof APPROVED_DECISION_SNAPSHOT_V2_KIND;
  readonly approval_id: string;
  /** These opaque frozen commitments are intentionally not re-derived here. */
  readonly staged_content_sha256: Sha256Digest;
  /** These opaque frozen commitments are intentionally not re-derived here. */
  readonly final_content_sha256: Sha256Digest;
  readonly payload_contract_id: "organization-record-approval-payload-v1";
  readonly approved_payload: OrganizationRecordApprovalPayloadV1;
}

function fail(message: string): never {
  return organizationProtocolValidationFailure(message);
}

export function validateApprovedDecisionSnapshotV2(
  value: unknown,
): ApprovedDecisionSnapshotV2 {
  const snapshot = exactObject(
    value,
    APPROVED_DECISION_SNAPSHOT_KEYS,
    "Approved decision snapshot v2",
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
    REQUIRE_FINITE_JSON_NUMBERS,
  );
  if (snapshot.schema_version !== 2 || snapshot.kind !== APPROVED_DECISION_SNAPSHOT_V2_KIND) {
    fail("Approved decision snapshot v2 has an unsupported envelope");
  }
  assertText(snapshot.approval_id, "Approved decision snapshot v2 approval_id");
  assertDigest(snapshot.staged_content_sha256, "Approved decision snapshot v2 staged_content_sha256");
  assertDigest(snapshot.final_content_sha256, "Approved decision snapshot v2 final_content_sha256");
  if (snapshot.payload_contract_id !== "organization-record-approval-payload-v1") {
    fail("Approved decision snapshot v2 has an unsupported payload contract");
  }
  assertOrganizationRecordApprovalPayload(
    snapshot.approved_payload,
    "Approved decision snapshot v2 approved_payload",
  );
  return snapshot as unknown as ApprovedDecisionSnapshotV2;
}

export function approvedDecisionSnapshotV2Sha256(
  snapshot: ApprovedDecisionSnapshotV2,
): Sha256Digest {
  return canonicalSha256(validateApprovedDecisionSnapshotV2(snapshot));
}
