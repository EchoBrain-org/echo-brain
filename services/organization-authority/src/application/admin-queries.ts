import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type {
  OrganizationAdminOverviewV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationMembershipPageV1,
} from '@echo-brain/organization-api';
import { timestampMillis } from '../domain/rules.js';
import { AuthorityOperationError } from '../domain/errors.js';
import type { OrganizationAuthorityRepository } from './ports/authority-repository.js';
import type { AuthorityClock } from './ports/runtime-ports.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAXIMUM_PAGE_LIMIT = 100;
const MAXIMUM_CURSOR_BYTES = 512;

type CursorKind = 'audit' | 'grants' | 'installations' | 'memberships';

export interface AdminPageRequest {
  cursor?: string;
  limit?: number;
}

function invalidPage(message: string): never {
  throw new AuthorityOperationError('invalid_request', message);
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAXIMUM_PAGE_LIMIT
  ) {
    invalidPage(
      `admin page limit must be from 1 through ${MAXIMUM_PAGE_LIMIT}`,
    );
  }
  return limit;
}

function encodeCursor(kind: CursorKind, value: string | number): string {
  return Buffer.from(canonicalJson({ kind, value }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string | undefined,
  expectedKind: CursorKind,
): string | number | undefined {
  if (cursor === undefined) return undefined;
  if (
    cursor.length === 0 ||
    cursor.length > MAXIMUM_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    invalidPage('admin page cursor is invalid');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cursor, 'base64url');
  } catch {
    invalidPage('admin page cursor is invalid');
  }
  if (
    bytes.length === 0 ||
    bytes.toString('base64url') !== cursor ||
    bytes.length > MAXIMUM_CURSOR_BYTES
  ) {
    invalidPage('admin page cursor is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    invalidPage('admin page cursor is invalid');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'kind,value'
  ) {
    invalidPage('admin page cursor is invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.kind !== expectedKind ||
    (typeof record.value !== 'string' && typeof record.value !== 'number') ||
    canonicalJson(record as never) !== bytes.toString('utf8')
  ) {
    invalidPage('admin page cursor is invalid');
  }
  return record.value;
}

function stringCursor(
  cursor: string | undefined,
  kind: Exclude<CursorKind, 'audit'>,
  pattern: RegExp,
): string | undefined {
  const value = decodeCursor(cursor, kind);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    invalidPage('admin page cursor is invalid');
  }
  return value;
}

function auditCursor(cursor: string | undefined): number | undefined {
  const value = decodeCursor(cursor, 'audit');
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalidPage('admin page cursor is invalid');
  }
  return value;
}

function pageResult<T, C extends string | number>(
  rows: T[],
  limit: number,
  kind: CursorKind,
  cursorValue: (row: T) => C,
): { items: T[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      hasMore && last !== undefined
        ? encodeCursor(kind, cursorValue(last))
        : null,
  };
}

export class OrganizationAuthorityAdminQueries {
  constructor(
    private readonly repository: OrganizationAuthorityRepository,
    private readonly clock: AuthorityClock,
  ) {}

  overview(): OrganizationAdminOverviewV1 {
    const now = this.clock.now();
    timestampMillis(now, 'admin overview time');
    return this.repository.read((transaction) => {
      const metadata = transaction.metadata();
      return {
        organization_id: metadata.organization_id,
        organization_display_name: metadata.organization_display_name,
        authority_id: metadata.authority_id,
        authority_pin_sha256: metadata.authority_pin_sha256,
        created_at: metadata.created_at,
        last_observed_at: metadata.last_observed_at,
        counts: transaction.adminCounts(now),
      };
    });
  }

  memberships(request: AdminPageRequest = {}): OrganizationMembershipPageV1 {
    const limit = pageLimit(request.limit);
    const after = stringCursor(
      request.cursor,
      'memberships',
      /^mem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const rows = this.repository.read((transaction) =>
      transaction.membershipsAfter(after, limit + 1),
    );
    return pageResult(
      rows.map((membership) => ({
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        display_name: membership.display_name,
        membership_type: membership.membership_type,
        status: membership.status,
        provisioned_at: membership.provisioned_at,
        revoked_at: membership.revoked_at,
        revocation_reason: membership.revocation_reason,
      })),
      limit,
      'memberships',
      (membership) => membership.membership_id,
    );
  }

  installations(
    request: AdminPageRequest = {},
  ): OrganizationInstallationPageV1 {
    const limit = pageLimit(request.limit);
    const after = stringCursor(
      request.cursor,
      'installations',
      /^enr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const rows = this.repository.read((transaction) =>
      transaction.enrollmentsAfter(after, limit + 1).map((enrollment) => {
        const current = transaction.currentAccessState(
          enrollment.enrollment_id,
        );
        if (current === undefined) {
          throw new Error(
            'authority enrollment has no access-state high watermark',
          );
        }
        return {
          organization_id: enrollment.organization_id,
          principal_id: enrollment.principal_id,
          membership_id: enrollment.membership_id,
          enrollment_id: enrollment.enrollment_id,
          installation_id: enrollment.installation_id,
          installation_key_id: enrollment.installation_signing_key.key_id,
          status: enrollment.status,
          enrolled_at: enrollment.enrolled_at,
          revoked_at: enrollment.revoked_at,
          revocation_kind: enrollment.revocation_kind,
          revocation_reason: enrollment.revocation_reason,
          current_access_sequence: current.state.access_state_sequence,
          current_access_status: current.state.status,
          current_access_valid_until: current.state.valid_until,
        };
      }),
    );
    return pageResult(
      rows,
      limit,
      'installations',
      (installation) => installation.enrollment_id,
    );
  }

  enrollmentGrants(
    request: AdminPageRequest = {},
  ): OrganizationEnrollmentGrantPageV1 {
    const limit = pageLimit(request.limit);
    const after = stringCursor(
      request.cursor,
      'grants',
      /^sha256:[0-9a-f]{64}$/,
    ) as Sha256Digest | undefined;
    const now = this.clock.now();
    timestampMillis(now, 'admin enrollment-grant query time');
    const rows = this.repository.read((transaction) =>
      transaction.grantsAfter(after, limit + 1),
    );
    return pageResult(
      rows.map((grant) => ({
        organization_id: grant.organization_id,
        principal_id: grant.principal_id,
        membership_id: grant.membership_id,
        enrollment_grant_sha256: grant.grant_sha256,
        issued_at: grant.issued_at,
        expires_at: grant.expires_at,
        consumed_at: grant.consumed_at,
        status:
          grant.consumed_at !== null
            ? ('consumed' as const)
            : grant.expires_at <= now
              ? ('expired' as const)
              : ('pending' as const),
      })),
      limit,
      'grants',
      (grant) => grant.enrollment_grant_sha256,
    );
  }

  audit(request: AdminPageRequest = {}): OrganizationAuditPageV1 {
    const limit = pageLimit(request.limit);
    const before = auditCursor(request.cursor);
    const rows = this.repository.read((transaction) =>
      transaction.recentAuditBefore(before, limit + 1),
    );
    return pageResult(rows, limit, 'audit', (entry) => entry.audit_sequence);
  }
}
