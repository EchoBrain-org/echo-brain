import type Database from 'better-sqlite3';
import type { Sha256Digest } from '../application/contracts.js';
import type { ReviewerRestrictedEnvelopeValidator } from '../application/reviewer-policy-fact.js';
import type { ReviewerFactAdmission } from '../log/reviewer-fact-admission.js';
import { verifyReviewerFactAdmission } from '../log/reviewer-fact-admission.js';
import {
  openReviewerReadSession,
  type ReviewerReadCaller,
  type ReviewerReadSession,
} from './reviewer-policy-reader.js';

export interface OpenReviewerRecordSessionInput {
  readonly caller: ReviewerReadCaller;
  readonly request_sha256: Sha256Digest;
  readonly limit: number;
}

/**
 * The complete database-free surface Authority reviewer composition receives.
 * It cannot open SQLite, enumerate broad rows, derive content, or mint append
 * capabilities.
 */
export interface ReviewerRecordPort {
  verifyFactAdmission(): ReviewerFactAdmission;
  openSession(input: OpenReviewerRecordSessionInput): ReviewerReadSession;
}

export interface CreateReviewerRecordPortInput {
  readonly organization_id: string;
  readonly authority_id: string;
  readonly reviewer_validator: ReviewerRestrictedEnvelopeValidator;
}

export function createReviewerRecordPort(
  database: Database.Database,
  input: CreateReviewerRecordPortInput,
): ReviewerRecordPort {
  const binding = Object.freeze({ ...input });
  return Object.freeze({
    verifyFactAdmission: () =>
      verifyReviewerFactAdmission(database, {
        organization_id: binding.organization_id,
        authority_id: binding.authority_id,
        reviewer_validator: binding.reviewer_validator,
      }),
    openSession: (session: OpenReviewerRecordSessionInput) =>
      openReviewerReadSession(database, {
        ...session,
        organization_id: binding.organization_id,
        authority_id: binding.authority_id,
        reviewer_validator: binding.reviewer_validator,
      }),
  });
}
