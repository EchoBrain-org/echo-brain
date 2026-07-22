import {
  canonicalSha256,
  verifyP256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";
import type { Buffer } from "node:buffer";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { OrganizationAuthorityDescriptorV1 } from "./contracts.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  canonicalSnapshot,
  validateP256SigningKey,
} from "./validation-support.js";

declare const PINNED_ORGANIZATION_AUTHORITY: unique symbol;

/**
 * A process-local, non-serializable proof that an authority descriptor matched
 * an independently trusted pin. Only verifyOrganizationAuthorityPin can create
 * a runtime-valid handle.
 */
export interface PinnedOrganizationAuthority {
  readonly authority_pin_sha256: Sha256Digest;
  readonly [PINNED_ORGANIZATION_AUTHORITY]: true;
}

const pinnedAuthorities = new WeakMap<
  object,
  OrganizationAuthorityDescriptorV1
>();

/**
 * Validates syntax and public-key self-consistency. This does not authenticate
 * the authority; callers must obtain and pin the descriptor out of band.
 */
export function validateOrganizationAuthorityDescriptor(
  value: unknown,
): OrganizationAuthorityDescriptorV1 {
  const snapshot = canonicalSnapshot(
    value,
    "organization authority descriptor",
  );
  const record = asRecord(snapshot, "organization authority descriptor");
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "authority_id",
      "organization_id",
      "signing_key",
    ],
    "organization authority descriptor",
  );
  assertLiteral(
    record.schema_version,
    1,
    "organization authority schema_version",
  );
  assertLiteral(
    record.kind,
    "echo-organization-authority",
    "organization authority kind",
  );
  assertId(record.authority_id, "oau", "organization authority_id");
  assertId(record.organization_id, "org", "authority organization_id");
  validateP256SigningKey(
    record.signing_key,
    "organization authority signing key",
  );
  return record as unknown as OrganizationAuthorityDescriptorV1;
}

/**
 * Compares a descriptor with a pin loaded independently from the descriptor.
 * Re-run this check after every process restart; handles cannot be copied or
 * deserialized.
 */
export function verifyOrganizationAuthorityPin(
  descriptorValue: unknown,
  independentlyTrustedPin: unknown,
): PinnedOrganizationAuthority {
  assertDigest(independentlyTrustedPin, "trusted organization authority pin");
  const descriptor = validateOrganizationAuthorityDescriptor(descriptorValue);
  const actualPin = canonicalSha256(descriptor);
  if (actualPin !== independentlyTrustedPin) {
    throw new Error(
      "organization authority descriptor does not match its trusted pin",
    );
  }
  const frozenDescriptor = Object.freeze({
    ...descriptor,
    signing_key: Object.freeze({ ...descriptor.signing_key }),
  });
  const handle = Object.freeze({
    authority_pin_sha256: actualPin,
  }) as PinnedOrganizationAuthority;
  pinnedAuthorities.set(handle, frozenDescriptor);
  return handle;
}

export function resolvePinnedOrganizationAuthority(
  value: unknown,
): OrganizationAuthorityDescriptorV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "pinned organization authority must be created by verifyOrganizationAuthorityPin",
    );
  }
  const descriptor = pinnedAuthorities.get(value);
  if (descriptor === undefined) {
    throw new Error(
      "pinned organization authority must be created by verifyOrganizationAuthorityPin",
    );
  }
  return descriptor;
}

/** Returns fresh public-key bytes from a verified process-local pin handle. */
export function organizationAuthorityPublicKey(
  pinnedAuthority: PinnedOrganizationAuthority,
): Buffer {
  const descriptor = resolvePinnedOrganizationAuthority(pinnedAuthority);
  return verifyP256SigningKeyDescriptor(descriptor.signing_key);
}

/** Canonical digest suitable for an exact local authority pin. */
export function organizationAuthorityPinSha256(
  descriptor: unknown,
): Sha256Digest {
  return canonicalSha256(validateOrganizationAuthorityDescriptor(descriptor));
}
