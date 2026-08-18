import type { JsonObject } from '@echo-brain/federation-protocol';

/** Where a decision came from, as persisted on the requested slot. */
export interface OrganizationRecordSourceLocator {
  readonly adapter_id: string;
  readonly instance_id: string;
  readonly external_id: string;
}

export type OrganizationRecordEventType = 'approval' | 'rejection';

/**
 * The authority-verified authorization evidence already stored on the resolved
 * slot by the approval surface. Organization ingest requires it: a node
 * resolved before enrollment, or otherwise without evidence, is skipped with
 * an operator alert and never silently downgraded.
 *
 * The whole allow decision travels, not a summary of it. The request and
 * provider-event digests bind the evidence to the exact signed permission
 * check the Authority evaluated, and the binding and grant ids preserve its
 * attribution for the pre-append audit lookup.
 */
interface OrganizationRecordAuthorizationEvidenceBase {
  readonly kind: 'echo-organization-authorization-evidence';
  readonly authority_id: string;
  readonly organization_id: string;
  readonly enrollment_id: string;
  readonly installation_id: string;
  readonly request_id: string;
  readonly approval_id: string;
  readonly action: OrganizationRecordAction;
  readonly request_sha256: string;
  readonly provider_event_sha256: string;
  readonly allowed: true;
  readonly reason_code: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
  readonly evaluated_at: string;
}

export interface OrganizationRecordAuthorizationEvidenceV1
  extends OrganizationRecordAuthorizationEvidenceBase {
  readonly schema_version: 1;
  readonly action: OrganizationRecordAction;
  readonly reason_code: string;
}

export interface OrganizationRecordReviewerAuthorizationEvidenceV2
  extends OrganizationRecordAuthorizationEvidenceBase {
  readonly schema_version: 2;
  readonly action: 'approve';
  readonly reason_code: 'active_reviewer_restricted_notice_v1';
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: string;
  readonly reviewer_release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly semantic_intent_sha256: string;
  readonly message_presentation_sha256: string;
}

export interface OrganizationRecordOrganizationMemberAuthorizationEvidenceV3
  extends OrganizationRecordAuthorizationEvidenceBase {
  readonly schema_version: 3;
  readonly action: 'approve';
  readonly reason_code: 'active_organization_member_readable_notice_v1';
  readonly policy_id: 'organization-member-readable-v1';
  readonly policy_contract_sha256: string;
  readonly authorization_audit_event_id: string;
  readonly authorization_audit_entry_sha256: string;
  readonly release_draft_sha256: string;
  readonly approval_presentation_sha256: string;
  readonly semantic_intent_sha256: string;
  readonly message_presentation_sha256: string;
}

/** Every closed authorization family the record submitter may carry. */
export type OrganizationRecordAuthorizationEvidence =
  | OrganizationRecordAuthorizationEvidenceV1
  | OrganizationRecordReviewerAuthorizationEvidenceV2
  | OrganizationRecordOrganizationMemberAuthorizationEvidenceV3;

export type OrganizationRecordAction = 'approve' | 'reject';

export interface OrganizationRecordEnvelopeBuildInput {
  readonly event_type: OrganizationRecordEventType;
  /** The sha256 approval id; also the envelope's idempotency key. */
  readonly approval_id: string;
  readonly source: OrganizationRecordSourceLocator;
  readonly meeting_id: string;
  /** The exact approved brief. Null for rejection events, which carry no brief content. */
  readonly brief: unknown;
  readonly alternatives: readonly JsonObject[];
  readonly links: {
    readonly parent: string | null;
    readonly supersedes: string | null;
  };
  readonly reviewed_at: string;
  /** Display-only; the verified principal in the evidence is the identity of record. */
  readonly reviewed_by: string;
  /** Organization-visible rejection reason, or null. */
  readonly reason: string | null;
  readonly surface: string;
  readonly authorization: OrganizationRecordAuthorizationEvidence;
  readonly submitted_at: string;
}

/** The built, installation-signed envelope before the submitter freezes it. */
export interface BuiltOrganizationRecordEnvelope {
  readonly envelope_id: string;
  readonly idempotency_key: string;
  readonly event_type: OrganizationRecordEventType;
  readonly envelope: JsonObject;
}

export interface OrganizationRecordEnvelopeBuilder {
  build(
    input: OrganizationRecordEnvelopeBuildInput,
  ): Promise<BuiltOrganizationRecordEnvelope>;
}
