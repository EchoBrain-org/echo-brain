import {
  canonicalJsonBytes,
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
  OrganizationRecordEnvelopeV1,
  OrganizationRecordReceiptPayloadV1,
  OrganizationRecordReceiptV1,
} from "./contracts.js";
import { verifyOrganizationRecordEnvelope } from "./record-envelope.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  assertPositiveSafeInteger,
  assertTimestamp,
  canonicalSnapshot,
  validateSignedIntegrity,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export interface CreateOrganizationRecordReceiptInput {
  envelope: OrganizationRecordEnvelopeV1;
  installation_signing_key: P256SigningKeyDescriptor;
  position: number;
  record_hash: Sha256Digest;
  recorded_at: string;
}

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;

function envelopeSha256(
  envelope: OrganizationRecordEnvelopeV1,
): Sha256Digest {
  return sha256Digest(canonicalJsonBytes(envelope));
}

export function validateOrganizationRecordReceipt(
  value: unknown,
): OrganizationRecordReceiptV1 {
  const label = "organization record receipt";
  const record = asRecord(canonicalSnapshot(value, label), label);
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "authority_id",
      "organization_id",
      "envelope_id",
      "envelope_sha256",
      "installation_id",
      "idempotency_key",
      "position",
      "record_hash",
      "recorded_at",
      "integrity",
    ],
    label,
  );
  assertLiteral(record.schema_version, 1, `${label} schema_version`);
  assertLiteral(
    record.kind,
    "echo-organization-record-receipt",
    `${label} kind`,
  );
  assertId(record.authority_id, "oau", `${label} authority_id`);
  assertId(record.organization_id, "org", `${label} organization_id`);
  assertId(record.envelope_id, "rec", `${label} envelope_id`);
  assertDigest(record.envelope_sha256, `${label} envelope_sha256`);
  assertId(record.installation_id, "ins", `${label} installation_id`);
  if (
    typeof record.idempotency_key !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(record.idempotency_key)
  ) {
    organizationProtocolValidationFailure(
      `${label} idempotency_key must be a lowercase sha256 approval id`,
    );
  }
  assertPositiveSafeInteger(record.position, `${label} position`);
  assertDigest(record.record_hash, `${label} record_hash`);
  assertTimestamp(record.recorded_at, `${label} recorded_at`);
  // Shape only. The signing key is not a payload field, so binding it to the
  // pinned authority is verification's job, never validation's.
  validateSignedIntegrity(record.integrity, `${label} integrity`);
  return record as unknown as OrganizationRecordReceiptV1;
}

/**
 * Verifies the authority signature and every receipt-to-envelope binding. The
 * envelope digest is recomputed from the exact canonical signed bytes rather
 * than trusted from the receipt.
 */
export function verifyOrganizationRecordReceipt(
  value: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  envelope: unknown,
  installationSigningKey: P256SigningKeyDescriptor,
): OrganizationRecordReceiptV1 {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const verifiedEnvelope = verifyOrganizationRecordEnvelope(
    envelope,
    pinnedAuthority,
    installationSigningKey,
  );
  return verifyReceiptAgainstEnvelope(value, authority, verifiedEnvelope);
}

function verifyReceiptAgainstEnvelope(
  value: unknown,
  authority: ReturnType<typeof resolvePinnedOrganizationAuthority>,
  envelope: OrganizationRecordEnvelopeV1,
): OrganizationRecordReceiptV1 {
  const receipt = validateOrganizationRecordReceipt(value);
  if (
    receipt.authority_id !== authority.authority_id ||
    receipt.organization_id !== authority.organization_id ||
    receipt.integrity.key_id !== authority.signing_key.key_id
  ) {
    throw new Error(
      "organization record receipt does not match the pinned authority",
    );
  }
  if (
    receipt.envelope_id !== envelope.envelope_id ||
    receipt.installation_id !== envelope.submitter.installation_id ||
    receipt.idempotency_key !== envelope.idempotency_key ||
    receipt.envelope_sha256 !== envelopeSha256(envelope)
  ) {
    throw new Error(
      "organization record receipt does not bind the exact envelope",
    );
  }
  const publicKey = verifyP256SigningKeyDescriptor(authority.signing_key);
  verifySignedDocument(receipt, publicKey, authority.signing_key.key_id);
  return receipt;
}

export async function createOrganizationRecordReceipt(
  input: CreateOrganizationRecordReceiptInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationRecordReceiptV1> {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const envelope = verifyOrganizationRecordEnvelope(
    input.envelope,
    pinnedAuthority,
    input.installation_signing_key,
  );
  assertPositiveSafeInteger(
    input.position,
    "organization record receipt position",
  );
  assertDigest(input.record_hash, "organization record receipt record_hash");
  assertTimestamp(
    input.recorded_at,
    "organization record receipt recorded_at",
  );
  const payload: OrganizationRecordReceiptPayloadV1 = {
    schema_version: 1,
    kind: "echo-organization-record-receipt",
    authority_id: authority.authority_id,
    organization_id: authority.organization_id,
    envelope_id: envelope.envelope_id,
    envelope_sha256: envelopeSha256(envelope),
    installation_id: envelope.submitter.installation_id,
    idempotency_key: envelope.idempotency_key,
    position: input.position,
    record_hash: input.record_hash,
    recorded_at: input.recorded_at,
  };
  canonicalSnapshot(payload, "organization record receipt payload");
  const document = await createSignedDocumentWithKey(
    payload,
    authority.signing_key.key_id,
    sign,
  );
  return verifyReceiptAgainstEnvelope(document, authority, envelope);
}
