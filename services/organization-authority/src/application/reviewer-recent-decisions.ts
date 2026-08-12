import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS,
  MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES,
  ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  validateOrganizationReviewerRecentDecisionsResponse,
} from '@echo-brain/organization-api';
import type {
  OrganizationRecentDecisionKindV1,
  OrganizationReviewerRecentDecisionItemV1,
  OrganizationReviewerRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';
import { RESTRICTED_REVIEWER_POLICY_ID } from '@echo-brain/organization-protocol';
import { reviewerPolicyContractSha256 } from './reviewer-policy-contract.js';
import { validateReviewerQueryAuditDecisionDetail } from './reviewer-query-audit.js';

/**
 * The reviewer read, in pure application terms.
 *
 * Everything here is deliberately free of storage: it builds the one closed
 * response, its exact bytes, and the two closed audit details. The route's
 * fence -- current Person root, fact selection, audit revalidation, resolver
 * binding, canonical reprojection, and the final linearizing transaction --
 * lives in the Authority application that calls these.
 */

export type ReviewerRecentDecisionsErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'unavailable';

export class ReviewerRecentDecisionsError extends Error {
  constructor(
    readonly code: ReviewerRecentDecisionsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReviewerRecentDecisionsError';
  }
}

function unavailable(message: string, cause?: unknown): never {
  throw new ReviewerRecentDecisionsError('unavailable', message, { cause });
}

export type ReviewerRecentDecisionsAuditedStatus = 200 | 401 | 404;

export interface PreparedReviewerRecentDecisionsResponse {
  readonly status_code: ReviewerRecentDecisionsAuditedStatus;
  /** The exact bytes whose digest is committed before they may be sent. */
  readonly body: Buffer;
  /**
   * Minimized audit references, aligned by item. Never handed to the HTTP
   * serializer and never part of the response.
   */
  readonly returned_atom_ids: readonly Sha256Digest[];
  readonly returned_record_hashes: readonly Sha256Digest[];
}

/** One reprojected released item plus its internal, never-published address. */
export interface ReviewerResolvedItem {
  readonly kind: OrganizationRecentDecisionKindV1;
  readonly text: string;
  readonly atom_id: Sha256Digest;
  readonly record_hash: Sha256Digest;
}

function closedResponse(
  items: readonly OrganizationReviewerRecentDecisionItemV1[],
): OrganizationReviewerRecentDecisionsResponseV1 {
  return {
    schema_version: 1,
    items: [...items],
    policy_id: RESTRICTED_REVIEWER_POLICY_ID,
    witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  };
}

function responseBytes(
  value: OrganizationReviewerRecentDecisionsResponseV1,
): Buffer {
  try {
    return Buffer.from(canonicalJson(value), 'utf8');
  } catch (error) {
    unavailable('reviewer recent decisions response is not canonicalizable', error);
  }
}

/**
 * Builds and serializes the bounded response exactly once.
 *
 * There is no prefix truncation: the frozen draft bounds already guarantee the
 * fit, and builder and ingest rejected impossible input before append. An
 * over-budget or over-count result here is therefore incoherent stored state,
 * not a response to trim.
 */
export function prepareReviewerRecentDecisionsResponse(
  items: readonly ReviewerResolvedItem[],
): PreparedReviewerRecentDecisionsResponse {
  if (items.length > MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS) {
    unavailable('reviewer recent decisions exceeded its item bound');
  }
  let value: OrganizationReviewerRecentDecisionsResponseV1;
  try {
    value = validateOrganizationReviewerRecentDecisionsResponse(
      closedResponse(
        items.map((item) => ({ kind: item.kind, text: item.text })),
      ),
    );
  } catch (error) {
    unavailable(
      'reviewer recent decisions response failed closed-schema validation',
      error,
    );
  }
  const body = responseBytes(value);
  if (body.length > MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES) {
    unavailable('reviewer recent decisions response exceeded its byte bound');
  }
  return {
    status_code: 200,
    body,
    returned_atom_ids: items.map((item) => item.atom_id),
    returned_record_hashes: items.map((item) => item.record_hash),
  };
}

/**
 * The exact policy-contract digest. It covers the policy, the human
 * consequence, and every wire version this read depends on, so a change to any
 * of them is visible in every audited decision.
 *
 * Its one definition lives in `reviewer-policy-contract.ts` so the audit
 * validator can compare a stored digest with the same fixed value without
 * importing this module back.
 */
export { reviewerPolicyContractSha256 };

export interface ReviewerQueryAuditRequester {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly enrollment_id: string;
  readonly installation_id: string;
}

export interface ReviewerQueryAuditRecordHead {
  readonly position: number;
  readonly record_hash: Sha256Digest | null;
}

export interface ReviewerAllowAuditInput {
  readonly request_id: string;
  readonly request_sha256: Sha256Digest;
  readonly requester: ReviewerQueryAuditRequester;
  readonly person_state_sha256: Sha256Digest;
  readonly record_head: ReviewerQueryAuditRecordHead;
  readonly returned_atom_ids: readonly Sha256Digest[];
  readonly returned_record_hashes: readonly Sha256Digest[];
  readonly evaluated_at: string;
  readonly response_sha256: Sha256Digest;
}

/**
 * The exact allow detail. An empty result is still an audited allow: it stores
 * empty returned arrays, the canonical empty-200 response digest, and it does
 * not omit the head witness.
 */
export function reviewerAllowAuditDetail(
  input: ReviewerAllowAuditInput,
): JsonValue {
  if (
    input.returned_atom_ids.length !== input.returned_record_hashes.length
  ) {
    unavailable('reviewer audit item references are not aligned');
  }
  if (
    (input.record_head.position === 0) !==
    (input.record_head.record_hash === null)
  ) {
    unavailable('reviewer audit record head is inconsistent');
  }
  return validateReviewerQueryAuditDecisionDetail(
    {
      decision: 'allow',
      reason_code: 'active_exact_reviewer_membership',
      occurred_at: input.evaluated_at,
    },
    {
      schema_version: 1,
      kind: 'reviewer-query-decision-audit-detail-v1',
      request_id: input.request_id,
      request_sha256: input.request_sha256,
      requester: {
        principal_id: input.requester.principal_id,
        membership_id: input.requester.membership_id,
        enrollment_id: input.requester.enrollment_id,
        installation_id: input.requester.installation_id,
      },
      decision: 'allow',
      reason_code: 'active_exact_reviewer_membership',
      evaluation_complete: true,
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: reviewerPolicyContractSha256(),
      person_state_sha256: input.person_state_sha256,
      record_head: {
        position: input.record_head.position,
        record_hash: input.record_head.record_hash,
      },
      returned_atom_ids: [...input.returned_atom_ids],
      returned_record_hashes: [...input.returned_record_hashes],
      evaluated_at: input.evaluated_at,
      response_sha256: input.response_sha256,
    },
  );
}

export type ReviewerDenialReasonCode =
  | 'installation_access_expired'
  | 'inactive_or_unbound_reviewer_membership';

export interface ReviewerDenialAuditInput {
  readonly request_id: string;
  readonly request_sha256: Sha256Digest;
  readonly requester: ReviewerQueryAuditRequester;
  readonly reason_code: ReviewerDenialReasonCode;
  readonly person_state_sha256: Sha256Digest;
  readonly evaluated_at: string;
  readonly response_sha256: Sha256Digest;
}

/**
 * The exact denial detail. It omits `record_head`, `returned_atom_ids`, and
 * `returned_record_hashes` entirely, and contains no target, item, record,
 * meeting, participant, title, text, source, candidate count, or descriptive
 * evidence.
 */
export function reviewerDenialAuditDetail(
  input: ReviewerDenialAuditInput,
): JsonValue {
  return validateReviewerQueryAuditDecisionDetail(
    {
      decision: 'deny',
      reason_code: input.reason_code,
      occurred_at: input.evaluated_at,
    },
    {
      schema_version: 1,
      kind: 'reviewer-query-decision-audit-detail-v1',
      request_id: input.request_id,
      request_sha256: input.request_sha256,
      requester: {
        principal_id: input.requester.principal_id,
        membership_id: input.requester.membership_id,
        enrollment_id: input.requester.enrollment_id,
        installation_id: input.requester.installation_id,
      },
      decision: 'deny',
      reason_code: input.reason_code,
      evaluation_complete: true,
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      policy_contract_sha256: reviewerPolicyContractSha256(),
      person_state_sha256: input.person_state_sha256,
      evaluated_at: input.evaluated_at,
      response_sha256: input.response_sha256,
    },
  );
}

const FIXED_ERROR_VALUES = {
  400: { error: { code: 'invalid_request', message: 'request is invalid' } },
  401: { error: { code: 'unauthorized', message: 'authorization failed' } },
  404: { error: { code: 'not_found', message: 'resource was not found' } },
  503: {
    error: {
      code: 'unavailable',
      message: 'service is temporarily unavailable',
    },
  },
  500: {
    error: { code: 'internal_error', message: 'authority operation failed' },
  },
} as const;

export type ReviewerRecentDecisionsFixedErrorStatus =
  keyof typeof FIXED_ERROR_VALUES;

export function fixedReviewerRecentDecisionsErrorBytes(
  status: ReviewerRecentDecisionsFixedErrorStatus,
): Buffer {
  return Buffer.from(canonicalJson(FIXED_ERROR_VALUES[status]), 'utf8');
}

/** The audited denial's own exact bytes, whose digest is committed with it. */
export function preparedReviewerDenial(
  status: 401 | 404,
): PreparedReviewerRecentDecisionsResponse {
  return {
    status_code: status,
    body: fixedReviewerRecentDecisionsErrorBytes(status),
    returned_atom_ids: [],
    returned_record_hashes: [],
  };
}
