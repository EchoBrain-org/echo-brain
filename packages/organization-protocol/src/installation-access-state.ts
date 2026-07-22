import {
  canonicalJson,
  canonicalSha256,
  createSignedDocumentWithKey,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from "@echo-brain/federation-protocol";
import { resolvePinnedOrganizationAuthority } from "./authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "./authority-descriptor.js";
import type {
  ActiveOrganizationInstallationAccessStatePayloadV1,
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessDecisionV1,
  OrganizationInstallationAccessStatePayloadV1,
  OrganizationInstallationAccessStateV1,
  RevokedOrganizationInstallationAccessStatePayloadV1,
} from "./contracts.js";
import { verifyOrganizationEnrollmentReceipt } from "./enrollment-receipt.js";
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertId,
  assertLiteral,
  assertMembershipType,
  assertNonnegativeSafeInteger,
  assertPositiveSafeInteger,
  assertTimestamp,
  canonicalSnapshot,
  timestampMillis,
  validateSignedIntegrity,
} from "./validation-support.js";

export const MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface CreateOrganizationInstallationAccessStateBaseInput {
  request: OrganizationEnrollmentRequestV1;
  receipt: OrganizationEnrollmentReceiptV1;
  previous_state: OrganizationInstallationAccessStateV1 | null;
  access_state_sequence: number;
  evaluated_at: string;
}

export type CreateOrganizationInstallationAccessStateInput =
  | (CreateOrganizationInstallationAccessStateBaseInput & {
      status: "active";
      valid_until: string;
      maximum_active_ttl_ms: number;
    })
  | (CreateOrganizationInstallationAccessStateBaseInput & {
      status: "revoked";
      revocation_reason: "membership_revoked" | "installation_revoked";
    });

export interface VerifyOrganizationInstallationAccessStateInput {
  state: unknown;
  pinned_authority: PinnedOrganizationAuthority;
  enrollment_request: unknown;
  enrollment_receipt: unknown;
  now: string;
  maximum_active_ttl_ms: number;
  allowed_clock_skew_ms?: number;
  previous_state: unknown | null;
}

export function validateOrganizationInstallationAccessState(
  value: unknown,
): OrganizationInstallationAccessStateV1 {
  const snapshot = canonicalSnapshot(
    value,
    "organization installation access state",
  );
  const record = asRecord(snapshot, "organization installation access state");
  assertExactKeys(
    record,
    [
      "schema_version",
      "kind",
      "authority_id",
      "authority_key_id",
      "organization_id",
      "enrollment_id",
      "enrollment_receipt_sha256",
      "principal_id",
      "membership_id",
      "membership_type",
      "installation_id",
      "installation_key_id",
      "access_state_sequence",
      "status",
      "revocation_reason",
      "evaluated_at",
      "valid_until",
      "integrity",
    ],
    "organization installation access state",
  );
  assertLiteral(
    record.schema_version,
    1,
    "organization installation access state schema_version",
  );
  assertLiteral(
    record.kind,
    "echo-organization-installation-access-state",
    "organization installation access state kind",
  );
  assertId(record.authority_id, "oau", "access state authority_id");
  assertDigest(record.authority_key_id, "access state authority_key_id");
  assertId(record.organization_id, "org", "access state organization_id");
  assertId(record.enrollment_id, "enr", "access state enrollment_id");
  assertDigest(
    record.enrollment_receipt_sha256,
    "access state enrollment_receipt_sha256",
  );
  assertId(record.principal_id, "prn", "access state principal_id");
  assertId(record.membership_id, "mem", "access state membership_id");
  assertMembershipType(record.membership_type, "access state membership_type");
  assertId(record.installation_id, "ins", "access state installation_id");
  assertDigest(record.installation_key_id, "access state installation_key_id");
  assertPositiveSafeInteger(
    record.access_state_sequence,
    "access state sequence",
  );
  assertTimestamp(record.evaluated_at, "access state evaluated_at");
  if (record.status === "active") {
    if (record.revocation_reason !== null) {
      throw new Error("active access state must not have a revocation reason");
    }
    assertTimestamp(record.valid_until, "active access state valid_until");
  } else if (record.status === "revoked") {
    if (
      record.revocation_reason !== "membership_revoked" &&
      record.revocation_reason !== "installation_revoked"
    ) {
      throw new Error("revoked access state must have a supported reason");
    }
    if (record.valid_until !== null) {
      throw new Error("revoked access state must not expire");
    }
  } else {
    throw new Error("organization installation access status is unsupported");
  }
  const integrity = validateSignedIntegrity(
    record.integrity,
    "organization installation access state integrity",
  );
  if (integrity.key_id !== record.authority_key_id) {
    throw new Error(
      "access state signature key does not match the authority key",
    );
  }
  return record as unknown as OrganizationInstallationAccessStateV1;
}

function authenticateAccessState(
  value: unknown,
  authority: OrganizationAuthorityDescriptorV1,
  receipt: OrganizationEnrollmentReceiptV1,
): OrganizationInstallationAccessStateV1 {
  const state = validateOrganizationInstallationAccessState(value);
  if (
    state.authority_id !== authority.authority_id ||
    state.authority_key_id !== authority.signing_key.key_id ||
    state.organization_id !== authority.organization_id
  ) {
    throw new Error(
      "organization access state does not match the pinned authority",
    );
  }
  if (
    state.enrollment_id !== receipt.enrollment_id ||
    state.enrollment_receipt_sha256 !== canonicalSha256(receipt) ||
    state.principal_id !== receipt.principal_id ||
    state.membership_id !== receipt.membership_id ||
    state.membership_type !== receipt.membership_type ||
    state.installation_id !== receipt.installation_id ||
    state.installation_key_id !== receipt.installation_key_id
  ) {
    throw new Error(
      "organization access state does not bind the exact enrollment",
    );
  }
  const evaluatedAt = timestampMillis(
    state.evaluated_at,
    "access state evaluated_at",
  );
  const enrolledAt = timestampMillis(
    receipt.enrolled_at,
    "enrollment receipt enrolled_at",
  );
  if (evaluatedAt < enrolledAt) {
    throw new Error("organization access state predates enrollment");
  }
  if (state.status === "active") {
    const validUntil = timestampMillis(
      state.valid_until,
      "active access state valid_until",
    );
    if (validUntil <= evaluatedAt) {
      throw new Error("active organization access state has an empty lease");
    }
  }
  const publicKey = verifyP256SigningKeyDescriptor(authority.signing_key);
  verifySignedDocument(state, publicKey, authority.signing_key.key_id);
  return state;
}

/**
 * Verifies current installation-level organization access. This is not a
 * user-session or record-audience authorization decision.
 */
export function verifyOrganizationInstallationAccessState(
  input: VerifyOrganizationInstallationAccessStateInput,
): OrganizationInstallationAccessDecisionV1 {
  const authority = resolvePinnedOrganizationAuthority(input.pinned_authority);
  const receipt = verifyOrganizationEnrollmentReceipt(
    input.enrollment_receipt,
    input.pinned_authority,
    input.enrollment_request,
  );
  const state = authenticateAccessState(input.state, authority, receipt);
  const now = timestampMillis(
    input.now,
    "organization access verification time",
  );
  assertPositiveSafeInteger(
    input.maximum_active_ttl_ms,
    "maximum active access TTL",
  );
  const clockSkew = input.allowed_clock_skew_ms ?? 0;
  assertNonnegativeSafeInteger(clockSkew, "allowed access clock skew");
  if (clockSkew > MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS) {
    throw new Error(
      `allowed access clock skew must not exceed ${MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS} milliseconds`,
    );
  }
  const evaluatedAt = timestampMillis(
    state.evaluated_at,
    "access state evaluated_at",
  );
  if (evaluatedAt > now + clockSkew) {
    throw new Error("organization access state is implausibly future-dated");
  }

  if (input.previous_state === undefined) {
    throw new Error(
      "previous organization access state must be supplied explicitly or set to null",
    );
  }
  if (input.previous_state === null) {
    if (state.access_state_sequence !== 1) {
      throw new Error(
        "first verified organization access state sequence must be 1",
      );
    }
  } else {
    const previous = authenticateAccessState(
      input.previous_state,
      authority,
      receipt,
    );
    if (state.access_state_sequence < previous.access_state_sequence) {
      throw new Error("organization access state sequence rolled back");
    }
    if (state.access_state_sequence === previous.access_state_sequence) {
      if (canonicalJson(state) !== canonicalJson(previous)) {
        throw new Error(
          "organization access state sequence was reused divergently",
        );
      }
    } else {
      if (previous.status === "revoked") {
        throw new Error("revoked organization access state is terminal");
      }
      if (
        timestampMillis(state.evaluated_at, "access state evaluated_at") <
        timestampMillis(
          previous.evaluated_at,
          "previous access state evaluated_at",
        )
      ) {
        throw new Error("organization access state evaluation time regressed");
      }
    }
  }

  if (state.status === "revoked") {
    return { permitted: false, state };
  }
  const validUntil = timestampMillis(
    state.valid_until,
    "active access state valid_until",
  );
  if (validUntil - evaluatedAt > input.maximum_active_ttl_ms) {
    throw new Error("active organization access lease exceeds the allowed TTL");
  }
  if (now >= validUntil) {
    throw new Error("active organization access lease has expired");
  }
  return { permitted: true, state };
}

export async function createOrganizationInstallationAccessState(
  input: CreateOrganizationInstallationAccessStateInput,
  pinnedAuthority: PinnedOrganizationAuthority,
  sign: CanonicalPayloadSigner,
): Promise<OrganizationInstallationAccessStateV1> {
  const authority = resolvePinnedOrganizationAuthority(pinnedAuthority);
  const receipt = verifyOrganizationEnrollmentReceipt(
    input.receipt,
    pinnedAuthority,
    input.request,
  );
  if (input.previous_state === undefined) {
    throw new Error(
      "previous organization access state must be supplied explicitly or set to null",
    );
  }
  assertPositiveSafeInteger(
    input.access_state_sequence,
    "access state sequence",
  );
  assertTimestamp(input.evaluated_at, "access state evaluated_at");
  const evaluatedAt = timestampMillis(
    input.evaluated_at,
    "access state evaluated_at",
  );
  if (
    evaluatedAt <
    timestampMillis(receipt.enrolled_at, "enrollment receipt enrolled_at")
  ) {
    throw new Error("organization access state predates enrollment");
  }
  if (input.previous_state === null) {
    if (input.access_state_sequence !== 1) {
      throw new Error("first organization access state sequence must be 1");
    }
  } else {
    const previous = authenticateAccessState(
      input.previous_state,
      authority,
      receipt,
    );
    if (previous.status === "revoked") {
      throw new Error("revoked organization access state is terminal");
    }
    if (
      previous.access_state_sequence === Number.MAX_SAFE_INTEGER ||
      input.access_state_sequence !== previous.access_state_sequence + 1
    ) {
      throw new Error(
        "new organization access state must use the next sequence",
      );
    }
    if (
      evaluatedAt <
      timestampMillis(
        previous.evaluated_at,
        "previous access state evaluated_at",
      )
    ) {
      throw new Error("organization access state evaluation time regressed");
    }
  }
  const base = {
    schema_version: 1,
    kind: "echo-organization-installation-access-state",
    authority_id: authority.authority_id,
    authority_key_id: authority.signing_key.key_id,
    organization_id: authority.organization_id,
    enrollment_id: receipt.enrollment_id,
    enrollment_receipt_sha256: canonicalSha256(receipt),
    principal_id: receipt.principal_id,
    membership_id: receipt.membership_id,
    membership_type: receipt.membership_type,
    installation_id: receipt.installation_id,
    installation_key_id: receipt.installation_key_id,
    access_state_sequence: input.access_state_sequence,
    evaluated_at: input.evaluated_at,
  } as const;
  let payload: OrganizationInstallationAccessStatePayloadV1;
  if (input.status === "active") {
    assertPositiveSafeInteger(
      input.maximum_active_ttl_ms,
      "maximum active access TTL",
    );
    assertTimestamp(input.valid_until, "active access state valid_until");
    const validUntil = timestampMillis(
      input.valid_until,
      "active access state valid_until",
    );
    if (validUntil <= evaluatedAt) {
      throw new Error("active organization access state has an empty lease");
    }
    if (validUntil - evaluatedAt > input.maximum_active_ttl_ms) {
      throw new Error(
        "active organization access lease exceeds the allowed TTL",
      );
    }
    payload = {
      ...base,
      status: "active",
      revocation_reason: null,
      valid_until: input.valid_until,
    } satisfies ActiveOrganizationInstallationAccessStatePayloadV1;
  } else if (input.status === "revoked") {
    if (
      input.revocation_reason !== "membership_revoked" &&
      input.revocation_reason !== "installation_revoked"
    ) {
      throw new Error("revoked access state must have a supported reason");
    }
    payload = {
      ...base,
      status: "revoked",
      revocation_reason: input.revocation_reason,
      valid_until: null,
    } satisfies RevokedOrganizationInstallationAccessStatePayloadV1;
  } else {
    throw new Error("organization installation access status is unsupported");
  }
  canonicalSnapshot(payload, "organization installation access state payload");
  const document = await createSignedDocumentWithKey(
    payload,
    authority.signing_key.key_id,
    sign,
  );
  return authenticateAccessState(document, authority, receipt);
}
