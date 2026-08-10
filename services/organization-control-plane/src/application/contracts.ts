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
  "reactions:read",
  "users:read",
] as const);

export interface VerifiedSlackConnection {
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string;
  app_id: string | null;
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
}

export interface SlackApprovalPresentationExpectation {
  presentation_policy_id: "pilot-two-person-audience-v1";
  audience_notice_sha256: `sha256:${string}`;
  notice_text: string;
  fallback_text: string;
}

export interface VerifiedSlackReaction {
  observed: boolean;
  /** True when a grammar-valid card contains an own audience extension. */
  presentation_candidate_observed: boolean;
  /** Present only after the exact, unedited marker-bound card was verified. */
  message_presentation_sha256: `sha256:${string}` | null;
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
