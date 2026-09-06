export const AUTHORITY_FILE_SECRET_BACKEND = "authority-file-v1";
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

export interface BegunSlackIdentityLinkChallenge {
  challenge_attempt_id: string;
  created_at: string;
  expires_at: string;
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
