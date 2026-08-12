import { Buffer } from 'node:buffer';
import {
  assertFederationId,
  assertP256LowS,
  canonicalJson,
  canonicalSha256,
  createSignedDocumentWithKey,
  sha256Digest,
  verifyP256LowSSignature,
  verifyP256SigningKeyDescriptor,
  verifySignedDocument,
} from '@echo-brain/federation-protocol';
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
  SignedIntegrity,
} from '@echo-brain/federation-protocol';
import {
  compareOrganizationInternalLiveReleaseVersions,
  isOrganizationApiValidationError,
  MINIMUM_ORGANIZATION_ACCESS_RECOVERY_GAP,
  validateApproveOrganizationInternalLiveReleaseRequest,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateOrganizationAccessLeaseRequest,
  validateOrganizationInternalLiveDirectiveRequest,
  validateOrganizationInternalLiveUpdateReceipt,
  validateOrganizationPermissionCheckRequest,
  validateOrganizationReadableSearchRequest,
  validateOrganizationRecentDecisionsRequest,
  validateOrganizationReviewerRecentDecisionsRequest,
  validateOrganizationReviewerPermissionCheckRequest,
  validateOrganizationMemberReadablePermissionCheckRequest,
  validateProvisionOrganizationMembershipRequest,
  validateRecoverOrganizationInstallationAccessRequest,
} from '@echo-brain/organization-api';
import type {
  IssueOrganizationEnrollmentGrantRequestV1,
  ApproveOrganizationInternalLiveReleaseRequestV1,
  OrganizationAccessLeaseRequestV1,
  OrganizationAdminOverviewV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationInternalLiveDirectiveRequestV1,
  OrganizationInternalLiveRolloutStatusV1,
  OrganizationInternalLiveUpdateDirectiveV1,
  OrganizationInternalLiveUpdateReceiptV1,
  OrganizationMembershipPageV1,
  OrganizationPermissionCheckRequestV1,
  OrganizationReadableSearchRequestV1,
  OrganizationRecentDecisionsRequestV1,
  OrganizationReviewerRecentDecisionsRequestV1,
  OrganizationReviewerPermissionCheckRequestV2,
  OrganizationMemberReadablePermissionCheckRequestV3,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RecoverOrganizationInstallationAccessRequestV1,
  RecoveredOrganizationInstallationAccessV1,
} from '@echo-brain/organization-api';
import {
  createOrganizationEnrollmentReceipt,
  createOrganizationInstallationAccessState,
  organizationAuthorityPublicKey,
  organizationEnrollmentGrantSha256,
  organizationEnrollmentReceiptSha256,
  organizationEnrollmentRequestSha256,
  validateOrganizationAuthorityDescriptor,
  validateOrganizationRecordReceipt,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationRecordEnvelope,
} from '@echo-brain/organization-protocol';
import type {
  ActiveOrganizationInstallationAccessStateV1,
  OrganizationAuthorityDescriptorV1,
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessStateV1,
  OrganizationRecordEnvelopeAnyVersion,
  OrganizationRecordReceiptPayloadV1,
  OrganizationRecordReceiptV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import {
  AuthorityOperationError,
  StaleAccessStateError,
} from '../domain/errors.js';
import {
  addMilliseconds,
  assertConfiguredLeaseTtl,
  assertConfiguredRequestAge,
  assertDisplayName,
  assertFreshAccessRequest,
  assertFreshInstallationRequest,
  assertGrantLifetimeSeconds,
  assertMembershipType,
  assertRevocationReason,
  MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS,
  timestampMillis,
} from '../domain/rules.js';
import type {
  AuthorityReadTransaction,
  AuthorityWriteTransaction,
  OrganizationAuthorityRepository,
  StoredAccessLeaseRequest,
  StoredAuthorityAccessState,
  StoredAuthorityEnrollment,
  StoredAuthorityMembership,
  StoredEnrollmentGrant,
  StoredInternalLiveRelease,
  StoredReadableSearchActiveGeneration,
} from './ports/authority-repository.js';
import type {
  AuthorityClock,
  AuthorityIdentifierGenerator,
  OrganizationAuthoritySigner,
} from './ports/runtime-ports.js';
import {
  OrganizationAuthorityAdminQueries,
  type AdminPageRequest,
} from './admin-queries.js';
import {
  fixedRecentDecisionsErrorBytes,
  OrganizationRecentDecisionsError,
  prepareAllowedRecentDecisionsResponse,
  validateRecentDecisionsPilotActivation,
} from './recent-decisions.js';
import {
  prepareReviewerRecentDecisionsResponse,
  preparedReviewerDenial,
  reviewerAllowAuditDetail,
  reviewerDenialAuditDetail,
  ReviewerRecentDecisionsError,
} from './reviewer-recent-decisions.js';
import type {
  PreparedReviewerRecentDecisionsResponse,
  ReviewerDenialReasonCode,
  ReviewerResolvedItem,
} from './reviewer-recent-decisions.js';
import type {
  OrganizationRecentDecisionsPilotActivation,
  OrganizationRecentDecisionsProjectedRecord,
  PreparedOrganizationRecentDecisionsResponse,
} from './recent-decisions.js';
import {
  ReadableSearchError,
  type ReadableSearchAuthorityStatePort,
  type ReadableSearchAuthenticatedRequest,
  type ReadableSearchCurrentPerson,
  type ReadableSearchGenerationBinding,
  type ReadableSearchScope,
} from './readable-search.js';

const MAX_TRANSITION_RETRIES = 16;

export interface IssuedEnrollmentGrant {
  authority_id: string;
  authority_pin_sha256: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  enrollment_grant_sha256: Sha256Digest;
  issued_at: string;
  expires_at: string;
}

export interface CompletedEnrollment {
  enrollment_receipt: OrganizationEnrollmentReceiptV1;
  access_state: OrganizationInstallationAccessStateV1;
}

export interface RevokedMembershipResult {
  membership: StoredAuthorityMembership;
  installations: Array<{
    installation_id: string;
    access_state: OrganizationInstallationAccessStateV1;
  }>;
}

export interface OrganizationPermissionAuthorityTarget {
  principal_id: string;
  membership_id: string;
}

export interface OrganizationPermissionAuthorityStatus {
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: Sha256Digest;
  installation_principal_id: string;
  installation_membership_id: string;
  installation_active: boolean;
  target_principal_id: string | null;
  target_membership_id: string | null;
  target_active: boolean | null;
  evaluated_at: string;
}

export interface OrganizationIntegrationAdminContext {
  administrator: {
    principal_id: string;
    membership_id: string;
  };
  target: {
    principal_id: string;
    membership_id: string;
  };
  installation: {
    principal_id: string;
    membership_id: string;
    installation_id: string;
    installation_key_id: Sha256Digest;
  };
  checked_at: string;
}

export interface OrganizationIntegrationOwnerContext {
  administrator: {
    principal_id: string;
    membership_id: string;
  };
  checked_at: string;
}

export interface InstallationSignedCommand {
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  installation_key_id: Sha256Digest;
  integrity: SignedIntegrity;
}

export interface OrganizationIntegrationInstallationContext {
  request_sha256: Sha256Digest;
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_key_id: Sha256Digest;
  checked_at: string;
}

/**
 * The live installation facts organization-record ingest needs before it may
 * append: an active enrollment, an active membership, an unexpired access
 * lease, and the installation signing key the envelope must be signed with.
 *
 * This is deliberately narrower than
 * `OrganizationIntegrationInstallationContext`. A record envelope is not an
 * installation-signed *command* — it carries no `authority_key_id`,
 * `enrollment_id`, or `installation_key_id` at the top level, because those
 * would be extra frozen bytes in every log record forever. The signature over
 * the whole envelope is verified against the key returned here, so the binding
 * is the same one `authenticateInstallationCommand` makes, read from durable
 * enrollment state rather than from the document.
 */
export interface OrganizationRecordInstallationContext {
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
  checked_at: string;
}

interface RecentDecisionsPersonState {
  membership_id: string;
  principal_id: string;
  membership_status: 'active' | 'revoked';
  enrollment_id: string;
  enrollment_status: 'active' | 'revoked';
  installation_id: string;
  installation_key_id: Sha256Digest;
  access_state_sequence: number;
  access_state_sha256: Sha256Digest;
  access_status: 'active' | 'revoked';
  access_valid_until: string | null;
  checked_at: string;
}

type RecentDecisionsPersonDecision = 'eligible' | 'expired' | 'not_found';

interface RecentDecisionsPersonSnapshot {
  readonly state: RecentDecisionsPersonState;
  readonly state_sha256: Sha256Digest;
  readonly decision: RecentDecisionsPersonDecision;
  readonly governed_reason:
    | 'active_bound_pilot_membership'
    | 'installation_access_expired'
    | 'inactive_or_unbound_pilot_membership';
}

interface AuthenticatedRecentDecisionsRequest {
  readonly request: OrganizationRecentDecisionsRequestV1;
  readonly request_sha256: Sha256Digest;
  readonly activation: OrganizationRecentDecisionsPilotActivation;
}

interface ReviewerRecentDecisionsPersonState {
  membership_id: string;
  principal_id: string;
  membership_status: 'active' | 'revoked';
  enrollment_id: string;
  enrollment_status: 'active' | 'revoked';
  installation_id: string;
  installation_key_id: Sha256Digest;
  access_state_sequence: number;
  access_state_sha256: Sha256Digest;
  access_status: 'active' | 'revoked';
  access_valid_until: string | null;
  checked_at: string;
}

type ReviewerRecentDecisionsPersonDecision =
  | 'eligible'
  | 'expired'
  | 'not_found';

interface ReviewerRecentDecisionsPersonSnapshot {
  readonly state: ReviewerRecentDecisionsPersonState;
  readonly state_sha256: Sha256Digest;
  readonly decision: ReviewerRecentDecisionsPersonDecision;
  readonly governed_reason:
    | 'active_exact_reviewer_membership'
    | ReviewerDenialReasonCode;
}

interface AuthenticatedReviewerRecentDecisionsRequest {
  readonly request: OrganizationReviewerRecentDecisionsRequestV1;
  readonly request_sha256: Sha256Digest;
}

export interface ReviewerRecentDecisionsSourceInput {
  readonly request_sha256: Sha256Digest;
  readonly reviewer_principal_id: string;
  readonly reviewer_membership_id: string;
}

export interface ReviewerRecentDecisionsSourceOutput {
  readonly items: readonly ReviewerResolvedItem[];
  readonly record_head: {
    readonly position: number;
    readonly record_hash: Sha256Digest | null;
  };
}

/**
 * Composition owns the record runtime.  This is the only read the Authority
 * needs from it at the final authorization linearization point.
 */
export interface ReadableSearchRecordHeadVerifier {
  stillMatches(binding: ReadableSearchGenerationBinding): boolean;
}

export interface CreateOrganizationAuthorityApplicationOptions {
  repository: OrganizationAuthorityRepository;
  signer: OrganizationAuthoritySigner;
  clock: AuthorityClock;
  identifiers: AuthorityIdentifierGenerator;
  independently_trusted_authority_pin: Sha256Digest;
  organization_display_name: string;
  active_lease_ttl_ms: number;
  access_request_maximum_age_ms: number;
}

function sameDescriptor(
  left: OrganizationAuthorityDescriptorV1,
  right: OrganizationAuthorityDescriptorV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireCurrentAccessState(
  transaction: AuthorityReadTransaction,
  enrollmentId: string,
): StoredAuthorityAccessState {
  const state = transaction.currentAccessState(enrollmentId);
  if (state === undefined) {
    throw new Error('authority enrollment has no access-state high watermark');
  }
  return state;
}

function requireEnrollment(
  transaction: AuthorityReadTransaction,
  enrollmentId: string,
): StoredAuthorityEnrollment {
  const enrollment = transaction.enrollmentById(enrollmentId);
  if (enrollment === undefined) {
    throw new AuthorityOperationError('not_found', 'enrollment was not found');
  }
  return enrollment;
}

function canRecoverExpiredStaleAccessHead(input: {
  namedPrevious: StoredAuthorityAccessState;
  current: StoredAuthorityAccessState;
  commandRequestedAtMillis: number;
  authorityReceivedAtMillis: number;
}): boolean {
  if (
    input.namedPrevious.state.status !== 'active' ||
    input.current.state.status !== 'active' ||
    input.namedPrevious.state.access_state_sequence + 1 !==
      input.current.state.access_state_sequence
  ) {
    return false;
  }
  const currentEvaluatedAtMillis = timestampMillis(
    input.current.state.evaluated_at,
    'current access state evaluation time',
  );
  const recoveryNotBeforeMillis =
    currentEvaluatedAtMillis + MAX_AUTHORITY_ACCESS_REQUEST_AGE_MS;
  return (
    timestampMillis(
      input.current.state.valid_until,
      'current access state expiry',
    ) <= input.authorityReceivedAtMillis &&
    input.authorityReceivedAtMillis > recoveryNotBeforeMillis &&
    input.commandRequestedAtMillis > recoveryNotBeforeMillis
  );
}

function recoveredInstallationAccess(input: {
  installation_id: string;
  changed: boolean;
  local_access_state_sequence: number;
  state: ActiveOrganizationInstallationAccessStateV1;
}): RecoveredOrganizationInstallationAccessV1 {
  return {
    installation_id: input.installation_id,
    changed: input.changed,
    local_access_state_sequence: input.local_access_state_sequence,
    access_state_sequence: input.state.access_state_sequence,
    valid_until: input.state.valid_until,
  };
}

export class OrganizationAuthorityApplication {
  private readonly adminQueries: OrganizationAuthorityAdminQueries;

  private constructor(
    private readonly repository: OrganizationAuthorityRepository,
    private readonly signer: OrganizationAuthoritySigner,
    private readonly clock: AuthorityClock,
    private readonly identifiers: AuthorityIdentifierGenerator,
    private readonly descriptorValue: OrganizationAuthorityDescriptorV1,
    private readonly pinnedAuthority: PinnedOrganizationAuthority,
    private readonly activeLeaseTtlMs: number,
    private readonly accessRequestMaximumAgeMs: number,
  ) {
    this.adminQueries = new OrganizationAuthorityAdminQueries(
      repository,
      clock,
    );
  }

  static async create(
    options: CreateOrganizationAuthorityApplicationOptions,
  ): Promise<OrganizationAuthorityApplication> {
    assertConfiguredLeaseTtl(options.active_lease_ttl_ms);
    assertConfiguredRequestAge(options.access_request_maximum_age_ms);
    assertDisplayName(options.organization_display_name);
    const descriptor = validateOrganizationAuthorityDescriptor(
      await options.signer.inspect(),
    );
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      descriptor,
      options.independently_trusted_authority_pin,
    );
    const initializedAt = options.clock.now();
    timestampMillis(initializedAt, 'authority initialization time');
    options.repository.initialize({
      descriptor,
      authority_pin_sha256: options.independently_trusted_authority_pin,
      organization_display_name: options.organization_display_name,
      maximum_active_lease_ttl_ms: options.active_lease_ttl_ms,
      initialized_at: initializedAt,
    });
    return new OrganizationAuthorityApplication(
      options.repository,
      options.signer,
      options.clock,
      options.identifiers,
      descriptor,
      pinnedAuthority,
      options.active_lease_ttl_ms,
      options.access_request_maximum_age_ms,
    );
  }

  descriptor(): OrganizationAuthorityDescriptorV1 {
    return JSON.parse(
      canonicalJson(this.descriptorValue),
    ) as OrganizationAuthorityDescriptorV1;
  }

  authorityPinSha256(): Sha256Digest {
    return this.pinnedAuthority.authority_pin_sha256;
  }

  adminOverview(): OrganizationAdminOverviewV1 {
    return this.adminQueries.overview();
  }

  listMemberships(request?: AdminPageRequest): OrganizationMembershipPageV1 {
    return this.adminQueries.memberships(request);
  }

  listInstallations(
    request?: AdminPageRequest,
  ): OrganizationInstallationPageV1 {
    return this.adminQueries.installations(request);
  }

  listEnrollmentGrants(
    request?: AdminPageRequest,
  ): OrganizationEnrollmentGrantPageV1 {
    return this.adminQueries.enrollmentGrants(request);
  }

  listAudit(request?: AdminPageRequest): OrganizationAuditPageV1 {
    return this.adminQueries.audit(request);
  }

  integrationOwnerContext(
    administratorMembershipId: string,
  ): OrganizationIntegrationOwnerContext {
    this.assertIntegrationIdentifiers([
      [
        administratorMembershipId,
        'mem',
        'integration administrator membership',
      ],
    ]);
    const checkedAt = this.now('organization integration administrator check');
    return this.repository.read((transaction) => {
      const administrator = this.activeIntegrationOwner(
        transaction,
        administratorMembershipId,
      );
      return {
        administrator: {
          principal_id: administrator.principal_id,
          membership_id: administrator.membership_id,
        },
        checked_at: checkedAt,
      };
    });
  }

  integrationAdminContext(
    administratorMembershipId: string,
    targetMembershipId: string,
    installationId: string,
  ): OrganizationIntegrationAdminContext {
    this.assertIntegrationIdentifiers([
      [
        administratorMembershipId,
        'mem',
        'integration administrator membership',
      ],
      [targetMembershipId, 'mem', 'integration target membership'],
      [installationId, 'ins', 'integration target installation'],
    ]);
    const checkedAt = this.now('organization integration administrator check');
    return this.repository.read((transaction) => {
      const administrator = this.activeIntegrationOwner(
        transaction,
        administratorMembershipId,
      );
      const target = transaction.membership(targetMembershipId);
      if (
        target === undefined ||
        target.organization_id !== this.descriptorValue.organization_id ||
        target.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'not_found',
          'integration target membership is not active',
        );
      }
      const enrollment = transaction.enrollmentByInstallation(installationId);
      if (
        enrollment === undefined ||
        enrollment.organization_id !== this.descriptorValue.organization_id ||
        enrollment.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'not_found',
          'integration target installation is not active',
        );
      }
      const installationMembership = transaction.membership(
        enrollment.membership_id,
      );
      const access = requireCurrentAccessState(
        transaction,
        enrollment.enrollment_id,
      );
      if (
        installationMembership === undefined ||
        installationMembership.status !== 'active' ||
        installationMembership.principal_id !== enrollment.principal_id ||
        access.state.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'not_found',
          'integration target installation is not active',
        );
      }
      return {
        administrator: {
          principal_id: administrator.principal_id,
          membership_id: administrator.membership_id,
        },
        target: {
          principal_id: target.principal_id,
          membership_id: target.membership_id,
        },
        installation: {
          principal_id: enrollment.principal_id,
          membership_id: enrollment.membership_id,
          installation_id: enrollment.installation_id,
          installation_key_id: enrollment.installation_signing_key.key_id,
        },
        checked_at: checkedAt,
      };
    });
  }

  integrationInstallationContext(
    command: InstallationSignedCommand & { requested_at: string },
    label: string,
  ): OrganizationIntegrationInstallationContext {
    return this.authenticatedActiveInstallationContext(
      command,
      command.requested_at,
      label,
    );
  }

  /**
   * The record-ingest half of the installation-authentication path.
   *
   * The signature is not checked here because a record envelope is signed as a
   * whole document rather than as an installation command; the caller verifies
   * it against `installation_signing_key`, which comes from the same durable
   * enrollment row `authenticateInstallationCommand` reads. Everything else —
   * active enrollment, active membership, current unexpired access lease — is
   * the same live check, so an expired lease or a revoked installation refuses
   * ingest exactly as it refuses every other installation call.
   *
   * A *new* append additionally requires the current lease to still be valid at
   * this evaluation instant. `assertActiveEnrolledInstallation` only proves the
   * high watermark was never revoked; an `active` state whose `valid_until` has
   * already passed is a lapsed member machine, and admitting a first-ever
   * record from one would write an immutable log row no live authorization
   * covers. Recovering a receipt for an act the log already accepted takes the
   * record module's replay path and never reaches this check, which is what
   * keeps a lease that expires mid-flight from stranding a durable record.
   */
  recordIngestInstallationContext(
    installationId: string,
  ): OrganizationRecordInstallationContext {
    const label = 'organization record ingest';
    const checkedAt = this.now(`${label} evaluation time`);
    return this.repository.read((transaction) => {
      const enrollment = transaction.enrollmentByInstallation(installationId);
      if (enrollment === undefined) {
        throw new AuthorityOperationError(
          'unauthorized',
          `${label} authentication failed`,
        );
      }
      const access = this.assertActiveEnrolledInstallation(
        transaction,
        enrollment,
        label,
      );
      this.assertUnexpiredAccessLease(access, checkedAt, label);
      return {
        authority_id: enrollment.authority_id,
        organization_id: enrollment.organization_id,
        enrollment_id: enrollment.enrollment_id,
        principal_id: enrollment.principal_id,
        membership_id: enrollment.membership_id,
        installation_id: enrollment.installation_id,
        installation_signing_key: enrollment.installation_signing_key,
        checked_at: checkedAt,
      };
    });
  }

  /**
   * Validates one record envelope and authenticates its installation
   * signature. The pinned-authority handle never leaves this object: it is a
   * process-local proof, and exposing it would let a caller assert a pin this
   * application never verified.
   */
  verifyRecordEnvelope(
    value: unknown,
    installationSigningKey: P256SigningKeyDescriptor,
  ): OrganizationRecordEnvelopeAnyVersion {
    return verifyOrganizationRecordEnvelope(
      value,
      this.pinnedAuthority,
      installationSigningKey,
    );
  }

  /**
   * Signs the exact deterministic receipt payload the append transaction
   * committed, with the existing authority signing key member machines already
   * pin. The payload is signed verbatim — no field is recomputed here — so the
   * signed receipt's `kind`, `schema_version`, `position`, and every binding
   * digest are the ones stored with the log row.
   *
   * The assembled document is then verified against this authority's own public
   * key and exact key id before it is returned. Validation is shape-only, and
   * the caller persists this document create-once: a signer that produced a
   * well-formed but unverifiable receipt would otherwise freeze a receipt no
   * member can ever check against the log, with no second chance to replace it.
   */
  async signRecordReceipt(
    payload: OrganizationRecordReceiptPayloadV1,
  ): Promise<OrganizationRecordReceiptV1> {
    if (
      payload.authority_id !== this.descriptorValue.authority_id ||
      payload.organization_id !== this.descriptorValue.organization_id
    ) {
      throw new Error(
        'organization record receipt payload belongs to another authority',
      );
    }
    const document = await createSignedDocumentWithKey(
      payload,
      this.descriptorValue.signing_key.key_id,
      (bytes) => this.signCanonicalPayload(bytes),
    );
    const receipt = validateOrganizationRecordReceipt(document);
    verifySignedDocument(
      receipt,
      organizationAuthorityPublicKey(this.pinnedAuthority),
      this.descriptorValue.signing_key.key_id,
    );
    return receipt;
  }

  private assertActiveEnrolledInstallation(
    transaction: AuthorityReadTransaction,
    enrollment: StoredAuthorityEnrollment,
    label: string,
  ): StoredAuthorityAccessState {
    const membership = transaction.membership(enrollment.membership_id);
    const access = requireCurrentAccessState(
      transaction,
      enrollment.enrollment_id,
    );
    if (
      enrollment.status !== 'active' ||
      enrollment.authority_id !== this.descriptorValue.authority_id ||
      enrollment.organization_id !== this.descriptorValue.organization_id ||
      membership === undefined ||
      membership.organization_id !== enrollment.organization_id ||
      membership.principal_id !== enrollment.principal_id ||
      membership.status !== 'active' ||
      access.state.status !== 'active'
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        `${label} requires an active enrolled installation`,
      );
    }
    return access;
  }

  /**
   * The lease-expiry half of the installation check, deliberately separate
   * from `assertActiveEnrolledInstallation` so callers can sample time at
   * their own consistency boundary. Strictly later, not "not earlier": a
   * lease that expires exactly now is expired.
   */
  private assertUnexpiredAccessLease(
    access: StoredAuthorityAccessState,
    checkedAt: string,
    label: string,
  ): void {
    if (
      access.state.status !== 'active' ||
      timestampMillis(
        access.state.valid_until,
        `${label} access lease expiry`,
      ) <= timestampMillis(checkedAt, `${label} evaluation time`)
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        `${label} requires a current unexpired access lease`,
      );
    }
  }

  private authenticatedActiveInstallationContext(
    command: InstallationSignedCommand,
    freshnessTimestamp: string | null,
    label: string,
  ): OrganizationIntegrationInstallationContext {
    const enrollment = this.repository.read((transaction) =>
      transaction.enrollmentById(command.enrollment_id),
    );
    if (enrollment === undefined) {
      throw new AuthorityOperationError(
        'unauthorized',
        `${label} authentication failed`,
      );
    }
    const requestSha256 = this.authenticateInstallationCommand(
      command,
      enrollment,
      label,
    );
    return this.repository.read((transaction) => {
      const currentEnrollment = transaction.enrollmentById(
        command.enrollment_id,
      );
      if (currentEnrollment === undefined) {
        throw new Error(`authenticated ${label} enrollment disappeared`);
      }
      const access = this.assertActiveEnrolledInstallation(
        transaction,
        currentEnrollment,
        label,
      );
      const checkedAt = this.now(`${label} evaluation time`);
      if (freshnessTimestamp !== null) {
        assertFreshInstallationRequest(
          freshnessTimestamp,
          checkedAt,
          this.accessRequestMaximumAgeMs,
          label,
        );
      }
      this.assertUnexpiredAccessLease(access, checkedAt, label);
      return {
        request_sha256: requestSha256,
        authority_id: currentEnrollment.authority_id,
        organization_id: currentEnrollment.organization_id,
        enrollment_id: currentEnrollment.enrollment_id,
        principal_id: currentEnrollment.principal_id,
        membership_id: currentEnrollment.membership_id,
        installation_id: currentEnrollment.installation_id,
        installation_key_id: currentEnrollment.installation_signing_key.key_id,
        checked_at: checkedAt,
      };
    });
  }

  private internalLiveDirective(
    release: StoredInternalLiveRelease,
    evaluatedAt: string,
  ): OrganizationInternalLiveUpdateDirectiveV1 {
    return {
      schema_version: 1,
      kind: 'echo-internal-live-update-directive',
      channel: 'internal-live',
      directive_sequence: release.directive_sequence,
      manifest_url: release.manifest_url,
      manifest_sha256: release.manifest_sha256,
      approved_at: release.approved_at,
      evaluated_at: evaluatedAt,
    };
  }

  approveInternalLiveRelease(
    input: ApproveOrganizationInternalLiveReleaseRequestV1,
  ): OrganizationInternalLiveUpdateDirectiveV1 {
    const command =
      validateApproveOrganizationInternalLiveReleaseRequest(input);
    const commandSha256 = canonicalSha256(command);
    const replay = this.repository.read((transaction) =>
      transaction.internalLiveReleaseByCommand(command.command_id),
    );
    if (replay !== undefined) {
      if (replay.command_sha256 !== commandSha256) {
        throw new AuthorityOperationError(
          'conflict',
          'administrator command ID was reused with different internal-live release input',
        );
      }
      return this.internalLiveDirective(replay, replay.approved_at);
    }
    const approvedAt = this.now('internal-live release approval time');
    return this.repository.write(approvedAt, (transaction) => {
      const concurrent = transaction.internalLiveReleaseByCommand(
        command.command_id,
      );
      if (concurrent !== undefined) {
        if (concurrent.command_sha256 !== commandSha256) {
          throw new AuthorityOperationError(
            'conflict',
            'administrator command ID was reused with different internal-live release input',
          );
        }
        return this.internalLiveDirective(concurrent, concurrent.approved_at);
      }
      const current = transaction.currentInternalLiveRelease();
      if (
        current !== undefined &&
        compareOrganizationInternalLiveReleaseVersions(
          command.manifest.release_version,
          current.release_version,
        ) <= 0
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'internal-live release version must increase monotonically',
        );
      }
      if (
        current?.manifest_sha256 === command.manifest_sha256 ||
        current?.artifact_sha256 === command.manifest.artifact.sha256
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'internal-live release is already approved',
        );
      }
      if (current !== undefined) {
        const activeInstallations = transaction.activeEnrollments(101);
        if (activeInstallations.length > 100) {
          throw new AuthorityOperationError(
            'unavailable',
            'internal-live rollout exceeds the minimum-v1 installation bound',
          );
        }
        const rolloutReceipts = activeInstallations.map((installation) =>
          transaction.latestInternalLiveUpdateReceipt(
            installation.installation_id,
            current.directive_sequence,
          ),
        );
        const rolloutStarted = rolloutReceipts.some(
          (receipt) => receipt !== undefined,
        );
        const everyActiveInstallationHealthy = rolloutReceipts.every(
          (receipt) => receipt?.receipt.outcome === 'healthy',
        );
        if (rolloutStarted && !everyActiveInstallationHealthy) {
          throw new AuthorityOperationError(
            'conflict',
            'current internal-live release is not healthy on every active installation',
          );
        }
      }
      transaction.insertInternalLiveRelease({
        command,
        command_sha256: commandSha256,
        approved_at: approvedAt,
      });
      const stored = transaction.internalLiveReleaseByCommand(
        command.command_id,
      );
      if (stored === undefined) {
        throw new Error('approved internal-live release disappeared');
      }
      transaction.appendAudit({
        occurred_at: approvedAt,
        actor_kind: 'admin',
        action: 'internal_live.release_approved',
        subject_id: stored.release_tag,
        detail: {
          command_id: command.command_id,
          directive_sequence: stored.directive_sequence,
          manifest_sha256: stored.manifest_sha256,
          release_version: stored.release_version,
          source_sha: stored.source_sha,
        },
      });
      return this.internalLiveDirective(stored, approvedAt);
    });
  }

  fetchInternalLiveDirective(
    input: OrganizationInternalLiveDirectiveRequestV1,
  ): OrganizationInternalLiveUpdateDirectiveV1 {
    const request = validateOrganizationInternalLiveDirectiveRequest(input);
    const context = this.integrationInstallationContext(
      request,
      'internal-live directive request',
    );
    const release = this.repository.read((transaction) =>
      transaction.currentInternalLiveRelease(),
    );
    if (release === undefined) {
      throw new AuthorityOperationError(
        'not_found',
        'no internal-live release is approved',
      );
    }
    return this.internalLiveDirective(release, context.checked_at);
  }

  recordInternalLiveUpdateReceipt(
    input: OrganizationInternalLiveUpdateReceiptV1,
  ): void {
    const receipt = validateOrganizationInternalLiveUpdateReceipt(input);
    const context = this.authenticatedActiveInstallationContext(
      receipt,
      null,
      'internal-live update receipt',
    );
    if (Date.parse(receipt.finished_at) > Date.parse(context.checked_at)) {
      throw new AuthorityOperationError(
        'invalid_request',
        'internal-live update receipt finished_at cannot be in the future',
      );
    }
    const payloadSha256 = receipt.integrity.payload_sha256;
    const replay = this.repository.read((transaction) =>
      transaction.internalLiveUpdateReceiptByTransaction(
        receipt.transaction_id,
      ),
    );
    if (replay !== undefined) {
      if (replay.payload_sha256 !== payloadSha256) {
        throw new AuthorityOperationError(
          'conflict',
          'internal-live transaction ID was reused with a different receipt',
        );
      }
      return;
    }
    const release = this.repository.read((transaction) =>
      transaction.internalLiveReleaseBySequence(receipt.directive_sequence),
    );
    if (
      release === undefined ||
      release.release_version !== receipt.release_version ||
      release.manifest_sha256 !== receipt.manifest_sha256 ||
      release.artifact_sha256 !== receipt.artifact_sha256 ||
      release.source_sha !== receipt.source_sha
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'internal-live update receipt does not match an approved release',
      );
    }
    const acceptedAt = context.checked_at;
    return this.repository.write(acceptedAt, (transaction) => {
      const concurrent = transaction.internalLiveUpdateReceiptByTransaction(
        receipt.transaction_id,
      );
      if (concurrent !== undefined) {
        if (concurrent.payload_sha256 !== payloadSha256) {
          throw new AuthorityOperationError(
            'conflict',
            'internal-live transaction ID was reused with a different receipt',
          );
        }
        return;
      }
      const currentRelease = transaction.internalLiveReleaseBySequence(
        receipt.directive_sequence,
      );
      const currentEnrollment = transaction.enrollmentById(
        receipt.enrollment_id,
      );
      if (
        currentRelease === undefined ||
        currentRelease.release_version !== receipt.release_version ||
        currentRelease.manifest_sha256 !== receipt.manifest_sha256 ||
        currentRelease.artifact_sha256 !== receipt.artifact_sha256 ||
        currentRelease.source_sha !== receipt.source_sha ||
        currentEnrollment?.status !== 'active' ||
        currentEnrollment.installation_id !== receipt.installation_id
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'internal-live update receipt state changed before commit',
        );
      }
      transaction.insertInternalLiveUpdateReceipt({
        payload_sha256: payloadSha256,
        receipt,
        received_at: acceptedAt,
      });
      transaction.appendAudit({
        occurred_at: acceptedAt,
        actor_kind: 'installation',
        action: 'internal_live.update_reported',
        subject_id: receipt.installation_id,
        detail: {
          artifact_sha256: receipt.artifact_sha256,
          directive_sequence: receipt.directive_sequence,
          manifest_sha256: receipt.manifest_sha256,
          outcome: receipt.outcome,
          source_sha: receipt.source_sha,
          transaction_id: receipt.transaction_id,
        },
      });
    });
  }

  internalLiveRolloutStatus(): OrganizationInternalLiveRolloutStatusV1 {
    const evaluatedAt = this.now('internal-live rollout status time');
    return this.repository.read((transaction) => {
      const release = transaction.currentInternalLiveRelease();
      const installations = transaction.activeEnrollments(101);
      if (installations.length > 100) {
        throw new AuthorityOperationError(
          'unavailable',
          'internal-live rollout status exceeds the minimum-v1 installation bound',
        );
      }
      return {
        schema_version: 1,
        kind: 'echo-internal-live-rollout-status',
        channel: 'internal-live',
        evaluated_at: evaluatedAt,
        approved_release:
          release === undefined
            ? null
            : {
                directive_sequence: release.directive_sequence,
                release_version: release.release_version,
                manifest_url: release.manifest_url,
                manifest_sha256: release.manifest_sha256,
                approved_at: release.approved_at,
              },
        installations: installations.map((installation) => {
          const stored =
            release === undefined
              ? undefined
              : transaction.latestInternalLiveUpdateReceipt(
                  installation.installation_id,
                  release.directive_sequence,
                );
          const receipt = stored?.receipt;
          return {
            installation_id: installation.installation_id,
            rollout_state:
              release === undefined
                ? ('no_release' as const)
                : receipt === undefined
                  ? ('pending' as const)
                  : receipt.outcome,
            receipt:
              receipt === undefined || stored === undefined
                ? null
                : {
                    release_version: receipt.release_version,
                    outcome: receipt.outcome,
                    doctor: receipt.doctor,
                    failure: receipt.failure,
                    finished_at: receipt.finished_at,
                  },
          };
        }),
      };
    });
  }

  private assertIntegrationIdentifiers(
    identifiers: ReadonlyArray<
      readonly [value: string, prefix: 'mem' | 'ins', label: string]
    >,
  ): void {
    try {
      for (const [value, prefix, label] of identifiers) {
        assertFederationId(value, prefix, label);
      }
    } catch {
      throw new AuthorityOperationError(
        'invalid_request',
        'organization integration administrator input is invalid',
      );
    }
  }

  private activeIntegrationOwner(
    transaction: AuthorityReadTransaction,
    membershipId: string,
  ): StoredAuthorityMembership {
    const membership = transaction.membership(membershipId);
    if (
      membership === undefined ||
      membership.organization_id !== this.descriptorValue.organization_id ||
      membership.status !== 'active' ||
      membership.membership_type !== 'owner'
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        'an active organization owner is required',
      );
    }
    return membership;
  }

  close(): void {
    this.repository.close();
  }

  private now(label: string): string {
    const value = this.clock.now();
    timestampMillis(value, label);
    return value;
  }

  private async signCanonicalPayload(bytes: Buffer): Promise<Buffer> {
    const current = validateOrganizationAuthorityDescriptor(
      await this.signer.inspect(),
    );
    if (!sameDescriptor(current, this.descriptorValue)) {
      throw new Error('organization authority signer descriptor changed');
    }
    const message = Buffer.from(bytes);
    const signature = await this.signer.sign(
      Buffer.from(message),
      this.descriptorValue.signing_key.key_id,
    );
    assertP256LowS(signature);
    if (
      !verifyP256LowSSignature(
        organizationAuthorityPublicKey(this.pinnedAuthority),
        message,
        signature,
      )
    ) {
      throw new Error(
        'organization authority signer returned an invalid signature',
      );
    }
    return Buffer.from(signature);
  }

  private originalProvisionedMembership(
    membership: StoredAuthorityMembership,
  ): ProvisionedOrganizationMembershipV1 {
    if (membership.organization_id !== this.descriptorValue.organization_id) {
      throw new Error('stored membership belongs to another organization');
    }
    return {
      organization_id: membership.organization_id,
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      display_name: membership.display_name,
      membership_type: membership.membership_type,
      status: 'active',
      provisioned_at: membership.provisioned_at,
      revoked_at: null,
    };
  }

  provisionMembership(
    input: ProvisionOrganizationMembershipRequestV1,
  ): ProvisionedOrganizationMembershipV1 {
    const command = validateProvisionOrganizationMembershipRequest(input);
    const commandSha256 = canonicalSha256(command);
    const replay = this.repository.read((transaction) =>
      transaction.membershipByAdminCommand(command.command_id),
    );
    if (replay !== undefined) {
      if (replay.admin_command_sha256 !== commandSha256) {
        throw new AuthorityOperationError(
          'conflict',
          'administrator command ID was reused with different membership input',
        );
      }
      return this.originalProvisionedMembership(replay);
    }
    assertDisplayName(command.display_name);
    assertMembershipType(command.membership_type);
    const provisionedAt = this.now('membership provisioning time');
    const principalId = this.identifiers.next('prn');
    const membershipId = this.identifiers.next('mem');
    assertFederationId(principalId, 'prn', 'generated principal_id');
    assertFederationId(membershipId, 'mem', 'generated membership_id');
    const membership: StoredAuthorityMembership = {
      organization_id: this.descriptorValue.organization_id,
      principal_id: principalId,
      membership_id: membershipId,
      display_name: command.display_name,
      membership_type: command.membership_type,
      status: 'active',
      provisioned_at: provisionedAt,
      revoked_at: null,
      revocation_reason: null,
      admin_command_id: command.command_id,
      admin_command_sha256: commandSha256,
    };
    const stored = this.repository.write(provisionedAt, (transaction) => {
      const concurrent = transaction.membershipByAdminCommand(
        command.command_id,
      );
      if (concurrent !== undefined) {
        if (concurrent.admin_command_sha256 !== commandSha256) {
          throw new AuthorityOperationError(
            'conflict',
            'administrator command ID was reused with different membership input',
          );
        }
        return concurrent;
      }
      transaction.insertMembership(membership);
      transaction.appendAudit({
        occurred_at: provisionedAt,
        actor_kind: 'admin',
        action: 'membership.provisioned',
        subject_id: membership.membership_id,
        detail: {
          command_id: command.command_id,
          membership_type: membership.membership_type,
          principal_id: membership.principal_id,
        },
      });
      return membership;
    });
    return this.originalProvisionedMembership(stored);
  }

  private issuedEnrollmentGrant(
    grant: StoredEnrollmentGrant,
  ): IssuedEnrollmentGrant {
    if (
      grant.authority_id !== this.descriptorValue.authority_id ||
      grant.organization_id !== this.descriptorValue.organization_id
    ) {
      throw new Error('stored enrollment grant belongs to another authority');
    }
    return {
      authority_id: grant.authority_id,
      authority_pin_sha256: this.pinnedAuthority.authority_pin_sha256,
      organization_id: grant.organization_id,
      principal_id: grant.principal_id,
      membership_id: grant.membership_id,
      enrollment_grant_sha256: grant.grant_sha256,
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
    };
  }

  issueEnrollmentGrant(
    membershipId: string,
    input: IssueOrganizationEnrollmentGrantRequestV1,
  ): IssuedEnrollmentGrant {
    assertFederationId(membershipId, 'mem', 'enrollment grant membership');
    const command = validateIssueOrganizationEnrollmentGrantRequest(input);
    assertGrantLifetimeSeconds(command.lifetime_seconds);
    const grantSha256 = command.enrollment_grant_sha256;
    const commandSha256 = canonicalSha256({
      membership_id: membershipId,
      ...command,
    });
    const replay = this.repository.read((transaction) =>
      transaction.grantByAdminCommand(command.command_id),
    );
    if (replay !== undefined) {
      if (replay.admin_command_sha256 !== commandSha256) {
        throw new AuthorityOperationError(
          'conflict',
          'administrator command ID was reused with different invitation input',
        );
      }
      return this.issuedEnrollmentGrant(replay);
    }
    const issuedAt = this.now('enrollment grant issue time');
    const expiresAt = addMilliseconds(
      issuedAt,
      command.lifetime_seconds * 1000,
    );
    return this.repository.write(issuedAt, (transaction) => {
      const concurrent = transaction.grantByAdminCommand(command.command_id);
      if (concurrent !== undefined) {
        if (concurrent.admin_command_sha256 !== commandSha256) {
          throw new AuthorityOperationError(
            'conflict',
            'administrator command ID was reused with different invitation input',
          );
        }
        return this.issuedEnrollmentGrant(concurrent);
      }
      const digestCollision = transaction.grant(grantSha256);
      if (digestCollision !== undefined) {
        throw new AuthorityOperationError(
          'conflict',
          'enrollment grant digest is already registered',
        );
      }
      const membership = transaction.membership(membershipId);
      if (
        membership === undefined ||
        membership.organization_id !== this.descriptorValue.organization_id ||
        membership.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'not_found',
          'active membership was not found',
        );
      }
      const stored: StoredEnrollmentGrant = {
        grant_sha256: grantSha256,
        authority_id: this.descriptorValue.authority_id,
        organization_id: this.descriptorValue.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        issued_at: issuedAt,
        expires_at: expiresAt,
        consumed_at: null,
        request_sha256: null,
        admin_command_id: command.command_id,
        admin_command_sha256: commandSha256,
      };
      transaction.insertGrant(stored);
      transaction.appendAudit({
        occurred_at: issuedAt,
        actor_kind: 'admin',
        action: 'enrollment_grant.issued',
        subject_id: membership.membership_id,
        detail: {
          command_id: command.command_id,
          expires_at: expiresAt,
          grant_sha256: grantSha256,
        },
      });
      return this.issuedEnrollmentGrant(stored);
    });
  }

  private existingEnrollmentResult(
    transaction: AuthorityReadTransaction,
    grantSha256: Sha256Digest,
    requestSha256: Sha256Digest,
  ): CompletedEnrollment | undefined {
    const grant = transaction.grant(grantSha256);
    if (grant?.consumed_at === null || grant === undefined) return undefined;
    if (grant.request_sha256 !== requestSha256) {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment grant is unavailable',
      );
    }
    const enrollment = transaction.enrollmentByGrant(grantSha256);
    if (
      enrollment === undefined ||
      enrollment.request_sha256 !== requestSha256
    ) {
      throw new Error('stored enrollment result is inconsistent');
    }
    const initialState = transaction.accessState(enrollment.enrollment_id, 1);
    if (initialState === undefined) {
      throw new Error('stored enrollment initial access state is missing');
    }
    return {
      enrollment_receipt: enrollment.receipt,
      access_state: initialState.state,
    };
  }

  async completeEnrollment(input: {
    enrollment_grant: Uint8Array;
    enrollment_request: OrganizationEnrollmentRequestV1;
  }): Promise<CompletedEnrollment> {
    const grantSha256 = organizationEnrollmentGrantSha256(
      input.enrollment_grant,
    );
    let request: OrganizationEnrollmentRequestV1;
    try {
      request = verifyOrganizationEnrollmentRequest(
        input.enrollment_request,
        this.pinnedAuthority,
      );
    } catch {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment request authentication failed',
      );
    }
    if (request.enrollment_grant_sha256 !== grantSha256) {
      throw new AuthorityOperationError(
        'unauthorized',
        'enrollment grant is unavailable',
      );
    }
    const requestSha256 = organizationEnrollmentRequestSha256(
      request,
      this.pinnedAuthority,
    );
    const existing = this.repository.read((transaction) =>
      this.existingEnrollmentResult(transaction, grantSha256, requestSha256),
    );
    if (existing !== undefined) return existing;

    const preparedAt = this.now('enrollment preparation time');
    const snapshot = this.repository.read((transaction) => {
      const grant = transaction.grant(grantSha256);
      const membership = transaction.membership(request.membership_id);
      if (
        grant === undefined ||
        grant.consumed_at !== null ||
        grant.authority_id !== request.authority_id ||
        grant.organization_id !== request.organization_id ||
        grant.principal_id !== request.principal_id ||
        grant.membership_id !== request.membership_id ||
        membership === undefined ||
        membership.status !== 'active' ||
        membership.principal_id !== request.principal_id ||
        preparedAt < grant.issued_at ||
        preparedAt >= grant.expires_at
      ) {
        throw new AuthorityOperationError(
          'unauthorized',
          'enrollment grant is unavailable',
        );
      }
      return { membership };
    });

    const enrollmentId = this.identifiers.next('enr');
    assertFederationId(enrollmentId, 'enr', 'generated enrollment_id');
    const receipt = await createOrganizationEnrollmentReceipt(
      {
        enrollment_id: enrollmentId,
        membership_type: snapshot.membership.membership_type,
        enrolled_at: preparedAt,
        request,
      },
      this.pinnedAuthority,
      (bytes) => this.signCanonicalPayload(bytes),
    );
    const receiptSha256 = organizationEnrollmentReceiptSha256(
      receipt,
      this.pinnedAuthority,
      request,
    );
    const initialState = await createOrganizationInstallationAccessState(
      {
        request,
        receipt,
        previous_state: null,
        access_state_sequence: 1,
        evaluated_at: preparedAt,
        status: 'active',
        valid_until: addMilliseconds(preparedAt, this.activeLeaseTtlMs),
        maximum_active_ttl_ms: this.activeLeaseTtlMs,
      },
      this.pinnedAuthority,
      (bytes) => this.signCanonicalPayload(bytes),
    );
    const initialStateSha256 = canonicalSha256(initialState);
    const candidate: StoredAuthorityEnrollment = {
      enrollment_id: enrollmentId,
      grant_sha256: grantSha256,
      request_sha256: requestSha256,
      request,
      receipt_sha256: receiptSha256,
      receipt,
      authority_id: request.authority_id,
      organization_id: request.organization_id,
      principal_id: request.principal_id,
      membership_id: request.membership_id,
      membership_type: snapshot.membership.membership_type,
      installation_id: request.installation_id,
      installation_signing_key: request.installation_signing_key,
      status: 'active',
      enrolled_at: preparedAt,
      revoked_at: null,
      revocation_kind: null,
      revocation_reason: null,
    };

    return this.repository.writeAtLinearization(
      () => this.now('enrollment commit time'),
      (transaction, commitAt) => {
        if (commitAt < preparedAt) {
          throw new Error(
            'authority clock regressed while completing enrollment',
          );
        }
        if (
          initialState.status !== 'active' ||
          commitAt >= initialState.valid_until
        ) {
          throw new AuthorityOperationError(
            'conflict',
            'enrollment signing exceeded the initial access lease',
          );
        }
        const concurrent = this.existingEnrollmentResult(
          transaction,
          grantSha256,
          requestSha256,
        );
        if (concurrent !== undefined) return concurrent;
        const grant = transaction.grant(grantSha256);
        const membership = transaction.membership(request.membership_id);
        if (
          grant === undefined ||
          grant.consumed_at !== null ||
          commitAt < grant.issued_at ||
          commitAt >= grant.expires_at ||
          grant.authority_id !== request.authority_id ||
          grant.organization_id !== request.organization_id ||
          grant.principal_id !== request.principal_id ||
          grant.membership_id !== request.membership_id ||
          membership === undefined ||
          membership.status !== 'active' ||
          membership.principal_id !== request.principal_id ||
          membership.membership_type !== snapshot.membership.membership_type
        ) {
          throw new AuthorityOperationError(
            'unauthorized',
            'enrollment grant is unavailable',
          );
        }
        if (
          transaction.enrollmentByInstallation(request.installation_id) !==
            undefined ||
          transaction.enrollmentByKey(
            request.installation_signing_key.key_id,
          ) !== undefined ||
          transaction.enrollmentByRequest(requestSha256) !== undefined
        ) {
          throw new AuthorityOperationError(
            'conflict',
            'installation identifier or signing key is already enrolled',
          );
        }
        transaction.insertEnrollment({
          enrollment: candidate,
          initial_access_state: {
            enrollment_id: enrollmentId,
            state_sha256: initialStateSha256,
            state: initialState,
          },
        });
        if (!transaction.consumeGrant(grantSha256, requestSha256, commitAt)) {
          throw new Error(
            'enrollment grant consumption lost its transaction race',
          );
        }
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'enrollment_grant',
          action: 'installation.enrolled',
          subject_id: request.installation_id,
          detail: {
            enrollment_id: enrollmentId,
            request_sha256: requestSha256,
          },
        });
        return {
          enrollment_receipt: receipt,
          access_state: initialState,
        };
      },
    );
  }

  private authenticateInstallationCommand(
    command: InstallationSignedCommand,
    enrollment: StoredAuthorityEnrollment,
    label: string,
  ): Sha256Digest {
    if (
      command.authority_id !== enrollment.authority_id ||
      command.authority_key_id !== this.descriptorValue.signing_key.key_id ||
      command.organization_id !== enrollment.organization_id ||
      command.enrollment_id !== enrollment.enrollment_id ||
      command.installation_id !== enrollment.installation_id ||
      command.installation_key_id !== enrollment.installation_signing_key.key_id
    ) {
      throw new AuthorityOperationError(
        'unauthorized',
        `${label} does not match the enrollment`,
      );
    }
    try {
      const publicKey = verifyP256SigningKeyDescriptor(
        enrollment.installation_signing_key,
      );
      verifySignedDocument(
        command,
        publicKey,
        enrollment.installation_signing_key.key_id,
      );
    } catch {
      throw new AuthorityOperationError(
        'unauthorized',
        `${label} authentication failed`,
      );
    }
    return canonicalSha256(command);
  }

  /**
   * The durable active-generation pointer is intentionally exposed as a
   * value, never as a repository handle.  Composition resolves its private
   * directory and opens the retrieval generation from this exact pin.
   */
  readableSearchActiveGeneration(): StoredReadableSearchActiveGeneration | null {
    try {
      return this.repository.read((transaction) =>
        transaction.activeReadableSearchGeneration(),
      );
    } catch (error) {
      throw new ReadableSearchError(
        'unavailable',
        'readable-search active generation is unavailable',
        { cause: error },
      );
    }
  }

  /** The reusable port retains no request state across concurrent searches. */
  createBoundReadableSearchAuthorityStatePort(
    recordHead: ReadableSearchRecordHeadVerifier,
  ): ReadableSearchAuthorityStatePort {
    const port: ReadableSearchAuthorityStatePort = {
      authenticate: (input: OrganizationReadableSearchRequestV1) =>
        this.authenticateReadableSearchRequest(input),
      currentPerson: (request: ReadableSearchAuthenticatedRequest) =>
        this.readableSearchRead((transaction) =>
          this.readableSearchPersonSnapshot(
            transaction,
            request,
            this.now('readable-search initial authorization time'),
          ),
        ),
      writeAtLinearization: <T>(
        authenticated: ReadableSearchAuthenticatedRequest,
        scope: ReadableSearchScope | null,
        selected: readonly import('./readable-search.js').ReadableSearchCandidate[],
        operation: (input: {
          readonly person: ReadableSearchCurrentPerson;
          readonly checked_at: string;
          readonly scope_still_admitted: boolean;
          appendQueryAudit: AuthorityWriteTransaction['appendReadableSearchQueryAudit'];
        }) => T,
      ): T => {
        return this.writeReadableSearchAtLinearization(
          authenticated,
          scope,
          selected,
          recordHead,
          operation,
        );
      },
    };
    return Object.freeze(port);
  }

  private authenticateReadableSearchRequest(
    raw: OrganizationReadableSearchRequestV1,
  ): ReadableSearchAuthenticatedRequest {
    let request: OrganizationReadableSearchRequestV1;
    try {
      request = JSON.parse(
        canonicalJson(validateOrganizationReadableSearchRequest(raw)),
      ) as OrganizationReadableSearchRequestV1;
    } catch (error) {
      throw new ReadableSearchError(
        'invalid_request',
        'readable-search request is invalid',
        { cause: error },
      );
    }
    try {
      const enrollment = this.repository.read((transaction) =>
        transaction.enrollmentById(request.enrollment_id),
      );
      if (enrollment === undefined) {
        throw new AuthorityOperationError(
          'unauthorized',
          'readable-search enrollment does not exist',
        );
      }
      const requestSha256 = this.authenticateInstallationCommand(
        request,
        enrollment,
        'readable-search request',
      );
      assertFreshInstallationRequest(
        request.requested_at,
        this.now('readable-search request freshness time'),
        this.accessRequestMaximumAgeMs,
        'readable-search request',
      );
      return Object.freeze({ request, request_sha256: requestSha256 });
    } catch (error) {
      if (
        error instanceof AuthorityOperationError &&
        error.code === 'unauthorized'
      ) {
        throw new ReadableSearchError(
          'unauthorized',
          'readable-search authentication failed',
          { cause: error },
        );
      }
      if (error instanceof ReadableSearchError) throw error;
      throw new ReadableSearchError(
        'unavailable',
        'readable-search authentication is unavailable',
        { cause: error },
      );
    }
  }

  private readableSearchRead<T>(
    operation: (transaction: AuthorityReadTransaction) => T,
  ): T {
    try {
      return this.repository.read(operation);
    } catch (error) {
      if (error instanceof ReadableSearchError) throw error;
      throw new ReadableSearchError(
        'unavailable',
        'readable-search Authority state is unavailable',
        { cause: error },
      );
    }
  }

  private readableSearchPersonSnapshot(
    transaction: AuthorityReadTransaction,
    authenticated: ReadableSearchAuthenticatedRequest,
    checkedAt: string,
  ): ReadableSearchCurrentPerson {
    const { request } = authenticated;
    const enrollment = transaction.enrollmentById(request.enrollment_id);
    if (enrollment === undefined) {
      throw new ReadableSearchError(
        'unavailable',
        'authenticated readable-search enrollment disappeared',
      );
    }
    const membership = transaction.membership(enrollment.membership_id);
    const access = transaction.currentAccessState(enrollment.enrollment_id);
    if (membership === undefined || access === undefined) {
      throw new ReadableSearchError(
        'unavailable',
        'readable-search current Person state is incomplete',
      );
    }
    if (
      request.authority_id !== this.descriptorValue.authority_id ||
      request.organization_id !== this.descriptorValue.organization_id ||
      enrollment.authority_id !== request.authority_id ||
      enrollment.organization_id !== request.organization_id ||
      enrollment.enrollment_id !== request.enrollment_id ||
      enrollment.installation_id !== request.installation_id ||
      enrollment.installation_signing_key.key_id !== request.installation_key_id ||
      membership.organization_id !== enrollment.organization_id ||
      membership.membership_id !== enrollment.membership_id ||
      membership.principal_id !== enrollment.principal_id ||
      membership.membership_type !== enrollment.membership_type ||
      access.enrollment_id !== enrollment.enrollment_id
    ) {
      throw new ReadableSearchError(
        'unavailable',
        'readable-search current Person state is inconsistent',
      );
    }
    const authorizationState = {
      schema_version: 1,
      kind: 'readable-search-authorization-state-v1',
      authority_id: this.descriptorValue.authority_id,
      organization_id: this.descriptorValue.organization_id,
      membership_id: membership.membership_id,
      principal_id: membership.principal_id,
      membership_type: membership.membership_type,
      membership_status: membership.status,
      membership_revoked_at: membership.revoked_at,
      enrollment_id: enrollment.enrollment_id,
      enrollment_status: enrollment.status,
      enrollment_revoked_at: enrollment.revoked_at,
      enrollment_revocation_kind: enrollment.revocation_kind,
      installation_id: enrollment.installation_id,
      installation_key_id: enrollment.installation_signing_key.key_id,
      access_state_sequence: access.state.access_state_sequence,
      access_state_sha256: access.state_sha256,
      access_status: access.state.status,
      access_valid_until: access.state.valid_until,
    } as const;
    const authorizationStateSha256 = canonicalSha256(authorizationState);
    const personStateSha256 = canonicalSha256({
      ...authorizationState,
      kind: 'readable-search-person-state-v1',
      evaluated_at: checkedAt,
    });
    const base = {
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      membership_type: membership.membership_type,
      enrollment_id: enrollment.enrollment_id,
      installation_id: enrollment.installation_id,
      authorization_state_sha256: authorizationStateSha256,
      person_state_sha256: personStateSha256,
    } as const;
    if (membership.status !== 'active') {
      return Object.freeze({
        ...base,
        decision: 'not_found' as const,
        governed_reason: 'inactive_or_unbound_organization_membership' as const,
      });
    }
    if (enrollment.status !== 'active') {
      return Object.freeze({
        ...base,
        decision: 'not_found' as const,
        governed_reason: 'inactive_or_revoked_installation_enrollment' as const,
      });
    }
    if (access.state.status !== 'active') {
      return Object.freeze({
        ...base,
        decision: 'not_found' as const,
        governed_reason: 'inactive_or_revoked_installation_enrollment' as const,
      });
    }
    if (access.state.valid_until === null) {
      throw new ReadableSearchError(
        'unavailable',
        'active readable-search access state has no expiry',
      );
    }
    if (
      timestampMillis(access.state.valid_until, 'readable-search access expiry') <=
      timestampMillis(checkedAt, 'readable-search Person check time')
    ) {
      return Object.freeze({
        ...base,
        decision: 'expired' as const,
        governed_reason: 'installation_access_expired' as const,
      });
    }
    return Object.freeze({
      ...base,
      decision: 'eligible' as const,
      governed_reason: 'active_member_with_scoped_policy_paths' as const,
    });
  }

  private readableSearchGenerationStillMatches(
    transaction: AuthorityReadTransaction,
    scope: ReadableSearchScope,
  ): boolean {
    const active = transaction.activeReadableSearchGeneration();
    return (
      active !== null &&
      active.generation_id === scope.binding.generation_id &&
      active.manifest_sha256 === scope.binding.manifest_sha256 &&
      active.retrieval_contract_sha256 ===
        scope.binding.retrieval_contract_sha256 &&
      active.record_head_position === scope.binding.record_head_position &&
      active.record_head_hash === scope.binding.record_head_hash
    );
  }

  private writeReadableSearchAtLinearization<T>(
    authenticated: ReadableSearchAuthenticatedRequest,
    scope: ReadableSearchScope | null,
    selected: readonly import('./readable-search.js').ReadableSearchCandidate[],
    recordHead: ReadableSearchRecordHeadVerifier,
    operation: (input: {
      readonly person: ReadableSearchCurrentPerson;
      readonly checked_at: string;
      readonly scope_still_admitted: boolean;
      appendQueryAudit: AuthorityWriteTransaction['appendReadableSearchQueryAudit'];
    }) => T,
  ): T {
    try {
      return this.repository.writeAtLinearization(
        () => this.now('readable-search authorization commit time'),
        (transaction, checkedAt) => {
          const person = this.readableSearchPersonSnapshot(
            transaction,
            authenticated,
            checkedAt,
          );
          const scopeStillAdmitted =
            scope === null ||
            (this.readableSearchGenerationStillMatches(transaction, scope) &&
              recordHead.stillMatches(scope.binding) &&
              scope.selected_policy_paths_still_match(selected));
          return operation({
            person,
            checked_at: checkedAt,
            scope_still_admitted: scopeStillAdmitted,
            appendQueryAudit: (entry) =>
              transaction.appendReadableSearchQueryAudit(entry),
          });
        },
      );
    } catch (error) {
      if (error instanceof ReadableSearchError) throw error;
      throw new ReadableSearchError(
        'unavailable',
        'readable-search final authorization is unavailable',
        { cause: error },
      );
    }
  }

  private authenticateAccessCommand(
    command: OrganizationAccessLeaseRequestV1,
    enrollment: StoredAuthorityEnrollment,
  ): Sha256Digest {
    return this.authenticateInstallationCommand(
      command,
      enrollment,
      'access lease request',
    );
  }

  private recentDecisionsRead<T>(
    operation: (transaction: AuthorityReadTransaction) => T,
  ): T {
    try {
      return this.repository.read(operation);
    } catch (error) {
      if (error instanceof OrganizationRecentDecisionsError) throw error;
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'authority state is unavailable for recent decisions',
        { cause: error },
      );
    }
  }

  private recentDecisionsPersonSnapshot(
    transaction: AuthorityReadTransaction,
    authenticated: AuthenticatedRecentDecisionsRequest,
    checkedAt: string,
  ): RecentDecisionsPersonSnapshot {
    const request = authenticated.request;
    const enrollment = transaction.enrollmentById(request.enrollment_id);
    if (enrollment === undefined) {
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'authenticated recent decisions enrollment disappeared',
      );
    }
    const membership = transaction.membership(enrollment.membership_id);
    const access = transaction.currentAccessState(enrollment.enrollment_id);
    if (membership === undefined || access === undefined) {
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'recent decisions person state is incomplete',
      );
    }
    if (
      enrollment.authority_id !== this.descriptorValue.authority_id ||
      enrollment.organization_id !== authenticated.activation.organization_id ||
      enrollment.enrollment_id !== request.enrollment_id ||
      enrollment.installation_id !== request.installation_id ||
      enrollment.installation_signing_key.key_id !==
        request.installation_key_id ||
      membership.organization_id !== enrollment.organization_id ||
      membership.membership_id !== enrollment.membership_id ||
      membership.principal_id !== enrollment.principal_id ||
      access.enrollment_id !== enrollment.enrollment_id
    ) {
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'recent decisions person state is inconsistent',
      );
    }

    const state: RecentDecisionsPersonState = {
      membership_id: membership.membership_id,
      principal_id: membership.principal_id,
      membership_status: membership.status,
      enrollment_id: enrollment.enrollment_id,
      enrollment_status: enrollment.status,
      installation_id: enrollment.installation_id,
      installation_key_id: enrollment.installation_signing_key.key_id,
      access_state_sequence: access.state.access_state_sequence,
      access_state_sha256: access.state_sha256,
      access_status: access.state.status,
      access_valid_until: access.state.valid_until,
      checked_at: checkedAt,
    };
    const inactive =
      membership.status !== 'active' ||
      enrollment.status !== 'active' ||
      access.state.status !== 'active';
    if (inactive) {
      return {
        state,
        state_sha256: canonicalSha256(state),
        decision: 'not_found',
        governed_reason: 'inactive_or_unbound_pilot_membership',
      };
    }
    if (access.state.valid_until === null) {
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'active recent decisions access state has no expiry',
      );
    }
    if (
      timestampMillis(
        access.state.valid_until,
        'recent decisions access lease expiry',
      ) <= timestampMillis(checkedAt, 'recent decisions person check time')
    ) {
      return {
        state,
        state_sha256: canonicalSha256(state),
        decision: 'expired',
        governed_reason: 'installation_access_expired',
      };
    }
    if (
      !authenticated.activation.membership_ids.includes(
        membership.membership_id,
      )
    ) {
      return {
        state,
        state_sha256: canonicalSha256(state),
        decision: 'not_found',
        governed_reason: 'inactive_or_unbound_pilot_membership',
      };
    }
    return {
      state,
      state_sha256: canonicalSha256(state),
      decision: 'eligible',
      governed_reason: 'active_bound_pilot_membership',
    };
  }

  private preparedRecentDecisionsDenial(
    snapshot: RecentDecisionsPersonSnapshot,
  ): PreparedOrganizationRecentDecisionsResponse {
    const statusCode = snapshot.decision === 'expired' ? 401 : 404;
    return {
      status_code: statusCode,
      body: fixedRecentDecisionsErrorBytes(statusCode),
      item_references: [],
    };
  }

  private appendRecentDecisionsAudit(
    transaction: AuthorityWriteTransaction,
    authenticated: AuthenticatedRecentDecisionsRequest,
    snapshot: RecentDecisionsPersonSnapshot,
    prepared: PreparedOrganizationRecentDecisionsResponse,
  ): void {
    const allowed = prepared.status_code === 200;
    const common = {
      operation: 'recent_decisions',
      decision: allowed ? 'allow' : 'deny',
      governed_reason: snapshot.governed_reason,
      request_sha256: authenticated.request_sha256,
      response_sha256: sha256Digest(prepared.body),
      policy_id: authenticated.activation.policy_id,
      policy_marker_sha256: authenticated.activation.marker_sha256,
      audience_notice_sha256: authenticated.activation.audience_notice_sha256,
      pilot_person_state_sha256: snapshot.state_sha256,
      pilot_person_state: { ...snapshot.state },
    } as const;
    transaction.appendAudit({
      occurred_at: snapshot.state.checked_at,
      actor_kind: 'installation',
      action: 'permission_pilot.recent_decisions_decided',
      subject_id: authenticated.request.installation_id,
      detail: allowed
        ? {
            ...common,
            returned_items: prepared.item_references.map((item) => ({
              atom_id: item.atom_id,
              record_hash: item.record_hash,
            })),
          }
        : common,
    });
  }

  private commitRecentDecisionsResponse(
    authenticated: AuthenticatedRecentDecisionsRequest,
    allowedResponse: PreparedOrganizationRecentDecisionsResponse | null,
  ): PreparedOrganizationRecentDecisionsResponse {
    try {
      return this.repository.writeAtLinearization(
        () => this.now('recent decisions authorization commit time'),
        (transaction, checkedAt) => {
          const snapshot = this.recentDecisionsPersonSnapshot(
            transaction,
            authenticated,
            checkedAt,
          );
          if (allowedResponse === null && snapshot.decision === 'eligible') {
            throw new OrganizationRecentDecisionsError(
              'unavailable',
              'recent decisions person state changed before denial commit',
            );
          }
          const prepared =
            allowedResponse !== null && snapshot.decision === 'eligible'
              ? allowedResponse
              : this.preparedRecentDecisionsDenial(snapshot);
          this.appendRecentDecisionsAudit(
            transaction,
            authenticated,
            snapshot,
            prepared,
          );
          return prepared;
        },
      );
    } catch (error) {
      if (error instanceof OrganizationRecentDecisionsError) throw error;
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'recent decisions audit commit is unavailable',
        { cause: error },
      );
    }
  }

  /**
   * Authenticates, authorizes, selects, projects, and commits the audit for one
   * fixed recent-decisions operation. `loadProjectedRecords` is invoked only
   * after the caller is active and belongs to the startup-cached marker pair.
   */
  serveRecentDecisions(
    input: OrganizationRecentDecisionsRequestV1,
    activationInput: OrganizationRecentDecisionsPilotActivation,
    loadProjectedRecords: () => readonly OrganizationRecentDecisionsProjectedRecord[],
  ): PreparedOrganizationRecentDecisionsResponse {
    const activation = validateRecentDecisionsPilotActivation(activationInput);
    if (activation.organization_id !== this.descriptorValue.organization_id) {
      throw new OrganizationRecentDecisionsError(
        'unavailable',
        'permission pilot activation belongs to another organization',
      );
    }

    let request: OrganizationRecentDecisionsRequestV1;
    try {
      request = validateOrganizationRecentDecisionsRequest(input);
      request = JSON.parse(
        canonicalJson(request),
      ) as OrganizationRecentDecisionsRequestV1;
    } catch (error) {
      if (!isOrganizationApiValidationError(error)) throw error;
      throw new OrganizationRecentDecisionsError(
        'invalid_request',
        'recent decisions request is invalid',
        { cause: error },
      );
    }

    const enrollment = this.recentDecisionsRead((transaction) =>
      transaction.enrollmentById(request.enrollment_id),
    );
    if (enrollment === undefined) {
      throw new OrganizationRecentDecisionsError(
        'unauthorized',
        'recent decisions request authentication failed',
      );
    }
    let requestSha256: Sha256Digest;
    try {
      requestSha256 = this.authenticateInstallationCommand(
        request,
        enrollment,
        'recent decisions request',
      );
    } catch (error) {
      if (
        error instanceof AuthorityOperationError &&
        error.code === 'unauthorized'
      ) {
        throw new OrganizationRecentDecisionsError(
          'unauthorized',
          'recent decisions request authentication failed',
          { cause: error },
        );
      }
      throw error;
    }
    const checkedAt = this.now('recent decisions initial authorization time');
    try {
      assertFreshInstallationRequest(
        request.requested_at,
        checkedAt,
        this.accessRequestMaximumAgeMs,
        'recent decisions request',
      );
    } catch (error) {
      if (
        error instanceof AuthorityOperationError &&
        error.code === 'unauthorized'
      ) {
        throw new OrganizationRecentDecisionsError(
          'unauthorized',
          'recent decisions request is outside the accepted time window',
          { cause: error },
        );
      }
      throw error;
    }
    const authenticated: AuthenticatedRecentDecisionsRequest = {
      request,
      request_sha256: requestSha256,
      activation,
    };
    const initial = this.recentDecisionsRead((transaction) =>
      this.recentDecisionsPersonSnapshot(transaction, authenticated, checkedAt),
    );
    if (initial.decision !== 'eligible') {
      // The row source has not been touched. This transaction rechecks the
      // denial and commits the exact 401/404 bytes before they may be sent.
      return this.commitRecentDecisionsResponse(authenticated, null);
    }

    const projected = loadProjectedRecords();
    const allowed = prepareAllowedRecentDecisionsResponse(projected);
    return this.commitRecentDecisionsResponse(authenticated, allowed);
  }

  private reviewerRecentDecisionsRead<T>(
    operation: (transaction: AuthorityReadTransaction) => T,
  ): T {
    try {
      return this.repository.read(operation);
    } catch (error) {
      if (error instanceof ReviewerRecentDecisionsError) throw error;
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'authority state is unavailable for reviewer recent decisions',
        { cause: error },
      );
    }
  }

  private reviewerRecentDecisionsPersonSnapshot(
    transaction: AuthorityReadTransaction,
    authenticated: AuthenticatedReviewerRecentDecisionsRequest,
    checkedAt: string,
  ): ReviewerRecentDecisionsPersonSnapshot {
    const { request } = authenticated;
    const enrollment = transaction.enrollmentById(request.enrollment_id);
    if (enrollment === undefined) {
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'authenticated reviewer enrollment disappeared',
      );
    }
    const membership = transaction.membership(enrollment.membership_id);
    const access = transaction.currentAccessState(enrollment.enrollment_id);
    if (membership === undefined || access === undefined) {
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'reviewer current Person state is incomplete',
      );
    }
    if (
      request.authority_id !== this.descriptorValue.authority_id ||
      request.organization_id !== this.descriptorValue.organization_id ||
      enrollment.authority_id !== request.authority_id ||
      enrollment.organization_id !== request.organization_id ||
      enrollment.enrollment_id !== request.enrollment_id ||
      enrollment.installation_id !== request.installation_id ||
      enrollment.installation_signing_key.key_id !==
        request.installation_key_id ||
      membership.organization_id !== enrollment.organization_id ||
      membership.membership_id !== enrollment.membership_id ||
      membership.principal_id !== enrollment.principal_id ||
      access.enrollment_id !== enrollment.enrollment_id
    ) {
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'reviewer current Person state is inconsistent',
      );
    }
    const state: ReviewerRecentDecisionsPersonState = {
      membership_id: membership.membership_id,
      principal_id: membership.principal_id,
      membership_status: membership.status,
      enrollment_id: enrollment.enrollment_id,
      enrollment_status: enrollment.status,
      installation_id: enrollment.installation_id,
      installation_key_id: enrollment.installation_signing_key.key_id,
      access_state_sequence: access.state.access_state_sequence,
      access_state_sha256: access.state_sha256,
      access_status: access.state.status,
      access_valid_until: access.state.valid_until,
      checked_at: checkedAt,
    };
    const stateSha256 = canonicalSha256(state);
    if (
      membership.status !== 'active' ||
      enrollment.status !== 'active' ||
      access.state.status !== 'active'
    ) {
      return {
        state,
        state_sha256: stateSha256,
        decision: 'not_found',
        governed_reason: 'inactive_or_unbound_reviewer_membership',
      };
    }
    if (access.state.valid_until === null) {
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'active reviewer access state has no expiry',
      );
    }
    if (
      timestampMillis(
        access.state.valid_until,
        'reviewer access lease expiry',
      ) <= timestampMillis(checkedAt, 'reviewer Person check time')
    ) {
      return {
        state,
        state_sha256: stateSha256,
        decision: 'expired',
        governed_reason: 'installation_access_expired',
      };
    }
    return {
      state,
      state_sha256: stateSha256,
      decision: 'eligible',
      governed_reason: 'active_exact_reviewer_membership',
    };
  }

  private preparedReviewerRecentDecisionsDenial(
    snapshot: ReviewerRecentDecisionsPersonSnapshot,
  ): PreparedReviewerRecentDecisionsResponse {
    return preparedReviewerDenial(snapshot.decision === 'expired' ? 401 : 404);
  }

  private commitReviewerRecentDecisionsResponse(
    authenticated: AuthenticatedReviewerRecentDecisionsRequest,
    allowed:
      | {
          readonly prepared: PreparedReviewerRecentDecisionsResponse;
          readonly source: ReviewerRecentDecisionsSourceOutput;
          readonly resolved_reviewer_principal_id: string;
          readonly resolved_reviewer_membership_id: string;
        }
      | null,
  ): PreparedReviewerRecentDecisionsResponse {
    try {
      return this.repository.writeAtLinearization(
        () => this.now('reviewer recent decisions authorization commit time'),
        (transaction, checkedAt) => {
          const snapshot = this.reviewerRecentDecisionsPersonSnapshot(
            transaction,
            authenticated,
            checkedAt,
          );
          if (allowed === null && snapshot.decision === 'eligible') {
            throw new ReviewerRecentDecisionsError(
              'unavailable',
              'reviewer Person state changed before denial commit',
            );
          }
          // The source selected every fact under this exact tuple. Requiring
          // the final Person root to reproduce it reruns the reviewer resolver
          // for the complete immutable selection without reopening content in
          // the Authority transaction.
          const resolverStillMatches =
            allowed !== null &&
            snapshot.state.principal_id ===
              allowed.resolved_reviewer_principal_id &&
            snapshot.state.membership_id ===
              allowed.resolved_reviewer_membership_id;
          const isAllow =
            allowed !== null &&
            snapshot.decision === 'eligible' &&
            resolverStillMatches;
          const prepared = isAllow
            ? allowed.prepared
            : this.preparedReviewerRecentDecisionsDenial(snapshot);
          const requester = {
            principal_id: snapshot.state.principal_id,
            membership_id: snapshot.state.membership_id,
            enrollment_id: snapshot.state.enrollment_id,
            installation_id: snapshot.state.installation_id,
          };
          const responseSha256 = sha256Digest(prepared.body);
          const detail = isAllow
            ? reviewerAllowAuditDetail({
                request_id: authenticated.request.request_id,
                request_sha256: authenticated.request_sha256,
                requester,
                person_state_sha256: snapshot.state_sha256,
                record_head: allowed.source.record_head,
                returned_atom_ids: prepared.returned_atom_ids,
                returned_record_hashes: prepared.returned_record_hashes,
                evaluated_at: checkedAt,
                response_sha256: responseSha256,
              })
            : reviewerDenialAuditDetail({
                request_id: authenticated.request.request_id,
                request_sha256: authenticated.request_sha256,
                requester,
                reason_code:
                  snapshot.decision === 'expired'
                    ? 'installation_access_expired'
                    : 'inactive_or_unbound_reviewer_membership',
                person_state_sha256: snapshot.state_sha256,
                evaluated_at: checkedAt,
                response_sha256: responseSha256,
              });
          transaction.appendReviewerQueryAudit({
            decision: isAllow ? 'allow' : 'deny',
            reason_code: isAllow
              ? 'active_exact_reviewer_membership'
              : snapshot.decision === 'expired'
                ? 'installation_access_expired'
                : 'inactive_or_unbound_reviewer_membership',
            detail,
            response_bytes: prepared.body,
          });
          return prepared;
        },
      );
    } catch (error) {
      if (error instanceof ReviewerRecentDecisionsError) throw error;
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'reviewer recent decisions audit commit is unavailable',
        { cause: error },
      );
    }
  }

  /**
   * Authenticates and fences the exact reviewer-only read.  The injected
   * source is called only after the current Person root is active and returns
   * immutable record selections; the final transaction rechecks the same
   * principal/membership and commits the exact response digest before bytes
   * leave this method.
   */
  serveReviewerRecentDecisions(
    input: OrganizationReviewerRecentDecisionsRequestV1,
    source: (
      input: ReviewerRecentDecisionsSourceInput,
    ) => ReviewerRecentDecisionsSourceOutput,
  ): PreparedReviewerRecentDecisionsResponse {
    let request: OrganizationReviewerRecentDecisionsRequestV1;
    try {
      request = validateOrganizationReviewerRecentDecisionsRequest(input);
      request = JSON.parse(
        canonicalJson(request),
      ) as OrganizationReviewerRecentDecisionsRequestV1;
    } catch (error) {
      if (!isOrganizationApiValidationError(error)) throw error;
      throw new ReviewerRecentDecisionsError(
        'invalid_request',
        'reviewer recent decisions request is invalid',
        { cause: error },
      );
    }
    const enrollment = this.reviewerRecentDecisionsRead((transaction) =>
      transaction.enrollmentById(request.enrollment_id),
    );
    if (enrollment === undefined) {
      throw new ReviewerRecentDecisionsError(
        'unauthorized',
        'reviewer recent decisions authentication failed',
      );
    }
    let requestSha256: Sha256Digest;
    try {
      requestSha256 = this.authenticateInstallationCommand(
        request,
        enrollment,
        'reviewer recent decisions request',
      );
    } catch (error) {
      if (
        error instanceof AuthorityOperationError &&
        error.code === 'unauthorized'
      ) {
        throw new ReviewerRecentDecisionsError(
          'unauthorized',
          'reviewer recent decisions authentication failed',
          { cause: error },
        );
      }
      throw error;
    }
    const checkedAt = this.now(
      'reviewer recent decisions initial authorization time',
    );
    try {
      assertFreshInstallationRequest(
        request.requested_at,
        checkedAt,
        this.accessRequestMaximumAgeMs,
        'reviewer recent decisions request',
      );
    } catch (error) {
      throw new ReviewerRecentDecisionsError(
        'unauthorized',
        'reviewer recent decisions request is outside the accepted time window',
        { cause: error },
      );
    }
    const authenticated = Object.freeze({
      request,
      request_sha256: requestSha256,
    });
    const initial = this.reviewerRecentDecisionsRead((transaction) =>
      this.reviewerRecentDecisionsPersonSnapshot(
        transaction,
        authenticated,
        checkedAt,
      ),
    );
    if (initial.decision !== 'eligible') {
      return this.commitReviewerRecentDecisionsResponse(authenticated, null);
    }
    let selected: ReviewerRecentDecisionsSourceOutput;
    try {
      selected = source({
        request_sha256: requestSha256,
        reviewer_principal_id: initial.state.principal_id,
        reviewer_membership_id: initial.state.membership_id,
      });
    } catch (error) {
      if (error instanceof ReviewerRecentDecisionsError) throw error;
      throw new ReviewerRecentDecisionsError(
        'unavailable',
        'reviewer record selection is unavailable',
        { cause: error },
      );
    }
    const prepared = prepareReviewerRecentDecisionsResponse(selected.items);
    return this.commitReviewerRecentDecisionsResponse(authenticated, {
      prepared,
      source: selected,
      resolved_reviewer_principal_id: initial.state.principal_id,
      resolved_reviewer_membership_id: initial.state.membership_id,
    });
  }

  checkPermissionSubject(
    request: OrganizationPermissionCheckRequestV1,
    target: OrganizationPermissionAuthorityTarget | null,
  ): OrganizationPermissionAuthorityStatus {
    return this.permissionSubjectStatus(
      JSON.parse(
        canonicalJson(validateOrganizationPermissionCheckRequest(request)),
      ) as OrganizationPermissionCheckRequestV1,
      target,
    );
  }

  /**
   * The schema-v2 twin. It authenticates the reviewer request with the closed
   * v2 validator and then reuses the one current-Person evaluation: schema-v1
   * status and body behavior stay byte-for-byte unchanged.
   */
  checkReviewerPermissionSubject(
    request: OrganizationReviewerPermissionCheckRequestV2,
    target: OrganizationPermissionAuthorityTarget | null,
  ): OrganizationPermissionAuthorityStatus {
    return this.permissionSubjectStatus(
      JSON.parse(
        canonicalJson(
          validateOrganizationReviewerPermissionCheckRequest(request),
        ),
      ) as OrganizationReviewerPermissionCheckRequestV2,
      target,
    );
  }

  /**
   * Schema-v3 uses the same current-Person status calculation as the earlier
   * permission checks, after authenticating its own closed request contract.
   * Keeping this entry point separate prevents a schema-v3 request from being
   * reinterpreted through either v1 or v2 validation.
   */
  checkOrganizationMemberReadablePermissionSubject(
    request: OrganizationMemberReadablePermissionCheckRequestV3,
    target: OrganizationPermissionAuthorityTarget | null,
  ): OrganizationPermissionAuthorityStatus {
    return this.permissionSubjectStatus(
      JSON.parse(
        canonicalJson(
          validateOrganizationMemberReadablePermissionCheckRequest(request),
        ),
      ) as OrganizationMemberReadablePermissionCheckRequestV3,
      target,
    );
  }

  private permissionSubjectStatus(
    request:
      | OrganizationPermissionCheckRequestV1
      | OrganizationReviewerPermissionCheckRequestV2
      | OrganizationMemberReadablePermissionCheckRequestV3,
    target: OrganizationPermissionAuthorityTarget | null,
  ): OrganizationPermissionAuthorityStatus {
    if (target !== null) {
      try {
        assertFederationId(
          target.principal_id,
          'prn',
          'permission check target principal',
        );
        assertFederationId(
          target.membership_id,
          'mem',
          'permission check target membership',
        );
      } catch {
        throw new AuthorityOperationError(
          'invalid_request',
          'permission check target is invalid',
        );
      }
    }
    const enrollment = this.repository.read((transaction) =>
      transaction.enrollmentById(request.enrollment_id),
    );
    if (enrollment === undefined) {
      throw new AuthorityOperationError(
        'unauthorized',
        'permission check request authentication failed',
      );
    }
    const requestSha256 = this.authenticateInstallationCommand(
      request,
      enrollment,
      'permission check request',
    );
    return this.repository.read((transaction) => {
      const currentEnrollment = transaction.enrollmentById(
        request.enrollment_id,
      );
      if (currentEnrollment === undefined) {
        throw new Error(
          'authenticated permission check enrollment disappeared',
        );
      }
      const installationMembership = transaction.membership(
        currentEnrollment.membership_id,
      );
      const currentAccess = requireCurrentAccessState(
        transaction,
        currentEnrollment.enrollment_id,
      );
      const targetMembership =
        target === null
          ? undefined
          : transaction.membership(target.membership_id);
      const evaluatedAt = this.now('permission check evaluation time');
      assertFreshInstallationRequest(
        request.requested_at,
        evaluatedAt,
        this.accessRequestMaximumAgeMs,
        'permission check request',
      );
      const accessActive =
        currentAccess.state.status === 'active' &&
        timestampMillis(
          currentAccess.state.valid_until,
          'permission check access lease expiry',
        ) >
          timestampMillis(evaluatedAt, 'permission check evaluation time');
      const installationActive =
        currentEnrollment.status === 'active' &&
        installationMembership?.organization_id === request.organization_id &&
        installationMembership.principal_id ===
          currentEnrollment.principal_id &&
        installationMembership.status === 'active' &&
        accessActive;
      const targetActive =
        target === null
          ? null
          : targetMembership?.organization_id === request.organization_id &&
            targetMembership.principal_id === target.principal_id &&
            targetMembership.status === 'active';
      return {
        request_sha256: requestSha256,
        provider_event_sha256: request.provider_event_sha256,
        authority_id: request.authority_id,
        organization_id: request.organization_id,
        enrollment_id: currentEnrollment.enrollment_id,
        installation_id: currentEnrollment.installation_id,
        installation_key_id: currentEnrollment.installation_signing_key.key_id,
        installation_principal_id: currentEnrollment.principal_id,
        installation_membership_id: currentEnrollment.membership_id,
        installation_active: installationActive,
        target_principal_id: target?.principal_id ?? null,
        target_membership_id: target?.membership_id ?? null,
        target_active: targetActive,
        evaluated_at: evaluatedAt,
      };
    });
  }

  private storedLeaseResponse(
    transaction: AuthorityReadTransaction,
    requestSha256: Sha256Digest,
    request: OrganizationAccessLeaseRequestV1,
  ): OrganizationInstallationAccessStateV1 | undefined {
    const stored = transaction.accessLeaseRequestByDigest(requestSha256);
    if (stored === undefined) return undefined;
    if (canonicalJson(stored.request) !== canonicalJson(request)) {
      throw new Error('stored access request digest is inconsistent');
    }
    const state = transaction.accessStateByDigest(
      stored.resulting_state_sha256,
    );
    if (state === undefined || state.enrollment_id !== stored.enrollment_id) {
      throw new Error('stored access request result is inconsistent');
    }
    return state.state;
  }

  async issueAccessLease(
    command: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationInstallationAccessStateV1> {
    command = validateOrganizationAccessLeaseRequest(command);
    command = JSON.parse(
      canonicalJson(command),
    ) as OrganizationAccessLeaseRequestV1;
    const enrollment = this.repository.read((transaction) =>
      requireEnrollment(transaction, command.enrollment_id),
    );
    const requestSha256 = this.authenticateAccessCommand(command, enrollment);
    const replay = this.repository.read((transaction) =>
      this.storedLeaseResponse(transaction, requestSha256, command),
    );
    if (replay !== undefined) return replay;
    const requestedAt = this.now('access lease request receipt time');
    assertFreshAccessRequest(
      command.requested_at,
      requestedAt,
      this.accessRequestMaximumAgeMs,
    );
    const requestedAtMillis = timestampMillis(
      requestedAt,
      'access lease request receipt time',
    );
    const commandRequestedAtMillis = timestampMillis(
      command.requested_at,
      'access lease request requested_at',
    );

    const snapshot = this.repository.read((transaction) => {
      const currentEnrollment = requireEnrollment(
        transaction,
        command.enrollment_id,
      );
      const duplicateId = transaction.accessLeaseRequestById(
        command.enrollment_id,
        command.request_id,
      );
      if (
        duplicateId !== undefined &&
        duplicateId.request_sha256 !== requestSha256
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'access request_id was reused with different content',
        );
      }
      const namedPrevious = transaction.accessStateByDigest(
        command.previous_access_state_sha256,
      );
      if (
        namedPrevious === undefined ||
        namedPrevious.enrollment_id !== currentEnrollment.enrollment_id
      ) {
        throw new AuthorityOperationError(
          'unauthorized',
          'access lease request names an unknown previous state',
        );
      }
      return {
        enrollment: currentEnrollment,
        membership: transaction.membership(currentEnrollment.membership_id),
        namedPrevious,
        current: requireCurrentAccessState(
          transaction,
          currentEnrollment.enrollment_id,
        ),
      };
    });
    let recoveringExpiredStaleHead = false;
    if (snapshot.enrollment.status === 'active') {
      if (
        snapshot.membership === undefined ||
        snapshot.membership.status !== 'active'
      ) {
        throw new Error('active enrollment has no active membership');
      }
      if (
        command.previous_access_state_sha256 !== snapshot.current.state_sha256
      ) {
        // V1 recovers exactly one skipped head. Allowing older ancestors would
        // let a briefly held installation key pre-sign future renewals. If the
        // recovery 409 is lost until its replacement expires, operator repair
        // remains the deliberately narrow fallback.
        recoveringExpiredStaleHead = canRecoverExpiredStaleAccessHead({
          namedPrevious: snapshot.namedPrevious,
          current: snapshot.current,
          commandRequestedAtMillis,
          authorityReceivedAtMillis: requestedAtMillis,
        });
        if (!recoveringExpiredStaleHead) {
          throw new StaleAccessStateError(snapshot.current.state);
        }
      }
    }

    let candidate: StoredAuthorityAccessState | undefined;
    if (snapshot.enrollment.status === 'active') {
      const state = await createOrganizationInstallationAccessState(
        {
          request: snapshot.enrollment.request,
          receipt: snapshot.enrollment.receipt,
          previous_state: snapshot.current.state,
          access_state_sequence:
            snapshot.current.state.access_state_sequence + 1,
          evaluated_at: requestedAt,
          status: 'active',
          valid_until: addMilliseconds(requestedAt, this.activeLeaseTtlMs),
          maximum_active_ttl_ms: this.activeLeaseTtlMs,
        },
        this.pinnedAuthority,
        (bytes) => this.signCanonicalPayload(bytes),
      );
      candidate = {
        enrollment_id: snapshot.enrollment.enrollment_id,
        state_sha256: canonicalSha256(state),
        state,
      };
    }

    const commitAt = this.now('access lease commit time');
    if (commitAt < requestedAt) {
      throw new Error('authority clock regressed while issuing access lease');
    }
    if (
      candidate?.state.status === 'active' &&
      commitAt >= candidate.state.valid_until
    ) {
      throw new AuthorityOperationError(
        'conflict',
        'access-state signing exceeded the active lease',
      );
    }
    const committed = this.repository.write(commitAt, (transaction) => {
      const exact = this.storedLeaseResponse(
        transaction,
        requestSha256,
        command,
      );
      if (exact !== undefined) {
        return { kind: 'response' as const, state: exact };
      }
      const duplicateId = transaction.accessLeaseRequestById(
        command.enrollment_id,
        command.request_id,
      );
      if (duplicateId !== undefined) {
        throw new AuthorityOperationError(
          'conflict',
          'access request_id was reused with different content',
        );
      }
      const currentEnrollment = requireEnrollment(
        transaction,
        command.enrollment_id,
      );
      const current = requireCurrentAccessState(
        transaction,
        command.enrollment_id,
      );
      let resulting = current;
      if (currentEnrollment.status === 'active') {
        const membership = transaction.membership(
          currentEnrollment.membership_id,
        );
        if (membership === undefined || membership.status !== 'active') {
          throw new Error('active enrollment has no active membership');
        }
        if (recoveringExpiredStaleHead) {
          const namedPrevious = transaction.accessStateByDigest(
            command.previous_access_state_sha256,
          );
          if (
            current.state_sha256 !== snapshot.current.state_sha256 ||
            current.state.status !== 'active' ||
            namedPrevious === undefined ||
            namedPrevious.enrollment_id !== currentEnrollment.enrollment_id ||
            !canRecoverExpiredStaleAccessHead({
              namedPrevious,
              current,
              commandRequestedAtMillis,
              authorityReceivedAtMillis: requestedAtMillis,
            })
          ) {
            throw new StaleAccessStateError(current.state);
          }
        } else if (
          current.state_sha256 !== command.previous_access_state_sha256
        ) {
          throw new StaleAccessStateError(current.state);
        }
        if (candidate === undefined) {
          throw new Error('active access lease candidate is unavailable');
        }
        transaction.insertAccessState(candidate);
        resulting = candidate;
        if (recoveringExpiredStaleHead) {
          transaction.appendAudit({
            occurred_at: commitAt,
            actor_kind: 'installation',
            action: 'access_lease.recovered',
            subject_id: currentEnrollment.installation_id,
            detail: {
              request_id: command.request_id,
              request_sha256: requestSha256,
              named_access_state_sha256: command.previous_access_state_sha256,
              recovered_access_state_sequence:
                current.state.access_state_sequence,
              access_state_sequence: candidate.state.access_state_sequence,
            },
          });
          return { kind: 'stale_recovery' as const, state: candidate.state };
        }
      }
      const requestRecord: StoredAccessLeaseRequest = {
        request_id: command.request_id,
        request_sha256: requestSha256,
        request: command,
        enrollment_id: command.enrollment_id,
        previous_access_state_sha256: command.previous_access_state_sha256,
        resulting_state_sha256: resulting.state_sha256,
        received_at: commitAt,
      };
      transaction.insertAccessLeaseRequest(requestRecord);
      transaction.appendAudit({
        occurred_at: commitAt,
        actor_kind: 'installation',
        action:
          resulting.state.status === 'active'
            ? 'access_lease.issued'
            : 'access_lease.revoked_state_returned',
        subject_id: currentEnrollment.installation_id,
        detail: {
          request_id: command.request_id,
          access_state_sequence: resulting.state.access_state_sequence,
        },
      });
      return { kind: 'response' as const, state: resulting.state };
    });
    if (committed.kind === 'stale_recovery') {
      throw new StaleAccessStateError(committed.state);
    }
    return committed.state;
  }

  async revokeInstallation(
    installationId: string,
    reason: string,
  ): Promise<OrganizationInstallationAccessStateV1> {
    assertFederationId(installationId, 'ins', 'revoked installation');
    assertRevocationReason(reason);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      const snapshot = this.repository.read((transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        return {
          enrollment,
          current: requireCurrentAccessState(
            transaction,
            enrollment.enrollment_id,
          ),
        };
      });
      if (snapshot.enrollment.status === 'revoked') {
        return snapshot.current.state;
      }
      const evaluatedAt = this.now('installation revocation time');
      const state = await createOrganizationInstallationAccessState(
        {
          request: snapshot.enrollment.request,
          receipt: snapshot.enrollment.receipt,
          previous_state: snapshot.current.state,
          access_state_sequence:
            snapshot.current.state.access_state_sequence + 1,
          evaluated_at: evaluatedAt,
          status: 'revoked',
          revocation_reason: 'installation_revoked',
        },
        this.pinnedAuthority,
        (bytes) => this.signCanonicalPayload(bytes),
      );
      const candidate: StoredAuthorityAccessState = {
        enrollment_id: snapshot.enrollment.enrollment_id,
        state_sha256: canonicalSha256(state),
        state,
      };
      const commitAt = this.now('installation revocation commit time');
      if (commitAt < evaluatedAt) {
        throw new Error(
          'authority clock regressed while revoking installation',
        );
      }
      const result = this.repository.write(commitAt, (transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        const current = requireCurrentAccessState(
          transaction,
          enrollment.enrollment_id,
        );
        if (enrollment.status === 'revoked') return current.state;
        if (current.state_sha256 !== snapshot.current.state_sha256) return null;
        transaction.insertAccessState(candidate);
        if (
          !transaction.revokeEnrollment(
            enrollment.enrollment_id,
            commitAt,
            'installation_revoked',
            reason,
          )
        ) {
          throw new Error(
            'installation enrollment changed inside its revocation transaction',
          );
        }
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'admin',
          action: 'installation.revoked',
          subject_id: installationId,
          detail: { reason },
        });
        return state;
      });
      if (result !== null) return result;
    }
    throw new AuthorityOperationError(
      'conflict',
      'installation revocation could not serialize',
    );
  }

  /**
   * The operator repair for an installation stranded further behind than the
   * one skipped head automatic recovery covers. It appends exactly one ordinary
   * active head to the same chain: history is never rewritten or deleted, the
   * sequence and TTL rules are the ordinary ones, and a revoked membership,
   * enrollment, or access head is never revived.
   *
   * The reported sequence is the operator's word for what the stranded
   * installation holds locally, and nothing here proves that laptop state.
   * Access history is a dense chain from sequence one, so a positive reported
   * sequence at least two behind the current head necessarily names a real
   * earlier state of this enrollment and looking it up would establish nothing.
   * The sequence only establishes that the reported head is too far behind for
   * automatic recovery; it never selects the parent of the new head, which is
   * always the current head.
   */
  async recoverInstallationAccess(
    installationId: string,
    command: RecoverOrganizationInstallationAccessRequestV1,
  ): Promise<RecoveredOrganizationInstallationAccessV1> {
    assertFederationId(installationId, 'ins', 'recovered installation');
    // The shared request validator is the only bound on the reason and the
    // reported sequence, so an in-process caller cannot skip what the route
    // applies.
    command = validateRecoverOrganizationInstallationAccessRequest(command);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      const snapshot = this.repository.read((transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        return {
          enrollment,
          membership: transaction.membership(enrollment.membership_id),
          current: requireCurrentAccessState(
            transaction,
            enrollment.enrollment_id,
          ),
        };
      });
      if (snapshot.enrollment.status !== 'active') {
        throw new AuthorityOperationError(
          'conflict',
          'installation enrollment is not active',
        );
      }
      if (
        snapshot.membership === undefined ||
        snapshot.membership.status !== 'active'
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'installation membership is not active',
        );
      }
      const current = snapshot.current.state;
      if (current.status !== 'active') {
        throw new AuthorityOperationError(
          'conflict',
          'current installation access is not active',
        );
      }
      if (
        current.access_state_sequence - command.local_access_state_sequence <
        MINIMUM_ORGANIZATION_ACCESS_RECOVERY_GAP
      ) {
        throw new AuthorityOperationError(
          'conflict',
          'reported local access state is within automatic recovery range',
        );
      }
      const requestedAt = this.now('installation access recovery time');
      if (
        timestampMillis(current.valid_until, 'current access state expiry') >
        timestampMillis(requestedAt, 'installation access recovery time')
      ) {
        // Returning the head unchanged avoids unnecessary chain churn while a
        // usable live head exists, and is what makes a retry safe.
        return recoveredInstallationAccess({
          installation_id: installationId,
          changed: false,
          local_access_state_sequence: command.local_access_state_sequence,
          state: current,
        });
      }

      const state = await createOrganizationInstallationAccessState(
        {
          request: snapshot.enrollment.request,
          receipt: snapshot.enrollment.receipt,
          previous_state: current,
          access_state_sequence: current.access_state_sequence + 1,
          evaluated_at: requestedAt,
          status: 'active',
          valid_until: addMilliseconds(requestedAt, this.activeLeaseTtlMs),
          maximum_active_ttl_ms: this.activeLeaseTtlMs,
        },
        this.pinnedAuthority,
        (bytes) => this.signCanonicalPayload(bytes),
      );
      const candidate: StoredAuthorityAccessState = {
        enrollment_id: snapshot.enrollment.enrollment_id,
        state_sha256: canonicalSha256(state),
        state,
      };
      const commitAt = this.now('installation access recovery commit time');
      if (commitAt < requestedAt) {
        throw new Error(
          'authority clock regressed while recovering installation access',
        );
      }
      if (state.status !== 'active' || commitAt >= state.valid_until) {
        throw new AuthorityOperationError(
          'conflict',
          'access-state signing exceeded the active lease',
        );
      }

      const committed = this.repository.write(commitAt, (transaction) => {
        const enrollment = transaction.enrollmentByInstallation(installationId);
        if (enrollment === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'installation was not found',
          );
        }
        const membership = transaction.membership(enrollment.membership_id);
        // The head digest is the whole precondition: an unchanged head carries
        // the same sequence, status, and expiry every check above was made
        // against.
        if (
          enrollment.status !== 'active' ||
          membership === undefined ||
          membership.status !== 'active' ||
          requireCurrentAccessState(transaction, enrollment.enrollment_id)
            .state_sha256 !== snapshot.current.state_sha256
        ) {
          return null;
        }
        transaction.insertAccessState(candidate);
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'admin',
          action: 'installation.access_recovered',
          subject_id: installationId,
          detail: {
            reason: command.reason,
            local_access_state_sequence: command.local_access_state_sequence,
            recovered_access_state_sequence: current.access_state_sequence,
            access_state_sequence: candidate.state.access_state_sequence,
          },
        });
        return state;
      });
      if (committed !== null) {
        return recoveredInstallationAccess({
          installation_id: installationId,
          changed: true,
          local_access_state_sequence: command.local_access_state_sequence,
          state: committed,
        });
      }
    }
    throw new AuthorityOperationError(
      'conflict',
      'installation access recovery could not serialize',
    );
  }

  async revokeMembership(
    membershipId: string,
    reason: string,
  ): Promise<RevokedMembershipResult> {
    assertFederationId(membershipId, 'mem', 'revoked membership');
    assertRevocationReason(reason);
    for (let attempt = 0; attempt < MAX_TRANSITION_RETRIES; attempt += 1) {
      const snapshot = this.repository.read((transaction) => {
        const membership = transaction.membership(membershipId);
        if (membership === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'membership was not found',
          );
        }
        const enrollments = transaction.enrollmentsForMembership(membershipId);
        return {
          membership,
          enrollments: enrollments.map((enrollment) => ({
            enrollment,
            current: requireCurrentAccessState(
              transaction,
              enrollment.enrollment_id,
            ),
          })),
        };
      });
      if (snapshot.membership.status === 'revoked') {
        return {
          membership: snapshot.membership,
          installations: snapshot.enrollments.map(
            ({ enrollment, current }) => ({
              installation_id: enrollment.installation_id,
              access_state: current.state,
            }),
          ),
        };
      }
      const evaluatedAt = this.now('membership revocation time');
      const candidates = new Map<string, StoredAuthorityAccessState>();
      for (const { enrollment, current } of snapshot.enrollments) {
        if (enrollment.status === 'revoked') continue;
        const state = await createOrganizationInstallationAccessState(
          {
            request: enrollment.request,
            receipt: enrollment.receipt,
            previous_state: current.state,
            access_state_sequence: current.state.access_state_sequence + 1,
            evaluated_at: evaluatedAt,
            status: 'revoked',
            revocation_reason: 'membership_revoked',
          },
          this.pinnedAuthority,
          (bytes) => this.signCanonicalPayload(bytes),
        );
        candidates.set(enrollment.enrollment_id, {
          enrollment_id: enrollment.enrollment_id,
          state_sha256: canonicalSha256(state),
          state,
        });
      }
      const commitAt = this.now('membership revocation commit time');
      if (commitAt < evaluatedAt) {
        throw new Error('authority clock regressed while revoking membership');
      }
      const result = this.repository.write(commitAt, (transaction) => {
        const membership = transaction.membership(membershipId);
        if (membership === undefined) {
          throw new AuthorityOperationError(
            'not_found',
            'membership was not found',
          );
        }
        if (membership.status === 'revoked') return null;
        const currentEnrollments =
          transaction.enrollmentsForMembership(membershipId);
        if (
          currentEnrollments.length !== snapshot.enrollments.length ||
          currentEnrollments.some(
            (enrollment, index) =>
              enrollment.enrollment_id !==
              snapshot.enrollments[index]?.enrollment.enrollment_id,
          )
        ) {
          return null;
        }
        for (const item of snapshot.enrollments) {
          const enrollment = transaction.enrollmentById(
            item.enrollment.enrollment_id,
          );
          const current = requireCurrentAccessState(
            transaction,
            item.enrollment.enrollment_id,
          );
          if (
            enrollment === undefined ||
            enrollment.status !== item.enrollment.status ||
            current.state_sha256 !== item.current.state_sha256
          ) {
            return null;
          }
        }
        if (!transaction.revokeMembership(membershipId, commitAt, reason)) {
          return null;
        }
        for (const item of snapshot.enrollments) {
          if (item.enrollment.status === 'revoked') continue;
          const candidate = candidates.get(item.enrollment.enrollment_id);
          if (candidate === undefined) {
            throw new Error('membership revocation candidate is unavailable');
          }
          transaction.insertAccessState(candidate);
          if (
            !transaction.revokeEnrollment(
              item.enrollment.enrollment_id,
              commitAt,
              'membership_revoked',
              reason,
            )
          ) {
            throw new Error(
              'membership enrollment revocation lost its transaction race',
            );
          }
        }
        transaction.appendAudit({
          occurred_at: commitAt,
          actor_kind: 'admin',
          action: 'membership.revoked',
          subject_id: membershipId,
          detail: { reason },
        });
        const storedMembership = transaction.membership(membershipId);
        if (storedMembership === undefined) {
          throw new Error('revoked membership disappeared');
        }
        return {
          membership: storedMembership,
          installations: transaction
            .enrollmentsForMembership(membershipId)
            .map((enrollment) => ({
              installation_id: enrollment.installation_id,
              access_state: requireCurrentAccessState(
                transaction,
                enrollment.enrollment_id,
              ).state,
            })),
        };
      });
      if (result !== null) return result;
    }
    throw new AuthorityOperationError(
      'conflict',
      'membership revocation could not serialize',
    );
  }
}
