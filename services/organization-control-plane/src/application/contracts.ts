export const SLACK_PROVIDER = "slack";
export const SLACK_PROVIDER_ISSUER = "https://slack.com";
export const AUTHORITY_FILE_SECRET_BACKEND = "authority-file-v1";
export const SLACK_ORGANIZATION_TOOL_PROFILE = "slack-organization-tool-v1";
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
  ): Promise<boolean>;
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
  granted_scopes: readonly string[];
  secret: OrganizationSecretReference;
}

export interface LegacySlackOrganizationTool
  extends ActiveSlackOrganizationTool {
  activated_at: string;
  approve_reaction: string;
  reject_reaction: string;
}

export interface BootstrapSlackApprovalInput {
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
  adapter_id: "slack-reactions";
  adapter_instance_id: string;
  adapter_version: string;
  channel_id: string;
  approve_reaction: string;
  reject_reaction: string;
  organization_connection_id: string;
  connection: VerifiedSlackConnection;
  channel: VerifiedSlackChannel;
  human: VerifiedSlackHuman;
  now: string;
}

export interface BootstrapSlackApprovalResult {
  connection_attempt_id: string;
  identity_attempt_id: string;
  identity_link_id: string;
  connection_id: string;
  adapter_binding_id: string;
  approve_permission_grant_id: string;
  reject_permission_grant_id: string;
  organization_id: string;
  membership_id: string;
  installation_id: string;
  slack_team_id: string;
  slack_user_id: string;
  channel_id: string;
  created_at: string;
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
