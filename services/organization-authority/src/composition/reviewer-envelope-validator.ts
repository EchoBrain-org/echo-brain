import {
  projectReviewerReleaseDraft,
  reviewerSignalIdSha256,
  validateOrganizationRecordReviewerApprovalEnvelope,
} from '@echo-brain/organization-protocol';
import type {
  JsonObject,
} from '@echo-brain/organization-record';
import type {
  ReviewerRestrictedEnvelopeValidator,
  ReviewerRestrictedEnvelopeView,
} from '@echo-brain/organization-record/reviewer';

/**
 * The one adapter from the durable reviewer-v2 contract to the record
 * workspace's structural view.
 *
 * `packages/organization-protocol` owns the closed v2 validator. The record
 * workspace owns facts, proofs, and derivation, and has no import edge to the
 * protocol package — so composition is the only place the two can meet. This
 * function is that place, and it is deliberately the only reviewer-v2 reader
 * any record-side caller is given: ingest, the log's append and duplicate
 * reproof, derive, startup admission, and the selected-row read all receive
 * exactly this closure.
 *
 * It adds one binding the pure document validator cannot make on its own: the
 * envelope's authorization evidence must name this Authority and this
 * organization. A well-formed reviewer approval for a different organization
 * or a different authority is not admissible here, and failing that check is
 * indistinguishable from any other closed-validation failure downstream.
 */
export interface ReviewerRestrictedEnvelopeValidatorBinding {
  readonly organization_id: string;
  readonly authority_id: string;
}

function releasedSignals(
  envelope: ReturnType<typeof validateOrganizationRecordReviewerApprovalEnvelope>,
): ReviewerRestrictedEnvelopeView['signals'] {
  // Exactly the canonical projector order the frozen draft is built from:
  // decisions in payload order, then actions, then rationales.
  const raw = [
    ...envelope.payload.brief.decisions,
    ...envelope.payload.brief.actions,
    ...envelope.payload.brief.rationales,
  ];
  const draft = projectReviewerReleaseDraft({
    approval_id: envelope.idempotency_key,
    brief: envelope.payload.brief,
  });
  if (draft.items.length !== raw.length) {
    throw new Error(
      'reviewer release draft does not cover every released payload signal',
    );
  }
  return draft.items.map((item, index) => {
    const signal = raw[index];
    if (
      signal === undefined ||
      reviewerSignalIdSha256(signal.id) !== item.signal_id_sha256 ||
      signal.kind !== item.kind ||
      signal.text !== item.text
    ) {
      // The raw signal id is what the fact's `signal_id_sha256` and `atom_id`
      // are derived from, and the draft is what the reviewer actually
      // approved. If the two disagree at any position the package is not the
      // one that was released.
      throw new Error(
        `reviewer released signal ${index} does not match the approved release draft`,
      );
    }
    return { id: signal.id, kind: item.kind, text: item.text };
  });
}

export function reviewerRestrictedEnvelopeValidator(
  binding: ReviewerRestrictedEnvelopeValidatorBinding,
): ReviewerRestrictedEnvelopeValidator {
  return (document: JsonObject): ReviewerRestrictedEnvelopeView => {
    const envelope =
      validateOrganizationRecordReviewerApprovalEnvelope(document);
    const evidence = envelope.reviewer.authorization;
    if (
      evidence.organization_id !== binding.organization_id ||
      evidence.authority_id !== binding.authority_id
    ) {
      throw new Error(
        'reviewer envelope authorization does not name this organization and authority',
      );
    }
    return {
      schema_version: 2,
      authority_id: evidence.authority_id,
      organization_id: evidence.organization_id,
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      installation_id: envelope.submitter.installation_id,
      reviewer_principal_id: envelope.reviewer.principal_id,
      reviewer_membership_id: envelope.reviewer.membership_id,
      approval_id: evidence.approval_id,
      request_id: evidence.request_id,
      request_sha256: evidence.request_sha256,
      provider_event_sha256: evidence.provider_event_sha256,
      adapter_binding_id: evidence.adapter_binding_id,
      permission_grant_id: evidence.permission_grant_id,
      semantic_intent_sha256: evidence.semantic_intent_sha256,
      reviewer_release_draft_sha256: evidence.reviewer_release_draft_sha256,
      approval_presentation_sha256: evidence.approval_presentation_sha256,
      message_presentation_sha256: evidence.message_presentation_sha256,
      authorization_audit_event_id: evidence.authorization_audit_event_id,
      authorization_audit_entry_sha256:
        evidence.authorization_audit_entry_sha256,
      evaluated_at: evidence.evaluated_at,
      signals: releasedSignals(envelope),
    };
  };
}
