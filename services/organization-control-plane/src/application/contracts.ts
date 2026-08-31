export const SLACK_PROVIDER = "slack";
export const SLACK_PROVIDER_ISSUER = "https://slack.com";
export const AUTHORITY_FILE_SECRET_BACKEND = "authority-file-v1";
export const SLACK_ORGANIZATION_TOOL_PROFILE = "slack-organization-tool-v1";
export const SLACK_DEFAULT_APPROVE_REACTION = "white_check_mark";
export const SLACK_DEFAULT_REJECT_REACTION = "x";
export const SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES = Object.freeze([
  "channels:history",
  "channels:read",
  "chat:write",
  "im:history",
  "im:write",
  "reactions:read",
  "users:read",
] as const);

export interface VerifiedSlackConnection {
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string;
  app_id: string;
  granted_scopes: readonly string[];
  verification_evidence_sha256: `sha256:${string}`;
}

export interface VerifiedSlackHuman {
  team_id: string;
  user_id: string;
  verification_evidence_sha256: `sha256:${string}`;
}

export interface VerifiedSlackChannel {
  team_id: string;
  channel_id: string;
  /** The exact selected channel was verified as a public organization channel. */
  is_public_organization_channel?: boolean;
  /** The selected channel was not archived, frozen, read-only, or thread-only. */
  is_active?: boolean;
  /** The bot was observed as a member of that exact selected channel. */
  bot_membership_verified?: boolean;
  /** Slack accepted the bot's channel inspection with the supplied token. */
  bot_access_verified?: boolean;
  verification_evidence_sha256: `sha256:${string}`;
}

export interface VerifySlackReactionInput {
  expected_team_id: string;
  expected_enterprise_id: string | null;
  expected_bot_user_id: string;
  expected_bot_id: string;
  expected_app_id: string | null;
  approval_id: string;
  channel_id: string;
  message_ts: string;
  reaction_name: string;
  opposite_reaction_name: string;
  user_id: string;
  /**
   * Authority-owned presentation evidence. The caller does not choose these
   * values: they come from the startup-validated permission-pilot marker.
   * `null` preserves the pre-pilot approval path without making it eligible
   * for the pilot read policy.
   */
  expected_presentation: SlackApprovalPresentationExpectation | null;
  /**
   * The closed reviewer expectation, or `null` for every non-reviewer card.
   * The pilot and reviewer expectations are mutually exclusive: a request that
   * carries both is invalid input, never a card to reinterpret.
   */
  expected_reviewer_presentation?: SlackReviewerPresentationExpectation | null;
  expected_organization_member_presentation?: SlackOrganizationMemberPresentationExpectation | null;
  /**
   * The signed request's provider-event digest. It is a member of the reviewer
   * provider-message preimage, so a proof can never be replayed against a
   * different signed action.
   */
  reviewer_provider_event_sha256?: `sha256:${string}`;
  organization_member_provider_event_sha256?: `sha256:${string}`;
  /**
   * True when the caller only needs the reviewer card's own frozen reaction
   * pair parsed -- the schema-v1 rejection of a reviewer card. No reviewer
   * proof is produced.
   */
  parse_reviewer_card_reactions?: boolean;
  /**
   * True when the caller only needs the organization-member card's own frozen
   * reaction pair parsed -- the schema-v1 rejection of an organization-member
   * card. No organization-member approval proof is produced.
   */
  parse_organization_member_card_reactions?: boolean;
}

export interface SlackApprovalPresentationExpectation {
  presentation_policy_id: "pilot-two-person-audience-v1";
  audience_notice_sha256: `sha256:${string}`;
  notice_text: string;
  fallback_text: string;
}

/**
 * The closed reviewer expectation. It contains only the policy, the frozen
 * reaction pair, and the two digests the signed request committed to: the
 * verifier reconstructs the draft and presentation from the live card and
 * compares, so no title, item text, or reconstructed draft is an input.
 */
export interface SlackReviewerPresentationExpectation {
  policy_id: "restricted-reviewer-v1";
  approve_reaction: string;
  reject_reaction: string;
  reviewer_release_draft_sha256: `sha256:${string}`;
  approval_presentation_sha256: `sha256:${string}`;
}

/** A positive reviewer proof returns digests only, never card content. */
export interface VerifiedSlackReviewerPresentation {
  reviewer_release_draft_sha256: `sha256:${string}`;
  approval_presentation_sha256: `sha256:${string}`;
  message_presentation_sha256: `sha256:${string}`;
}
export interface SlackOrganizationMemberPresentationExpectation {
  policy_id: "organization-member-readable-v1";
  policy_contract_sha256: `sha256:${string}`;
  approve_reaction: string;
  reject_reaction: string;
  release_draft_sha256: `sha256:${string}`;
  approval_presentation_sha256: `sha256:${string}`;
}
export interface VerifiedSlackOrganizationMemberPresentation {
  release_draft_sha256: `sha256:${string}`;
  approval_presentation_sha256: `sha256:${string}`;
  message_presentation_sha256: `sha256:${string}`;
}

export interface VerifiedSlackReaction {
  observed: boolean;
  /** True when a grammar-valid card contains an own audience extension. */
  presentation_candidate_observed: boolean;
  /** Present only after the exact, unedited marker-bound card was verified. */
  message_presentation_sha256: `sha256:${string}` | null;
  /**
   * Present only after the complete closed reviewer card, both recomputed
   * digests, provider identity, absent edit evidence, and the reaction all
   * verified. A mixed pilot/reviewer presentation never produces it.
   */
  reviewer_presentation?: VerifiedSlackReviewerPresentation;
  organization_member_presentation?: VerifiedSlackOrganizationMemberPresentation;
  /**
   * The two frozen reaction names parsed from the live reviewer card. The
   * schema-v1 rejection path uses them to prove the card's own pair, and
   * requires both to equal the current active binding pair.
   */
  reviewer_card_reactions?: {
    approve_reaction: string;
    reject_reaction: string;
  };
  /**
   * The two frozen reaction names parsed from the live organization-member
   * card. This is rejection-only schema-v1 evidence, not schema-v3 approval
   * presentation evidence.
   */
  organization_member_card_reactions?: {
    approve_reaction: string;
    reject_reaction: string;
  };
}

export interface PostSlackIdentityLinkChallengeInput {
  expected_team_id: string;
  expected_enterprise_id: string | null;
  expected_bot_user_id: string;
  expected_bot_id: string;
  expected_app_id: string | null;
  challenge_attempt_id: string;
  channel_id: string;
  issued_at: string;
  expires_at: string;
}

export interface PostedSlackIdentityLinkChallenge {
  team_id: string;
  channel_id: string;
  challenge_message_ts: string;
}

export interface ObserveSlackIdentityLinkChallengeInput
  extends PostSlackIdentityLinkChallengeInput {
  challenge_message_ts: string;
  challenge_code: string;
}

export interface ObservedSlackIdentityLinkChallenge {
  team_id: string;
  user_id: string;
  channel_id: string;
  challenge_message_ts: string;
  reply_message_ts: string;
  verification_evidence_sha256: `sha256:${string}`;
}

export interface SlackIntegrationProvider {
  verifyConnection(
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection>;
  verifyHuman(
    token: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackHuman>;
  verifyChannel(
    token: string,
    channelId: string,
    expectedTeamId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackChannel>;
  verifyReaction(
    token: string,
    input: VerifySlackReactionInput,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackReaction>;
  postIdentityLinkChallenge(
    token: string,
    input: PostSlackIdentityLinkChallengeInput,
    signal?: AbortSignal,
  ): Promise<PostedSlackIdentityLinkChallenge>;
  observeIdentityLinkChallenge(
    token: string,
    input: ObserveSlackIdentityLinkChallengeInput,
    signal?: AbortSignal,
  ): Promise<ObservedSlackIdentityLinkChallenge>;
}

export interface OrganizationSecretReference {
  secret_backend_id: typeof AUTHORITY_FILE_SECRET_BACKEND;
  secret_handle_id: string;
}

export interface OrganizationSecretStore {
  create(secret: string): OrganizationSecretReference;
  read(reference: OrganizationSecretReference): string;
  listReferences(): readonly OrganizationSecretReference[];
  remove(reference: OrganizationSecretReference): void;
}

export interface ActiveSlackOrganizationTool {
  connection_attempt_id: string;
  connection_id: string;
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string;
  app_id: string | null;
  channel_id: string;
  approve_reaction: string;
  reject_reaction: string;
  granted_scopes: readonly string[];
  secret: OrganizationSecretReference;
}

export interface LegacySlackOrganizationTool
  extends ActiveSlackOrganizationTool {
  activated_at: string;
}

/**
 * A ready v1 Slack organization tool created before Slack app identity was
 * mandatory. It may only be upgraded by re-running the explicit onboarding
 * operation with a freshly verified, canonical app ID.
 */
export interface UpgradeableSlackOrganizationTool
  extends ActiveSlackOrganizationTool {
  activated_at: string;
  app_id: null;
}

export interface SlackIdentityLinkInstallation {
  authority_id: string;
  organization_id: string;
  enrollment_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  installation_key_id: `sha256:${string}`;
}

export interface BeginSlackIdentityLinkChallengeInput {
  request_sha256: `sha256:${string}`;
  challenge_code_sha256: `sha256:${string}`;
  installation: SlackIdentityLinkInstallation;
  organization_tool: ActiveSlackOrganizationTool;
  now: string;
}

export interface BegunSlackIdentityLinkChallenge {
  challenge_attempt_id: string;
  created_at: string;
  expires_at: string;
}

export interface PendingSlackIdentityLinkChallenge
  extends BegunSlackIdentityLinkChallenge {
  principal_id: string;
  membership_id: string;
  installation_id: string;
}

export interface CompleteSlackIdentityLinkChallengeInput {
  command_id: string;
  command_sha256: `sha256:${string}`;
  challenge_attempt_id: string;
  challenge_code_sha256: `sha256:${string}`;
  challenge_message_ts: string;
  installation: SlackIdentityLinkInstallation;
  organization_tool: ActiveSlackOrganizationTool;
  observed: ObservedSlackIdentityLinkChallenge;
  adapter_id: "slack-reactions";
  adapter_instance_id: string;
  adapter_version: string;
  authority_checked_at: string;
  now: string;
}

export interface CompletedSlackIdentityLink {
  schema_version: 1;
  kind: "echo-organization-slack-link-result";
  identity_link_id: string;
  connection_id: string;
  adapter_binding_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  installation_id: string;
  provider: "slack";
  provider_tenant_id: string;
  provider_subject_id: string;
  channel_id: string;
  linked_at: string;
  identity_link_created: boolean;
  adapter_binding_created: boolean;
  permission_grants_created: 0;
}

/**
 * The stable Authority-owned Person session coordinates that bind one Slack
 * challenge. Access credentials and their digests remain Authority-private;
 * completion re-authenticates this exact identity binding and family.
 */
export interface PersonSlackIdentityLinkSession {
  authority_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  identity_binding_id: string;
  session_family_id: string;
}

export interface BeginPersonSlackIdentityLinkChallengeInput {
  request_sha256: `sha256:${string}`;
  challenge_code_sha256: `sha256:${string}`;
  person_session: PersonSlackIdentityLinkSession;
  organization_tool: ActiveSlackOrganizationTool;
  now: string;
}

export interface PendingPersonSlackIdentityLinkChallenge
  extends BegunSlackIdentityLinkChallenge {
  principal_id: string;
  membership_id: string;
}

export interface CompletePersonSlackIdentityLinkChallengeInput {
  command_id: string;
  command_sha256: `sha256:${string}`;
  challenge_attempt_id: string;
  challenge_code_sha256: `sha256:${string}`;
  challenge_message_ts: string;
  person_session: PersonSlackIdentityLinkSession;
  organization_tool: ActiveSlackOrganizationTool;
  observed: ObservedSlackIdentityLinkChallenge;
  authority_checked_at: string;
  now: string;
}

/** Person-v2 completion creates or reuses only the external identity link. */
export interface CompletedPersonSlackIdentityLink {
  schema_version: 2;
  kind: "echo-organization-person-slack-link-result";
  identity_link_id: string;
  connection_id: string;
  organization_id: string;
  principal_id: string;
  membership_id: string;
  provider: "slack";
  provider_tenant_id: string;
  provider_subject_id: string;
  channel_id: string;
  linked_at: string;
  identity_link_created: boolean;
}

export interface ActivateExistingSlackApprovalInput {
  command_id: string;
  command_sha256: `sha256:${string}`;
  organization_id: string;
  authority_id: string;
  administrator_principal_id: string;
  administrator_membership_id: string;
  target_principal_id: string;
  target_membership_id: string;
  installation_id: string;
  installation_key_id: `sha256:${string}`;
  identity_link_id: string;
  adapter_binding_id: string;
  now: string;
}

export interface ActivateExistingSlackApprovalResult {
  identity_link_id: string;
  adapter_binding_id: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
  membership_id: string;
  installation_id: string;
  activated_at: string;
  permission_grants_created: 0 | 2;
}

export interface OnboardSlackOrganizationToolInput {
  command_id: string;
  command_sha256: `sha256:${string}`;
  organization_id: string;
  authority_id: string;
  administrator_principal_id: string;
  administrator_membership_id: string;
  connection: VerifiedSlackConnection;
  channel: VerifiedSlackChannel;
  secret: OrganizationSecretReference;
  now: string;
}

export interface OnboardSlackOrganizationToolResult {
  connection_attempt_id: string;
  connection_id: string;
  organization_id: string;
  provider: typeof SLACK_PROVIDER;
  status: "active";
  slack_team_id: string;
  slack_bot_user_id: string;
  channel_id: string;
  granted_scopes: readonly string[];
  activated_at: string;
}

export interface SlackApprovalPermissionLookup {
  organization_id: string;
  installation_id: string;
  installation_key_id: `sha256:${string}`;
  adapter_id: string;
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  reaction_name: string;
  slack_team_id: string;
  slack_user_id: string;
  slack_enterprise_id: string | null;
  slack_bot_user_id: string;
  slack_bot_id: string;
  slack_app_id: string | null;
  action: "approve" | "reject";
}

export interface SlackApprovalPermissionCandidate {
  identity_link_id: string;
  principal_id: string;
  membership_id: string;
  connection_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  secret_backend_id: typeof AUTHORITY_FILE_SECRET_BACKEND;
  secret_handle_id: string;
  slack_bot_user_id: string;
  slack_bot_id: string;
  slack_enterprise_id: string | null;
  slack_app_id: string | null;
  approve_reaction: string;
  reject_reaction: string;
}

/**
 * The one complete active Slack approval binding a server runtime may compose.
 * It is deliberately narrower than the administrator overview: both action
 * grants and the exact linked human must already exist before this view is
 * returned.
 */
export interface ActiveSlackApprovalRuntimeBinding {
  organization_tool: ActiveSlackOrganizationTool;
  identity_link_id: string;
  principal_id: string;
  membership_id: string;
  reviewer_slack_user_id: string;
  adapter_binding_id: string;
  installation_id: string;
  installation_key_id: `sha256:${string}`;
  adapter_id: "slack-reactions";
  adapter_instance_id: string;
  adapter_version: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
}

export type OrganizationPermissionReasonCode =
  | "active_membership_and_direct_grant"
  | "active_membership_direct_grant_pilot_notice_v1"
  | "installation_inactive"
  | "no_active_link_binding_or_grant"
  | "provider_unavailable"
  | "provider_identity_mismatch"
  | "provider_reaction_not_observed"
  | "target_membership_inactive";

export interface RecordedPermissionDecision {
  request_sha256: `sha256:${string}`;
  provider_event_sha256: `sha256:${string}`;
  action: "approve" | "reject";
  allowed: boolean;
  reason_code: OrganizationPermissionReasonCode;
  principal_id: string | null;
  membership_id: string | null;
  adapter_binding_id: string | null;
  permission_grant_id: string | null;
  evaluated_at: string;
}

export interface RecordPermissionDecisionInput extends RecordedPermissionDecision {
  request_id: string;
  authority_evidence_sha256: `sha256:${string}`;
  authority_checked_at: string;
  organization_id: string;
  caller_principal_id: string;
  caller_membership_id: string;
  installation_id: string;
  identity_link_id: string | null;
  connection_id: string | null;
  approval_id: string;
  detail: Readonly<Record<string, unknown>>;
}

export interface OrganizationIntegrationsOverview {
  identity_links: readonly Readonly<Record<string, unknown>>[];
  tool_connections: readonly Readonly<Record<string, unknown>>[];
  adapter_bindings: readonly Readonly<Record<string, unknown>>[];
  permission_grants: readonly Readonly<Record<string, unknown>>[];
  recent_audit: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Every field of a frozen authorization evidence document, as the appended
 * audit row stores them. The lookup below matches all of them at once: the
 * evidence is only meaningful if the Authority's own append-only audit still
 * holds exactly this evaluation.
 *
 * `authority_evidence_sha256` is deliberately absent. That column digests the
 * Authority *status* the evaluation observed, not this evidence document, so
 * comparing an invented digest against it would authorize nothing.
 */
export interface ApprovalAuthorizationEvidenceLookup {
  organization_id: string;
  installation_id: string;
  approval_id: string;
  action: "approve" | "reject";
  request_id: string;
  principal_id: string;
  membership_id: string;
  request_sha256: string;
  provider_event_sha256: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  reason_code: string;
  evaluated_at: string;
}

export interface OrganizationPermissionPilotEligibilityProof {
  policy_id: "pilot-member-readable-v1";
  presentation_policy_id: "pilot-two-person-audience-v1";
  audience_notice_sha256: `sha256:${string}`;
  message_presentation_sha256: `sha256:${string}`;
}

/**
 * Absent, ambiguous, and corrupt are distinct outcomes and all deny. Keeping
 * malformed notice detail separate from a genuine miss lets the record
 * Authority preserve a frozen pilot envelope for a retry instead of filing a
 * permanent rejection for damage in its own audit store.
 */
export type ApprovalAuthorizationEvidenceMatch =
  | {
      readonly status: "matched";
      readonly permission_pilot_eligibility?: OrganizationPermissionPilotEligibilityProof;
    }
  | { readonly status: "absent" }
  | { readonly status: "ambiguous" }
  | { readonly status: "corrupt" };

/**
 * The signed reviewer commitments one exact `aud_*` row must satisfy. The
 * lookup is by primary key, so multiplicity is database corruption rather than
 * an `ambiguous` result.
 */
export interface ReviewerAuthorizationEvidenceExpectation {
  organization_id: string;
  installation_id: string;
  approval_id: string;
  request_id: string;
  principal_id: string;
  membership_id: string;
  request_sha256: string;
  provider_event_sha256: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  reviewer_release_draft_sha256: string;
  approval_presentation_sha256: string;
  semantic_intent_sha256: string;
  message_presentation_sha256: string;
  authorization_audit_entry_sha256: string;
}

/** The closed reviewer proof. No raw presentation content is ever returned. */
export interface ReviewerRestrictedAuthorizationProof {
  policy_id: "restricted-reviewer-v1";
  reviewer_principal_id: string;
  reviewer_membership_id: string;
  reviewer_release_draft_sha256: `sha256:${string}`;
  approval_presentation_sha256: `sha256:${string}`;
  semantic_intent_sha256: `sha256:${string}`;
  message_presentation_sha256: `sha256:${string}`;
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: `sha256:${string}`;
  evaluated_at: string;
}

/**
 * The complete, text-free reviewer authorization reconstructed from one
 * validated immutable integration-audit row.
 *
 * This is used by startup admission and the reviewer read path, where the
 * caller intentionally does not have protected canonical-envelope content
 * yet.  The exact `aud_*` primary-key lookup owns all of these values; no
 * caller supplies them as an expected object.
 */
export interface ReviewerRestrictedAuthorizationEvidence
  extends ReviewerRestrictedAuthorizationProof {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly installation_id: string;
  readonly approval_id: string;
  readonly request_id: string;
  readonly request_sha256: `sha256:${string}`;
  readonly provider_event_sha256: `sha256:${string}`;
  readonly adapter_binding_id: string;
  readonly permission_grant_id: string;
}

export type ReviewerAuthorizationEvidenceRead =
  | {
      readonly status: "matched";
      readonly evidence: ReviewerRestrictedAuthorizationEvidence;
    }
  | { readonly status: "absent" }
  | { readonly status: "corrupt" }
  | { readonly status: "unavailable" };

export interface OrganizationIntegrationAuditChainVerification {
  readonly valid: boolean;
  readonly entries_verified: number;
  readonly head_sequence: number;
  readonly head_entry_sha256: `sha256:${string}` | null;
  readonly failure: string | null;
}

/**
 * Healthy `absent`/`mismatch` is terminal invalid input. `corrupt` and
 * `unavailable` are retryable and degrade reviewer V1 alone; they never widen
 * access or fall back to another policy.
 */
export type ReviewerAuthorizationEvidenceMatch =
  | {
      readonly status: "matched";
      readonly audit_entry_sha256: `sha256:${string}`;
      readonly proof: ReviewerRestrictedAuthorizationProof;
    }
  | { readonly status: "absent" }
  | { readonly status: "mismatch" }
  | { readonly status: "corrupt" }
  | { readonly status: "unavailable" };

/**
 * The reviewer allow that appends exactly one integration-audit row. Every
 * digest is Authority-computed; the caller supplies no proof object.
 */
export interface RecordReviewerPermissionDecisionInput {
  organization_id: string;
  authority_id: string;
  request_id: string;
  request_sha256: `sha256:${string}`;
  provider_event_sha256: `sha256:${string}`;
  approval_id: string;
  installation_id: string;
  reviewer_principal_id: string;
  reviewer_membership_id: string;
  identity_link_id: string;
  connection_id: string;
  adapter_binding_id: string;
  permission_grant_id: string;
  evaluated_at: string;
  authority_evidence_sha256: `sha256:${string}`;
  detail: Readonly<Record<string, unknown>>;
}

export interface RecordedReviewerPermissionDecision {
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: `sha256:${string}`;
}
export interface RecordOrganizationMemberReadablePermissionDecisionInput {
  organization_id: string; authority_id: string; request_id: string;
  request_sha256: `sha256:${string}`; provider_event_sha256: `sha256:${string}`;
  approval_id: string; installation_id: string; approving_principal_id: string;
  approving_membership_id: string; identity_link_id: string; connection_id: string;
  adapter_binding_id: string; permission_grant_id: string; evaluated_at: string;
  authority_evidence_sha256: `sha256:${string}`; detail: Readonly<Record<string, unknown>>;
}
export interface RecordedOrganizationMemberReadablePermissionDecision {
  authorization_audit_event_id: string;
  authorization_audit_entry_sha256: `sha256:${string}`;
}
export interface OrganizationMemberAuthorizationEvidenceExpectation {
  organization_id: string; installation_id: string; approval_id: string; request_id: string;
  principal_id: string; membership_id: string; request_sha256: string;
  provider_event_sha256: string; adapter_binding_id: string; adapter_instance_id: string;
  permission_grant_id: string;
  evaluated_at: string; policy_contract_sha256: string; release_draft_sha256: string;
  approval_presentation_sha256: string; semantic_intent_sha256: string;
  message_presentation_sha256: string; authorization_audit_entry_sha256: string;
}
export type OrganizationMemberAuthorizationEvidenceMatch =
  | {
      readonly status: "matched";
      readonly audit_entry_sha256: `sha256:${string}`;
      readonly adapter_instance_id: string;
    }
  | { readonly status: "absent" | "mismatch" | "corrupt" | "unavailable" };
