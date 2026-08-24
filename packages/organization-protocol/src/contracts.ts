import type {
  JsonObject,
  P256SigningKeyDescriptor,
} from "@echo-brain/federation-protocol";

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
