import type { OrganizationSecretReference } from "@echo-brain/organization-control-plane/application/organization-secret-store-contracts";
export {
  AUTHORITY_FILE_SECRET_BACKEND,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
} from "@echo-brain/organization-control-plane/application/organization-secret-store-contracts";

/**
 * The exact bot scopes ECHO's private per-organization Slack app requests,
 * and the only scope set an organization connection contract accepts.
 */
export const SLACK_PRIVATE_APP_BOT_SCOPES_V1 = Object.freeze([
  "chat:write",
  "im:history",
  "im:write",
  "users:read",
] as const);

/**
 * The user scopes the same app declares for the person's browser sign-in
 * (Sign in with Slack). Sign-in only: the bot install never requests them and
 * no organization connection contract records them.
 */
export const SLACK_PRIVATE_APP_SIGN_IN_SCOPES_V1 = Object.freeze([
  "openid",
  "profile",
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

export interface PostSlackIdentityLinkChallengeInput {
  recipient_user_id?: string;
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
  openIdentityLinkDirectMessage?(
    token: string, recipientUserId: string, expectedTeamId: string, signal?: AbortSignal,
  ): Promise<{ team_id: string; channel_id: string; recipient_user_id: string }>;

  verifyConnection(
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection>;
  verifyHuman(
    token: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackHuman>;
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

/** The organization's own ECHO app installed through Nango; identity proofs use private DMs only. */
export interface ActiveSlackOrganizationTool {
  connection_attempt_id: string;
  connection_id: string;
  team_id: string;
  enterprise_id: string | null;
  bot_user_id: string;
  bot_id: string;
  app_id: string | null;
  granted_scopes: readonly string[];
  secret: OrganizationSecretReference;
}

export interface BegunSlackIdentityLinkChallenge {
  channel_id: string;
  recipient_user_id: string;
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
  channel_id: string;
  recipient_user_id: string;
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
