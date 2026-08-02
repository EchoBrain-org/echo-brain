import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  createSignedDocumentWithKey,
  normalizeP256LowS,
  p256KeyId,
  signedPayload,
} from "@echo-brain/federation-protocol";
import * as protocol from "../src/index.js";
import {
  isOrganizationProtocolValidationError,
  OrganizationProtocolValidationError,
  createOrganizationEnrollmentReceipt,
  createOrganizationEnrollmentRequest,
  createOrganizationInstallationAccessState,
  organizationAuthorityPinSha256,
  organizationAuthorityPublicKey,
  organizationEnrollmentGrantSha256,
  organizationEnrollmentReceiptSha256,
  organizationEnrollmentRequestSha256,
  validateOrganizationAuthorityDescriptor,
  validateOrganizationEnrollmentReceipt,
  validateOrganizationEnrollmentRequest,
  validateOrganizationInstallationAccessState,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationInstallationAccessState,
} from "../src/index.js";
import type {
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  VerifyOrganizationInstallationAccessStateInput,
} from "../src/index.js";
import { canonicalSnapshot } from "../src/validation-support.js";

interface GoldenVector {
  payload_canonical_utf8_base64: string;
  payload_sha256: string;
  document_canonical_utf8_base64: string;
  document_sha256: string;
}

interface GoldenFixture {
  fixture_version: number;
  kind: string;
  authority_descriptor: OrganizationAuthorityDescriptorV1;
  authority_descriptor_canonical: string;
  authority_pin_sha256: string;
  enrollment_grant_sha256: string;
  enrollment_request: OrganizationEnrollmentRequestV1;
  enrollment_request_vector: GoldenVector;
  enrollment_receipt: OrganizationEnrollmentReceiptV1;
  enrollment_receipt_vector: GoldenVector;
  active_access_state: OrganizationInstallationAccessStateV1;
  active_access_state_vector: GoldenVector;
  revoked_access_state: OrganizationInstallationAccessStateV1;
  revoked_access_state_vector: GoldenVector;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/onboarding-access-chain.v1.json", import.meta.url),
    "utf8",
  ),
) as GoldenFixture;

const pinnedFixtureAuthority = verifyOrganizationAuthorityPin(
  fixture.authority_descriptor,
  fixture.authority_pin_sha256,
);

function assertGoldenVector(
  document:
    | OrganizationEnrollmentRequestV1
    | OrganizationEnrollmentReceiptV1
    | OrganizationInstallationAccessStateV1,
  vector: GoldenVector,
): void {
  const payload = signedPayload(document);
  expect(canonicalJsonBytes(payload).toString("base64")).toBe(
    vector.payload_canonical_utf8_base64,
  );
  expect(canonicalSha256(payload)).toBe(vector.payload_sha256);
  expect(canonicalJsonBytes(document).toString("base64")).toBe(
    vector.document_canonical_utf8_base64,
  );
  expect(canonicalSha256(document)).toBe(vector.document_sha256);
}

function replaySigner(
  vector: GoldenVector,
  signatureBase64: string,
): CanonicalPayloadSigner {
  return async (bytes) => {
    expect(bytes.toString("base64")).toBe(vector.payload_canonical_utf8_base64);
    return Buffer.from(signatureBase64, "base64");
  };
}

function withIntegrityPatch<T extends { integrity: object }>(
  document: T,
  patch: Record<string, unknown>,
): T {
  return {
    ...structuredClone(document),
    integrity: { ...document.integrity, ...patch },
  } as T;
}

function generatedSigner(): {
  descriptor: OrganizationAuthorityDescriptorV1["signing_key"];
  sign: CanonicalPayloadSigner;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer)) throw new Error("unexpected key export");
  return {
    descriptor: {
      key_id: p256KeyId(publicKeyDer),
      algorithm: "ecdsa-p256-sha256-der-low-s",
      public_key_spki_der_base64: publicKeyDer.toString("base64"),
    },
    sign: async (bytes) =>
      normalizeP256LowS(
        signMessage("sha256", bytes, {
          key: privateKey,
          dsaEncoding: "der",
        }),
      ),
  };
}

function fixtureAccessVerification(
  state: unknown,
  previous_state: unknown | null,
  overrides: Partial<VerifyOrganizationInstallationAccessStateInput> = {},
): VerifyOrganizationInstallationAccessStateInput {
  return {
    state,
    previous_state,
    pinned_authority: pinnedFixtureAuthority,
    enrollment_request: fixture.enrollment_request,
    enrollment_receipt: fixture.enrollment_receipt,
    now: "2026-07-22T00:03:00.000Z",
    maximum_active_ttl_ms: 300_000,
    ...overrides,
  };
}

describe("organization onboarding and access golden chain", () => {
  it("freezes the authority pin and all signed bytes", () => {
    expect(fixture.fixture_version).toBe(1);
    expect(fixture.kind).toBe(
      "echo-organization-onboarding-access-golden-fixture",
    );
    expect(
      validateOrganizationAuthorityDescriptor(fixture.authority_descriptor),
    ).toEqual(fixture.authority_descriptor);
    expect(canonicalJson(fixture.authority_descriptor)).toBe(
      fixture.authority_descriptor_canonical,
    );
    expect(organizationAuthorityPinSha256(fixture.authority_descriptor)).toBe(
      fixture.authority_pin_sha256,
    );
    expect(Object.isFrozen(pinnedFixtureAuthority)).toBe(true);
    expect(Object.keys(pinnedFixtureAuthority)).toEqual([
      "authority_pin_sha256",
    ]);
    expect(
      p256KeyId(organizationAuthorityPublicKey(pinnedFixtureAuthority)),
    ).toBe(fixture.authority_descriptor.signing_key.key_id);
    expect(() =>
      verifyOrganizationAuthorityPin(
        fixture.authority_descriptor,
        `sha256:${"0".repeat(64)}`,
      ),
    ).toThrow("does not match its trusted pin");
    expect(() =>
      organizationAuthorityPublicKey({ ...pinnedFixtureAuthority } as never),
    ).toThrow("must be created by verifyOrganizationAuthorityPin");

    assertGoldenVector(
      fixture.enrollment_request,
      fixture.enrollment_request_vector,
    );
    assertGoldenVector(
      fixture.enrollment_receipt,
      fixture.enrollment_receipt_vector,
    );
    assertGoldenVector(
      fixture.active_access_state,
      fixture.active_access_state_vector,
    );
    assertGoldenVector(
      fixture.revoked_access_state,
      fixture.revoked_access_state_vector,
    );
  });

  it("replays provider-neutral creation over the exact canonical payloads", async () => {
    expect(
      organizationEnrollmentGrantSha256(
        Uint8Array.from({ length: 32 }, (_, index) => index),
      ),
    ).toBe(fixture.enrollment_grant_sha256);

    const request = await createOrganizationEnrollmentRequest(
      {
        enrollment_grant_sha256:
          fixture.enrollment_request.enrollment_grant_sha256,
        principal_id: fixture.enrollment_request.principal_id,
        membership_id: fixture.enrollment_request.membership_id,
        installation_id: fixture.enrollment_request.installation_id,
        installation_signing_key:
          fixture.enrollment_request.installation_signing_key,
      },
      pinnedFixtureAuthority,
      replaySigner(
        fixture.enrollment_request_vector,
        fixture.enrollment_request.integrity.signature_base64,
      ),
    );
    expect(request).toEqual(fixture.enrollment_request);

    const receipt = await createOrganizationEnrollmentReceipt(
      {
        enrollment_id: fixture.enrollment_receipt.enrollment_id,
        membership_type: fixture.enrollment_receipt.membership_type,
        enrolled_at: fixture.enrollment_receipt.enrolled_at,
        request,
      },
      pinnedFixtureAuthority,
      replaySigner(
        fixture.enrollment_receipt_vector,
        fixture.enrollment_receipt.integrity.signature_base64,
      ),
    );
    expect(receipt).toEqual(fixture.enrollment_receipt);

    const active = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence:
          fixture.active_access_state.access_state_sequence,
        evaluated_at: fixture.active_access_state.evaluated_at,
        status: "active",
        valid_until:
          fixture.active_access_state.status === "active"
            ? fixture.active_access_state.valid_until
            : "",
        maximum_active_ttl_ms: 300_000,
      },
      pinnedFixtureAuthority,
      replaySigner(
        fixture.active_access_state_vector,
        fixture.active_access_state.integrity.signature_base64,
      ),
    );
    expect(active).toEqual(fixture.active_access_state);

    const revoked = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: active,
        access_state_sequence:
          fixture.revoked_access_state.access_state_sequence,
        evaluated_at: fixture.revoked_access_state.evaluated_at,
        status: "revoked",
        revocation_reason: "installation_revoked",
      },
      pinnedFixtureAuthority,
      replaySigner(
        fixture.revoked_access_state_vector,
        fixture.revoked_access_state.integrity.signature_base64,
      ),
    );
    expect(revoked).toEqual(fixture.revoked_access_state);
  });

  it("verifies enrollment and yields an explicit allow or deny decision", () => {
    expect(
      validateOrganizationEnrollmentRequest(fixture.enrollment_request),
    ).toEqual(fixture.enrollment_request);
    expect(
      verifyOrganizationEnrollmentRequest(
        fixture.enrollment_request,
        pinnedFixtureAuthority,
      ),
    ).toEqual(fixture.enrollment_request);
    expect(
      organizationEnrollmentRequestSha256(
        fixture.enrollment_request,
        pinnedFixtureAuthority,
      ),
    ).toBe(fixture.enrollment_request_vector.document_sha256);
    expect(
      validateOrganizationEnrollmentReceipt(fixture.enrollment_receipt),
    ).toEqual(fixture.enrollment_receipt);
    expect(
      verifyOrganizationEnrollmentReceipt(
        fixture.enrollment_receipt,
        pinnedFixtureAuthority,
        fixture.enrollment_request,
      ),
    ).toEqual(fixture.enrollment_receipt);
    expect(
      organizationEnrollmentReceiptSha256(
        fixture.enrollment_receipt,
        pinnedFixtureAuthority,
        fixture.enrollment_request,
      ),
    ).toBe(fixture.enrollment_receipt_vector.document_sha256);

    expect(
      validateOrganizationInstallationAccessState(fixture.active_access_state),
    ).toEqual(fixture.active_access_state);
    const active = verifyOrganizationInstallationAccessState(
      fixtureAccessVerification(fixture.active_access_state, null),
    );
    expect(active).toEqual({
      permitted: true,
      state: fixture.active_access_state,
    });

    const revoked = verifyOrganizationInstallationAccessState(
      fixtureAccessVerification(
        fixture.revoked_access_state,
        fixture.active_access_state,
      ),
    );
    expect(revoked).toEqual({
      permitted: false,
      state: fixture.revoked_access_state,
    });
  });

  it("rejects malformed, unbound, stale, or rollback trust facts", () => {
    expect(() =>
      verifyOrganizationEnrollmentRequest(
        fixture.enrollment_request,
        fixture.authority_descriptor as never,
      ),
    ).toThrow("must be created by verifyOrganizationAuthorityPin");
    expect(() =>
      validateOrganizationAuthorityDescriptor({
        ...fixture.authority_descriptor,
        extra: true,
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      validateOrganizationAuthorityDescriptor({
        ...fixture.authority_descriptor,
        signing_key: {
          ...fixture.authority_descriptor.signing_key,
          key_id: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).toThrow("fingerprint does not match");

    expect(() =>
      validateOrganizationEnrollmentRequest({
        ...fixture.enrollment_request,
        extra: true,
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      validateOrganizationEnrollmentRequest(
        withIntegrityPatch(fixture.enrollment_request, {
          key_id: fixture.authority_descriptor.signing_key.key_id,
        }),
      ),
    ).toThrow("does not match the installation key");
    expect(() =>
      verifyOrganizationEnrollmentRequest(
        {
          ...fixture.enrollment_request,
          membership_id: "mem_00000000-0000-4000-8000-000000000002",
        },
        pinnedFixtureAuthority,
      ),
    ).toThrow("payload digest does not match");
    expect(() =>
      verifyOrganizationEnrollmentRequest(
        {
          ...fixture.enrollment_request,
          authority_key_id: `sha256:${"0".repeat(64)}`,
        },
        pinnedFixtureAuthority,
      ),
    ).toThrow("does not match the pinned authority");

    const receiptBindingMutations = [
      {
        principal_id: "prn_00000000-0000-4000-8000-000000000002",
      },
      {
        membership_id: "mem_00000000-0000-4000-8000-000000000002",
      },
      {
        installation_id: "ins_00000000-0000-4000-8000-000000000002",
      },
      { installation_key_id: `sha256:${"0".repeat(64)}` },
      { request_sha256: `sha256:${"0".repeat(64)}` },
    ];
    for (const mutation of receiptBindingMutations) {
      expect(() =>
        verifyOrganizationEnrollmentReceipt(
          { ...fixture.enrollment_receipt, ...mutation },
          pinnedFixtureAuthority,
          fixture.enrollment_request,
        ),
      ).toThrow("does not bind the exact request");
    }
    expect(() =>
      verifyOrganizationEnrollmentReceipt(
        withIntegrityPatch(fixture.enrollment_receipt, {
          signature_base64:
            fixture.enrollment_request.integrity.signature_base64,
        }),
        pinnedFixtureAuthority,
        fixture.enrollment_request,
      ),
    ).toThrow();
    expect(() =>
      validateOrganizationEnrollmentReceipt({
        ...fixture.enrollment_receipt,
        enrolled_at: "2026-02-30T00:00:00.000Z",
      }),
    ).toThrow("is not a real UTC timestamp");

    expect(() =>
      validateOrganizationInstallationAccessState({
        ...fixture.active_access_state,
        revocation_reason: "installation_revoked",
      }),
    ).toThrow("active access state must not have a revocation reason");
    expect(() =>
      verifyOrganizationInstallationAccessState(
        fixtureAccessVerification(fixture.active_access_state, null, {
          now: "2026-07-22T00:06:00.000Z",
        }),
      ),
    ).toThrow("lease has expired");
    expect(() =>
      verifyOrganizationInstallationAccessState(
        fixtureAccessVerification(fixture.active_access_state, null, {
          maximum_active_ttl_ms: 299_999,
        }),
      ),
    ).toThrow("exceeds the allowed TTL");
    expect(() =>
      verifyOrganizationInstallationAccessState({
        state: fixture.active_access_state,
        pinned_authority: pinnedFixtureAuthority,
        enrollment_request: fixture.enrollment_request,
        enrollment_receipt: fixture.enrollment_receipt,
        now: "2026-07-22T00:03:00.000Z",
        maximum_active_ttl_ms: 300_000,
      } as never),
    ).toThrow("must be supplied explicitly or set to null");
    expect(() =>
      verifyOrganizationInstallationAccessState(
        fixtureAccessVerification(
          {
            ...fixture.active_access_state,
            enrollment_receipt_sha256: `sha256:${"0".repeat(64)}`,
          },
          null,
        ),
      ),
    ).toThrow("does not bind the exact enrollment");
    expect(() =>
      verifyOrganizationInstallationAccessState(
        fixtureAccessVerification(
          fixture.active_access_state,
          fixture.revoked_access_state,
        ),
      ),
    ).toThrow("sequence rolled back");
    expect(() =>
      verifyOrganizationInstallationAccessState(
        fixtureAccessVerification(fixture.revoked_access_state, null),
      ),
    ).toThrow("first verified organization access state sequence must be 1");
  });

  it("rejects divergent sequence reuse and post-revocation progression", async () => {
    const authoritySigner = generatedSigner();
    const installationSigner = generatedSigner();
    const authority: OrganizationAuthorityDescriptorV1 = {
      schema_version: 1,
      kind: "echo-organization-authority",
      authority_id: "oau_00000000-0000-4000-8000-000000000002",
      organization_id: "org_00000000-0000-4000-8000-000000000002",
      signing_key: authoritySigner.descriptor,
    };
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      authority,
      organizationAuthorityPinSha256(authority),
    );
    const request = await createOrganizationEnrollmentRequest(
      {
        enrollment_grant_sha256: `sha256:${"1".repeat(64)}`,
        principal_id: "prn_00000000-0000-4000-8000-000000000002",
        membership_id: "mem_00000000-0000-4000-8000-000000000002",
        installation_id: "ins_00000000-0000-4000-8000-000000000002",
        installation_signing_key: installationSigner.descriptor,
      },
      pinnedAuthority,
      installationSigner.sign,
    );
    const receipt = await createOrganizationEnrollmentReceipt(
      {
        enrollment_id: "enr_00000000-0000-4000-8000-000000000002",
        membership_type: "employee",
        enrolled_at: "2026-07-22T01:00:00.000Z",
        request,
      },
      pinnedAuthority,
      authoritySigner.sign,
    );
    let rejectedSignCalls = 0;
    const rejectedSigner: CanonicalPayloadSigner = async (bytes) => {
      rejectedSignCalls += 1;
      return authoritySigner.sign(bytes);
    };
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          previous_state: null,
          access_state_sequence: 1,
          evaluated_at: "2026-07-22T01:01:00.000Z",
          status: "suspended",
          revocation_reason: "membership_revoked",
        } as never,
        pinnedAuthority,
        rejectedSigner,
      ),
    ).rejects.toThrow("access status is unsupported");
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          previous_state: null,
          access_state_sequence: 1,
          evaluated_at: "2026-07-22T01:01:00.000Z",
          status: "revoked",
          revocation_reason: "organization_revoked",
        } as never,
        pinnedAuthority,
        rejectedSigner,
      ),
    ).rejects.toThrow("must have a supported reason");
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          previous_state: null,
          access_state_sequence: 1,
          evaluated_at: "2026-07-22T00:59:59.999Z",
          status: "revoked",
          revocation_reason: "membership_revoked",
        },
        pinnedAuthority,
        rejectedSigner,
      ),
    ).rejects.toThrow("predates enrollment");
    expect(rejectedSignCalls).toBe(0);
    const active = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence: 1,
        evaluated_at: "2026-07-22T01:01:00.000Z",
        status: "active",
        valid_until: "2026-07-22T01:06:00.000Z",
        maximum_active_ttl_ms: 300_000,
      },
      pinnedAuthority,
      authoritySigner.sign,
    );
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          access_state_sequence: 1,
          evaluated_at: "2026-07-22T01:01:00.000Z",
          status: "active",
          valid_until: "2026-07-22T01:06:00.000Z",
          maximum_active_ttl_ms: 300_000,
        } as never,
        pinnedAuthority,
        authoritySigner.sign,
      ),
    ).rejects.toThrow("must be supplied explicitly or set to null");
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          previous_state: null,
          access_state_sequence: 2,
          evaluated_at: "2026-07-22T01:01:00.000Z",
          status: "active",
          valid_until: "2026-07-22T01:06:00.000Z",
          maximum_active_ttl_ms: 300_000,
        },
        pinnedAuthority,
        authoritySigner.sign,
      ),
    ).rejects.toThrow("first organization access state sequence must be 1");
    const divergent = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence: 1,
        evaluated_at: "2026-07-22T01:02:00.000Z",
        status: "active",
        valid_until: "2026-07-22T01:07:00.000Z",
        maximum_active_ttl_ms: 300_000,
      },
      pinnedAuthority,
      authoritySigner.sign,
    );
    expect(() =>
      verifyOrganizationInstallationAccessState({
        state: divergent,
        previous_state: active,
        pinned_authority: pinnedAuthority,
        enrollment_request: request,
        enrollment_receipt: receipt,
        now: "2026-07-22T01:03:00.000Z",
        maximum_active_ttl_ms: 300_000,
      }),
    ).toThrow("sequence was reused divergently");

    const revoked = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: active,
        access_state_sequence: 2,
        evaluated_at: "2026-07-22T01:03:00.000Z",
        status: "revoked",
        revocation_reason: "membership_revoked",
      },
      pinnedAuthority,
      authoritySigner.sign,
    );
    await expect(
      createOrganizationInstallationAccessState(
        {
          request,
          receipt,
          previous_state: revoked,
          access_state_sequence: 3,
          evaluated_at: "2026-07-22T01:04:00.000Z",
          status: "active",
          valid_until: "2026-07-22T01:09:00.000Z",
          maximum_active_ttl_ms: 300_000,
        },
        pinnedAuthority,
        authoritySigner.sign,
      ),
    ).rejects.toThrow("revoked organization access state is terminal");
    const afterRevocation = await createSignedDocumentWithKey(
      {
        ...signedPayload(active),
        access_state_sequence: 3,
        evaluated_at: "2026-07-22T01:04:00.000Z",
        valid_until: "2026-07-22T01:09:00.000Z",
      },
      authority.signing_key.key_id,
      authoritySigner.sign,
    );
    expect(() =>
      verifyOrganizationInstallationAccessState({
        state: afterRevocation,
        previous_state: revoked,
        pinned_authority: pinnedAuthority,
        enrollment_request: request,
        enrollment_receipt: receipt,
        now: "2026-07-22T01:05:00.000Z",
        maximum_active_ttl_ms: 300_000,
      }),
    ).toThrow("revoked organization access state is terminal");
  });

  it("exposes only the accepted protocol surface", () => {
    expect(Object.keys(protocol).sort()).toEqual([
      "MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS",
      "MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES",
      "OrganizationProtocolValidationError",
      "createOrganizationEnrollmentReceipt",
      "createOrganizationEnrollmentRequest",
      "createOrganizationInstallationAccessState",
      "isOrganizationProtocolValidationError",
      "organizationAuthorityPinSha256",
      "organizationAuthorityPublicKey",
      "organizationEnrollmentGrantSha256",
      "organizationEnrollmentReceiptSha256",
      "organizationEnrollmentRequestSha256",
      "validateOrganizationAuthorityDescriptor",
      "validateOrganizationEnrollmentReceipt",
      "validateOrganizationEnrollmentRequest",
      "validateOrganizationInstallationAccessState",
      "verifyOrganizationAuthorityPin",
      "verifyOrganizationEnrollmentReceipt",
      "verifyOrganizationEnrollmentRequest",
      "verifyOrganizationInstallationAccessState",
    ]);
  });

  it("types malformed organization documents without typing unrelated faults", () => {
    const validators = [
      validateOrganizationAuthorityDescriptor,
      validateOrganizationEnrollmentRequest,
      validateOrganizationEnrollmentReceipt,
      validateOrganizationInstallationAccessState,
    ];
    for (const validate of validators) {
      let thrown: unknown;
      try {
        validate({ malformed: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OrganizationProtocolValidationError);
      expect(isOrganizationProtocolValidationError(thrown)).toBe(true);
    }
    expect(
      isOrganizationProtocolValidationError(new TypeError("internal fault")),
    ).toBe(false);
  });

  it("bounds canonical protocol documents before signing or storage", () => {
    expect(() =>
      canonicalSnapshot(
        { value: "x".repeat(16 * 1024) },
        "oversized organization document",
      ),
    ).toThrow("must be between 1 and 16384 canonical bytes");
  });

  it("validates one canonical snapshot of accessor-backed input", () => {
    const accessorBacked = structuredClone(
      fixture.enrollment_request,
    ) as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessorBacked, "membership_id", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1
          ? fixture.enrollment_request.membership_id
          : "mem_00000000-0000-4000-8000-000000000002";
      },
    });

    expect(
      validateOrganizationEnrollmentRequest(accessorBacked).membership_id,
    ).toBe(fixture.enrollment_request.membership_id);
    expect(reads).toBe(1);
  });
});
