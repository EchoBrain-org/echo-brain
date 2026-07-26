import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../../packages/federation-protocol/src/index.js";
import {
  validateOrganizationAuthorityDescriptor,
  validateOrganizationEnrollmentReceipt,
  validateOrganizationEnrollmentRequest,
  validateOrganizationInstallationAccessState,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
} from "../../../packages/organization-protocol/src/index.js";
import type {
  OrganizationAuthorityDescriptorV1 as StableAuthorityDescriptor,
  OrganizationEnrollmentReceiptV1 as StableReceipt,
  OrganizationEnrollmentRequestV1 as StableRequest,
  OrganizationInstallationAccessStateV1,
} from "../../../packages/organization-protocol/src/index.js";
import { verifyOrganizationAuthorityDescriptor as verifyExperimentalAuthority } from "../../../src/experimental/n2/authority/authority-signer.js";
import type {
  OrganizationAuthorityDescriptorV1 as ExperimentalAuthorityDescriptor,
  OrganizationEnrollmentReceiptV1 as ExperimentalReceipt,
  OrganizationEnrollmentRequestV1 as ExperimentalRequest,
} from "../../../src/experimental/n2/contracts.js";
import { validateN2Document } from "../../../src/experimental/n2/schema-validation.js";

interface CompatibilityFixture {
  authority_descriptor: StableAuthorityDescriptor;
  authority_pin_sha256: string;
  enrollment_request: StableRequest;
  enrollment_receipt: StableReceipt;
  active_access_state: OrganizationInstallationAccessStateV1;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/organization-protocol/fixtures/onboarding-access-chain.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as CompatibilityFixture;

const pinnedAuthority = verifyOrganizationAuthorityPin(
  fixture.authority_descriptor,
  fixture.authority_pin_sha256,
);

// These projections exercise schema-level coordinate compatibility only. Their
// copied integrity values intentionally do not authenticate the changed pilot
// payloads and are never passed to a cryptographic verifier.
function experimentalRequestSchemaProjection(
  request: StableRequest,
): ExperimentalRequest {
  return {
    schema_version: 1,
    kind: "echo-organization-enrollment-request",
    enrollment_grant_sha256: request.enrollment_grant_sha256,
    authority_id: request.authority_id,
    organization_id: request.organization_id,
    principal_id: request.principal_id,
    membership_id: request.membership_id,
    installation_id: request.installation_id,
    installation_key_id: request.installation_signing_key.key_id,
    identity_manifest_id: "idm_00000000-0000-4000-8000-000000000001",
    identity_manifest_sha256: `sha256:${"1".repeat(64)}`,
    publication_policy_id: "pol_00000000-0000-4000-8000-000000000001",
    publication_policy_version: 1,
    publication_policy_sha256: `sha256:${"2".repeat(64)}`,
    integrity: request.integrity,
  };
}

function experimentalReceiptSchemaProjection(
  receipt: StableReceipt,
): ExperimentalReceipt {
  return {
    schema_version: 1,
    kind: "echo-organization-enrollment-receipt",
    enrollment_id: receipt.enrollment_id,
    authority_id: receipt.authority_id,
    authority_key_id: receipt.authority_key_id,
    organization_id: receipt.organization_id,
    principal_id: receipt.principal_id,
    membership_id: receipt.membership_id,
    installation_id: receipt.installation_id,
    installation_key_id: receipt.installation_key_id,
    identity_manifest_id: "idm_00000000-0000-4000-8000-000000000001",
    identity_manifest_sha256: `sha256:${"1".repeat(64)}`,
    publication_policy_id: "pol_00000000-0000-4000-8000-000000000001",
    publication_policy_version: 1,
    publication_policy_sha256: `sha256:${"2".repeat(64)}`,
    request_sha256: receipt.request_sha256,
    enrolled_at: receipt.enrolled_at,
    integrity: receipt.integrity,
  };
}

describe("organization protocol promotion boundary", () => {
  it("preserves the existing authority descriptor bytes and P-256 pin", () => {
    const stable = validateOrganizationAuthorityDescriptor(
      fixture.authority_descriptor,
    );
    const experimental =
      fixture.authority_descriptor as ExperimentalAuthorityDescriptor;

    expect(stable).toEqual(experimental);
    expect(verifyExperimentalAuthority(experimental)).toEqual(
      Buffer.from(stable.signing_key.public_key_spki_der_base64, "base64"),
    );
    expect(canonicalSha256(stable)).toBe(canonicalSha256(experimental));
  });

  it("preserves enrollment identity coordinates while removing ingest coupling", () => {
    const request = verifyOrganizationEnrollmentRequest(
      fixture.enrollment_request,
      pinnedAuthority,
    );
    const receipt = verifyOrganizationEnrollmentReceipt(
      fixture.enrollment_receipt,
      pinnedAuthority,
      request,
    );
    const oldRequest = experimentalRequestSchemaProjection(request);
    const oldReceipt = experimentalReceiptSchemaProjection(receipt);

    expect(
      validateN2Document<ExperimentalRequest>(
        "organization-enrollment-request",
        oldRequest,
      ),
    ).toEqual(oldRequest);
    expect(
      validateN2Document<ExperimentalReceipt>(
        "organization-enrollment-receipt",
        oldReceipt,
      ),
    ).toEqual(oldReceipt);
    expect({
      authority_id: request.authority_id,
      organization_id: request.organization_id,
      principal_id: request.principal_id,
      membership_id: request.membership_id,
      installation_id: request.installation_id,
      installation_key_id: request.installation_signing_key.key_id,
    }).toEqual({
      authority_id: oldRequest.authority_id,
      organization_id: oldRequest.organization_id,
      principal_id: oldRequest.principal_id,
      membership_id: oldRequest.membership_id,
      installation_id: oldRequest.installation_id,
      installation_key_id: oldRequest.installation_key_id,
    });
    expect(request).not.toHaveProperty("identity_manifest_id");
    expect(request).not.toHaveProperty("publication_policy_id");
    expect(receipt).not.toHaveProperty("identity_manifest_id");
    expect(receipt).not.toHaveProperty("publication_policy_id");
  });

  it("makes the intentional wire break fail closed in both directions", () => {
    const oldRequest = experimentalRequestSchemaProjection(
      fixture.enrollment_request,
    );
    const oldReceipt = experimentalReceiptSchemaProjection(
      fixture.enrollment_receipt,
    );

    expect(() => validateOrganizationEnrollmentRequest(oldRequest)).toThrow(
      "unexpected shape",
    );
    expect(() => validateOrganizationEnrollmentReceipt(oldReceipt)).toThrow(
      "unexpected shape",
    );
    expect(() =>
      validateN2Document(
        "organization-enrollment-request",
        fixture.enrollment_request,
      ),
    ).toThrow();
    expect(() =>
      validateN2Document(
        "organization-enrollment-receipt",
        fixture.enrollment_receipt,
      ),
    ).toThrow();
  });

  it("adds a fresh access fact instead of reusing an ingest batch receipt", () => {
    const access = validateOrganizationInstallationAccessState(
      fixture.active_access_state,
    );

    expect(access.kind).toBe("echo-organization-installation-access-state");
    expect(access).toHaveProperty("access_state_sequence");
    expect(access).toHaveProperty("valid_until");
    expect(access).not.toHaveProperty("batch_sha256");
    expect(access).not.toHaveProperty("event_count");
    expect(access).not.toHaveProperty("previous_head");
    expect(access).not.toHaveProperty("resulting_head");
  });
});
