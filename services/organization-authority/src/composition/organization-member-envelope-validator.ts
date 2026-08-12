import {
  organizationMemberReadableSignalIdSha256,
  projectOrganizationMemberReadableReleaseDraft,
  validateOrganizationRecordOrganizationMemberApprovalEnvelope,
} from '@echo-brain/organization-protocol';
import type { JsonObject } from '@echo-brain/organization-record';
import type {
  OrganizationMemberReadableEnvelopeValidator,
  OrganizationMemberReadableEnvelopeView,
} from '@echo-brain/organization-record/append';

/**
 * The sole Authority-composed adapter from the closed protocol v3 validator
 * to record's intentionally smaller structural view. Record never imports the
 * protocol package and never supplies a looser validator for this family.
 */
export function organizationMemberReadableEnvelopeValidator(input: {
  readonly organization_id: string;
  readonly authority_id: string;
}): OrganizationMemberReadableEnvelopeValidator {
  return (document: JsonObject): OrganizationMemberReadableEnvelopeView => {
    const envelope = validateOrganizationRecordOrganizationMemberApprovalEnvelope(document);
    const authorization = envelope.reviewer.authorization;
    if (
      authorization.organization_id !== input.organization_id ||
      authorization.authority_id !== input.authority_id
    ) {
      throw new Error('organization-member authorization does not name this organization and authority');
    }
    const raw = [
      ...envelope.payload.brief.decisions,
      ...envelope.payload.brief.actions,
      ...envelope.payload.brief.rationales,
    ];
    const draft = projectOrganizationMemberReadableReleaseDraft({
      approval_id: envelope.idempotency_key,
      brief: envelope.payload.brief,
    });
    if (draft.items.length !== raw.length) {
      throw new Error('organization-member release draft does not cover every released payload signal');
    }
    const signals = draft.items.map((item, index) => {
      const signal = raw[index];
      if (
        signal === undefined ||
        organizationMemberReadableSignalIdSha256(signal.id) !== item.signal_id_sha256 ||
        signal.kind !== item.kind ||
        signal.text !== item.text
      ) {
        throw new Error(`organization-member released signal ${index} does not match the approved release draft`);
      }
      return { id: signal.id, kind: item.kind, text: item.text };
    });
    return {
      schema_version: 3,
      authority_id: authorization.authority_id,
      organization_id: authorization.organization_id,
      envelope_id: envelope.envelope_id,
      idempotency_key: envelope.idempotency_key,
      installation_id: envelope.submitter.installation_id,
      approving_principal_id: envelope.reviewer.principal_id,
      approving_membership_id: envelope.reviewer.membership_id,
      policy_contract_sha256: authorization.policy_contract_sha256,
      release_draft_sha256: authorization.release_draft_sha256,
      approval_presentation_sha256: authorization.approval_presentation_sha256,
      semantic_intent_sha256: authorization.semantic_intent_sha256,
      message_presentation_sha256: authorization.message_presentation_sha256,
      authorization_audit_event_id: authorization.authorization_audit_event_id,
      authorization_audit_entry_sha256: authorization.authorization_audit_entry_sha256,
      evaluated_at: authorization.evaluated_at,
      signals,
    };
  };
}
