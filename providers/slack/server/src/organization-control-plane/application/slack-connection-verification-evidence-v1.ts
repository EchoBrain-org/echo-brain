import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import type { VerifiedSlackConnection } from "./slack-integration-contracts.js";

/** The exact existing auth.test + bots.info proof, shared with capability-aware recovery. */
export function slackConnectionVerificationEvidenceSha256V1(input: Omit<VerifiedSlackConnection, "verification_evidence_sha256">): `sha256:${string}` {
  return canonicalSha256({
    method: "slack_auth_test_bots_info",
    team_id: input.team_id,
    enterprise_id: input.enterprise_id,
    bot_user_id: input.bot_user_id,
    bot_id: input.bot_id,
    app_id: input.app_id,
    bot_deleted: false,
    granted_scopes: input.granted_scopes,
  });
}
