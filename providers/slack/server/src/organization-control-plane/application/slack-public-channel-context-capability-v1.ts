import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";
import type { OrganizationToolConnectionContractV2 } from "./organization-tool-connection-contracts-v2.js";
import { SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, type VerifiedSlackConnection } from "./slack-integration-contracts.js";
import { slackConnectionVerificationEvidenceSha256V1 } from "./slack-connection-verification-evidence-v1.js";

/**
 * A fresh provider observation proves capability; the frozen connection state
 * is historical approval evidence and cannot authorize a channel read itself.
 * Authority must separately fence the configured channel and current owner.
 */
export function assertSlackPublicChannelContextConnectionV1(input: {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly verified: VerifiedSlackConnection;
}): void {
  const { connection, verified } = input;
  const scopes = verified.granted_scopes;
  if (connection.provider_tenant_id !== verified.team_id || connection.provider_enterprise_id !== verified.enterprise_id ||
      connection.provider_app_id !== verified.app_id || connection.provider_bot_id !== verified.bot_id || connection.provider_bot_user_id !== verified.bot_user_id ||
      scopes.length !== SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1.length || scopes.some((scope, index) => scope !== SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1[index]) ||
      verified.verification_evidence_sha256 !== slackConnectionVerificationEvidenceSha256V1(verified)) {
    throw new AuthorityOperationError("unauthorized", "Slack public-channel context is not available");
  }
}
