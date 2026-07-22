import {
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalSha256,
  parseCanonicalJson,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS,
  organizationAuthorityPinSha256,
  organizationEnrollmentReceiptSha256,
  organizationEnrollmentRequestSha256,
  validateOrganizationAuthorityDescriptor,
  validateOrganizationInstallationAccessState,
  verifyOrganizationAuthorityPin,
  verifyOrganizationEnrollmentReceipt,
  verifyOrganizationEnrollmentRequest,
  verifyOrganizationInstallationAccessState,
  type OrganizationAuthorityDescriptorV1,
  type OrganizationEnrollmentReceiptV1,
  type OrganizationEnrollmentRequestV1,
  type OrganizationInstallationAccessDecisionV1,
  type OrganizationInstallationAccessStateV1,
  type PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';
import { openProductDatabase } from '../../storage/open-product-database.js';

export interface OrganizationAccessVerificationPolicy {
  /** Caller-supplied trusted UTC millisecond time. */
  now: string;
  maximum_active_ttl_ms: number;
  allowed_clock_skew_ms?: number;
}

export interface StoredOrganizationEnrollment {
  request: OrganizationEnrollmentRequestV1;
  receipt: OrganizationEnrollmentReceiptV1 | null;
  accepted_access_sequence: number;
  accepted_access_sha256: Sha256Digest | null;
  trusted_time_high_watermark: string | null;
}

export interface OrganizationStateStore {
  pinAuthority(
    descriptor: unknown,
    independentlyTrustedPin: unknown,
  ): PinnedOrganizationAuthority;
  readPinnedAuthority(): PinnedOrganizationAuthority | null;
  saveEnrollmentRequest(request: unknown): OrganizationEnrollmentRequestV1;
  saveEnrollmentReceipt(receipt: unknown): OrganizationEnrollmentReceiptV1;
  readEnrollment(): StoredOrganizationEnrollment | null;
  acceptAccessState(
    state: unknown,
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1;
  verifyCurrentAccess(
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1;
  close(): void;
}

export class OrganizationStateConflictError extends Error {
  readonly code = 'ORGANIZATION_STATE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'OrganizationStateConflictError';
  }
}

export class OrganizationStateCorruptionError extends Error {
  readonly code = 'ORGANIZATION_STATE_CORRUPT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OrganizationStateCorruptionError';
  }
}

export class OrganizationStateUnavailableError extends Error {
  readonly code = 'ORGANIZATION_STATE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'OrganizationStateUnavailableError';
  }
}

export class OrganizationClockRollbackError extends Error {
  readonly code = 'ORGANIZATION_CLOCK_ROLLBACK';

  constructor(message: string) {
    super(message);
    this.name = 'OrganizationClockRollbackError';
  }
}

interface AuthorityPinRow {
  authority_id: string;
  organization_id: string;
  authority_key_id: string;
  descriptor_sha256: string;
  trusted_pin_sha256: string;
  descriptor_json: string;
}

interface EnrollmentRow {
  request_sha256: string;
  authority_id: string;
  authority_key_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_key_id: string;
  enrollment_grant_sha256: string;
  request_json: string;
  status: string;
  enrollment_id: string | null;
  receipt_sha256: string | null;
  receipt_json: string | null;
  accepted_access_sequence: number;
  accepted_access_sha256: string | null;
  trusted_time_high_watermark: string | null;
}

interface AccessHighWatermarkRow {
  request_sha256: string;
  authority_id: string;
  installation_id: string;
  enrollment_id: string;
  access_state_sequence: number;
  state_sha256: string;
  status: string;
  revocation_reason: string | null;
  evaluated_at: string;
  valid_until: string | null;
  trusted_time_high_watermark: string;
  state_json: string;
}

interface LoadedAuthorityPin {
  descriptor: OrganizationAuthorityDescriptorV1;
  handle: PinnedOrganizationAuthority;
  canonical: string;
  sha256: Sha256Digest;
}

interface LoadedEnrollment {
  row: EnrollmentRow;
  request: OrganizationEnrollmentRequestV1;
  receipt: OrganizationEnrollmentReceiptV1 | null;
}

interface LoadedAccessState {
  row: AccessHighWatermarkRow;
  state: OrganizationInstallationAccessStateV1;
}

interface LoadedContext {
  authority: LoadedAuthorityPin;
  enrollment: LoadedEnrollment;
  access: LoadedAccessState | null;
}

function corruption(message: string, cause: unknown): never {
  if (cause instanceof OrganizationStateCorruptionError) throw cause;
  throw new OrganizationStateCorruptionError(message, { cause });
}

function parseStoredCanonicalJson(raw: string, label: string): unknown {
  try {
    return parseCanonicalJson(raw);
  } catch (error) {
    return corruption(`${label} is not exact canonical JSON`, error);
  }
}

function assertDigestEquality(
  actual: string,
  expected: string,
  label: string,
): asserts actual is Sha256Digest {
  if (actual !== expected) {
    throw new OrganizationStateCorruptionError(
      `${label} digest is inconsistent`,
    );
  }
}

function timestampMillis(value: string, label: string): number {
  try {
    assertUtcMillisecondTimestamp(value, label);
  } catch (error) {
    return corruption(`${label} is invalid`, error);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new OrganizationStateCorruptionError(`${label} is invalid`);
  }
  return milliseconds;
}

function policyClock(policy: OrganizationAccessVerificationPolicy): {
  nowMillis: number;
  allowedSkew: number;
} {
  try {
    assertUtcMillisecondTimestamp(policy.now, 'organization trusted clock');
  } catch (error) {
    throw new OrganizationStateUnavailableError(
      `organization trusted clock is invalid: ${(error as Error).message}`,
    );
  }
  const nowMillis = Date.parse(policy.now);
  if (!Number.isFinite(nowMillis)) {
    throw new OrganizationStateUnavailableError(
      'organization trusted clock is invalid',
    );
  }
  const allowedSkew = policy.allowed_clock_skew_ms ?? 0;
  if (
    !Number.isSafeInteger(allowedSkew) ||
    allowedSkew < 0 ||
    allowedSkew > MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS
  ) {
    throw new OrganizationStateUnavailableError(
      `allowed organization clock skew must be between 0 and ${MAX_ORGANIZATION_ACCESS_CLOCK_SKEW_MS} milliseconds`,
    );
  }
  return { nowMillis, allowedSkew };
}

function laterTrustedTime(left: string, right: string): string {
  const leftMillis = timestampMillis(left, 'organization trusted time');
  const rightMillis = timestampMillis(right, 'organization trusted time');
  return rightMillis > leftMillis ? right : left;
}

/**
 * Installation-owned organization trust state.
 *
 * The store deliberately accepts signed protocol values, not bearer grant
 * bytes. Enrollment grants remain caller-owned transient secrets; only the
 * digest already present in the signed request is persisted.
 */
export class SqliteOrganizationStateStore implements OrganizationStateStore {
  private readonly database: ReturnType<typeof openProductDatabase>;
  private closed = false;

  constructor(databasePath: string) {
    this.database = openProductDatabase(databasePath, {
      durability: 'evidence',
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('organization state store is closed');
  }

  private rollbackPreserving(error: unknown): never {
    try {
      if (this.database.inTransaction) this.database.exec('ROLLBACK');
    } catch {
      // Preserve the operation failure if SQLite also rejects rollback.
    }
    throw error;
  }

  private writeTransaction<T>(operation: () => T): T {
    this.assertOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      return this.rollbackPreserving(error);
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.assertOpen();
    this.database.exec('BEGIN');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      return this.rollbackPreserving(error);
    }
  }

  private authorityPinRow(): AuthorityPinRow | undefined {
    return this.database
      .prepare(
        `SELECT authority_id, organization_id, authority_key_id,
                descriptor_sha256, trusted_pin_sha256, descriptor_json
         FROM organization_authority_pins
         WHERE singleton = 1`,
      )
      .get() as AuthorityPinRow | undefined;
  }

  private loadAuthorityPin(): LoadedAuthorityPin | null {
    const row = this.authorityPinRow();
    if (row === undefined) return null;
    try {
      const descriptor = validateOrganizationAuthorityDescriptor(
        parseStoredCanonicalJson(
          row.descriptor_json,
          'stored organization authority descriptor',
        ),
      );
      const canonical = canonicalJson(descriptor);
      if (canonical !== row.descriptor_json) {
        throw new Error('descriptor bytes changed during validation');
      }
      const sha256 = organizationAuthorityPinSha256(descriptor);
      assertDigestEquality(
        row.descriptor_sha256,
        sha256,
        'stored organization authority descriptor',
      );
      if (row.trusted_pin_sha256 !== row.descriptor_sha256) {
        throw new Error('descriptor and trusted pin inputs differ');
      }
      if (
        row.authority_id !== descriptor.authority_id ||
        row.organization_id !== descriptor.organization_id ||
        row.authority_key_id !== descriptor.signing_key.key_id
      ) {
        throw new Error('authority columns do not match the descriptor');
      }
      const handle = verifyOrganizationAuthorityPin(
        descriptor,
        row.trusted_pin_sha256,
      );
      return { descriptor, handle, canonical, sha256 };
    } catch (error) {
      return corruption('stored organization authority pin is corrupt', error);
    }
  }

  pinAuthority(
    descriptorValue: unknown,
    independentlyTrustedPin: unknown,
  ): PinnedOrganizationAuthority {
    const descriptor = validateOrganizationAuthorityDescriptor(descriptorValue);
    const handle = verifyOrganizationAuthorityPin(
      descriptor,
      independentlyTrustedPin,
    );
    const canonical = canonicalJson(descriptor);
    const sha256 = organizationAuthorityPinSha256(descriptor);

    return this.writeTransaction(() => {
      const existing = this.loadAuthorityPin();
      if (existing !== null) {
        if (
          existing.canonical !== canonical ||
          existing.sha256 !== sha256 ||
          existing.handle.authority_pin_sha256 !== handle.authority_pin_sha256
        ) {
          throw new OrganizationStateConflictError(
            'organization authority conflicts with the write-once local pin',
          );
        }
        return handle;
      }
      this.database
        .prepare(
          `INSERT INTO organization_authority_pins (
             singleton, authority_id, organization_id, authority_key_id,
             descriptor_sha256, trusted_pin_sha256, descriptor_json
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          descriptor.authority_id,
          descriptor.organization_id,
          descriptor.signing_key.key_id,
          sha256,
          handle.authority_pin_sha256,
          canonical,
        );
      return handle;
    });
  }

  readPinnedAuthority(): PinnedOrganizationAuthority | null {
    return this.readTransaction(() => this.loadAuthorityPin()?.handle ?? null);
  }

  private enrollmentRow(): EnrollmentRow | undefined {
    return this.database
      .prepare(
        `SELECT request_sha256, authority_id, authority_key_id,
                organization_id, principal_id, membership_id,
                installation_id, installation_key_id,
                enrollment_grant_sha256, request_json, status,
                enrollment_id, receipt_sha256, receipt_json,
                accepted_access_sequence, accepted_access_sha256,
                trusted_time_high_watermark
         FROM organization_enrollments
         WHERE singleton = 1`,
      )
      .get() as EnrollmentRow | undefined;
  }

  private loadEnrollment(
    authority: LoadedAuthorityPin,
  ): LoadedEnrollment | null {
    const row = this.enrollmentRow();
    if (row === undefined) return null;
    try {
      const request = verifyOrganizationEnrollmentRequest(
        parseStoredCanonicalJson(
          row.request_json,
          'stored organization enrollment request',
        ),
        authority.handle,
      );
      const requestSha256 = organizationEnrollmentRequestSha256(
        request,
        authority.handle,
      );
      assertDigestEquality(
        row.request_sha256,
        requestSha256,
        'stored organization enrollment request',
      );
      if (
        row.request_json !== canonicalJson(request) ||
        row.authority_id !== request.authority_id ||
        row.authority_key_id !== request.authority_key_id ||
        row.organization_id !== request.organization_id ||
        row.principal_id !== request.principal_id ||
        row.membership_id !== request.membership_id ||
        row.installation_id !== request.installation_id ||
        row.installation_key_id !== request.installation_signing_key.key_id ||
        row.enrollment_grant_sha256 !== request.enrollment_grant_sha256
      ) {
        throw new Error('request columns do not match the signed request');
      }
      if (
        !Number.isSafeInteger(row.accepted_access_sequence) ||
        row.accepted_access_sequence < 0
      ) {
        throw new Error('access pointer sequence is invalid');
      }
      const emptyAccessPointer =
        row.accepted_access_sequence === 0 &&
        row.accepted_access_sha256 === null &&
        row.trusted_time_high_watermark === null;
      const populatedAccessPointer =
        row.accepted_access_sequence > 0 &&
        row.accepted_access_sha256 !== null &&
        row.trusted_time_high_watermark !== null;
      if (!emptyAccessPointer && !populatedAccessPointer) {
        throw new Error('access pointer is incomplete');
      }
      if (row.trusted_time_high_watermark !== null) {
        timestampMillis(
          row.trusted_time_high_watermark,
          'stored organization trusted time high-watermark',
        );
      }

      if (row.status === 'pending') {
        if (
          row.enrollment_id !== null ||
          row.receipt_sha256 !== null ||
          row.receipt_json !== null ||
          !emptyAccessPointer
        ) {
          throw new Error('pending enrollment contains accepted evidence');
        }
        return { row, request, receipt: null };
      }
      if (
        row.status !== 'enrolled' ||
        row.enrollment_id === null ||
        row.receipt_sha256 === null ||
        row.receipt_json === null
      ) {
        throw new Error('enrollment receipt columns are incomplete');
      }
      const receipt = verifyOrganizationEnrollmentReceipt(
        parseStoredCanonicalJson(
          row.receipt_json,
          'stored organization enrollment receipt',
        ),
        authority.handle,
        request,
      );
      const receiptSha256 = organizationEnrollmentReceiptSha256(
        receipt,
        authority.handle,
        request,
      );
      assertDigestEquality(
        row.receipt_sha256,
        receiptSha256,
        'stored organization enrollment receipt',
      );
      if (
        row.receipt_json !== canonicalJson(receipt) ||
        row.enrollment_id !== receipt.enrollment_id
      ) {
        throw new Error('receipt columns do not match the signed receipt');
      }
      return { row, request, receipt };
    } catch (error) {
      return corruption('stored organization enrollment is corrupt', error);
    }
  }

  saveEnrollmentRequest(
    requestValue: unknown,
  ): OrganizationEnrollmentRequestV1 {
    return this.writeTransaction(() => {
      const authority = this.loadAuthorityPin();
      if (authority === null) {
        throw new OrganizationStateUnavailableError(
          'organization authority must be pinned before enrollment',
        );
      }
      const request = verifyOrganizationEnrollmentRequest(
        requestValue,
        authority.handle,
      );
      const canonical = canonicalJson(request);
      const sha256 = organizationEnrollmentRequestSha256(
        request,
        authority.handle,
      );
      const existing = this.loadEnrollment(authority);
      if (existing !== null) {
        if (
          existing.row.request_sha256 !== sha256 ||
          existing.row.request_json !== canonical
        ) {
          throw new OrganizationStateConflictError(
            'a different organization enrollment request is already retained',
          );
        }
        return existing.request;
      }
      this.database
        .prepare(
          `INSERT INTO organization_enrollments (
             request_sha256, singleton, authority_id, authority_key_id,
             organization_id, principal_id, membership_id,
             installation_id, installation_key_id,
             enrollment_grant_sha256, request_json, status
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          sha256,
          request.authority_id,
          request.authority_key_id,
          request.organization_id,
          request.principal_id,
          request.membership_id,
          request.installation_id,
          request.installation_signing_key.key_id,
          request.enrollment_grant_sha256,
          canonical,
        );
      return request;
    });
  }

  saveEnrollmentReceipt(
    receiptValue: unknown,
  ): OrganizationEnrollmentReceiptV1 {
    return this.writeTransaction(() => {
      const authority = this.loadAuthorityPin();
      if (authority === null) {
        throw new OrganizationStateUnavailableError(
          'organization authority pin is unavailable',
        );
      }
      const enrollment = this.loadEnrollment(authority);
      if (enrollment === null) {
        throw new OrganizationStateUnavailableError(
          'organization enrollment request is unavailable',
        );
      }
      const receipt = verifyOrganizationEnrollmentReceipt(
        receiptValue,
        authority.handle,
        enrollment.request,
      );
      const canonical = canonicalJson(receipt);
      const sha256 = organizationEnrollmentReceiptSha256(
        receipt,
        authority.handle,
        enrollment.request,
      );
      if (enrollment.receipt !== null) {
        if (
          enrollment.row.receipt_sha256 !== sha256 ||
          enrollment.row.receipt_json !== canonical
        ) {
          throw new OrganizationStateConflictError(
            'a different organization enrollment receipt is already retained',
          );
        }
        return enrollment.receipt;
      }
      const result = this.database
        .prepare(
          `UPDATE organization_enrollments
           SET status = 'enrolled', enrollment_id = ?, receipt_sha256 = ?,
               receipt_json = ?,
               enrolled_locally_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE request_sha256 = ? AND status = 'pending'
             AND enrollment_id IS NULL AND receipt_sha256 IS NULL
             AND receipt_json IS NULL`,
        )
        .run(
          receipt.enrollment_id,
          sha256,
          canonical,
          enrollment.row.request_sha256,
        );
      if (result.changes !== 1) {
        throw new OrganizationStateConflictError(
          'organization enrollment changed while accepting its receipt',
        );
      }
      return receipt;
    });
  }

  readEnrollment(): StoredOrganizationEnrollment | null {
    return this.readTransaction(() => {
      const authority = this.loadAuthorityPin();
      if (authority === null) return null;
      const enrollment = this.loadEnrollment(authority);
      if (enrollment === null) return null;
      this.loadAccess(authority, enrollment);
      return {
        request: enrollment.request,
        receipt: enrollment.receipt,
        accepted_access_sequence: enrollment.row.accepted_access_sequence,
        accepted_access_sha256: enrollment.row
          .accepted_access_sha256 as Sha256Digest | null,
        trusted_time_high_watermark: enrollment.row.trusted_time_high_watermark,
      };
    });
  }

  private accessRow(requestSha256: string): AccessHighWatermarkRow | undefined {
    return this.database
      .prepare(
        `SELECT request_sha256, authority_id, installation_id, enrollment_id,
                access_state_sequence, state_sha256, status,
                revocation_reason, evaluated_at, valid_until,
                trusted_time_high_watermark, state_json
         FROM organization_access_high_watermarks
         WHERE request_sha256 = ?`,
      )
      .get(requestSha256) as AccessHighWatermarkRow | undefined;
  }

  private loadAccess(
    authority: LoadedAuthorityPin,
    enrollment: LoadedEnrollment,
  ): LoadedAccessState | null {
    const row = this.accessRow(enrollment.row.request_sha256);
    const pointerEmpty = enrollment.row.accepted_access_sequence === 0;
    if (pointerEmpty) {
      if (row !== undefined) {
        throw new OrganizationStateCorruptionError(
          'organization access state exists without its durable pointer',
        );
      }
      return null;
    }
    if (
      row === undefined ||
      enrollment.receipt === null ||
      enrollment.row.accepted_access_sha256 === null ||
      enrollment.row.trusted_time_high_watermark === null
    ) {
      throw new OrganizationStateCorruptionError(
        'organization access high-watermark is missing',
      );
    }
    try {
      const state = validateOrganizationInstallationAccessState(
        parseStoredCanonicalJson(
          row.state_json,
          'stored organization access state',
        ),
      );
      const sha256 = canonicalSha256(state);
      assertDigestEquality(
        row.state_sha256,
        sha256,
        'stored organization access state',
      );
      if (
        row.state_json !== canonicalJson(state) ||
        row.request_sha256 !== enrollment.row.request_sha256 ||
        row.authority_id !== enrollment.row.authority_id ||
        row.installation_id !== enrollment.row.installation_id ||
        row.enrollment_id !== enrollment.receipt.enrollment_id ||
        row.access_state_sequence !== state.access_state_sequence ||
        row.state_sha256 !== enrollment.row.accepted_access_sha256 ||
        row.access_state_sequence !== enrollment.row.accepted_access_sequence ||
        row.trusted_time_high_watermark !==
          enrollment.row.trusted_time_high_watermark ||
        row.status !== state.status ||
        row.revocation_reason !== state.revocation_reason ||
        row.evaluated_at !== state.evaluated_at ||
        row.valid_until !== state.valid_until
      ) {
        throw new Error('access columns do not match signed state and pointer');
      }
      timestampMillis(
        row.trusted_time_high_watermark,
        'stored organization trusted time high-watermark',
      );
      verifyOrganizationInstallationAccessState({
        state,
        pinned_authority: authority.handle,
        enrollment_request: enrollment.request,
        enrollment_receipt: enrollment.receipt,
        now: state.evaluated_at,
        maximum_active_ttl_ms: Number.MAX_SAFE_INTEGER,
        previous_state: state,
      });
      return { row, state };
    } catch (error) {
      return corruption(
        'stored organization access high-watermark is corrupt',
        error,
      );
    }
  }

  private loadContext(requireEnrollment: boolean): LoadedContext {
    const authority = this.loadAuthorityPin();
    if (authority === null) {
      throw new OrganizationStateUnavailableError(
        'organization authority pin is unavailable',
      );
    }
    const enrollment = this.loadEnrollment(authority);
    if (enrollment === null) {
      throw new OrganizationStateUnavailableError(
        'organization enrollment is unavailable',
      );
    }
    if (requireEnrollment && enrollment.receipt === null) {
      throw new OrganizationStateUnavailableError(
        'organization enrollment receipt is unavailable',
      );
    }
    return {
      authority,
      enrollment,
      access: this.loadAccess(authority, enrollment),
    };
  }

  private nextTrustedTime(
    stored: string,
    policy: OrganizationAccessVerificationPolicy,
  ): string {
    const { nowMillis, allowedSkew } = policyClock(policy);
    const storedMillis = timestampMillis(
      stored,
      'stored organization trusted time high-watermark',
    );
    if (nowMillis + allowedSkew < storedMillis) {
      throw new OrganizationClockRollbackError(
        'organization trusted clock rolled back beyond the allowed skew',
      );
    }
    return nowMillis > storedMillis ? policy.now : stored;
  }

  private updateTrustedTime(
    enrollment: LoadedEnrollment,
    access: LoadedAccessState,
    trustedTime: string,
  ): void {
    if (trustedTime === access.row.trusted_time_high_watermark) return;
    const accessResult = this.database
      .prepare(
        `UPDATE organization_access_high_watermarks
         SET trusted_time_high_watermark = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE request_sha256 = ? AND state_sha256 = ?
           AND trusted_time_high_watermark = ?`,
      )
      .run(
        trustedTime,
        access.row.request_sha256,
        access.row.state_sha256,
        access.row.trusted_time_high_watermark,
      );
    const enrollmentResult = this.database
      .prepare(
        `UPDATE organization_enrollments
         SET trusted_time_high_watermark = ?
         WHERE request_sha256 = ? AND accepted_access_sequence = ?
           AND accepted_access_sha256 = ?
           AND trusted_time_high_watermark = ?`,
      )
      .run(
        trustedTime,
        enrollment.row.request_sha256,
        enrollment.row.accepted_access_sequence,
        enrollment.row.accepted_access_sha256,
        enrollment.row.trusted_time_high_watermark,
      );
    if (accessResult.changes !== 1 || enrollmentResult.changes !== 1) {
      throw new OrganizationStateConflictError(
        'organization trusted time changed concurrently',
      );
    }
  }

  private commitClockBeforeDenying(
    enrollment: LoadedEnrollment,
    access: LoadedAccessState,
    trustedTime: string,
    error: unknown,
  ): never {
    try {
      this.updateTrustedTime(enrollment, access, trustedTime);
      this.database.exec('COMMIT');
    } catch (commitError) {
      return this.rollbackPreserving(commitError);
    }
    throw error;
  }

  acceptAccessState(
    stateValue: unknown,
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1 {
    this.assertOpen();
    policyClock(policy);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const context = this.loadContext(true);
      const { enrollment, authority, access } = context;
      const receipt = enrollment.receipt;
      if (receipt === null) {
        throw new OrganizationStateUnavailableError(
          'organization enrollment receipt is unavailable',
        );
      }
      let trustedTime =
        access === null
          ? policy.now
          : this.nextTrustedTime(
              access.row.trusted_time_high_watermark,
              policy,
            );
      let decision: OrganizationInstallationAccessDecisionV1;
      try {
        decision = verifyOrganizationInstallationAccessState({
          state: stateValue,
          pinned_authority: authority.handle,
          enrollment_request: enrollment.request,
          enrollment_receipt: receipt,
          now: policy.now,
          maximum_active_ttl_ms: policy.maximum_active_ttl_ms,
          ...(policy.allowed_clock_skew_ms === undefined
            ? {}
            : { allowed_clock_skew_ms: policy.allowed_clock_skew_ms }),
          previous_state: access?.state ?? null,
        });
      } catch (error) {
        if (access !== null) {
          return this.commitClockBeforeDenying(
            enrollment,
            access,
            trustedTime,
            error,
          );
        }
        return this.rollbackPreserving(error);
      }

      const state = decision.state;
      trustedTime = laterTrustedTime(trustedTime, state.evaluated_at);
      const stateCanonical = canonicalJson(state);
      const stateSha256 = canonicalSha256(state);
      if (
        access !== null &&
        access.row.access_state_sequence === state.access_state_sequence &&
        access.row.state_sha256 === stateSha256
      ) {
        this.updateTrustedTime(enrollment, access, trustedTime);
        this.database.exec('COMMIT');
        return decision;
      }

      this.database
        .prepare(
          `INSERT INTO organization_access_high_watermarks (
             request_sha256, authority_id, installation_id, enrollment_id,
             access_state_sequence, state_sha256, status,
             revocation_reason, evaluated_at, valid_until,
             trusted_time_high_watermark, state_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (request_sha256) DO UPDATE SET
             access_state_sequence = excluded.access_state_sequence,
             state_sha256 = excluded.state_sha256,
             status = excluded.status,
             revocation_reason = excluded.revocation_reason,
             evaluated_at = excluded.evaluated_at,
             valid_until = excluded.valid_until,
             trusted_time_high_watermark = excluded.trusted_time_high_watermark,
             state_json = excluded.state_json,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(
          enrollment.row.request_sha256,
          state.authority_id,
          state.installation_id,
          state.enrollment_id,
          state.access_state_sequence,
          stateSha256,
          state.status,
          state.revocation_reason,
          state.evaluated_at,
          state.valid_until,
          trustedTime,
          stateCanonical,
        );
      const pointerResult = this.database
        .prepare(
          `UPDATE organization_enrollments
           SET accepted_access_sequence = ?, accepted_access_sha256 = ?,
               trusted_time_high_watermark = ?
           WHERE request_sha256 = ? AND accepted_access_sequence = ?
             AND accepted_access_sha256 IS ?
             AND trusted_time_high_watermark IS ?`,
        )
        .run(
          state.access_state_sequence,
          stateSha256,
          trustedTime,
          enrollment.row.request_sha256,
          enrollment.row.accepted_access_sequence,
          enrollment.row.accepted_access_sha256,
          enrollment.row.trusted_time_high_watermark,
        );
      if (pointerResult.changes !== 1) {
        throw new OrganizationStateConflictError(
          'organization access pointer changed concurrently',
        );
      }
      this.database.exec('COMMIT');
      return decision;
    } catch (error) {
      return this.rollbackPreserving(error);
    }
  }

  verifyCurrentAccess(
    policy: OrganizationAccessVerificationPolicy,
  ): OrganizationInstallationAccessDecisionV1 {
    this.assertOpen();
    policyClock(policy);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const context = this.loadContext(true);
      const { enrollment, authority, access } = context;
      if (enrollment.receipt === null || access === null) {
        throw new OrganizationStateUnavailableError(
          'verified organization access state is unavailable',
        );
      }
      let trustedTime = this.nextTrustedTime(
        access.row.trusted_time_high_watermark,
        policy,
      );
      try {
        const decision = verifyOrganizationInstallationAccessState({
          state: access.state,
          pinned_authority: authority.handle,
          enrollment_request: enrollment.request,
          enrollment_receipt: enrollment.receipt,
          now: policy.now,
          maximum_active_ttl_ms: policy.maximum_active_ttl_ms,
          ...(policy.allowed_clock_skew_ms === undefined
            ? {}
            : { allowed_clock_skew_ms: policy.allowed_clock_skew_ms }),
          previous_state: access.state,
        });
        trustedTime = laterTrustedTime(
          trustedTime,
          decision.state.evaluated_at,
        );
        this.updateTrustedTime(enrollment, access, trustedTime);
        this.database.exec('COMMIT');
        return decision;
      } catch (error) {
        return this.commitClockBeforeDenying(
          enrollment,
          access,
          trustedTime,
          error,
        );
      }
    } catch (error) {
      return this.rollbackPreserving(error);
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.database.inTransaction) {
      throw new Error(
        'cannot close organization state store during a transaction',
      );
    }
    this.database.close();
    this.closed = true;
  }
}
