import { canonicalJson } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type {
  JsonObject,
  OrganizationRecordLogRow,
  Sha256Digest,
} from '../application/contracts.js';
import {
  deriveReviewerRestrictedEligibilityProof,
  isReviewerRestrictedEnvelopeDocument,
  projectReviewerPolicyFacts,
  readReviewerRestrictedEnvelope,
  reviewerFactInvalid,
  reviewerFactUnavailable,
  reviewerPolicyFactSetSha256,
  type OrganizationRecordReviewerPolicyFactRow,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';
import type { ReviewerPolicyFactAppendInput } from '../application/reviewer-eligibility-capability.js';

/**
 * The reviewer fact writer and its exact readers.
 *
 * Nothing here decides anything: the capability was minted by the Authority
 * append coordinator after an exact primary-key audit lookup, and this module
 * only proves that the capability, the canonical envelope, and the row about
 * to be written all describe the same act.
 */

export const REVIEWER_POLICY_FACT_COLUMNS = `reviewer_principal_id, reviewer_membership_id, log_position,
   record_hash, atom_order, signal_id_sha256, atom_id,
   semantic_intent_sha256, authorization_audit_event_id,
   authorization_audit_entry_sha256, authorization_proof_sha256`;

interface AppendedRecordIdentity {
  readonly organization_id: string;
  readonly position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope: JsonObject;
  readonly envelope_sha256: Sha256Digest;
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly installation_id: string;
  /** The injected closed reviewer-v2 validator, or absent in a v1-only host. */
  readonly validate: ReviewerRestrictedEnvelopeValidator | undefined;
}

/**
 * Derives the complete ordered fact set for one appended reviewer-v2 record,
 * proving the capability against the exact envelope identity first.
 *
 * Consuming the capability marks it spent before any comparison, so a failure
 * anywhere below cannot be retried with the same object; the coordinator must
 * repeat its audit lookup and mint a new attempt.
 */
export function reviewerPolicyFactsForAppend(
  identity: AppendedRecordIdentity,
  input: ReviewerPolicyFactAppendInput,
): readonly OrganizationRecordReviewerPolicyFactRow[] {
  const consumed = input.channel.consume(input.capability, {
    organization_id: identity.organization_id,
    envelope_id: identity.envelope_id,
    idempotency_key: identity.idempotency_key,
    installation_id: identity.installation_id,
    canonical_envelope_sha256: identity.envelope_sha256,
  });
  const envelope = readReviewerRestrictedEnvelope(
    identity.envelope,
    identity.validate as ReviewerRestrictedEnvelopeValidator,
  );

  // The digest that reaches the row is derived here, from the canonical
  // envelope and this log's own organization binding. The consumed capability
  // is then compared against that independent derivation rather than trusted
  // for it, so what is written is never a value a caller carried in.
  const derived = deriveReviewerRestrictedEligibilityProof({
    organization_id: identity.organization_id,
    canonical_envelope_sha256: identity.envelope_sha256,
    envelope,
  });
  if (
    canonicalJson(consumed.preimage as unknown as JsonObject) !==
      canonicalJson(derived.preimage as unknown as JsonObject) ||
    consumed.authorization_proof_sha256 !== derived.authorization_proof_sha256
  ) {
    reviewerFactInvalid(
      'verified reviewer eligibility does not describe this exact canonical envelope',
    );
  }
  return projectReviewerPolicyFacts({
    envelope,
    log_position: identity.position,
    record_hash: identity.record_hash,
    organization_id: identity.organization_id,
    canonical_envelope_sha256: identity.envelope_sha256,
  });
}

/**
 * Inserts the complete ordered fact set inside the caller's append
 * transaction. Every insert is strict: a duplicate, a gap, or a constraint
 * failure conflicts and rolls the record back with the facts.
 */
export function insertReviewerPolicyFacts(
  database: Database.Database,
  rows: readonly OrganizationRecordReviewerPolicyFactRow[],
): void {
  if (rows.length === 0) {
    reviewerFactInvalid('reviewer facts must not be empty for a reviewer record');
  }
  const insert = database.prepare(
    `INSERT INTO organization_record_reviewer_policy_fact (
       ${REVIEWER_POLICY_FACT_COLUMNS}
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [index, row] of rows.entries()) {
    if (row.atom_order !== index) {
      reviewerFactInvalid('reviewer facts must be a dense zero-based order');
    }
    insert.run(
      row.reviewer_principal_id,
      row.reviewer_membership_id,
      row.log_position,
      row.record_hash,
      row.atom_order,
      row.signal_id_sha256,
      row.atom_id,
      row.semantic_intent_sha256,
      row.authorization_audit_event_id,
      row.authorization_audit_entry_sha256,
      row.authorization_proof_sha256,
    );
  }
}

/** The committed facts of one record, in canonical order. */
export function readReviewerPolicyFactsAtPosition(
  database: Database.Database,
  position: number,
): readonly OrganizationRecordReviewerPolicyFactRow[] {
  return database
    .prepare(
      `SELECT ${REVIEWER_POLICY_FACT_COLUMNS}
       FROM organization_record_reviewer_policy_fact
       WHERE log_position = ?
       ORDER BY atom_order ASC`,
    )
    .all(position) as OrganizationRecordReviewerPolicyFactRow[];
}

/**
 * Reproves an already-committed reviewer record against a freshly minted
 * capability. A schema-v2 duplicate may not return before this succeeds: the
 * landed receipt-recovery shortcut is a schema-v1 affordance only.
 */
export function assertCommittedReviewerPolicyFactsMatch(
  database: Database.Database,
  identity: AppendedRecordIdentity,
  input: ReviewerPolicyFactAppendInput,
): void {
  const expected = reviewerPolicyFactsForAppend(identity, input);
  const committed = readReviewerPolicyFactsAtPosition(
    database,
    identity.position,
  );
  if (
    reviewerPolicyFactSetSha256(committed) !==
    reviewerPolicyFactSetSha256(expected)
  ) {
    // The record exists but its fact set is not the one this evidence proves.
    // That is incoherent stored state, not a caller error, so it stays
    // retryable and releases nothing.
    reviewerFactUnavailable(
      'committed reviewer facts do not match the reproved eligibility',
    );
  }
}

/**
 * The stored-row form of the same exact `(kind, schema_version)` dispatch. A
 * row whose bytes will not parse is not classified as reviewer-v2 here; the
 * chain walk and the per-record canonical checks in admission are what turn
 * that into a failure rather than a silent skip.
 */
export function isReviewerRestrictedRow(row: OrganizationRecordLogRow): boolean {
  if (row.event_type !== 'approval') return false;
  try {
    return isReviewerRestrictedEnvelopeDocument(
      JSON.parse(row.canonical_envelope) as unknown,
    );
  } catch {
    return false;
  }
}
