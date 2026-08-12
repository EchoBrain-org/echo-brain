import type { Buffer } from "node:buffer";
import type {
  JsonObject,
  P256SigningKeyDescriptor,
  Sha256Digest,
  SignedDocument,
} from "@echo-brain/federation-protocol";

export type CanonicalPayloadSigner = (
  canonicalPayload: Buffer,
) => Promise<Buffer>;

export type OrganizationMembershipTypeV1 = "owner" | "employee";

/**
 * An unsigned trust bootstrap. Authenticity comes only from the channel that
 * supplies and pins this exact descriptor, never from this document itself.
 */
export interface OrganizationAuthorityDescriptorV1 {
  schema_version: 1;
  kind: "echo-organization-authority";
  authority_id: string;
  organization_id: string;
  signing_key: P256SigningKeyDescriptor;
}

export interface OrganizationEnrollmentRequestPayloadV1 {
  schema_version: 1;
  kind: "echo-organization-enrollment-request";
  enrollment_grant_sha256: Sha256Digest;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_signing_key: P256SigningKeyDescriptor;
}

export interface OrganizationEnrollmentRequestV1
  extends OrganizationEnrollmentRequestPayloadV1, SignedDocument {}

export interface OrganizationEnrollmentReceiptPayloadV1 {
  schema_version: 1;
  kind: "echo-organization-enrollment-receipt";
  enrollment_id: string;
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  installation_id: string;
  installation_key_id: Sha256Digest;
  request_sha256: Sha256Digest;
  enrolled_at: string;
}

export interface OrganizationEnrollmentReceiptV1
  extends OrganizationEnrollmentReceiptPayloadV1, SignedDocument {}

interface OrganizationInstallationAccessStateBasePayloadV1 {
  schema_version: 1;
  kind: "echo-organization-installation-access-state";
  authority_id: string;
  authority_key_id: Sha256Digest;
  organization_id: string;
  enrollment_id: string;
  enrollment_receipt_sha256: Sha256Digest;
  principal_id: string;
  membership_id: string;
  membership_type: OrganizationMembershipTypeV1;
  installation_id: string;
  installation_key_id: Sha256Digest;
  access_state_sequence: number;
  evaluated_at: string;
}

export interface ActiveOrganizationInstallationAccessStatePayloadV1 extends OrganizationInstallationAccessStateBasePayloadV1 {
  status: "active";
  revocation_reason: null;
  valid_until: string;
}

export interface RevokedOrganizationInstallationAccessStatePayloadV1 extends OrganizationInstallationAccessStateBasePayloadV1 {
  status: "revoked";
  revocation_reason: "membership_revoked" | "installation_revoked";
  valid_until: null;
}

export type OrganizationInstallationAccessStatePayloadV1 =
  | ActiveOrganizationInstallationAccessStatePayloadV1
  | RevokedOrganizationInstallationAccessStatePayloadV1;

export type ActiveOrganizationInstallationAccessStateV1 =
  ActiveOrganizationInstallationAccessStatePayloadV1 & SignedDocument;

export type RevokedOrganizationInstallationAccessStateV1 =
  RevokedOrganizationInstallationAccessStatePayloadV1 & SignedDocument;

export type OrganizationInstallationAccessStateV1 =
  | ActiveOrganizationInstallationAccessStateV1
  | RevokedOrganizationInstallationAccessStateV1;

export type OrganizationInstallationAccessDecisionV1 =
  | {
      permitted: true;
      state: ActiveOrganizationInstallationAccessStateV1;
    }
  | {
      permitted: false;
      state: RevokedOrganizationInstallationAccessStateV1;
    };

/**
 * `correction` is reserved so a later tombstoning family cannot reuse a name
 * that already means something else. The V1 validators reject it.
 */
export type OrganizationRecordEventTypeV1 = "approval" | "rejection";

/**
 * A typed pointer back to the member-local source. Raw custody stays local:
 * only this locator and the bounded evidence spans already inside the approved
 * brief cross the wire.
 */
export interface OrganizationRecordSourceLocatorV1 {
  adapter_id: string;
  instance_id: string;
  external_id: string;
}

/**
 * The organization-record restatement of core's `EvidenceSpan`. Core imports no
 * packages by design, so the two shapes are pinned by shared golden fixtures
 * rather than by shared code.
 */
export interface OrganizationRecordEvidenceSpanV1 {
  meeting_id: string;
  block_id: string;
  quote?: string;
  started_at?: string;
  ended_at?: string;
}

interface OrganizationRecordSignalBaseV1 {
  id: string;
  text: string;
  subject: string | null;
  confidence: number | null;
  evidence: readonly OrganizationRecordEvidenceSpanV1[];
}

export interface OrganizationRecordDecisionSignalV1 extends OrganizationRecordSignalBaseV1 {
  kind: "decision";
  status: "proposed" | "decided" | "unresolved";
}

export interface OrganizationRecordActionSignalV1 extends OrganizationRecordSignalBaseV1 {
  kind: "action";
  owner: string | null;
  due_at: string | null;
}

export interface OrganizationRecordRationaleSignalV1 extends OrganizationRecordSignalBaseV1 {
  kind: "rationale";
  supports_signal_ids: readonly string[];
}

export type OrganizationRecordSignalV1 =
  | OrganizationRecordDecisionSignalV1
  | OrganizationRecordActionSignalV1
  | OrganizationRecordRationaleSignalV1;

export interface OrganizationRecordMeetingTimeV1 {
  scheduled_start_at?: string;
  scheduled_end_at?: string;
  actual_start_at?: string;
  actual_end_at?: string;
  timezone?: string;
  all_day?: boolean;
}

export interface OrganizationRecordParticipantIdentityV1 {
  kind: "source" | "email" | "phone" | "other";
  value: string;
}

export type OrganizationRecordParticipantRoleV1 =
  | "organizer"
  | "host"
  | "invitee"
  | "attendee"
  | "speaker"
  | "note_taker"
  | "bot";

/**
 * Participant facts exactly as approved. They are observations, never
 * principals: resolution against live membership is query-time gatekeeper work
 * and deliberately never travels with the record.
 */
export interface OrganizationRecordParticipantV1 {
  id: string;
  display_name?: string;
  identities?: readonly OrganizationRecordParticipantIdentityV1[];
  roles?: readonly OrganizationRecordParticipantRoleV1[];
  response_status?: "accepted" | "declined" | "tentative" | "unknown";
  attendance?: "attended" | "no_show" | "unknown";
  organization?: {
    name?: string;
    domain?: string;
  };
  is_external?: boolean;
  metadata?: Readonly<JsonObject>;
}

export interface OrganizationRecordDecisionBriefV1 {
  schema_version: 1;
  id: string;
  meeting: {
    id: string;
    title?: string;
    time?: OrganizationRecordMeetingTimeV1;
    participants: readonly OrganizationRecordParticipantV1[];
  };
  decisions: readonly OrganizationRecordDecisionSignalV1[];
  actions: readonly OrganizationRecordActionSignalV1[];
  rationales: readonly OrganizationRecordRationaleSignalV1[];
  provenance: {
    meeting_revision: string;
    processor: {
      kind: "decision-processor";
      adapter_id: string;
      instance_id: string;
      version: string;
    };
    generated_at: string;
  };
}

export interface OrganizationRecordDecisionLinksV1 {
  parent: string | null;
  supersedes: string | null;
}

/**
 * The resolved decision node exactly as the human approved it. `alternatives`
 * and `links` are carried for shape stability and are pinned to empty and null
 * by the V1 validator, because nothing in V1 derives meaning from them.
 */
export interface OrganizationRecordApprovalPayloadV1 {
  brief: OrganizationRecordDecisionBriefV1;
  source: OrganizationRecordSourceLocatorV1;
  alternatives: readonly JsonObject[];
  links: OrganizationRecordDecisionLinksV1 | null;
  reviewed_at: string;
  surface: string;
}

/**
 * A rejection records the act, never the rejected candidate content. The
 * optional reason is explicitly organization-visible.
 */
export interface OrganizationRecordRejectionPayloadV1 {
  source: OrganizationRecordSourceLocatorV1;
  meeting_id: string;
  rejected_at: string;
  reason: string | null;
  reconsider_after: string | null;
}

export type OrganizationRecordReviewerActionV1 = "approve" | "reject";

/**
 * The complete allowed authorization evaluation produced by the existing
 * approval-action authorizer. Organization ingest requires it; a locally
 * resolved node without it is skipped with an operator alert, never downgraded.
 *
 * `action` is the evaluated action the authority allowed. It must match the
 * envelope's `event_type` exactly -- `approve` for an approval, `reject` for a
 * rejection -- so an allow decision for one act can never authorize the other.
 */
export interface OrganizationRecordReviewerAuthorizationV1 {
  schema_version: 1;
  kind: "echo-organization-authorization-evidence";
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: OrganizationRecordReviewerActionV1;
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: true;
  reason_code: string;
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
}

/** The verified ids are the identity of record; `reviewed_by` is display only. */
export interface OrganizationRecordReviewerV1 {
  principal_id: string;
  membership_id: string;
  reviewed_by: string;
  authorization: OrganizationRecordReviewerAuthorizationV1;
}

/**
 * Approver intent as recorded, never a resolved reader list.
 *
 * Both fields are permanent contract, but schema version 1 pins them to the
 * conservative installation default (`restricted: true`, `reconsider_after:
 * null`): no approval surface has an affordance for either value, so any other
 * value on the wire would be an unattributed claim about approver intent.
 * Relaxing the pin when an affordance ships is a validator change, not a
 * schema change.
 */
export interface OrganizationRecordIntentV1 {
  restricted: boolean;
  reconsider_after: string | null;
}

export interface OrganizationRecordSubmitterV1 {
  installation_id: string;
  submitted_at: string;
}

interface OrganizationRecordEnvelopeBaseV1 {
  schema_version: 1;
  kind: "echo-organization-record-envelope";
  envelope_id: string;
  idempotency_key: string;
  reviewer: OrganizationRecordReviewerV1;
  submitter: OrganizationRecordSubmitterV1;
}

export interface OrganizationRecordApprovalEnvelopePayloadV1 extends OrganizationRecordEnvelopeBaseV1 {
  event_type: "approval";
  payload: OrganizationRecordApprovalPayloadV1;
  intent: OrganizationRecordIntentV1;
}

export interface OrganizationRecordRejectionEnvelopePayloadV1 extends OrganizationRecordEnvelopeBaseV1 {
  event_type: "rejection";
  payload: OrganizationRecordRejectionPayloadV1;
}

export interface OrganizationRecordApprovalEnvelopeV1
  extends OrganizationRecordApprovalEnvelopePayloadV1, SignedDocument {}

export interface OrganizationRecordRejectionEnvelopeV1
  extends OrganizationRecordRejectionEnvelopePayloadV1, SignedDocument {}

export type OrganizationRecordEnvelopeV1 =
  | OrganizationRecordApprovalEnvelopeV1
  | OrganizationRecordRejectionEnvelopeV1;

/**
 * The Authority-computed reviewer proof, quoted whole by the envelope. Every
 * digest is recomputed centrally from the live provider card and the immutable
 * integration-audit row: a client cannot nominate a reviewer, a policy, a
 * semantic digest, or a proof digest.
 */
export interface OrganizationRecordReviewerAuthorizationV2 {
  schema_version: 2;
  kind: "echo-organization-authorization-evidence";
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: "approve";
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: true;
  reason_code: "active_reviewer_restricted_notice_v1";
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: Sha256Digest;
  reviewer_release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
  semantic_intent_sha256: Sha256Digest;
  message_presentation_sha256: Sha256Digest;
}

export interface OrganizationRecordReviewerV2 {
  principal_id: string;
  membership_id: string;
  reviewed_by: string;
  authorization: OrganizationRecordReviewerAuthorizationV2;
}

/**
 * Reviewer intent is the frozen policy plus a commitment to the exact
 * Authority-computed semantic bytes the human approved. `purpose_id` and
 * `reconsider_after` are absent because V1 has no affordance for either; a
 * future purpose or reconsideration feature requires a new exact version.
 */
export interface OrganizationRecordReviewerIntentV2 {
  schema_version: 1;
  visibility: "restricted";
  policy_id: "restricted-reviewer-v1";
  provenance: {
    kind: "approval-surface-confirmation-v1";
    semantic_intent_sha256: Sha256Digest;
  };
}

export interface OrganizationRecordReviewerApprovalEnvelopePayloadV2 {
  schema_version: 2;
  kind: "echo-organization-record-envelope";
  event_type: "approval";
  envelope_id: string;
  idempotency_key: string;
  payload: OrganizationRecordApprovalPayloadV1;
  reviewer: OrganizationRecordReviewerV2;
  intent: OrganizationRecordReviewerIntentV2;
  submitter: OrganizationRecordSubmitterV1;
}

export interface OrganizationRecordReviewerApprovalEnvelopeV2
  extends OrganizationRecordReviewerApprovalEnvelopePayloadV2, SignedDocument {}

export interface OrganizationRecordOrganizationMemberAuthorizationV3 {
  schema_version: 3;
  kind: "echo-organization-authorization-evidence";
  policy_id: "organization-member-readable-v1";
  policy_contract_sha256: Sha256Digest;
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  installation_id: string;
  request_id: string;
  approval_id: string;
  action: "approve";
  request_sha256: Sha256Digest;
  provider_event_sha256: Sha256Digest;
  allowed: true;
  reason_code: "active_organization_member_readable_notice_v1";
  principal_id: string;
  membership_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: Sha256Digest;
  release_draft_sha256: Sha256Digest;
  approval_presentation_sha256: Sha256Digest;
  semantic_intent_sha256: Sha256Digest;
  message_presentation_sha256: Sha256Digest;
}

export interface OrganizationRecordOrganizationMemberV3 {
  principal_id: string;
  membership_id: string;
  reviewed_by: string;
  authorization: OrganizationRecordOrganizationMemberAuthorizationV3;
}

export interface OrganizationRecordOrganizationMemberIntentV3 {
  schema_version: 1;
  visibility: "organization-member-readable";
  policy_id: "organization-member-readable-v1";
  policy_contract_sha256: Sha256Digest;
  provenance: { kind: "approval-surface-confirmation-v1"; semantic_intent_sha256: Sha256Digest };
}

export interface OrganizationRecordOrganizationMemberApprovalEnvelopePayloadV3 {
  schema_version: 3;
  kind: "echo-organization-record-envelope";
  event_type: "approval";
  envelope_id: string;
  idempotency_key: string;
  payload: OrganizationRecordApprovalPayloadV1;
  reviewer: OrganizationRecordOrganizationMemberV3;
  intent: OrganizationRecordOrganizationMemberIntentV3;
  submitter: OrganizationRecordSubmitterV1;
}

export interface OrganizationRecordOrganizationMemberApprovalEnvelopeV3 extends OrganizationRecordOrganizationMemberApprovalEnvelopePayloadV3, SignedDocument {}

/**
 * Every envelope version the strict dispatcher admits. Unknown kinds and
 * versions are not members: they halt ingest and derive rather than falling
 * back to v1 or pilot behavior.
 */
export type OrganizationRecordEnvelopeAnyVersion =
  | OrganizationRecordEnvelopeV1
  | OrganizationRecordReviewerApprovalEnvelopeV2
  | OrganizationRecordOrganizationMemberApprovalEnvelopeV3;

/**
 * The authority's proof that one exact envelope reached one exact log
 * position. The signed `kind` and `schema_version` provide domain separation
 * with the shared `signed-document` primitive.
 *
 * `position` is the log record's monotonic position, named exactly as the
 * record core names it. The signing key is not restated as a payload field:
 * `integrity.key_id` already carries it, and verification compares that
 * directly with the pinned authority signing key.
 */
export interface OrganizationRecordReceiptPayloadV1 {
  schema_version: 1;
  kind: "echo-organization-record-receipt";
  authority_id: string;
  organization_id: string;
  envelope_id: string;
  envelope_sha256: Sha256Digest;
  installation_id: string;
  idempotency_key: string;
  position: number;
  record_hash: Sha256Digest;
  recorded_at: string;
}

export interface OrganizationRecordReceiptV1
  extends OrganizationRecordReceiptPayloadV1, SignedDocument {}
