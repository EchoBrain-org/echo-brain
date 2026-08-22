import { Buffer } from "node:buffer";
import {
  assertP256LowS,
  canonicalJsonBytes,
  canonicalSha256,
  verifyP256LowSSignature,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  resolvePinnedOrganizationAuthority,
} from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PersonContentPolicyIdV2 } from "./human-act-record-input-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "./person-content-policy-v2.js";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "./record-payload.js";
import {
  verifyOrganizationRecordEnvelopeV4,
} from "./record-envelope-v4.js";
import type {
  AuthorityDetachedSigner,
  OrganizationRecordEnvelopeV4,
} from "./record-envelope-v4.js";
import {
  assertDigest,
  assertPositiveSafeInteger,
  assertTimestamp,
  canonicalSnapshot,
  validateP256SigningKey,
} from "./validation-support.js";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const ORGANIZATION_RECORD_RECEIPT_V2_KIND =
  "echo-organization-record-receipt-v2" as const;
export const ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND =
  "echo-organization-record-receipt-signature-v2" as const;

const RECEIPT_BODY_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "envelope_id",
  "semantic_idempotency_key",
  "event_kind",
  "record_position",
  "record_sha256",
  "predecessor_record_sha256",
  "record_head_position",
  "record_head_sha256",
  "issued_at",
  "policy_fact_outcome",
] as const;

const NO_POLICY_FACT_OUTCOME_KEYS = ["kind"] as const;
const APPENDED_POLICY_FACT_OUTCOME_KEYS = ["kind", "policy_id"] as const;

const RECEIPT_SIGNATURE_INPUT_KEYS = [
  "schema_version",
  "kind",
  "authority_id",
  "organization_id",
  "state_lineage_id",
  "signing_key_id",
  "receipt_sha256",
] as const;

const RECEIPT_WRAPPER_KEYS = [
  "body",
  "receipt_sha256",
  "signing_key_descriptor",
  "signature",
] as const;

const CREATE_INPUT_KEYS = ["envelope", "record_position", "issued_at"] as const;

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface NoPolicyFactOutcomeV2 {
  readonly kind: "none";
}

export interface AppendedPolicyFactOutcomeV2 {
  readonly kind: "appended";
  readonly policy_id: PersonContentPolicyIdV2;
}

export type OrganizationRecordPolicyFactOutcomeV2 =
  | NoPolicyFactOutcomeV2
  | AppendedPolicyFactOutcomeV2;

export interface OrganizationRecordReceiptBodyV2 {
  readonly schema_version: 2;
  readonly kind: typeof ORGANIZATION_RECORD_RECEIPT_V2_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly envelope_id: string;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly event_kind: "approved" | "rejected";
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly predecessor_record_sha256: Sha256Digest | null;
  readonly record_head_position: number;
  readonly record_head_sha256: Sha256Digest;
  readonly issued_at: string;
  readonly policy_fact_outcome: OrganizationRecordPolicyFactOutcomeV2;
}

export interface OrganizationRecordReceiptSignatureInputV2 {
  readonly schema_version: 2;
  readonly kind: typeof ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly signing_key_id: Sha256Digest;
  readonly receipt_sha256: Sha256Digest;
}

export interface OrganizationRecordReceiptV2 {
  readonly body: OrganizationRecordReceiptBodyV2;
  readonly receipt_sha256: Sha256Digest;
  readonly signing_key_descriptor: P256SigningKeyDescriptor;
  readonly signature: string;
}

export interface CreateOrganizationRecordReceiptV2Input {
  readonly envelope: OrganizationRecordEnvelopeV4;
  readonly record_position: number;
  readonly issued_at: string;
}

function fail(message: string, cause?: unknown): never {
  return organizationProtocolValidationFailure(message, cause);
}

/** Reject every value that cannot be represented as inert, plain JSON data. */
function assertPlainJsonData(
  value: unknown,
  label: string,
  seen: Set<object> = new Set<object>(),
): void {
  if (value === null) return;
  if (typeof value !== "object") {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      fail(`${label} must contain only finite JSON data`);
    }
    return;
  }
  if (seen.has(value)) fail(`${label} must not contain a cycle`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail(`${label} must not contain symbol properties`);
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail(`${label} must be a plain array`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) {
        fail(`${label} must be a dense plain array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          fail(`${label} must contain only enumerable data properties`);
        }
        assertPlainJsonData(descriptor.value, label, seen);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(`${label} must be a plain object`);
    }
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        fail(`${label} must contain only enumerable data properties`);
      }
      assertPlainJsonData(descriptor.value, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertPlainJsonData(value, label);
  const snapshot = canonicalSnapshot(
    value,
    label,
    MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  );
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    fail(`${label} must be a plain object`);
  }
  const record = snapshot as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return record;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    fail(`${label} must be a bounded non-empty string`);
  }
}

function assertNullableDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest | null {
  if (value !== null) assertDigest(value, label);
}

function assertPolicyId(
  value: unknown,
  label: string,
): asserts value is PersonContentPolicyIdV2 {
  if (
    value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
    value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
  ) {
    fail(`${label} has an unsupported Person policy`);
  }
}

function validatePolicyFactOutcome(
  value: unknown,
  eventKind: "approved" | "rejected",
): OrganizationRecordPolicyFactOutcomeV2 {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "kind") &&
    Object.getOwnPropertyDescriptor(value, "kind")?.value === "none"
  ) {
    const outcome = exactObject(
      value,
      NO_POLICY_FACT_OUTCOME_KEYS,
      "Record receipt v2 no-policy-fact outcome",
    );
    if (eventKind !== "rejected") {
      fail("Record receipt v2 approval must append policy facts");
    }
    return { kind: outcome.kind as "none" };
  }
  const outcome = exactObject(
    value,
    APPENDED_POLICY_FACT_OUTCOME_KEYS,
    "Record receipt v2 appended-policy-fact outcome",
  );
  if (outcome.kind !== "appended") {
    fail("Record receipt v2 policy fact outcome kind is unsupported");
  }
  if (eventKind !== "approved") {
    fail("Record receipt v2 rejection must not append policy facts");
  }
  assertPolicyId(outcome.policy_id, "Record receipt v2 policy fact outcome");
  return { kind: "appended", policy_id: outcome.policy_id };
}

function decodeSignature(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 96 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    fail("Record receipt v2 signature must be bounded canonical base64");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.toString("base64") !== value) {
    fail("Record receipt v2 signature must be bounded canonical base64");
  }
  try {
    assertP256LowS(signature);
  } catch (error) {
    fail("Record receipt v2 signature must be strict DER low-S P-256", error);
  }
  return signature;
}

export function validateOrganizationRecordReceiptBodyV2(
  value: unknown,
): OrganizationRecordReceiptBodyV2 {
  const body = exactObject(value, RECEIPT_BODY_KEYS, "Record receipt body v2");
  if (
    body.schema_version !== 2 ||
    body.kind !== ORGANIZATION_RECORD_RECEIPT_V2_KIND
  ) {
    fail("Record receipt body v2 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
    "envelope_id",
  ] as const) {
    assertText(body[key], `Record receipt body v2 ${key}`);
  }
  assertDigest(
    body.semantic_idempotency_key,
    "Record receipt body v2 semantic_idempotency_key",
  );
  if (body.event_kind !== "approved" && body.event_kind !== "rejected") {
    fail("Record receipt body v2 event kind is unsupported");
  }
  assertPositiveSafeInteger(
    body.record_position,
    "Record receipt body v2 record_position",
  );
  assertDigest(body.record_sha256, "Record receipt body v2 record_sha256");
  assertNullableDigest(
    body.predecessor_record_sha256,
    "Record receipt body v2 predecessor_record_sha256",
  );
  if (
    (body.record_position === 1) !==
    (body.predecessor_record_sha256 === null)
  ) {
    fail("Record receipt body v2 predecessor must be null only at genesis");
  }
  assertPositiveSafeInteger(
    body.record_head_position,
    "Record receipt body v2 record_head_position",
  );
  assertDigest(
    body.record_head_sha256,
    "Record receipt body v2 record_head_sha256",
  );
  if (
    body.record_head_position !== body.record_position ||
    body.record_head_sha256 !== body.record_sha256
  ) {
    fail("Record receipt body v2 resulting head must be the appended record");
  }
  assertTimestamp(body.issued_at, "Record receipt body v2 issued_at");
  const policyFactOutcome = validatePolicyFactOutcome(
    body.policy_fact_outcome,
    body.event_kind,
  );
  return {
    schema_version: 2,
    kind: ORGANIZATION_RECORD_RECEIPT_V2_KIND,
    authority_id: body.authority_id as string,
    organization_id: body.organization_id as string,
    state_lineage_id: body.state_lineage_id as string,
    envelope_id: body.envelope_id as string,
    semantic_idempotency_key: body.semantic_idempotency_key,
    event_kind: body.event_kind,
    record_position: body.record_position,
    record_sha256: body.record_sha256,
    predecessor_record_sha256: body.predecessor_record_sha256,
    record_head_position: body.record_head_position,
    record_head_sha256: body.record_head_sha256,
    issued_at: body.issued_at as string,
    policy_fact_outcome: policyFactOutcome,
  };
}

export function organizationRecordReceiptBodyV2Sha256(
  value: OrganizationRecordReceiptBodyV2,
): Sha256Digest {
  return canonicalSha256(validateOrganizationRecordReceiptBodyV2(value));
}

export function validateOrganizationRecordReceiptSignatureInputV2(
  value: unknown,
): OrganizationRecordReceiptSignatureInputV2 {
  const input = exactObject(
    value,
    RECEIPT_SIGNATURE_INPUT_KEYS,
    "Record receipt signature input v2",
  );
  if (
    input.schema_version !== 2 ||
    input.kind !== ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND
  ) {
    fail("Record receipt signature input v2 has an unsupported envelope");
  }
  for (const key of [
    "authority_id",
    "organization_id",
    "state_lineage_id",
  ] as const) {
    assertText(input[key], `Record receipt signature input v2 ${key}`);
  }
  assertDigest(
    input.signing_key_id,
    "Record receipt signature input v2 signing_key_id",
  );
  assertDigest(
    input.receipt_sha256,
    "Record receipt signature input v2 receipt_sha256",
  );
  return input as unknown as OrganizationRecordReceiptSignatureInputV2;
}

export function buildOrganizationRecordReceiptSignatureInputV2(
  body: OrganizationRecordReceiptBodyV2,
  signingKeyId: Sha256Digest,
): OrganizationRecordReceiptSignatureInputV2 {
  const validatedBody = validateOrganizationRecordReceiptBodyV2(body);
  assertDigest(
    signingKeyId,
    "Record receipt signature input v2 signing_key_id",
  );
  return validateOrganizationRecordReceiptSignatureInputV2({
    schema_version: 2,
    kind: ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND,
    authority_id: validatedBody.authority_id,
    organization_id: validatedBody.organization_id,
    state_lineage_id: validatedBody.state_lineage_id,
    signing_key_id: signingKeyId,
    receipt_sha256: organizationRecordReceiptBodyV2Sha256(validatedBody),
  });
}

export function organizationRecordReceiptSignatureInputV2Bytes(
  value: OrganizationRecordReceiptSignatureInputV2,
): Buffer {
  return canonicalJsonBytes(
    validateOrganizationRecordReceiptSignatureInputV2(value),
  );
}

export function validateOrganizationRecordReceiptV2(
  value: unknown,
): OrganizationRecordReceiptV2 {
  const wrapper = exactObject(value, RECEIPT_WRAPPER_KEYS, "Record receipt v2");
  const body = validateOrganizationRecordReceiptBodyV2(wrapper.body);
  assertDigest(wrapper.receipt_sha256, "Record receipt v2 receipt_sha256");
  if (wrapper.receipt_sha256 !== organizationRecordReceiptBodyV2Sha256(body)) {
    fail("Record receipt v2 digest does not match its body");
  }
  const descriptor = validateP256SigningKey(
    wrapper.signing_key_descriptor,
    "Record receipt v2 signing key descriptor",
  );
  decodeSignature(wrapper.signature);
  return {
    body,
    receipt_sha256: wrapper.receipt_sha256,
    signing_key_descriptor: descriptor,
    signature: wrapper.signature as string,
  };
}

function assertReceiptMatchesEnvelope(
  receipt: OrganizationRecordReceiptV2,
  envelope: OrganizationRecordEnvelopeV4,
): void {
  assertPositionContinuesEnvelope(envelope, receipt.body.record_position);
  const event = envelope.body.event;
  if (
    receipt.body.authority_id !== envelope.body.authority_id ||
    receipt.body.organization_id !== envelope.body.organization_id ||
    receipt.body.state_lineage_id !== envelope.body.state_lineage_id ||
    receipt.body.envelope_id !== envelope.body.envelope_id ||
    receipt.body.semantic_idempotency_key !==
      envelope.body.semantic_idempotency_key ||
    receipt.body.event_kind !== event.kind ||
    receipt.body.record_sha256 !== envelope.record_sha256 ||
    receipt.body.predecessor_record_sha256 !==
      envelope.body.predecessor_record_sha256
  ) {
    fail("Record receipt v2 does not bind the exact record envelope v4");
  }
  const outcome = receipt.body.policy_fact_outcome;
  if (
    (event.kind === "rejected" && outcome.kind !== "none") ||
    (event.kind === "approved" &&
      (outcome.kind !== "appended" || outcome.policy_id !== event.policy_id))
  ) {
    fail("Record receipt v2 policy fact outcome does not match the record event");
  }
}

function assertPinnedReceipt(
  receipt: OrganizationRecordReceiptV2,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
): Buffer {
  assertText(expectedStateLineageId, "expected state lineage ID");
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  if (
    receipt.body.authority_id !== authority.authority_id ||
    receipt.body.organization_id !== authority.organization_id ||
    receipt.body.state_lineage_id !== expectedStateLineageId
  ) {
    fail("Record receipt v2 does not match the pinned Authority and expected lineage");
  }
  const actual = receipt.signing_key_descriptor;
  const expected = authority.signing_key;
  if (
    actual.key_id !== expected.key_id ||
    actual.algorithm !== expected.algorithm ||
    actual.public_key_spki_der_base64 !== expected.public_key_spki_der_base64
  ) {
    fail("Record receipt v2 signing key does not match the pinned Authority");
  }
  return verifyP256SigningKeyDescriptor(expected, "organization Authority");
}

export function verifyOrganizationRecordReceiptV2(
  value: unknown,
  envelopeValue: unknown,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
): OrganizationRecordReceiptV2 {
  const envelope = verifyOrganizationRecordEnvelopeV4(
    envelopeValue,
    pinnedAuthority,
    expectedStateLineageId,
  );
  const receipt = validateOrganizationRecordReceiptV2(value);
  assertReceiptMatchesEnvelope(receipt, envelope);
  const publicKey = assertPinnedReceipt(
    receipt,
    pinnedAuthority,
    expectedStateLineageId,
  );
  const signatureInput = buildOrganizationRecordReceiptSignatureInputV2(
    receipt.body,
    receipt.signing_key_descriptor.key_id,
  );
  const signature = decodeSignature(receipt.signature);
  let valid = false;
  try {
    valid = verifyP256LowSSignature(
      publicKey,
      organizationRecordReceiptSignatureInputV2Bytes(signatureInput),
      signature,
    );
  } catch (error) {
    fail("Record receipt v2 signature is invalid", error);
  }
  if (!valid) fail("Record receipt v2 signature is invalid");
  return receipt;
}

function assertPositionContinuesEnvelope(
  envelope: OrganizationRecordEnvelopeV4,
  recordPosition: number,
): void {
  assertPositiveSafeInteger(
    recordPosition,
    "Record receipt v2 record_position",
  );
  const predecessorPosition = envelope.body.predecessor_position;
  const expectedPosition = predecessorPosition === null
    ? 1
    : predecessorPosition + 1;
  if (
    !Number.isSafeInteger(expectedPosition) ||
    recordPosition !== expectedPosition
  ) {
    fail("Record receipt v2 position does not continue the envelope predecessor");
  }
}

export async function createOrganizationRecordReceiptV2(
  value: CreateOrganizationRecordReceiptV2Input,
  pinnedAuthority: PinnedOrganizationAuthority,
  expectedStateLineageId: string,
  sign: AuthorityDetachedSigner,
): Promise<OrganizationRecordReceiptV2> {
  const input = exactObject(value, CREATE_INPUT_KEYS, "Create record receipt v2 input");
  const envelope = verifyOrganizationRecordEnvelopeV4(
    input.envelope,
    pinnedAuthority,
    expectedStateLineageId,
  );
  assertPositionContinuesEnvelope(envelope, input.record_position as number);
  assertTimestamp(input.issued_at, "Create record receipt v2 issued_at");
  const event = envelope.body.event;
  const body = validateOrganizationRecordReceiptBodyV2({
    schema_version: 2,
    kind: ORGANIZATION_RECORD_RECEIPT_V2_KIND,
    authority_id: envelope.body.authority_id,
    organization_id: envelope.body.organization_id,
    state_lineage_id: envelope.body.state_lineage_id,
    envelope_id: envelope.body.envelope_id,
    semantic_idempotency_key: envelope.body.semantic_idempotency_key,
    event_kind: event.kind,
    record_position: input.record_position,
    record_sha256: envelope.record_sha256,
    predecessor_record_sha256: envelope.body.predecessor_record_sha256,
    record_head_position: input.record_position,
    record_head_sha256: envelope.record_sha256,
    issued_at: input.issued_at,
    policy_fact_outcome: event.kind === "approved"
      ? { kind: "appended", policy_id: event.policy_id }
      : { kind: "none" },
  });
  const receiptSha256 = organizationRecordReceiptBodyV2Sha256(body);
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const signingKeyDescriptor = canonicalSnapshot(
    authority.signing_key,
    "Record receipt v2 signing key descriptor",
  );
  const signatureInput = buildOrganizationRecordReceiptSignatureInputV2(
    body,
    signingKeyDescriptor.key_id,
  );
  // Snapshot every caller-owned value and the exact bytes before the first
  // await. Phase 3 must supply record_position through an unforgeable append
  // allocation and atomically persist the record, complete facts, and receipt.
  const bytesToSign = Buffer.from(
    organizationRecordReceiptSignatureInputV2Bytes(signatureInput),
  );
  const signerResult = await sign(
    Buffer.from(bytesToSign),
    signingKeyDescriptor.key_id,
  );
  if (!Buffer.isBuffer(signerResult)) {
    fail("Record receipt v2 signer must return signature bytes");
  }
  const signature = Buffer.from(signerResult);
  try {
    assertP256LowS(signature);
  } catch (error) {
    fail("Record receipt v2 signer returned a non-canonical signature", error);
  }
  return verifyOrganizationRecordReceiptV2(
    {
      body,
      receipt_sha256: receiptSha256,
      signing_key_descriptor: signingKeyDescriptor,
      signature: signature.toString("base64"),
    },
    envelope,
    pinnedAuthority,
    expectedStateLineageId,
  );
}
