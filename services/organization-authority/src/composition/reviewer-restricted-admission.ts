import {
  reviewerRestrictedEligibilityProofSha256,
} from '@echo-brain/organization-record/reviewer';
import type {
  ReviewerFactAdmission,
  ReviewerFactAuditExpectation,
  ReviewerFactAuthorizationReference,
  ReviewerRecordPort,
} from '@echo-brain/organization-record/reviewer';
import type {
  OrganizationRecordAuthorizationEvidenceStore,
  OrganizationRecordReviewerAuthorizationEvidenceView,
} from '../application/organization-record-ingest.js';

/**
 * Startup log-fact integrity admission, coordinated by Authority.
 *
 * The record package proves fact, envelope, and proof-digest structure and
 * hands back the exact audit rows it depends on. Authority then independently
 * re-queries each `aud_*` key by primary key and matches the complete closed
 * proof. Only when both halves agree may reviewer reads be marked ready.
 *
 * There is no window in which a self-consistent but unaudited fact becomes
 * readable, and there is no repair: missing or corrupt evidence keeps reviewer
 * reads and new reviewer-v2 ingest unavailable until a complete known-good
 * state restore and its operator reconciliation gate. Legacy append and derive
 * stay live regardless.
 */

export type ReviewerRestrictedReadinessFailureKind =
  | 'log_facts_invalid'
  | 'audit_evidence_absent'
  | 'audit_evidence_mismatch'
  | 'audit_evidence_corrupt'
  | 'audit_evidence_unavailable';

export interface ReviewerRestrictedReadinessFailure {
  readonly log_position: number | null;
  readonly kind: ReviewerRestrictedReadinessFailureKind;
  readonly detail: string;
}

export interface ReviewerRestrictedReadiness {
  readonly ready: boolean;
  readonly reviewer_records_verified: number;
  readonly reviewer_facts_verified: number;
  readonly audit_rows_revalidated: number;
  readonly failures: readonly ReviewerRestrictedReadinessFailure[];
}

const AUDIT_FAILURE_KIND: Readonly<
  Record<string, ReviewerRestrictedReadinessFailureKind>
> = Object.freeze({
  absent: 'audit_evidence_absent',
  mismatch: 'audit_evidence_mismatch',
  corrupt: 'audit_evidence_corrupt',
  unavailable: 'audit_evidence_unavailable',
});

export interface VerifyReviewerRestrictedReadinessInput {
  readonly records: ReviewerRecordPort;
  readonly evidence: OrganizationRecordAuthorizationEvidenceStore;
  readonly organization_id: string;
  readonly authority_id: string;
}

function evidenceMatchesExpectation(
  expectation: ReviewerFactAuditExpectation,
  evidence: OrganizationRecordReviewerAuthorizationEvidenceView,
): boolean {
  if (
    evidence.policy_id !== 'restricted-reviewer-v1' ||
    evidence.authority_id !== expectation.authority_id ||
    evidence.organization_id !== expectation.organization_id ||
    evidence.installation_id !== expectation.installation_id ||
    evidence.approval_id !== expectation.approval_id ||
    evidence.request_id !== expectation.request_id ||
    evidence.request_sha256 !== expectation.request_sha256 ||
    evidence.provider_event_sha256 !== expectation.provider_event_sha256 ||
    evidence.adapter_binding_id !== expectation.adapter_binding_id ||
    evidence.permission_grant_id !== expectation.permission_grant_id ||
    evidence.reviewer_principal_id !== expectation.reviewer_principal_id ||
    evidence.reviewer_membership_id !== expectation.reviewer_membership_id ||
    evidence.reviewer_release_draft_sha256 !==
      expectation.reviewer_release_draft_sha256 ||
    evidence.approval_presentation_sha256 !==
      expectation.approval_presentation_sha256 ||
    evidence.semantic_intent_sha256 !== expectation.semantic_intent_sha256 ||
    evidence.message_presentation_sha256 !==
      expectation.message_presentation_sha256 ||
    evidence.authorization_audit_event_id !==
      expectation.authorization_audit_event_id ||
    evidence.authorization_audit_entry_sha256 !==
      expectation.authorization_audit_entry_sha256 ||
    evidence.evaluated_at !== expectation.evaluated_at
  ) {
    return false;
  }
  return (
    reviewerRestrictedEligibilityProofSha256({
      organization_id: expectation.organization_id,
      envelope_id: expectation.envelope_id,
      idempotency_key: expectation.idempotency_key,
      installation_id: expectation.installation_id,
      canonical_envelope_sha256:
        expectation.canonical_envelope_sha256 as `sha256:${string}`,
      reviewer_principal_id: evidence.reviewer_principal_id,
      reviewer_membership_id: evidence.reviewer_membership_id,
      reviewer_release_draft_sha256:
        evidence.reviewer_release_draft_sha256,
      approval_presentation_sha256: evidence.approval_presentation_sha256,
      semantic_intent_sha256: evidence.semantic_intent_sha256,
      message_presentation_sha256: evidence.message_presentation_sha256,
      authorization_audit_event_id:
        evidence.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        evidence.authorization_audit_entry_sha256,
      evaluated_at: evidence.evaluated_at,
    }) === expectation.authorization_proof_sha256
  );
}

export function reviewerAuthorizationEvidenceMatchesReference(
  reference: ReviewerFactAuthorizationReference,
  evidence: OrganizationRecordReviewerAuthorizationEvidenceView,
): boolean {
  if (
    evidence.policy_id !== 'restricted-reviewer-v1' ||
    evidence.authority_id !== reference.authority_id ||
    evidence.organization_id !== reference.organization_id ||
    evidence.installation_id !== reference.installation_id ||
    evidence.reviewer_principal_id !== reference.reviewer_principal_id ||
    evidence.reviewer_membership_id !== reference.reviewer_membership_id ||
    evidence.semantic_intent_sha256 !== reference.semantic_intent_sha256 ||
    evidence.authorization_audit_event_id !==
      reference.authorization_audit_event_id ||
    evidence.authorization_audit_entry_sha256 !==
      reference.authorization_audit_entry_sha256
  ) {
    return false;
  }
  return (
    reviewerRestrictedEligibilityProofSha256({
      organization_id: reference.organization_id,
      envelope_id: reference.envelope_id,
      idempotency_key: reference.idempotency_key,
      installation_id: reference.installation_id,
      canonical_envelope_sha256: reference.canonical_envelope_sha256,
      reviewer_principal_id: evidence.reviewer_principal_id,
      reviewer_membership_id: evidence.reviewer_membership_id,
      reviewer_release_draft_sha256:
        evidence.reviewer_release_draft_sha256,
      approval_presentation_sha256: evidence.approval_presentation_sha256,
      semantic_intent_sha256: evidence.semantic_intent_sha256,
      message_presentation_sha256: evidence.message_presentation_sha256,
      authorization_audit_event_id:
        evidence.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        evidence.authorization_audit_entry_sha256,
      evaluated_at: evidence.evaluated_at,
    }) === reference.authorization_proof_sha256
  );
}

export function verifyReviewerRestrictedReadiness(
  input: VerifyReviewerRestrictedReadinessInput,
): ReviewerRestrictedReadiness {
  const admission: ReviewerFactAdmission = input.records.verifyFactAdmission();
  const failures: ReviewerRestrictedReadinessFailure[] = admission.failures.map(
    (failure) => ({
      log_position: failure.position,
      kind: 'log_facts_invalid' as const,
      detail: `${failure.kind}: ${failure.detail}`,
    }),
  );
  let revalidated = 0;

  const verifyChain = input.evidence.verifyIntegrationAuditChain;
  const readEvidence =
    input.evidence.readAllowedReviewerAuthorizationEvidenceById;
  if (verifyChain === undefined || readEvidence === undefined) {
    failures.push({
      log_position: null,
      kind: 'audit_evidence_unavailable',
      detail: 'reviewer audit chain verification is not available',
    });
  } else {
    const chain = verifyChain.call(input.evidence);
    if (!chain.valid) {
      failures.push({
        log_position: null,
        kind: 'audit_evidence_corrupt',
        detail: chain.failure ?? 'reviewer integration audit chain is invalid',
      });
    }
  }

  for (const expectation of admission.audit_expectations) {
    if (readEvidence === undefined) continue;
    const match = readEvidence.call(
      input.evidence,
      expectation.authorization_audit_event_id,
    );
    if (match.status !== 'matched') {
      failures.push({
        log_position: expectation.log_position,
        kind: AUDIT_FAILURE_KIND[match.status] ?? 'audit_evidence_unavailable',
        detail: `reviewer audit evidence ${expectation.authorization_audit_event_id} is ${match.status}`,
      });
      continue;
    }
    if (!evidenceMatchesExpectation(expectation, match.evidence)) {
      failures.push({
        log_position: expectation.log_position,
        kind: 'audit_evidence_mismatch',
        detail: 'reviewer audit proof does not match the committed fact',
      });
      continue;
    }
    revalidated += 1;
  }

  return Object.freeze({
    ready: failures.length === 0,
    reviewer_records_verified: admission.reviewer_records_verified,
    reviewer_facts_verified: admission.reviewer_facts_verified,
    audit_rows_revalidated: revalidated,
    failures: Object.freeze(failures),
  });
}
