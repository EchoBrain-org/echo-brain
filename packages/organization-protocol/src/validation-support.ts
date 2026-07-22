import { Buffer } from "node:buffer";
import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJsonBytes,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type {
  FederationIdPrefix,
  P256SigningKeyDescriptor,
  Sha256Digest,
  SignedIntegrity,
} from "@echo-brain/federation-protocol";
import type { OrganizationMembershipTypeV1 } from "./contracts.js";

export const MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES = 16 * 1024;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

export function assertLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) throw new Error(`${label} is unsupported`);
}

export function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

export function assertId(
  value: unknown,
  prefix: FederationIdPrefix,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ${prefix} identifier`);
  }
  assertFederationId(value, prefix, label);
}

export function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a UTC millisecond timestamp`);
  }
  assertUtcMillisecondTimestamp(value, label);
}

export function timestampMillis(value: string, label: string): number {
  assertTimestamp(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} is not a real UTC timestamp`);
  }
  return milliseconds;
}

export function assertPositiveSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertNonnegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

export function assertMembershipType(
  value: unknown,
  label: string,
): asserts value is OrganizationMembershipTypeV1 {
  if (value !== "owner" && value !== "employee") {
    throw new Error(`${label} must be owner or employee`);
  }
}

export function validateP256SigningKey(
  value: unknown,
  label: string,
): P256SigningKeyDescriptor {
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    ["key_id", "algorithm", "public_key_spki_der_base64"],
    label,
  );
  assertDigest(record.key_id, `${label} key_id`);
  assertLiteral(
    record.algorithm,
    "ecdsa-p256-sha256-der-low-s",
    `${label} algorithm`,
  );
  if (typeof record.public_key_spki_der_base64 !== "string") {
    throw new Error(`${label} public key must be canonical base64`);
  }
  const descriptor = record as unknown as P256SigningKeyDescriptor;
  verifyP256SigningKeyDescriptor(descriptor);
  return canonicalSnapshot(descriptor, label);
}

export function validateSignedIntegrity(
  value: unknown,
  label: string,
): SignedIntegrity {
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      "canonicalization",
      "payload_sha256",
      "signature_algorithm",
      "key_id",
      "signature_base64",
    ],
    label,
  );
  assertLiteral(
    record.canonicalization,
    "RFC8785",
    `${label} canonicalization`,
  );
  assertDigest(record.payload_sha256, `${label} payload_sha256`);
  assertLiteral(
    record.signature_algorithm,
    "ecdsa-p256-sha256-der-low-s",
    `${label} signature_algorithm`,
  );
  assertDigest(record.key_id, `${label} key_id`);
  const signature = record.signature_base64;
  if (
    typeof signature !== "string" ||
    signature.length < 8 ||
    signature.length > 96 ||
    !CANONICAL_BASE64_PATTERN.test(signature)
  ) {
    throw new Error(`${label} signature must be bounded canonical base64`);
  }
  const decoded = Buffer.from(signature, "base64");
  if (decoded.toString("base64") !== signature) {
    throw new Error(`${label} signature must be bounded canonical base64`);
  }
  return canonicalSnapshot(record as unknown as SignedIntegrity, label);
}

export function canonicalSnapshot<T>(value: T, label: string): T {
  const bytes = canonicalJsonBytes(value);
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES
  ) {
    throw new Error(
      `${label} must be between 1 and ${MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES} canonical bytes`,
    );
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}
