import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow } from '../application/contracts.js';
import {
  ReviewerPolicyFactError,
  projectReviewerPolicyFacts,
  readCanonicalRecordEnvelope,
  readReviewerRestrictedEnvelope,
  reviewerPolicyFactSetSha256,
  type OrganizationRecordReviewerPolicyFactRow,
  type ReviewerFactAuditExpectation,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';
import {
  toOrganizationRecordLogRow,
  type RawOrganizationRecordLogRow,
} from '../application/log-row.js';
import { verifyOrganizationRecordChain } from './chain-verification.js';
import {
  isReviewerRestrictedRow,
  readReviewerPolicyFactsAtPosition,
} from './reviewer-policy-fact.js';

/**
 * Startup log-fact integrity admission.
 *
 * Before the reviewer route may be admitted, this maintenance verifier walks
 * the log chain and deterministically compares every reviewer-v2 canonical
 * record with the complete fact table. It reads canonical rows directly and
 * never routes protected content through the serving facts port.
 *
 * It offers no repair. There is no fact repair, reconstruction, backfill, or
 * mutable shadow index in V1: an incomplete or corrupt fact state keeps
 * reviewer reads and new reviewer-v2 ingest unavailable until a complete
 * known-good state restore and its operator reconciliation gate. Legacy
 * append and derive remain live. Facts are never used to repair canonical
 * truth, and canonical truth is never rewritten to match a fact.
 */

export type ReviewerFactAdmissionFailureKind =
  | 'facts_missing'
  | 'facts_incomplete'
  | 'facts_unexpected'
  | 'facts_mismatched'
  | 'record_unreadable'
  | 'chain_invalid';

export interface ReviewerFactAdmissionFailure {
  readonly position: number | null;
  readonly kind: ReviewerFactAdmissionFailureKind;
  readonly detail: string;
}

/**
 * One exact audit row Authority must independently re-query before it may mark
 * reviewer reads ready. The record package proves structure and reprojection;
 * it never opens `authority.sqlite` or an integrations database, so it hands
 * back exactly what the caller needs for its own primary-key lookup.
 */
export interface ReviewerFactAdmission {
  readonly admitted: boolean;
  readonly reviewer_records_verified: number;
  readonly reviewer_facts_verified: number;
  readonly failures: readonly ReviewerFactAdmissionFailure[];
  /** Empty when the structural pass already failed. */
  readonly audit_expectations: readonly ReviewerFactAuditExpectation[];
}

function readRows(database: Database.Database): OrganizationRecordLogRow[] {
  return (
    database
      .prepare('SELECT * FROM organization_record_log ORDER BY position')
      .all() as RawOrganizationRecordLogRow[]
  ).map(toOrganizationRecordLogRow);
}

function orphanFactPositions(database: Database.Database): number[] {
  return (
    database
      .prepare(
        `SELECT DISTINCT fact.log_position AS log_position
         FROM organization_record_reviewer_policy_fact AS fact
         LEFT JOIN organization_record_log AS record
           ON record.position = fact.log_position
          AND record.record_hash = fact.record_hash
         WHERE record.position IS NULL
         ORDER BY fact.log_position`,
      )
      .all() as { log_position: number }[]
  ).map((row) => row.log_position);
}

export interface VerifyReviewerFactAdmissionInput {
  readonly organization_id: string;
  readonly authority_id: string;
  /**
   * The injected closed reviewer-v2 validator. Without it a stored reviewer-v2
   * record cannot be admitted: the route stays closed rather than admitting on
   * a looser reading of the durable document.
   */
  readonly reviewer_validator?: ReviewerRestrictedEnvelopeValidator;
}

export function verifyReviewerFactAdmission(
  database: Database.Database,
  input: VerifyReviewerFactAdmissionInput,
): ReviewerFactAdmission {
  const failures: ReviewerFactAdmissionFailure[] = [];
  const auditExpectations: ReviewerFactAuditExpectation[] = [];
  let reviewerRecords = 0;
  let reviewerFacts = 0;

  const rows = readRows(database);
  const chain = verifyOrganizationRecordChain({
    organization_id: input.organization_id,
    authority_id: input.authority_id,
    rows: () => rows,
  });
  for (const failure of chain.failures) {
    failures.push({
      position: failure.position,
      kind: 'chain_invalid',
      detail: `${failure.kind}: ${failure.detail}`,
    });
  }

  for (const position of orphanFactPositions(database)) {
    failures.push({
      position,
      kind: 'facts_unexpected',
      detail: 'reviewer facts reference no exact canonical record',
    });
  }

  for (const row of rows) {
    const committed = readReviewerPolicyFactsAtPosition(database, row.position);
    if (!isReviewerRestrictedRow(row)) {
      if (committed.length > 0) {
        failures.push({
          position: row.position,
          kind: 'facts_unexpected',
          detail: 'a non-reviewer record carries reviewer facts',
        });
      }
      continue;
    }
    reviewerRecords += 1;
    let expected: readonly OrganizationRecordReviewerPolicyFactRow[];
    let view: ReturnType<typeof readReviewerRestrictedEnvelope>;
    try {
      const envelope = readReviewerRestrictedEnvelope(
        readCanonicalRecordEnvelope(row),
        input.reviewer_validator as ReviewerRestrictedEnvelopeValidator,
      );
      if (committed.length === 0) {
        failures.push({
          position: row.position,
          kind: 'facts_missing',
          detail: 'a reviewer record committed without its facts',
        });
        continue;
      }
      view = envelope;
      // The expected proof digest is derived from the canonical envelope and
      // this log's organization binding, never read back out of `committed`.
      // A forged digest that every fact of this record agrees on is therefore
      // still a mismatch.
      expected = projectReviewerPolicyFacts({
        envelope,
        log_position: row.position,
        record_hash: row.record_hash,
        organization_id: input.organization_id,
        canonical_envelope_sha256: row.envelope_sha256,
      });
    } catch (error) {
      failures.push({
        position: row.position,
        kind: 'record_unreadable',
        detail:
          error instanceof ReviewerPolicyFactError
            ? error.message
            : 'reviewer record could not be reprojected',
      });
      continue;
    }
    if (committed.length !== expected.length) {
      failures.push({
        position: row.position,
        kind: 'facts_incomplete',
        detail: `expected ${expected.length} reviewer facts, found ${committed.length}`,
      });
      continue;
    }
    if (
      reviewerPolicyFactSetSha256(committed) !==
      reviewerPolicyFactSetSha256(expected)
    ) {
      failures.push({
        position: row.position,
        kind: 'facts_mismatched',
        detail: 'committed reviewer facts do not reproject from their record',
      });
      continue;
    }
    reviewerFacts += committed.length;
    auditExpectations.push(Object.freeze({
      log_position: row.position,
      record_hash: row.record_hash,
      organization_id: input.organization_id,
      authority_id: input.authority_id,
      envelope_id: view.envelope_id,
      canonical_envelope_sha256: row.envelope_sha256,
      approval_id: view.approval_id,
      request_id: view.request_id,
      request_sha256: view.request_sha256,
      provider_event_sha256: view.provider_event_sha256,
      adapter_binding_id: view.adapter_binding_id,
      permission_grant_id: view.permission_grant_id,
      authorization_audit_event_id: view.authorization_audit_event_id,
      authorization_audit_entry_sha256: view.authorization_audit_entry_sha256,
      authorization_proof_sha256:
        expected[0]?.authorization_proof_sha256 ?? '',
      reviewer_principal_id: view.reviewer_principal_id,
      reviewer_membership_id: view.reviewer_membership_id,
      semantic_intent_sha256: view.semantic_intent_sha256,
      reviewer_release_draft_sha256: view.reviewer_release_draft_sha256,
      approval_presentation_sha256: view.approval_presentation_sha256,
      message_presentation_sha256: view.message_presentation_sha256,
      evaluated_at: view.evaluated_at,
      idempotency_key: view.idempotency_key,
      installation_id: view.installation_id,
    }));
  }

  const admitted = failures.length === 0;
  return Object.freeze({
    admitted,
    reviewer_records_verified: reviewerRecords,
    reviewer_facts_verified: reviewerFacts,
    failures: Object.freeze(failures),
    // A failed structural pass publishes nothing to re-query: the route is
    // already closed, and there is no repair to attempt.
    audit_expectations: Object.freeze(admitted ? auditExpectations : []),
  });
}
