import type { Buffer } from "node:buffer";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
  SignedDocument,
} from "@echo-brain/federation-protocol";

export type CanonicalPayloadSigner = (
  canonicalPayload: Buffer,
) => Promise<Buffer>;

export type OrganizationMembershipTypeV1 = "owner" | "employee";

/**
 * An unsigned trust bootstrap. Authenticity comes only from the channel that
 * supplies and pins this exact descriptor, never from this document itself.
 */
export interface OrganizationAuthorityDescriptorV1 {
  schema_version: 1;
  kind: "echo-organization-authority";
  authority_id: string;
  organization_id: string;
  signing_key: P256SigningKeyDescriptor;
}

export interface OrganizationEnrollmentRequestPayloadV1 {
  schema_version: 1;
  kind: "echo-organization-enrollment-request";
  enrollment_grant_sha256: Sha256Digest;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
}

export interface OrganizationEnrollmentRequestV1
  extends OrganizationEnrollmentRequestPayloadV1, SignedDocument {}

export interface OrganizationEnrollmentReceiptPayloadV1 {
  schema_version: 1;
  kind: "echo-organization-enrollment-receipt";
  enrollment_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  installation_id: string;
  installation_key_id: Sha256Digest;
  request_sha256: Sha256Digest;
  enrolled_at: string;
}

export interface OrganizationEnrollmentReceiptV1
  extends OrganizationEnrollmentReceiptPayloadV1, SignedDocument {}

interface OrganizationInstallationAccessStateBasePayloadV1 {
  schema_version: 1;
  kind: "echo-organization-installation-access-state";
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  enrollment_receipt_sha256: Sha256Digest;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  installation_id: string;
  installation_key_id: Sha256Digest;
  access_state_sequence: number;
  evaluated_at: string;
}

export interface ActiveOrganizationInstallationAccessStatePayloadV1 extends OrganizationInstallationAccessStateBasePayloadV1 {
  status: "active";
  revocation_reason: null;
  valid_until: string;
}

export interface RevokedOrganizationInstallationAccessStatePayloadV1 extends OrganizationInstallationAccessStateBasePayloadV1 {
  status: "revoked";
  revocation_reason: "membership_revoked" | "installation_revoked";
  valid_until: null;
}

export type OrganizationInstallationAccessStatePayloadV1 =
  | ActiveOrganizationInstallationAccessStatePayloadV1
  | RevokedOrganizationInstallationAccessStatePayloadV1;

export type ActiveOrganizationInstallationAccessStateV1 =
  ActiveOrganizationInstallationAccessStatePayloadV1 & SignedDocument;

export type RevokedOrganizationInstallationAccessStateV1 =
  RevokedOrganizationInstallationAccessStatePayloadV1 & SignedDocument;

export type OrganizationInstallationAccessStateV1 =
  | ActiveOrganizationInstallationAccessStateV1
  | RevokedOrganizationInstallationAccessStateV1;

export type OrganizationInstallationAccessDecisionV1 =
  | {
      permitted: true;
      state: ActiveOrganizationInstallationAccessStateV1;
    }
  | {
      permitted: false;
      state: RevokedOrganizationInstallationAccessStateV1;
    };
