import type {
  FederationId,
  Sha256Digest,
  SignedDocument,
} from "../../product/federation/contracts.js";

/**
 * Public trust descriptor pinned by an authenticated organization setup flow.
 * It is deliberately not self-authenticating: the channel that supplies it is
 * the trust bootstrap for later enrollment and ingest receipts.
 */
export interface OrganizationAuthorityDescriptorV1 {
  schema_version: 1;
  kind: "echo-organization-authority";
  authority_id: FederationId;
  organization_id: FederationId;
  signing_key: {
    key_id: Sha256Digest;
    algorithm: "ecdsa-p256-sha256-der-low-s";
    public_key_spki_der_base64: string;
  };
}

export interface OrganizationEnrollmentRequestV1 extends SignedDocument {
  schema_version: 1;
  kind: "echo-organization-enrollment-request";
  enrollment_grant_sha256: Sha256Digest;
  authority_id: FederationId;
  organization_id: FederationId;
  principal_id: FederationId;
  membership_id: FederationId;
  installation_id: FederationId;
  installation_key_id: Sha256Digest;
  identity_manifest_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  publication_policy_id: FederationId;
  publication_policy_version: number;
  publication_policy_sha256: Sha256Digest;
}

export interface OrganizationEnrollmentReceiptV1 extends SignedDocument {
  schema_version: 1;
  kind: "echo-organization-enrollment-receipt";
  enrollment_id: FederationId;
  authority_id: FederationId;
  authority_key_id: Sha256Digest;
  organization_id: FederationId;
  principal_id: FederationId;
  membership_id: FederationId;
  installation_id: FederationId;
  installation_key_id: Sha256Digest;
  identity_manifest_id: FederationId;
  identity_manifest_sha256: Sha256Digest;
  publication_policy_id: FederationId;
  publication_policy_version: number;
  publication_policy_sha256: Sha256Digest;
  request_sha256: Sha256Digest;
  enrolled_at: string;
}

export type OrganizationBatchReceiptStatus =
  | "accepted"
  | "duplicate"
  | "rejected";

export type OrganizationBatchRejectionReason =
  | "membership_revoked"
  | "installation_revoked";

export interface OrganizationChainHeadV1 {
  last_sequence: number;
  last_event_hash: Sha256Digest | null;
}

export interface OrganizationBatchReceiptV1 extends SignedDocument {
  schema_version: 1;
  kind: "echo-organization-batch-receipt";
  receipt_id: FederationId;
  authority_id: FederationId;
  authority_key_id: Sha256Digest;
  organization_id: FederationId;
  membership_id: FederationId;
  installation_id: FederationId;
  enrollment_receipt_sha256: Sha256Digest;
  batch_sha256: Sha256Digest;
  event_count: number;
  status: OrganizationBatchReceiptStatus;
  reason: OrganizationBatchRejectionReason | null;
  server_received_at: string;
  previous_head: OrganizationChainHeadV1;
  resulting_head: OrganizationChainHeadV1;
}

/** Exact outbox strings are nested as strings so transport JSON cannot
 * silently parse and reserialize a signed envelope. */
export interface OrganizationIngestBatchV1 {
  schema_version: 1;
  kind: "echo-organization-ingest-batch";
  authority_id: FederationId;
  organization_id: FederationId;
  installation_id: FederationId;
  enrollment_receipt_sha256: Sha256Digest;
  events: readonly string[];
}
