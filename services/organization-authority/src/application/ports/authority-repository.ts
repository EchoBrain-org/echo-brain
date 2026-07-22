import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
} from '@echo-brain/organization-protocol';

export interface StoredAuthorityMetadata {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: Sha256Digest;
  descriptor: OrganizationAuthorityDescriptorV1;
  created_at: string;
  last_observed_at: string;
}

export interface StoredAuthorityMembership {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: OrganizationMembershipTypeV1;
  status: 'active' | 'revoked';
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export interface StoredEnrollmentGrant {
  grant_sha256: Sha256Digest;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  request_sha256: Sha256Digest | null;
}

export interface StoredAuthorityEnrollment {
  enrollment_id: string;
  grant_sha256: Sha256Digest;
  request_sha256: Sha256Digest;
  request: OrganizationEnrollmentRequestV1;
  receipt_sha256: Sha256Digest;
  receipt: OrganizationEnrollmentReceiptV1;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  status: 'active' | 'revoked';
  enrolled_at: string;
  revoked_at: string | null;
  revocation_kind: 'membership_revoked' | 'installation_revoked' | null;
  revocation_reason: string | null;
}

export interface StoredAuthorityAccessState {
  enrollment_id: string;
  state_sha256: Sha256Digest;
  state: OrganizationInstallationAccessStateV1;
}

export interface StoredAccessLeaseRequest {
  request_id: string;
  request_sha256: Sha256Digest;
  request_json: string;
  enrollment_id: string;
  previous_access_state_sha256: Sha256Digest;
  resulting_state_sha256: Sha256Digest;
  received_at: string;
}

export interface NewAuthorityEnrollment {
  enrollment: StoredAuthorityEnrollment;
  initial_access_state: StoredAuthorityAccessState;
}

export interface AuthorityAuditEntry {
  occurred_at: string;
  actor_kind: 'admin' | 'enrollment_grant' | 'installation';
  action: string;
  subject_id: string;
  detail_json: string;
}

export interface AuthorityReadTransaction {
  metadata(): StoredAuthorityMetadata;
  membership(membershipId: string): StoredAuthorityMembership | undefined;
  grant(grantSha256: Sha256Digest): StoredEnrollmentGrant | undefined;
  enrollmentByGrant(
    grantSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined;
  enrollmentByRequest(
    requestSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined;
  enrollmentById(enrollmentId: string): StoredAuthorityEnrollment | undefined;
  enrollmentByInstallation(
    installationId: string,
  ): StoredAuthorityEnrollment | undefined;
  enrollmentByKey(keyId: Sha256Digest): StoredAuthorityEnrollment | undefined;
  enrollmentsForMembership(membershipId: string): StoredAuthorityEnrollment[];
  currentAccessState(
    enrollmentId: string,
  ): StoredAuthorityAccessState | undefined;
  accessState(
    enrollmentId: string,
    accessStateSequence: number,
  ): StoredAuthorityAccessState | undefined;
  accessLeaseRequestByDigest(
    requestSha256: Sha256Digest,
  ): StoredAccessLeaseRequest | undefined;
  accessLeaseRequestById(
    enrollmentId: string,
    requestId: string,
  ): StoredAccessLeaseRequest | undefined;
  accessStateByDigest(
    stateSha256: Sha256Digest,
  ): StoredAuthorityAccessState | undefined;
}

export interface AuthorityWriteTransaction extends AuthorityReadTransaction {
  insertMembership(membership: StoredAuthorityMembership): void;
  insertGrant(grant: StoredEnrollmentGrant): void;
  insertEnrollment(value: NewAuthorityEnrollment): void;
  consumeGrant(
    grantSha256: Sha256Digest,
    requestSha256: Sha256Digest,
    consumedAt: string,
  ): boolean;
  insertAccessState(state: StoredAuthorityAccessState): void;
  insertAccessLeaseRequest(request: StoredAccessLeaseRequest): void;
  revokeMembership(
    membershipId: string,
    revokedAt: string,
    reason: string,
  ): boolean;
  revokeEnrollment(
    enrollmentId: string,
    revokedAt: string,
    kind: 'membership_revoked' | 'installation_revoked',
    reason: string,
  ): boolean;
  appendAudit(entry: AuthorityAuditEntry): void;
}

export interface InitializeAuthorityRepositoryInput {
  descriptor: OrganizationAuthorityDescriptorV1;
  authority_pin_sha256: Sha256Digest;
  organization_display_name: string;
  maximum_active_lease_ttl_ms: number;
  initialized_at: string;
}

export interface OrganizationAuthorityRepository {
  initialize(input: InitializeAuthorityRepositoryInput): void;
  read<T>(operation: (transaction: AuthorityReadTransaction) => T): T;
  write<T>(
    observedAt: string,
    operation: (transaction: AuthorityWriteTransaction) => T,
  ): T;
  close(): void;
}
