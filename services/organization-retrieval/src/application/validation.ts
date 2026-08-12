import type { Sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_MEMBER_POLICY_ID,
  RESTRICTED_REVIEWER_POLICY_ID,
  type ReadableSearchItemKind,
  type ReadableSearchPolicyId,
  type ReadableSearchRecordHead,
  type ReadableSearchSegmentIdentity,
  ReadableSearchValidationError,
} from './contracts.js';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ITEM_KINDS = new Set<ReadableSearchItemKind>([
  'decision',
  'action',
  'rationale',
]);

export function assertReadableSearchDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new ReadableSearchValidationError(`${label} must be a canonical sha256 digest`);
  }
  return value as Sha256Digest;
}

export function assertReadableSearchIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0') ||
    value !== value.normalize('NFC')
  ) {
    throw new ReadableSearchValidationError(`${label} is invalid`);
  }
  return value;
}

export function assertReadableSearchPolicyId(
  value: unknown,
): ReadableSearchPolicyId {
  if (value !== ORGANIZATION_MEMBER_POLICY_ID && value !== RESTRICTED_REVIEWER_POLICY_ID) {
    throw new ReadableSearchValidationError('readable-search policy is unsupported');
  }
  return value;
}

export function assertReadableSearchItemKind(value: unknown): ReadableSearchItemKind {
  if (typeof value !== 'string' || !ITEM_KINDS.has(value as ReadableSearchItemKind)) {
    throw new ReadableSearchValidationError('readable-search item kind is unsupported');
  }
  return value as ReadableSearchItemKind;
}

export function assertSafeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReadableSearchValidationError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function assertSafePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ReadableSearchValidationError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function assertReadableSearchRecordHead(
  value: ReadableSearchRecordHead,
  label: string,
): ReadableSearchRecordHead {
  const position = assertSafeNonNegativeInteger(value.position, `${label} position`);
  if (position === 0 && value.record_hash !== null) {
    throw new ReadableSearchValidationError(`${label} zero position requires a null hash`);
  }
  if (position > 0 && value.record_hash === null) {
    throw new ReadableSearchValidationError(`${label} positive position requires a hash`);
  }
  return Object.freeze({
    position,
    record_hash:
      value.record_hash === null
        ? null
        : assertReadableSearchDigest(value.record_hash, `${label} hash`),
  });
}

export function assertReadableSearchSegmentIdentity(
  value: ReadableSearchSegmentIdentity,
): ReadableSearchSegmentIdentity {
  const organizationId = assertReadableSearchIdentifier(value.organization_id, 'segment organization_id');
  const policyId = assertReadableSearchPolicyId(value.policy_id);
  const segmentKind = value.segment_kind;
  if (segmentKind !== 'organization-member' && segmentKind !== 'reviewer') {
    throw new ReadableSearchValidationError('segment kind is unsupported');
  }
  const reviewerPrincipalId = value.reviewer_principal_id;
  const reviewerMembershipId = value.reviewer_membership_id;
  const reviewerPairIsAbsent = reviewerPrincipalId === null && reviewerMembershipId === null;
  const reviewerPairIsPresent = reviewerPrincipalId !== null && reviewerMembershipId !== null;
  if (
    (segmentKind === 'organization-member' &&
      (policyId !== ORGANIZATION_MEMBER_POLICY_ID || !reviewerPairIsAbsent)) ||
    (segmentKind === 'reviewer' &&
      (policyId !== RESTRICTED_REVIEWER_POLICY_ID || !reviewerPairIsPresent))
  ) {
    throw new ReadableSearchValidationError('segment policy and reviewer branch disagree');
  }
  return Object.freeze({
    organization_id: organizationId,
    segment_id: assertReadableSearchDigest(value.segment_id, 'segment_id'),
    segment_kind: segmentKind,
    policy_id: policyId,
    policy_contract_sha256: assertReadableSearchDigest(
      value.policy_contract_sha256,
      'segment policy_contract_sha256',
    ),
    reviewer_principal_id:
      reviewerPrincipalId === null
        ? null
        : assertReadableSearchIdentifier(reviewerPrincipalId, 'reviewer_principal_id'),
    reviewer_membership_id:
      reviewerMembershipId === null
        ? null
        : assertReadableSearchIdentifier(reviewerMembershipId, 'reviewer_membership_id'),
  });
}
