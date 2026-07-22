import {
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
} from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  validateOrganizationAuthorityDescriptor,
  validateOrganizationInstallationAccessState,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationInstallationAccessState,
} from '@echo-brain/organization-protocol';
import type {
  OrganizationAuthorityDescriptorV1,
  OrganizationInstallationAccessStateV1,
  OrganizationMembershipTypeV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import { verifyOrganizationAccessLeaseRequest } from '@echo-brain/organization-api';
import type Database from 'better-sqlite3';
import { timestampMillis } from '../../../domain/rules.js';
import type {
  AuthorityAuditEntry,
  AuthorityReadTransaction,
  AuthorityWriteTransaction,
  InitializeAuthorityRepositoryInput,
  NewAuthorityEnrollment,
  OrganizationAuthorityRepository,
  StoredAccessLeaseRequest,
  StoredAuthorityAccessState,
  StoredAuthorityEnrollment,
  StoredAuthorityMembership,
  StoredAuthorityMetadata,
  StoredEnrollmentGrant,
} from '../../../application/ports/authority-repository.js';
import { openAuthorityDatabase } from './open-database.js';

interface MetadataRow {
  authority_id: string;
  organization_id: string;
  organization_display_name: string;
  authority_pin_sha256: string;
  descriptor_json: string;
  created_at: string;
  last_observed_at: string;
}

interface MembershipRow {
  organization_id: string;
  principal_organization_id: string;
  principal_id: string;
  membership_id: string;
  display_name: string;
  membership_type: string;
  status: string;
  provisioned_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface GrantRow {
  grant_sha256: string;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  request_sha256: string | null;
}

interface EnrollmentRow {
  enrollment_id: string;
  grant_sha256: string;
  request_sha256: string;
  request_json: string;
  receipt_sha256: string;
  receipt_json: string;
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: string;
  installation_id: string;
  installation_key_id: string;
  installation_public_key_spki_der_base64: string;
  status: string;
  enrolled_at: string;
  revoked_at: string | null;
  revocation_kind: string | null;
  revocation_reason: string | null;
}

interface AccessStateRow {
  enrollment_id: string;
  access_state_sequence: number;
  state_sha256: string;
  state_json: string;
  status: string;
  evaluated_at: string;
  valid_until: string | null;
  revocation_reason: string | null;
}

interface AccessLeaseRequestRow {
  request_id: string;
  request_sha256: string;
  request_json: string;
  enrollment_id: string;
  previous_access_state_sha256: string;
  resulting_state_sha256: string;
  received_at: string;
}

interface PersistedAuthorityTrustContext {
  descriptor: OrganizationAuthorityDescriptorV1;
  pinned_authority: PinnedOrganizationAuthority;
  authority_pin_sha256: Sha256Digest;
  organization_display_name: string;
  maximum_active_lease_ttl_ms: number;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`authority database invariant: ${message}`);
}

function assertDigest(
  value: string,
  label: string,
): asserts value is Sha256Digest {
  invariant(/^sha256:[0-9a-f]{64}$/.test(value), `${label} is not a digest`);
}

function parseStoredJson(value: string): unknown {
  const parsed = parseCanonicalJson(value);
  invariant(canonicalJson(parsed) === value, 'stored JSON is not canonical');
  return parsed;
}

function verifiedPersistedValue<T>(label: string, verify: () => T): T {
  try {
    return verify();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `authority database invariant: ${label} failed verification: ${detail}`,
    );
  }
}

class SqliteAuthorityTransaction
  implements AuthorityReadTransaction, AuthorityWriteTransaction
{
  private trustContext: PersistedAuthorityTrustContext | undefined;

  constructor(private readonly database: Database.Database) {}

  configureTrust(input: InitializeAuthorityRepositoryInput): void {
    const descriptor = validateOrganizationAuthorityDescriptor(
      input.descriptor,
    );
    const pinnedAuthority = verifyOrganizationAuthorityPin(
      descriptor,
      input.authority_pin_sha256,
    );
    invariant(
      Number.isSafeInteger(input.maximum_active_lease_ttl_ms) &&
        input.maximum_active_lease_ttl_ms > 0,
      'maximum active lease TTL is invalid',
    );
    this.trustContext = {
      descriptor,
      pinned_authority: pinnedAuthority,
      authority_pin_sha256: input.authority_pin_sha256,
      organization_display_name: input.organization_display_name,
      maximum_active_lease_ttl_ms: input.maximum_active_lease_ttl_ms,
    };
  }

  private trust(): PersistedAuthorityTrustContext {
    invariant(
      this.trustContext !== undefined,
      'repository trust context is not initialized',
    );
    return this.trustContext;
  }

  metadata(): StoredAuthorityMetadata {
    const trust = this.trust();
    const row = this.database
      .prepare(
        `SELECT authority_id, organization_id, organization_display_name,
                authority_pin_sha256, descriptor_json, created_at,
                last_observed_at
         FROM authority_metadata WHERE singleton = 1`,
      )
      .get() as MetadataRow | undefined;
    invariant(row !== undefined, 'authority metadata is missing');
    assertDigest(row.authority_pin_sha256, 'authority pin');
    const createdAt = timestampMillis(
      row.created_at,
      'stored authority creation time',
    );
    const lastObservedAt = timestampMillis(
      row.last_observed_at,
      'stored authority clock watermark',
    );
    invariant(
      lastObservedAt >= createdAt,
      'authority clock watermark predates creation',
    );
    const descriptor = validateOrganizationAuthorityDescriptor(
      parseStoredJson(row.descriptor_json),
    );
    invariant(
      canonicalSha256(descriptor) === row.authority_pin_sha256,
      'authority pin differs from descriptor',
    );
    invariant(
      canonicalJson(descriptor) === canonicalJson(trust.descriptor) &&
        row.authority_pin_sha256 === trust.authority_pin_sha256 &&
        row.authority_id === descriptor.authority_id &&
        row.organization_id === descriptor.organization_id &&
        row.organization_display_name === trust.organization_display_name,
      'authority metadata differs from configured trust root',
    );
    return {
      authority_id: row.authority_id,
      organization_id: row.organization_id,
      organization_display_name: row.organization_display_name,
      authority_pin_sha256: row.authority_pin_sha256 as Sha256Digest,
      descriptor,
      created_at: row.created_at,
      last_observed_at: row.last_observed_at,
    };
  }

  membership(membershipId: string): StoredAuthorityMembership | undefined {
    const trust = this.trust();
    const row = this.database
      .prepare(
        `SELECT m.organization_id, p.organization_id AS principal_organization_id,
                m.principal_id, m.membership_id,
                p.display_name, m.membership_type, m.status,
                m.provisioned_at, m.revoked_at, m.revocation_reason
         FROM authority_memberships m
         JOIN authority_principals p ON p.principal_id = m.principal_id
         WHERE m.membership_id = ?`,
      )
      .get(membershipId) as MembershipRow | undefined;
    if (row === undefined) return undefined;
    invariant(
      row.membership_type === 'owner' || row.membership_type === 'employee',
      'membership type is invalid',
    );
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'membership status is invalid',
    );
    invariant(
      row.organization_id === trust.descriptor.organization_id &&
        row.principal_organization_id === row.organization_id,
      'membership organization differs from configured authority',
    );
    const provisionedAt = timestampMillis(
      row.provisioned_at,
      'stored membership provisioning time',
    );
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(row.revoked_at, 'stored membership revocation time') >=
          provisionedAt,
        'membership revocation predates provisioning',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_reason !== null),
      'membership status columns are inconsistent',
    );
    return {
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      display_name: row.display_name,
      membership_type: row.membership_type as OrganizationMembershipTypeV1,
      status: row.status,
      provisioned_at: row.provisioned_at,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
    };
  }

  grant(grantSha256: Sha256Digest): StoredEnrollmentGrant | undefined {
    const trust = this.trust();
    const row = this.database
      .prepare(
        `SELECT grant_sha256, authority_id, organization_id, principal_id,
                membership_id, issued_at, expires_at, consumed_at,
                request_sha256
         FROM authority_enrollment_grants WHERE grant_sha256 = ?`,
      )
      .get(grantSha256) as GrantRow | undefined;
    if (row === undefined) return undefined;
    assertDigest(row.grant_sha256, 'enrollment grant');
    if (row.request_sha256 !== null) {
      assertDigest(row.request_sha256, 'enrollment request');
    }
    invariant(
      row.authority_id === trust.descriptor.authority_id &&
        row.organization_id === trust.descriptor.organization_id,
      'enrollment grant differs from configured authority',
    );
    const issuedAt = timestampMillis(
      row.issued_at,
      'stored enrollment grant issue time',
    );
    const expiresAt = timestampMillis(
      row.expires_at,
      'stored enrollment grant expiry time',
    );
    invariant(expiresAt > issuedAt, 'enrollment grant has an empty lifetime');
    if (row.consumed_at !== null) {
      const consumedAt = timestampMillis(
        row.consumed_at,
        'stored enrollment grant consumption time',
      );
      invariant(
        consumedAt >= issuedAt && consumedAt < expiresAt,
        'enrollment grant consumption is outside its lifetime',
      );
    }
    invariant(
      (row.consumed_at === null && row.request_sha256 === null) ||
        (row.consumed_at !== null && row.request_sha256 !== null),
      'enrollment grant consumption columns are inconsistent',
    );
    const membership = this.membership(row.membership_id);
    invariant(
      membership !== undefined &&
        membership.organization_id === row.organization_id &&
        membership.principal_id === row.principal_id,
      'enrollment grant differs from its membership',
    );
    return {
      ...row,
      grant_sha256: row.grant_sha256 as Sha256Digest,
      request_sha256: row.request_sha256 as Sha256Digest | null,
    };
  }

  private enrollmentFromRow(
    row: EnrollmentRow | undefined,
  ): StoredAuthorityEnrollment | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    invariant(
      row.membership_type === 'owner' || row.membership_type === 'employee',
      'enrollment membership type is invalid',
    );
    invariant(
      row.status === 'active' || row.status === 'revoked',
      'enrollment status is invalid',
    );
    invariant(
      row.revocation_kind === null ||
        row.revocation_kind === 'membership_revoked' ||
        row.revocation_kind === 'installation_revoked',
      'enrollment revocation kind is invalid',
    );
    const request = verifiedPersistedValue('enrollment request', () =>
      verifyOrganizationEnrollmentRequest(
        parseStoredJson(row.request_json),
        trust.pinned_authority,
      ),
    );
    const receipt = verifiedPersistedValue('enrollment receipt', () =>
      verifyOrganizationEnrollmentReceipt(
        parseStoredJson(row.receipt_json),
        trust.pinned_authority,
        request,
      ),
    );
    assertDigest(row.grant_sha256, 'stored enrollment grant');
    assertDigest(row.request_sha256, 'stored enrollment request');
    assertDigest(row.receipt_sha256, 'stored enrollment receipt');
    const requestSha256 = canonicalSha256(request);
    const receiptSha256 = canonicalSha256(receipt);
    invariant(
      requestSha256 === row.request_sha256 &&
        receiptSha256 === row.receipt_sha256 &&
        receipt.request_sha256 === requestSha256 &&
        request.enrollment_grant_sha256 === row.grant_sha256,
      'enrollment document digests differ from columns',
    );
    invariant(
      row.authority_id === trust.descriptor.authority_id &&
        row.organization_id === trust.descriptor.organization_id &&
        row.authority_id === request.authority_id &&
        row.authority_id === receipt.authority_id &&
        row.organization_id === request.organization_id &&
        row.organization_id === receipt.organization_id &&
        row.enrollment_id === receipt.enrollment_id &&
        row.principal_id === request.principal_id &&
        row.principal_id === receipt.principal_id &&
        row.membership_id === request.membership_id &&
        row.membership_id === receipt.membership_id &&
        row.membership_type === receipt.membership_type &&
        row.installation_id === request.installation_id &&
        row.installation_id === receipt.installation_id &&
        row.installation_key_id === request.installation_signing_key.key_id &&
        row.installation_key_id === receipt.installation_key_id &&
        row.installation_public_key_spki_der_base64 ===
          request.installation_signing_key.public_key_spki_der_base64 &&
        row.enrolled_at === receipt.enrolled_at,
      'enrollment columns differ from authenticated documents',
    );
    const enrolledAt = timestampMillis(
      row.enrolled_at,
      'stored enrollment time',
    );
    if (row.revoked_at !== null) {
      invariant(
        timestampMillis(row.revoked_at, 'stored enrollment revocation time') >=
          enrolledAt,
        'enrollment revocation predates enrollment',
      );
    }
    invariant(
      (row.status === 'active' &&
        row.revoked_at === null &&
        row.revocation_kind === null &&
        row.revocation_reason === null) ||
        (row.status === 'revoked' &&
          row.revoked_at !== null &&
          row.revocation_kind !== null &&
          row.revocation_reason !== null),
      'enrollment status columns are inconsistent',
    );
    const membership = this.membership(row.membership_id);
    invariant(
      membership !== undefined &&
        membership.organization_id === row.organization_id &&
        membership.principal_id === row.principal_id &&
        membership.membership_type === row.membership_type,
      'enrollment differs from its membership',
    );
    invariant(
      row.status !== 'active' || membership.status === 'active',
      'active enrollment belongs to a revoked membership',
    );
    invariant(
      row.revocation_kind !== 'membership_revoked' ||
        membership.status === 'revoked',
      'membership-revoked enrollment belongs to an active membership',
    );
    const grant = this.grant(row.grant_sha256 as Sha256Digest);
    invariant(
      grant !== undefined &&
        grant.consumed_at !== null &&
        grant.request_sha256 === row.request_sha256 &&
        grant.authority_id === row.authority_id &&
        grant.organization_id === row.organization_id &&
        grant.principal_id === row.principal_id &&
        grant.membership_id === row.membership_id &&
        timestampMillis(grant.issued_at, 'stored grant issue time') <=
          enrolledAt &&
        enrolledAt <
          timestampMillis(grant.expires_at, 'stored grant expiry time') &&
        timestampMillis(grant.consumed_at, 'stored grant consumption time') >=
          enrolledAt,
      'enrollment differs from its consumed grant',
    );
    return {
      enrollment_id: row.enrollment_id,
      grant_sha256: row.grant_sha256 as Sha256Digest,
      request_sha256: row.request_sha256 as Sha256Digest,
      request,
      receipt_sha256: row.receipt_sha256 as Sha256Digest,
      receipt,
      authority_id: row.authority_id,
      organization_id: row.organization_id,
      principal_id: row.principal_id,
      membership_id: row.membership_id,
      membership_type: row.membership_type,
      installation_id: row.installation_id,
      installation_signing_key: request.installation_signing_key,
      status: row.status,
      enrolled_at: row.enrolled_at,
      revoked_at: row.revoked_at,
      revocation_kind: row.revocation_kind,
      revocation_reason: row.revocation_reason,
    };
  }

  private enrollmentWhere(
    clause: string,
    value: string,
  ): StoredAuthorityEnrollment | undefined {
    const row = this.database
      .prepare(`SELECT * FROM authority_enrollments WHERE ${clause} = ?`)
      .get(value) as EnrollmentRow | undefined;
    return this.enrollmentFromRow(row);
  }

  enrollmentByGrant(
    grantSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('grant_sha256', grantSha256);
  }

  enrollmentByRequest(
    requestSha256: Sha256Digest,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('request_sha256', requestSha256);
  }

  enrollmentById(enrollmentId: string): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('enrollment_id', enrollmentId);
  }

  enrollmentByInstallation(
    installationId: string,
  ): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('installation_id', installationId);
  }

  enrollmentByKey(keyId: Sha256Digest): StoredAuthorityEnrollment | undefined {
    return this.enrollmentWhere('installation_key_id', keyId);
  }

  enrollmentsForMembership(membershipId: string): StoredAuthorityEnrollment[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM authority_enrollments
         WHERE membership_id = ? ORDER BY enrollment_id`,
      )
      .all(membershipId) as EnrollmentRow[];
    return rows.map((row) => {
      const enrollment = this.enrollmentFromRow(row);
      invariant(enrollment !== undefined, 'enrollment row disappeared');
      return enrollment;
    });
  }

  private validateAccessStateRow(
    row: AccessStateRow,
    enrollment: StoredAuthorityEnrollment,
  ): OrganizationInstallationAccessStateV1 {
    const state = validateOrganizationInstallationAccessState(
      parseStoredJson(row.state_json),
    );
    assertDigest(row.state_sha256, 'stored access state');
    invariant(
      row.enrollment_id === enrollment.enrollment_id &&
        state.enrollment_id === row.enrollment_id &&
        state.access_state_sequence === row.access_state_sequence &&
        state.status === row.status &&
        state.evaluated_at === row.evaluated_at &&
        state.valid_until === row.valid_until &&
        state.revocation_reason === row.revocation_reason,
      'access state columns differ from document',
    );
    invariant(
      canonicalSha256(state) === row.state_sha256,
      'access state digest differs from document',
    );
    return state;
  }

  private accessStateFromRow(
    row: AccessStateRow | undefined,
  ): StoredAuthorityAccessState | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    const enrollment = this.enrollmentById(row.enrollment_id);
    invariant(
      enrollment !== undefined,
      'access state enrollment is missing or invalid',
    );
    const state = this.validateAccessStateRow(row, enrollment);
    let previous: OrganizationInstallationAccessStateV1 | null = null;
    // Authenticate the replay target and its direct transition in O(1).
    // The schema trigger owns contiguous insertion and terminality, so replay
    // cost does not grow with years of five-minute lease history.
    if (row.access_state_sequence > 1) {
      const previousRow = this.database
        .prepare(
          `SELECT * FROM authority_access_states
           WHERE enrollment_id = ? AND access_state_sequence = ?`,
        )
        .get(row.enrollment_id, row.access_state_sequence - 1) as
        AccessStateRow | undefined;
      invariant(
        previousRow !== undefined,
        'access state immediate predecessor is missing',
      );
      previous = this.validateAccessStateRow(previousRow, enrollment);
      invariant(
        previous.access_state_sequence + 1 === state.access_state_sequence,
        'access state does not immediately follow its predecessor',
      );
      if (previous.status === 'active') {
        invariant(
          timestampMillis(
            previous.valid_until,
            'stored predecessor access state expiry',
          ) -
            timestampMillis(
              previous.evaluated_at,
              'stored predecessor access state evaluation time',
            ) <=
            trust.maximum_active_lease_ttl_ms,
          'predecessor access lease exceeds the configured maximum TTL',
        );
      }
    }
    const decision = verifiedPersistedValue(
      `access state sequence ${row.access_state_sequence}`,
      () =>
        verifyOrganizationInstallationAccessState({
          state,
          pinned_authority: trust.pinned_authority,
          enrollment_request: enrollment.request,
          enrollment_receipt: enrollment.receipt,
          now: state.evaluated_at,
          maximum_active_ttl_ms: trust.maximum_active_lease_ttl_ms,
          previous_state: previous,
        }),
    );
    const target: StoredAuthorityAccessState = {
      enrollment_id: row.enrollment_id,
      state_sha256: row.state_sha256 as Sha256Digest,
      state: decision.state,
    };

    const latest = this.database
      .prepare(
        `SELECT MAX(access_state_sequence) AS access_state_sequence
         FROM authority_access_states WHERE enrollment_id = ?`,
      )
      .get(row.enrollment_id) as { access_state_sequence: number | null };
    invariant(
      latest.access_state_sequence !== null,
      'access state high watermark is missing',
    );
    if (latest.access_state_sequence === target.state.access_state_sequence) {
      invariant(
        target.state.status === enrollment.status,
        'current access state differs from enrollment status',
      );
      if (target.state.status === 'revoked') {
        invariant(
          target.state.revocation_reason === enrollment.revocation_kind &&
            enrollment.revoked_at !== null &&
            timestampMillis(
              target.state.evaluated_at,
              'stored terminal access state evaluation time',
            ) <=
              timestampMillis(
                enrollment.revoked_at,
                'stored enrollment revocation time',
              ),
          'terminal access state differs from enrollment revocation',
        );
      }
    }
    return target;
  }

  currentAccessState(
    enrollmentId: string,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_states
         WHERE enrollment_id = ?
         ORDER BY access_state_sequence DESC LIMIT 1`,
      )
      .get(enrollmentId) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  accessState(
    enrollmentId: string,
    accessStateSequence: number,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_states
         WHERE enrollment_id = ? AND access_state_sequence = ?`,
      )
      .get(enrollmentId, accessStateSequence) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  accessStateByDigest(
    stateSha256: Sha256Digest,
  ): StoredAuthorityAccessState | undefined {
    const row = this.database
      .prepare('SELECT * FROM authority_access_states WHERE state_sha256 = ?')
      .get(stateSha256) as AccessStateRow | undefined;
    return this.accessStateFromRow(row);
  }

  private leaseRequestFromRow(
    row: AccessLeaseRequestRow | undefined,
  ): StoredAccessLeaseRequest | undefined {
    if (row === undefined) return undefined;
    const trust = this.trust();
    assertDigest(row.request_sha256, 'stored access request');
    assertDigest(
      row.previous_access_state_sha256,
      'stored previous access state',
    );
    assertDigest(row.resulting_state_sha256, 'stored resulting access state');
    const enrollment = this.enrollmentById(row.enrollment_id);
    invariant(
      enrollment !== undefined,
      'access request enrollment is missing or invalid',
    );
    const request = verifiedPersistedValue('access lease request', () =>
      verifyOrganizationAccessLeaseRequest(
        parseStoredJson(row.request_json),
        enrollment.installation_signing_key,
      ),
    );
    invariant(
      canonicalSha256(request) === row.request_sha256,
      'access request digest differs from document',
    );
    invariant(
      row.request_id === request.request_id &&
        row.enrollment_id === request.enrollment_id &&
        row.previous_access_state_sha256 ===
          request.previous_access_state_sha256 &&
        request.authority_id === trust.descriptor.authority_id &&
        request.authority_key_id === trust.descriptor.signing_key.key_id &&
        request.organization_id === trust.descriptor.organization_id &&
        request.enrollment_id === enrollment.enrollment_id &&
        request.installation_id === enrollment.installation_id &&
        request.installation_key_id ===
          enrollment.installation_signing_key.key_id,
      'access request columns or coordinates differ from authenticated document',
    );
    const receivedAt = timestampMillis(
      row.received_at,
      'stored access request receipt time',
    );
    const previous = this.accessStateByDigest(
      row.previous_access_state_sha256 as Sha256Digest,
    );
    const resulting = this.accessStateByDigest(
      row.resulting_state_sha256 as Sha256Digest,
    );
    invariant(
      previous !== undefined &&
        resulting !== undefined &&
        previous.enrollment_id === enrollment.enrollment_id &&
        resulting.enrollment_id === enrollment.enrollment_id,
      'access request state pointers differ from its enrollment',
    );
    invariant(
      resulting.state.access_state_sequence >=
        previous.state.access_state_sequence &&
        (resulting.state.status === 'revoked' ||
          resulting.state.access_state_sequence ===
            previous.state.access_state_sequence + 1),
      'access request result is not a valid successor',
    );
    invariant(
      timestampMillis(
        resulting.state.evaluated_at,
        'stored access request result evaluation time',
      ) <= receivedAt,
      'access request result postdates its committed receipt',
    );
    return {
      request_id: row.request_id,
      request_sha256: row.request_sha256 as Sha256Digest,
      request,
      enrollment_id: row.enrollment_id,
      previous_access_state_sha256:
        row.previous_access_state_sha256 as Sha256Digest,
      resulting_state_sha256: row.resulting_state_sha256 as Sha256Digest,
      received_at: row.received_at,
    };
  }

  accessLeaseRequestByDigest(
    requestSha256: Sha256Digest,
  ): StoredAccessLeaseRequest | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM authority_access_lease_requests WHERE request_sha256 = ?',
      )
      .get(requestSha256) as AccessLeaseRequestRow | undefined;
    return this.leaseRequestFromRow(row);
  }

  accessLeaseRequestById(
    enrollmentId: string,
    requestId: string,
  ): StoredAccessLeaseRequest | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM authority_access_lease_requests
         WHERE enrollment_id = ? AND request_id = ?`,
      )
      .get(enrollmentId, requestId) as AccessLeaseRequestRow | undefined;
    return this.leaseRequestFromRow(row);
  }

  insertMembership(membership: StoredAuthorityMembership): void {
    this.database
      .prepare(
        `INSERT INTO authority_principals (
           principal_id, organization_id, display_name, provisioned_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        membership.principal_id,
        membership.organization_id,
        membership.display_name,
        membership.provisioned_at,
      );
    this.database
      .prepare(
        `INSERT INTO authority_memberships (
           membership_id, organization_id, principal_id, membership_type,
           status, provisioned_at, revoked_at, revocation_reason
         ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL)`,
      )
      .run(
        membership.membership_id,
        membership.organization_id,
        membership.principal_id,
        membership.membership_type,
        membership.provisioned_at,
      );
  }

  insertGrant(grant: StoredEnrollmentGrant): void {
    this.database
      .prepare(
        `INSERT INTO authority_enrollment_grants (
           grant_sha256, authority_id, organization_id, principal_id,
           membership_id, issued_at, expires_at, consumed_at, request_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        grant.grant_sha256,
        grant.authority_id,
        grant.organization_id,
        grant.principal_id,
        grant.membership_id,
        grant.issued_at,
        grant.expires_at,
      );
  }

  insertEnrollment(value: NewAuthorityEnrollment): void {
    const enrollment = value.enrollment;
    this.database
      .prepare(
        `INSERT INTO authority_enrollments (
           enrollment_id, grant_sha256, request_sha256, request_json,
           receipt_sha256, receipt_json, authority_id, organization_id,
           principal_id, membership_id, membership_type, installation_id,
           installation_key_id, installation_public_key_spki_der_base64,
           status, enrolled_at, revoked_at, revocation_kind, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL)`,
      )
      .run(
        enrollment.enrollment_id,
        enrollment.grant_sha256,
        enrollment.request_sha256,
        canonicalJson(enrollment.request),
        enrollment.receipt_sha256,
        canonicalJson(enrollment.receipt),
        enrollment.authority_id,
        enrollment.organization_id,
        enrollment.principal_id,
        enrollment.membership_id,
        enrollment.membership_type,
        enrollment.installation_id,
        enrollment.installation_signing_key.key_id,
        enrollment.installation_signing_key.public_key_spki_der_base64,
        enrollment.enrolled_at,
      );
    this.insertAccessState(value.initial_access_state);
  }

  consumeGrant(
    grantSha256: Sha256Digest,
    requestSha256: Sha256Digest,
    consumedAt: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_enrollment_grants
           SET consumed_at = ?, request_sha256 = ?
           WHERE grant_sha256 = ? AND consumed_at IS NULL`,
        )
        .run(consumedAt, requestSha256, grantSha256).changes === 1
    );
  }

  insertAccessState(value: StoredAuthorityAccessState): void {
    const state = value.state;
    this.database
      .prepare(
        `INSERT INTO authority_access_states (
           enrollment_id, access_state_sequence, state_sha256, state_json,
           status, evaluated_at, valid_until, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.enrollment_id,
        state.access_state_sequence,
        value.state_sha256,
        canonicalJson(state),
        state.status,
        state.evaluated_at,
        state.valid_until,
        state.revocation_reason,
      );
  }

  insertAccessLeaseRequest(request: StoredAccessLeaseRequest): void {
    const requestJson = canonicalJson(request.request);
    this.database
      .prepare(
        `INSERT INTO authority_access_lease_requests (
           request_sha256, request_id, request_json, enrollment_id,
           previous_access_state_sha256, resulting_state_sha256, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.request_sha256,
        request.request_id,
        requestJson,
        request.enrollment_id,
        request.previous_access_state_sha256,
        request.resulting_state_sha256,
        request.received_at,
      );
  }

  revokeMembership(
    membershipId: string,
    revokedAt: string,
    reason: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_memberships
           SET status = 'revoked', revoked_at = ?, revocation_reason = ?
           WHERE membership_id = ? AND status = 'active'`,
        )
        .run(revokedAt, reason, membershipId).changes === 1
    );
  }

  revokeEnrollment(
    enrollmentId: string,
    revokedAt: string,
    kind: 'membership_revoked' | 'installation_revoked',
    reason: string,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE authority_enrollments
           SET status = 'revoked', revoked_at = ?, revocation_kind = ?,
               revocation_reason = ?
           WHERE enrollment_id = ? AND status = 'active'`,
        )
        .run(revokedAt, kind, reason, enrollmentId).changes === 1
    );
  }

  appendAudit(entry: AuthorityAuditEntry): void {
    const detailJson = canonicalJson(entry.detail);
    this.database
      .prepare(
        `INSERT INTO authority_audit_log (
           occurred_at, actor_kind, action, subject_id, detail_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.occurred_at,
        entry.actor_kind,
        entry.action,
        entry.subject_id,
        detailJson,
      );
  }
}

export class SqliteOrganizationAuthorityRepository implements OrganizationAuthorityRepository {
  private readonly database: Database.Database;
  private readonly transaction: SqliteAuthorityTransaction;
  private closed = false;

  constructor(databasePath: string) {
    this.database = openAuthorityDatabase(databasePath);
    this.transaction = new SqliteAuthorityTransaction(this.database);
  }

  initialize(input: InitializeAuthorityRepositoryInput): void {
    timestampMillis(
      input.initialized_at,
      'authority repository initialization time',
    );
    const descriptor = validateOrganizationAuthorityDescriptor(
      input.descriptor,
    );
    verifyOrganizationAuthorityPin(descriptor, input.authority_pin_sha256);
    invariant(
      Number.isSafeInteger(input.maximum_active_lease_ttl_ms) &&
        input.maximum_active_lease_ttl_ms > 0,
      'maximum active lease TTL is invalid',
    );
    this.transaction.configureTrust(input);
    const descriptorJson = canonicalJson(descriptor);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database
        .prepare(
          `SELECT authority_id, organization_id, organization_display_name,
                  authority_pin_sha256, descriptor_json, created_at,
                  last_observed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get() as MetadataRow | undefined;
      if (existing === undefined) {
        this.database
          .prepare(
            `INSERT INTO authority_metadata (
               singleton, authority_id, organization_id,
               organization_display_name, authority_pin_sha256,
               descriptor_json, created_at, last_observed_at
             ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.descriptor.authority_id,
            input.descriptor.organization_id,
            input.organization_display_name,
            input.authority_pin_sha256,
            descriptorJson,
            input.initialized_at,
            input.initialized_at,
          );
      } else {
        this.transaction.metadata();
        if (
          existing.authority_id !== input.descriptor.authority_id ||
          existing.organization_id !== input.descriptor.organization_id ||
          existing.organization_display_name !==
            input.organization_display_name ||
          existing.authority_pin_sha256 !== input.authority_pin_sha256 ||
          existing.descriptor_json !== descriptorJson
        ) {
          throw new Error(
            'configured organization authority differs from persisted authority metadata',
          );
        }
        if (input.initialized_at < existing.last_observed_at) {
          throw new Error(
            'authority clock regressed since the last committed write',
          );
        }
        this.database
          .prepare(
            `UPDATE authority_metadata SET last_observed_at = ?
             WHERE singleton = 1`,
          )
          .run(input.initialized_at);
      }
      this.transaction.metadata();
      this.database.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  read<T>(operation: (transaction: AuthorityReadTransaction) => T): T {
    this.assertOpen();
    this.database.exec('BEGIN');
    try {
      const result = operation(this.transaction);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  write<T>(
    observedAt: string,
    operation: (transaction: AuthorityWriteTransaction) => T,
  ): T {
    this.assertOpen();
    timestampMillis(observedAt, 'authority write time');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const metadata = this.transaction.metadata();
      if (observedAt < metadata.last_observed_at) {
        throw new Error(
          'authority clock regressed since the last committed write',
        );
      }
      this.database
        .prepare(
          'UPDATE authority_metadata SET last_observed_at = ? WHERE singleton = 1',
        )
        .run(observedAt);
      const result = operation(this.transaction);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error('organization authority repository is closed');
  }

  private rollback(): void {
    try {
      this.database.exec('ROLLBACK');
    } catch {}
  }
}
