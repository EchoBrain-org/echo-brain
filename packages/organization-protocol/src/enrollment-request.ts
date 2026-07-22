import { Buffer } from "node:buffer";
import {
  canonicalSha256,
  createSignedDocumentWithKey,
  sha256Digest,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from "@echo-brain/federation-protocol";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import { resolvePinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type {
  CanonicalPayloadSigner,
  OrganizationEnrollmentRequestPayloadV1,
  OrganizationEnrollmentRequestV1,
} from "./contracts.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  canonicalSnapshot,
  validateP256SigningKey,
  validateSignedIntegrity,
} from "./validation-support.js";

export interface CreateOrganizationEnrollmentRequestInput {
  enrollment_grant_sha256: Sha256Digest;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
}

/** Hashes the exact 32-byte bearer grant without accepting a text encoding. */
export function organizationEnrollmentGrantSha256(
  grant: Uint8Array,
): Sha256Digest {
  if (!(grant instanceof Uint8Array) || grant.byteLength !== 32) {
    throw new Error(
      "organization enrollment grant must contain exactly 32 bytes",
    );
  }
  return sha256Digest(Buffer.from(grant));
}

export function validateOrganizationEnrollmentRequest(
  value: unknown,
): OrganizationEnrollmentRequestV1 {
  const snapshot = canonicalSnapshot(value, "organization enrollment request");
  const record = asRecord(snapshot, "organization enrollment request");
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "enrollment_grant_sha256",
      "authority_id",
      "authority_key_id",
      "organization_id",
      "principal_id",
      "membership_id",
      "installation_id",
      "installation_signing_key",
      "integrity",
    ],
    "organization enrollment request",
  );
  assertLiteral(
    record.schema_version,
    1,
    "organization enrollment request schema_version",
  );
  assertLiteral(
    record.kind,
    "echo-organization-enrollment-request",
    "organization enrollment request kind",
  );
  assertDigest(
    record.enrollment_grant_sha256,
    "organization enrollment grant digest",
  );
  assertId(record.authority_id, "oau", "enrollment request authority_id");
  assertDigest(record.authority_key_id, "enrollment request authority_key_id");
  assertId(record.organization_id, "org", "enrollment request organization_id");
  assertId(record.principal_id, "prn", "enrollment request principal_id");
  assertId(record.membership_id, "mem", "enrollment request membership_id");
  assertId(record.installation_id, "ins", "enrollment request installation_id");
  const signingKey = validateP256SigningKey(
    record.installation_signing_key,
    "enrollment request installation signing key",
  );
  const integrity = validateSignedIntegrity(
    record.integrity,
    "enrollment request integrity",
  );
  if (integrity.key_id !== signingKey.key_id) {
    throw new Error(
      "enrollment request signature key does not match the installation key",
    );
  }
  return record as unknown as OrganizationEnrollmentRequestV1;
}

/**
 * Verifies key possession and binds the request to the independently pinned
 * authority descriptor. It does not validate grant state or membership state.
 */
export function verifyOrganizationEnrollmentRequest(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
): OrganizationEnrollmentRequestV1 {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const request = validateOrganizationEnrollmentRequest(value);
  if (
    request.authority_id !== authority.authority_id ||
    request.authority_key_id !== authority.signing_key.key_id ||
    request.organization_id !== authority.organization_id
  ) {
    throw new Error(
      "organization enrollment request does not match the pinned authority",
    );
  }
  const publicKey = verifyP256SigningKeyDescriptor(
    request.installation_signing_key,
  );
  verifySignedDocument(
    request,
    publicKey,
    request.installation_signing_key.key_id,
  );
  return request;
}

export async function createOrganizationEnrollmentRequest(
  input: CreateOrganizationEnrollmentRequestInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationEnrollmentRequestV1> {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const payload: OrganizationEnrollmentRequestPayloadV1 = {
    schema_version: 1,
    kind: "echo-organization-enrollment-request",
    enrollment_grant_sha256: input.enrollment_grant_sha256,
    authority_id: authority.authority_id,
    authority_key_id: authority.signing_key.key_id,
    organization_id: authority.organization_id,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    installation_id: input.installation_id,
    installation_signing_key: input.installation_signing_key,
  };
  validateOrganizationEnrollmentRequestPayload(payload);
  const document = await createSignedDocumentWithKey(
    payload,
    payload.installation_signing_key.key_id,
    sign,
  );
  return verifyOrganizationEnrollmentRequest(document, pinnedAuthority);
}

export function organizationEnrollmentRequestSha256(
  request: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
): Sha256Digest {
  return canonicalSha256(
    verifyOrganizationEnrollmentRequest(request, pinnedAuthority),
  );
}

function validateOrganizationEnrollmentRequestPayload(
  payload: OrganizationEnrollmentRequestPayloadV1,
): void {
  assertDigest(
    payload.enrollment_grant_sha256,
    "organization enrollment grant digest",
  );
  assertId(payload.authority_id, "oau", "enrollment request authority_id");
  assertDigest(payload.authority_key_id, "enrollment request authority_key_id");
  assertId(
    payload.organization_id,
    "org",
    "enrollment request organization_id",
  );
  assertId(payload.principal_id, "prn", "enrollment request principal_id");
  assertId(payload.membership_id, "mem", "enrollment request membership_id");
  assertId(
    payload.installation_id,
    "ins",
    "enrollment request installation_id",
  );
  validateP256SigningKey(
    payload.installation_signing_key,
    "enrollment request installation signing key",
  );
  canonicalSnapshot(payload, "organization enrollment request payload");
}
