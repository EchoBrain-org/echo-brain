import {
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { resolvePinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type {
  CanonicalPayloadSigner,
  OrganizationEnrollmentReceiptPayloadV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationMembershipTypeV1,
} from "./contracts.js";
import { verifyOrganizationEnrollmentRequest } from "./enrollment-request.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  assertMembershipType,
  assertTimestamp,
  canonicalSnapshot,
  validateSignedIntegrity,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export interface CreateOrganizationEnrollmentReceiptInput {
  enrollment_id: string;
  membership_type: OrganizationMembershipTypeV1;
  enrolled_at: string;
  request: OrganizationEnrollmentRequestV1;
}

export function validateOrganizationEnrollmentReceipt(
  value: unknown,
): OrganizationEnrollmentReceiptV1 {
  const snapshot = canonicalSnapshot(value, "organization enrollment receipt");
  const record = asRecord(snapshot, "organization enrollment receipt");
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "enrollment_id",
      "authority_id",
      "authority_key_id",
      "organization_id",
      "principal_id",
      "membership_id",
      "membership_type",
      "installation_id",
      "installation_key_id",
      "request_sha256",
      "enrolled_at",
      "integrity",
    ],
    "organization enrollment receipt",
  );
  assertLiteral(
    record.schema_version,
    1,
    "organization enrollment receipt schema_version",
  );
  assertLiteral(
    record.kind,
    "echo-organization-enrollment-receipt",
    "organization enrollment receipt kind",
  );
  assertId(record.enrollment_id, "enr", "enrollment receipt enrollment_id");
  assertId(record.authority_id, "oau", "enrollment receipt authority_id");
  assertDigest(record.authority_key_id, "enrollment receipt authority_key_id");
  assertId(record.organization_id, "org", "enrollment receipt organization_id");
  assertId(record.principal_id, "prn", "enrollment receipt principal_id");
  assertId(record.membership_id, "mem", "enrollment receipt membership_id");
  assertMembershipType(
    record.membership_type,
    "enrollment receipt membership_type",
  );
  assertId(record.installation_id, "ins", "enrollment receipt installation_id");
  assertDigest(
    record.installation_key_id,
    "enrollment receipt installation_key_id",
  );
  assertDigest(record.request_sha256, "enrollment receipt request_sha256");
  assertTimestamp(record.enrolled_at, "enrollment receipt enrolled_at");
  const integrity = validateSignedIntegrity(
    record.integrity,
    "enrollment receipt integrity",
  );
  if (integrity.key_id !== record.authority_key_id) {
    organizationProtocolValidationFailure(
      "enrollment receipt signature key does not match the authority key",
    );
  }
  return record as unknown as OrganizationEnrollmentReceiptV1;
}

/** Verifies the authority signature and every receipt-to-request binding. */
export function verifyOrganizationEnrollmentReceipt(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  enrollmentRequest: unknown,
): OrganizationEnrollmentReceiptV1 {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const request = verifyOrganizationEnrollmentRequest(
    enrollmentRequest,
    pinnedAuthority,
  );
  const receipt = validateOrganizationEnrollmentReceipt(value);
  if (
    receipt.authority_id !== authority.authority_id ||
    receipt.authority_key_id !== authority.signing_key.key_id ||
    receipt.organization_id !== authority.organization_id
  ) {
    throw new Error(
      "organization enrollment receipt does not match the pinned authority",
    );
  }
  if (
    receipt.authority_id !== request.authority_id ||
    receipt.authority_key_id !== request.authority_key_id ||
    receipt.organization_id !== request.organization_id ||
    receipt.principal_id !== request.principal_id ||
    receipt.membership_id !== request.membership_id ||
    receipt.installation_id !== request.installation_id ||
    receipt.installation_key_id !== request.installation_signing_key.key_id ||
    receipt.request_sha256 !== canonicalSha256(request)
  ) {
    throw new Error(
      "organization enrollment receipt does not bind the exact request",
    );
  }
  const publicKey = verifyP256SigningKeyDescriptor(authority.signing_key);
  verifySignedDocument(receipt, publicKey, authority.signing_key.key_id);
  return receipt;
}

export async function createOrganizationEnrollmentReceipt(
  input: CreateOrganizationEnrollmentReceiptInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationEnrollmentReceiptV1> {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const request = verifyOrganizationEnrollmentRequest(
    input.request,
    pinnedAuthority,
  );
  assertId(input.enrollment_id, "enr", "enrollment receipt enrollment_id");
  assertMembershipType(
    input.membership_type,
    "enrollment receipt membership_type",
  );
  assertTimestamp(input.enrolled_at, "enrollment receipt enrolled_at");
  const payload: OrganizationEnrollmentReceiptPayloadV1 = {
    schema_version: 1,
    kind: "echo-organization-enrollment-receipt",
    enrollment_id: input.enrollment_id,
    authority_id: authority.authority_id,
    authority_key_id: authority.signing_key.key_id,
    organization_id: authority.organization_id,
    principal_id: request.principal_id,
    membership_id: request.membership_id,
    membership_type: input.membership_type,
    installation_id: request.installation_id,
    installation_key_id: request.installation_signing_key.key_id,
    request_sha256: canonicalSha256(request),
    enrolled_at: input.enrolled_at,
  };
  canonicalSnapshot(payload, "organization enrollment receipt payload");
  const document = await createSignedDocumentWithKey(
    payload,
    authority.signing_key.key_id,
    sign,
  );
  return verifyOrganizationEnrollmentReceipt(
    document,
    pinnedAuthority,
    request,
  );
}

export function organizationEnrollmentReceiptSha256(
  receipt: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  enrollmentRequest: unknown,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationEnrollmentReceipt(
      receipt,
      pinnedAuthority,
      enrollmentRequest,
    ),
  );
}
