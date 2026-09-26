import {
  assertFederationId,
  assertUtcMillisecondTimestamp,
  canonicalJsonBytes,
  isFederationProtocolValidationError,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type {
  FederationIdPrefix,
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import { organizationProtocolValidationFailure } from "./validation-error.js";

export const MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES = 16 * 1024;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function translateFederationValidation<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (isFederationProtocolValidationError(error)) {
      organizationProtocolValidationFailure(error.message, error);
    }
    throw error;
  }
}

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    organizationProtocolValidationFailure(`${label} must be an object`);
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
    organizationProtocolValidationFailure(`${label} has an unexpected shape`);
  }
}

export function assertLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    organizationProtocolValidationFailure(`${label} is unsupported`);
  }
}

export function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    organizationProtocolValidationFailure(
      `${label} must be a canonical SHA-256 digest`,
    );
  }
}

export function assertId(
  value: unknown,
  prefix: FederationIdPrefix,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    organizationProtocolValidationFailure(
      `${label} must be a canonical ${prefix} identifier`,
    );
  }
  translateFederationValidation(() => assertFederationId(value, prefix, label));
}

export function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    organizationProtocolValidationFailure(
      `${label} must be a UTC millisecond timestamp`,
    );
  }
  translateFederationValidation(() =>
    assertUtcMillisecondTimestamp(value, label),
  );
}

export function assertPositiveSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    organizationProtocolValidationFailure(
      `${label} must be a positive safe integer`,
    );
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
    organizationProtocolValidationFailure(
      `${label} public key must be canonical base64`,
    );
  }
  const descriptor = record as unknown as P256SigningKeyDescriptor;
  translateFederationValidation(() =>
    verifyP256SigningKeyDescriptor(descriptor),
  );
  return canonicalSnapshot(descriptor, label);
}

/**
 * `maximumBytes` is an explicit per-document exemption, never a global raise:
 * every caller that omits it keeps the shared 16 KiB protocol default.
 */
export function canonicalSnapshot<T>(
  value: T,
  label: string,
  maximumBytes: number = MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES,
): T {
  const bytes = translateFederationValidation(() => canonicalJsonBytes(value));
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    organizationProtocolValidationFailure(
      `${label} must be between 1 and ${maximumBytes} canonical bytes`,
    );
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}

/**
 * Rejects every value that cannot be represented as inert, plain JSON data.
 * Human act record input v1 passes `requireFiniteNumbers = false`: it has
 * always accepted any number here and left NaN and Infinity for
 * canonicalSnapshot to reject.
 */
export function assertPlainJsonData(
  value: unknown,
  label: string,
  requireFiniteNumbers = true,
  seen: Set<object> = new Set<object>(),
): void {
  if (value === null) return;
  if (typeof value !== "object") {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" ||
        (requireFiniteNumbers && !Number.isFinite(value)))
    ) {
      organizationProtocolValidationFailure(
        requireFiniteNumbers
          ? `${label} must contain only finite JSON data`
          : `${label} must contain only JSON data`,
      );
    }
    return;
  }
  if (seen.has(value)) {
    organizationProtocolValidationFailure(`${label} must not contain a cycle`);
  }
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      organizationProtocolValidationFailure(
        `${label} must not contain symbol properties`,
      );
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        organizationProtocolValidationFailure(`${label} must be a plain array`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) {
        organizationProtocolValidationFailure(
          `${label} must be a dense plain array`,
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          organizationProtocolValidationFailure(
            `${label} must contain only enumerable data properties`,
          );
        }
        assertPlainJsonData(descriptor.value, label, requireFiniteNumbers, seen);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      organizationProtocolValidationFailure(`${label} must be a plain object`);
    }
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        organizationProtocolValidationFailure(
          `${label} must contain only enumerable data properties`,
        );
      }
      assertPlainJsonData(descriptor.value, label, requireFiniteNumbers, seen);
    }
  } finally {
    seen.delete(value);
  }
}

/**
 * Snapshots a plain JSON object that has exactly `keys`. Callers pass their
 * document byte limit, as for canonicalSnapshot.
 */
export function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  maximumBytes: number,
  requireFiniteNumbers = true,
): Record<string, unknown> {
  assertPlainJsonData(value, label, requireFiniteNumbers);
  const snapshot = canonicalSnapshot(value, label, maximumBytes);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    organizationProtocolValidationFailure(`${label} must be a plain object`);
  }
  const record = snapshot as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    organizationProtocolValidationFailure(`${label} has an unexpected shape`);
  }
  return record;
}

export function assertText(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    organizationProtocolValidationFailure(
      `${label} must be a bounded non-empty string`,
    );
  }
}
