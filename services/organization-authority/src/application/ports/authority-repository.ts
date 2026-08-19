import type {
  JsonValue,
  P256SigningKeyDescriptor,
  Sha256Digest,
} from '@echo-brain/federation-protocol';
import type {
  ApproveOrganizationInternalLiveReleaseRequestV1,
  OrganizationAccessLeaseRequestAnyVersion,
  OrganizationInternalLiveReleaseManifestV1,
  OrganizationInternalLiveUpdateReceiptV1,
} from '@echo-brain/organization-api';
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
  /** Null only for rows created before the retry-safe admin API. */
  admin_command_id: string | null;
  /** Canonical hash of the complete admin command, including its target. */
  admin_command_sha256: Sha256Digest | null;
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
  /** Null only for rows created before the retry-safe admin API. */
  admin_command_id: string | null;
  /** Distinct from request_sha256, which names the employee enrollment. */
  admin_command_sha256: Sha256Digest | null;
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
  request: OrganizationAccessLeaseRequestAnyVersion;
  enrollment_id: string;
  previous_access_state_sha256: Sha256Digest;
  resulting_state_sha256: Sha256Digest;
  received_at: string;
}

export interface StoredInternalLiveRelease {
  directive_sequence: number;
  command_id: string;
  command_sha256: Sha256Digest;
  manifest_url: string;
  manifest_sha256: string;
  manifest: OrganizationInternalLiveReleaseManifestV1;
  release_version: string;
  release_tag: string;
  source_sha: string;
  artifact_sha256: string;
  approved_at: string;
}

export interface NewInternalLiveRelease {
  command: ApproveOrganizationInternalLiveReleaseRequestV1;
  command_sha256: Sha256Digest;
  approved_at: string;
}

export interface StoredInternalLiveUpdateReceipt {
  receipt_sequence: number;
  payload_sha256: Sha256Digest;
  receipt: OrganizationInternalLiveUpdateReceiptV1;
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
  detail: JsonValue;
}

export interface StoredAuthorityAuditEntry extends AuthorityAuditEntry {
  audit_sequence: number;
}

export interface AuthorityAdminCounts {
  memberships: number;
  active_memberships: number;
  revoked_memberships: number;
  installations: number;
  active_installations: number;
  revoked_installations: number;
  enrollment_grants: number;
  pending_enrollment_grants: number;
  consumed_enrollment_grants: number;
  expired_enrollment_grants: number;
  audit_entries: number;
}

export const REVIEWER_QUERY_AUDIT_OPERATION =
  'permission.reviewer_recent_decisions_decided' as const;

export const REVIEWER_QUERY_AUDIT_RETENTION_DAYS = 180;

export const READABLE_SEARCH_QUERY_AUDIT_OPERATION =
  'permission.readable_search_decided' as const;

/** Immutable stopped-builder receipt, not a query decision. */
export const READABLE_SEARCH_GENERATION_PUBLISHED_ACTION =
  'permission.readable_search_generation_published' as const;

export const READABLE_SEARCH_QUERY_AUDIT_RETENTION_DAYS = 180;

export const READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION =
  'permission.readable_search_query_audit_export_authorized' as const;

export const READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION =
  'permission.readable_search_query_audit_expired' as const;

export type ReadableSearchQueryAuditControlAction =
  | typeof READABLE_SEARCH_QUERY_AUDIT_EXPORT_ACTION
  | typeof READABLE_SEARCH_QUERY_AUDIT_EXPIRED_ACTION;

export type ReadableSearchQueryAuditDecision = 'allow' | 'deny';

export type ReadableSearchQueryAuditReasonCode =
  | 'active_member_with_scoped_policy_paths'
  | 'installation_access_expired'
  | 'inactive_or_unbound_organization_membership'
  | 'inactive_or_revoked_installation_enrollment';

/** The published pointer has no segment, tuple, count, term, or content data. */
export interface ReadableSearchActiveGenerationPublication {
  organization_id: string;
  generation_id: Sha256Digest;
  manifest_sha256: Sha256Digest;
  retrieval_contract_sha256: Sha256Digest;
  record_head_position: number;
  record_head_hash: Sha256Digest | null;
}

export interface StoredReadableSearchActiveGeneration
  extends ReadableSearchActiveGenerationPublication {
  published_at: string;
}

/** The exact prepared response bytes are hashed and then discarded. */
export interface ReadableSearchQueryAuditEntry {
  decision: ReadableSearchQueryAuditDecision;
  reason_code: ReadableSearchQueryAuditReasonCode;
  detail: JsonValue;
  response_bytes: Uint8Array;
}

export interface StoredReadableSearchQueryAuditEntry {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  operation: typeof READABLE_SEARCH_QUERY_AUDIT_OPERATION;
  decision: ReadableSearchQueryAuditDecision;
  reason_code: ReadableSearchQueryAuditReasonCode;
  detail: JsonValue;
}

/** Immutable generic-audit receipt for one stopped readable-search command. */
export interface StoredReadableSearchQueryAuditControlEvent {
  audit_sequence: number;
  occurred_at: string;
  actor_kind: 'admin';
  action: ReadableSearchQueryAuditControlAction;
  subject_id: string;
  detail_json: string;
}

/** Closed command identity used for retry and cross-action conflict checks. */
export interface ReadableSearchQueryAuditCommandBinding {
  command_id: string;
  action: ReadableSearchQueryAuditControlAction;
  command_sha256: Sha256Digest;
}

export type ReviewerQueryAuditDecision = 'allow' | 'deny';

export type ReviewerQueryAuditReasonCode =
  | 'active_exact_reviewer_membership'
  | 'installation_access_expired'
  | 'inactive_or_unbound_reviewer_membership';

export const REVIEWER_QUERY_AUDIT_EXPORT_ACTION =
  'permission.reviewer_query_audit_export_authorized' as const;

export const REVIEWER_QUERY_AUDIT_EXPIRED_ACTION =
  'permission.reviewer_query_audit_expired' as const;

export type ReviewerQueryAuditControlAction =
  | typeof REVIEWER_QUERY_AUDIT_EXPORT_ACTION
  | typeof REVIEWER_QUERY_AUDIT_EXPIRED_ACTION;

/**
 * One reviewer query decision, as an online caller may state it.
 *
 * There is deliberately no `occurred_at`: the row's time is the transaction's
 * own final time, so an online caller cannot choose when its read happened and
 * therefore cannot choose when the 180-day retention ends.
 */
export interface ReviewerQueryAuditEntry {
  decision: ReviewerQueryAuditDecision;
  reason_code: ReviewerQueryAuditReasonCode;
  detail: JsonValue;
  /**
   * The exact prepared response bytes this decision is about.
   *
   * They are hashed here and compared with the detail's `response_sha256`, then
   * dropped: the audit stores the digest of what was authorized, never the
   * response text. A caller that cannot produce the bytes it is about to send
   * cannot record a response digest at all.
   */
  response_bytes: Uint8Array;
}

/**
 * One stored reviewer query-decision row. It lives in its own table, so the
 * generic admin listing and overview counts cannot see it, and it carries a
 * real Authority-computed retention the governed expiry command enforces.
 *
 * It deliberately does not extend the append input: the ephemeral response
 * bytes are not part of any stored row.
 */
export interface StoredReviewerQueryAuditEntry {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  operation: typeof REVIEWER_QUERY_AUDIT_OPERATION;
  decision: ReviewerQueryAuditDecision;
  reason_code: ReviewerQueryAuditReasonCode;
  detail: JsonValue;
}

/**
 * The stored generic control receipt for one governed maintenance command.
 *
 * This is the exact stored row, including the exact canonical `detail_json`
 * bytes rather than a reparse of them. The baseline generic audit has no entry
 * id and no entry hash, so these six durable fields are the whole receipt, and
 * a future operator service must be able to reproduce them byte for byte.
 */
export interface StoredReviewerQueryAuditControlEvent {
  audit_sequence: number;
  occurred_at: string;
  actor_kind: 'admin';
  action: ReviewerQueryAuditControlAction;
  subject_id: string;
  detail_json: string;
}

/**
 * The receipt a governed command asks for. Its action is not here: the action
 * belongs to the command binding the maintenance entrypoint was opened with, so
 * one command can never append a receipt for the other operation.
 */
export interface ReviewerQueryAuditControlEventInput {
  /** The owner membership. `actor_kind` and the time are not caller-chosen. */
  subject_id: string;
  detail: JsonValue;
}

/**
 * The closed identity of one governed maintenance command.
 *
 * All three parts are compared before a stored receipt is exposed as an exact
 * retry, so the same `qac_*` id under another operation or over other command
 * bytes is a terminal conflict rather than a replayed disclosure.
 */
export interface ReviewerQueryAuditCommandBinding {
  command_id: string;
  action: ReviewerQueryAuditControlAction;
  /** Canonical hash of the complete validated command, including its kind. */
  command_sha256: Sha256Digest;
}

/** Exact Authority person tuple; never inferred from an OIDC email claim. */
export interface AuthorityPersonMembershipBinding {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
}

export interface StoredOidcIdentityBinding
  extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  issuer: string;
  subject: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  initial_login_attempt_id: string;
  initial_login_grant_sha256: Sha256Digest;
  status: 'active' | 'revoked';
  bound_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewOidcIdentityBinding = Omit<
  StoredOidcIdentityBinding,
  'status' | 'bound_at' | 'revoked_at' | 'revocation_reason'
>;

/**
 * An application-sealed PKCE verifier envelope. A raw byte array cannot be
 * supplied where durable, authenticated ciphertext is required.
 */
export interface SealedPkceVerifier {
  key_id: string;
  sealed_bytes: Uint8Array;
}

export type OidcLoginAttemptTerminalOutcome =
  | 'succeeded'
  | 'denied'
  | 'expired';

export interface StoredOidcLoginAttempt {
  login_attempt_id: string;
  issuer: string;
  attempt_purpose: 'identity_bootstrap' | 'existing_identity_login';
  client_id: string;
  redirect_uri: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  /** Null when an already-bound identity starts the attempt. */
  login_grant_sha256: Sha256Digest | null;
  state_sha256: Sha256Digest;
  nonce_sha256: Sha256Digest;
  pkce_verifier_seal_key_id: string | null;
  /** Ciphertext/sealed bytes only. The repository never accepts a verifier. */
  pkce_verifier_sealed: Uint8Array | null;
  created_at: string;
  expires_at: string;
  redemption_claim_id: string | null;
  redemption_claimed_at: string | null;
  terminal_outcome: OidcLoginAttemptTerminalOutcome | null;
  completed_at: string | null;
  resolved_identity_binding_id: string | null;
  upstream_assertion_issued_at: string | null;
}

export type NewOidcLoginAttempt = Omit<
  StoredOidcLoginAttempt,
  | 'created_at'
  | 'terminal_outcome'
  | 'redemption_claim_id'
  | 'redemption_claimed_at'
  | 'completed_at'
  | 'resolved_identity_binding_id'
  | 'upstream_assertion_issued_at'
  | 'pkce_verifier_seal_key_id'
  | 'pkce_verifier_sealed'
> & {
  sealed_pkce_verifier: SealedPkceVerifier;
};

export type OidcLoginAttemptCompletion =
  | {
      outcome: 'succeeded';
      resolved_identity_binding_id: string;
      upstream_assertion_issued_at: string;
    }
  | { outcome: 'denied' };

export interface StoredPersonLoginGrant
  extends AuthorityPersonMembershipBinding {
  login_grant_sha256: Sha256Digest;
  grant_purpose: 'oidc_identity_bootstrap';
  /** Exact issuer this bootstrap grant permits; no subject is known yet. */
  expected_issuer: string;
  /** Domain-separated digest of the canonical invited work email. */
  expected_email_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export type NewPersonLoginGrant = Omit<
  StoredPersonLoginGrant,
  'issued_at' | 'consumed_at'
>;

export interface StoredPersonSessionFamily
  extends AuthorityPersonMembershipBinding {
  session_family_id: string;
  identity_binding_id: string;
  authentication_login_attempt_id: string;
  created_at: string;
  upstream_assertion_issued_at: string;
  tenant_constraint_sha256: Sha256Digest;
  oidc_configuration_sha256: Sha256Digest;
  hard_reauthentication_at: string;
  status: 'active' | 'revoked';
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewPersonSessionFamily = Omit<
  StoredPersonSessionFamily,
  'created_at' | 'status' | 'revoked_at' | 'revocation_reason'
>;

export type PersonSessionCredentialKind = 'access' | 'refresh';

export interface StoredPersonSessionCredential {
  session_credential_id: string;
  session_family_id: string;
  credential_kind: PersonSessionCredentialKind;
  rotation_sequence: number;
  token_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
  /** Non-null only after a refresh credential has been used for rotation. */
  consumed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type NewPersonSessionCredential = Omit<
  StoredPersonSessionCredential,
  'issued_at' | 'consumed_at' | 'revoked_at' | 'revocation_reason'
>;

export const PERSON_READ_DECISION_AUDIT_RETENTION_DAYS = 180;

export type PersonReadOperation =
  | 'recent_decisions'
  | 'reviewer_recent_decisions'
  | 'readable_search';

export type PersonReadDecisionReasonCode =
  | 'active_person_session'
  | 'person_or_session_inactive'
  | 'caller_subject_mismatch'
  | 'authorization_state_changed'
  | 'operation_not_permitted';

export interface PersonReadAuthenticatedEvidence
  extends AuthorityPersonMembershipBinding {
  identity_binding_id: string;
  session_family_id: string;
  access_credential_sha256: Sha256Digest;
  /**
   * Start denies retain the stage-1 session caller receipt. Final decisions
   * made after a readable-search scope opens retain its stage-2 scope receipt,
   * which nests stage 1 with generation, head, contracts, and segments.
   */
  caller_binding_sha256: Sha256Digest;
  person_state_sha256: Sha256Digest;
  session_state_sha256: Sha256Digest;
}

interface PersonReadDecisionAuditInputBase {
  operation: PersonReadOperation;
  /** SHA-256 of the operation's validated canonical request bytes. */
  request_sha256: Sha256Digest;
  /** Exact prepared response bytes. Only their SHA-256 is retained. */
  response_bytes: Uint8Array;
  asserted_subject_principal_id: string;
}

export type PersonReadDecisionAuditEntry = PersonReadDecisionAuditInputBase &
  (
    | {
        decision: 'allow';
        reason_code: 'active_person_session';
        authenticated: PersonReadAuthenticatedEvidence;
      }
    | {
        decision: 'deny';
        reason_code: 'person_or_session_inactive';
        authenticated: PersonReadAuthenticatedEvidence | null;
      }
    | {
        decision: 'deny';
        reason_code:
          | 'caller_subject_mismatch'
          | 'authorization_state_changed'
          | 'operation_not_permitted';
        authenticated: PersonReadAuthenticatedEvidence;
      }
  );

export interface StoredPersonReadDecisionAudit {
  audit_sequence: number;
  occurred_at: string;
  retain_until: string;
  authority_id: string;
  organization_id: string;
  operation: PersonReadOperation;
  request_sha256: Sha256Digest;
  response_sha256: Sha256Digest;
  asserted_subject_principal_id: string;
  decision: 'allow' | 'deny';
  reason_code: PersonReadDecisionReasonCode;
  authenticated: PersonReadAuthenticatedEvidence | null;
}

export interface MemberExclusionOwnerSource {
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  source_adapter_id: string;
  source_instance_id: string;
}

export type StoredMemberExclusionSelector =
  | {
      scope: 'source';
      source_adapter_id: string;
      source_instance_id: string;
    }
  | {
      scope: 'meeting';
      source_adapter_id: string;
      source_instance_id: string;
      external_id: string;
    };

interface MemberExclusionReadAuditInputBase {
  request_sha256: Sha256Digest;
  response_bytes: Uint8Array;
  result_count: number;
}

export type MemberExclusionReadAuditEntry =
  | (MemberExclusionReadAuditInputBase & {
      actor_kind: 'person';
      asserted_subject_principal_id: string;
      decision: 'allow';
      reason_code: 'active_person_session';
      authenticated: PersonReadAuthenticatedEvidence;
    })
  | (MemberExclusionReadAuditInputBase & {
      actor_kind: 'person';
      asserted_subject_principal_id: string;
      decision: 'deny';
      reason_code: 'person_or_session_inactive';
      authenticated: PersonReadAuthenticatedEvidence | null;
    })
  | (MemberExclusionReadAuditInputBase & {
      actor_kind: 'person';
      asserted_subject_principal_id: string;
      decision: 'deny';
      reason_code:
        | 'caller_subject_mismatch'
        | 'authorization_state_changed'
        | 'operation_not_permitted';
      authenticated: PersonReadAuthenticatedEvidence;
    })
  | (MemberExclusionReadAuditInputBase & {
      actor_kind: 'admin_break_glass';
      actor_binding_sha256: Sha256Digest;
      decision: 'allow';
      reason_code: 'break_glass_authorized';
    })
  | (MemberExclusionReadAuditInputBase & {
      actor_kind: 'admin_break_glass';
      actor_binding_sha256: Sha256Digest;
      decision: 'deny';
      reason_code: 'break_glass_target_unavailable';
    });

export interface AuthorityReadTransaction {
  metadata(): StoredAuthorityMetadata;
  membership(membershipId: string): StoredAuthorityMembership | undefined;
  membershipByAdminCommand(
    commandId: string,
  ): StoredAuthorityMembership | undefined;
  membershipsAfter(
    membershipId: string | undefined,
    limit: number,
  ): StoredAuthorityMembership[];
  grant(grantSha256: Sha256Digest): StoredEnrollmentGrant | undefined;
  grantByAdminCommand(commandId: string): StoredEnrollmentGrant | undefined;
  grantsAfter(
    grantSha256: Sha256Digest | undefined,
    limit: number,
  ): StoredEnrollmentGrant[];
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
  enrollmentsAfter(
    enrollmentId: string | undefined,
    limit: number,
  ): StoredAuthorityEnrollment[];
  activeEnrollments(limit: number): StoredAuthorityEnrollment[];
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
  internalLiveReleaseByCommand(
    commandId: string,
  ): StoredInternalLiveRelease | undefined;
  internalLiveReleaseBySequence(
    directiveSequence: number,
  ): StoredInternalLiveRelease | undefined;
  currentInternalLiveRelease(): StoredInternalLiveRelease | undefined;
  internalLiveUpdateReceiptByTransaction(
    transactionId: string,
  ): StoredInternalLiveUpdateReceipt | undefined;
  latestInternalLiveUpdateReceipt(
    installationId: string,
    directiveSequence: number,
  ): StoredInternalLiveUpdateReceipt | undefined;
  recentAuditBefore(
    auditSequence: number | undefined,
    limit: number,
  ): StoredAuthorityAuditEntry[];
  adminCounts(now: string): AuthorityAdminCounts;
  oidcIdentityBinding(
    issuer: string,
    subject: string,
  ): StoredOidcIdentityBinding | undefined;
  oidcIdentityBindingById(
    identityBindingId: string,
  ): StoredOidcIdentityBinding | undefined;
  oidcLoginAttempt(
    stateSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined;
  oidcLoginAttemptForLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredOidcLoginAttempt | undefined;
  personLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined;
  personSessionFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionFamily | undefined;
  personSessionCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined;
  personSessionCredentialsForFamily(
    sessionFamilyId: string,
  ): StoredPersonSessionCredential[];
  /** Returns `undefined` unless this exact source has this active owner. */
  memberExclusionsForOwnerSource(
    source: MemberExclusionOwnerSource,
  ): readonly StoredMemberExclusionSelector[] | undefined;
  /** `null` is the clean, never-built state; corruption throws. */
  activeReadableSearchGeneration(): StoredReadableSearchActiveGeneration | null;
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
  insertInternalLiveRelease(release: NewInternalLiveRelease): void;
  insertInternalLiveUpdateReceipt(
    receipt: Omit<StoredInternalLiveUpdateReceipt, 'receipt_sequence'>,
  ): void;
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
  insertOidcIdentityBinding(
    binding: NewOidcIdentityBinding,
  ): StoredOidcIdentityBinding;
  revokeOidcIdentityBinding(
    identityBindingId: string,
    reason: string,
  ): boolean;
  insertOidcLoginAttempt(
    attempt: NewOidcLoginAttempt,
  ): StoredOidcLoginAttempt;
  claimOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): StoredOidcLoginAttempt | undefined;
  releaseOidcLoginAttemptClaim(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
  ): boolean;
  completeOidcLoginAttempt(
    stateSha256: Sha256Digest,
    redemptionClaimId: string,
    completion: OidcLoginAttemptCompletion,
  ): StoredOidcLoginAttempt | undefined;
  /** Scrubs at most `limit` pending attempts whose exact expiry has passed. */
  expireOidcLoginAttempts(limit: number): number;
  insertPersonLoginGrant(
    grant: NewPersonLoginGrant,
  ): StoredPersonLoginGrant;
  consumePersonLoginGrant(
    loginGrantSha256: Sha256Digest,
  ): StoredPersonLoginGrant | undefined;
  insertPersonSessionFamily(
    family: NewPersonSessionFamily,
  ): StoredPersonSessionFamily;
  insertPersonSessionCredential(
    credential: NewPersonSessionCredential,
  ): StoredPersonSessionCredential;
  consumePersonSessionRefreshCredential(
    tokenSha256: Sha256Digest,
  ): StoredPersonSessionCredential | undefined;
  revokePersonSessionCredential(
    tokenSha256: Sha256Digest,
    reason: string,
  ): boolean;
  /** Revokes the family and every still-unrevoked credential atomically. */
  revokePersonSessionFamily(
    sessionFamilyId: string,
    reason: string,
  ): boolean;
  /** Appends one isolated V2 Person read decision at the transaction time. */
  appendPersonReadDecisionAudit(
    entry: PersonReadDecisionAuditEntry,
  ): StoredPersonReadDecisionAudit;
  /** Appends minimized INV-10 evidence; exclusion coordinates are never stored. */
  appendMemberExclusionReadAudit(entry: MemberExclusionReadAuditEntry): void;
  appendAudit(entry: AuthorityAuditEntry): void;
  /**
   * Appends one reviewer query decision at this transaction's own final time.
   *
   * Both `occurred_at` and `retain_until` are derived from that time, so an
   * online caller can neither forge when its read happened nor shorten the
   * Authority-computed 180-day retention.
   */
  appendReviewerQueryAudit(
    entry: ReviewerQueryAuditEntry,
  ): StoredReviewerQueryAuditEntry;
  /** Replaces the singleton pointer at this transaction's own final time. */
  publishReadableSearchActiveGeneration(
    publication: ReadableSearchActiveGenerationPublication,
  ): StoredReadableSearchActiveGeneration;
  /** Appends one isolated readable-search authorization decision. */
  appendReadableSearchQueryAudit(
    entry: ReadableSearchQueryAuditEntry,
  ): StoredReadableSearchQueryAuditEntry;
}

export interface InitializeAuthorityRepositoryInput {
  descriptor: OrganizationAuthorityDescriptorV1;
  authority_pin_sha256: Sha256Digest;
  organization_display_name: string;
  initialized_at: string;
}

export interface OrganizationAuthorityRepository {
  initialize(input: InitializeAuthorityRepositoryInput): void;
  read<T>(operation: (transaction: AuthorityReadTransaction) => T): T;
  write<T>(
    observedAt: string,
    operation: (transaction: AuthorityWriteTransaction) => T,
  ): T;
  /** Acquires the write fence, then samples the write time exactly once. */
  writeAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: AuthorityWriteTransaction,
      observedAt: string,
    ) => T,
  ): T;
  close(): void;
}
