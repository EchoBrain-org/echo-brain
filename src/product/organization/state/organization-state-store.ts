import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type {
  OrganizationEnrollmentReceiptV1,
  OrganizationEnrollmentRequestV1,
  OrganizationInstallationAccessDecisionV1,
  PinnedOrganizationAuthority,
} from '@echo-brain/organization-protocol';

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

/**
 * Installation-owned organization trust-state port.
 *
 * Implementations persist only signed protocol values and their verification
 * high-watermarks. Enrollment grant bytes remain transient caller-owned
 * secrets and must never cross this boundary.
 */
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
