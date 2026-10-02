import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { buildOrganizationToolConnectionContractV2 } from "../../../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { assertSlackPublicChannelContextConnectionV1 } from "../../../src/organization-control-plane/application/slack-public-channel-context-capability-v1.js";
import { slackConnectionVerificationEvidenceSha256V1 } from "../../../src/organization-control-plane/application/slack-connection-verification-evidence-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, type VerifiedSlackConnection } from "../../../src/organization-control-plane/application/slack-integration-contracts.js";

const connection = buildOrganizationToolConnectionContractV2({ authority_id: "authority-test", organization_id: "org-test", state_lineage_id: "lineage-test",
  connection_id: "connection-test", provider_issuer: "https://slack.com", provider_tenant_kind: "workspace", provider_tenant_id: "TTEST123",
  provider_enterprise_id: null, tool_kind: "slack", provider_app_id: "ATEST123", provider_bot_id: "BTEST123", provider_bot_user_id: "UBOT123",
  required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, public_connection_configuration_sha256: canonicalSha256({ recipe: 1 }) });

function proof(overrides: Partial<VerifiedSlackConnection> = {}): VerifiedSlackConnection {
  const value = { team_id: connection.provider_tenant_id, enterprise_id: connection.provider_enterprise_id, app_id: connection.provider_app_id,
    bot_id: connection.provider_bot_id, bot_user_id: connection.provider_bot_user_id, granted_scopes: SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, ...overrides };
  return { ...value, verification_evidence_sha256: overrides.verification_evidence_sha256 ?? slackConnectionVerificationEvidenceSha256V1(value) };
}

describe("Slack public-channel context capability proof V1", () => {
  it("preserves the pre-capability auth.test plus bots.info evidence format exactly", () => {
    // Golden baseline proof, computed from the deployed V1 canonical fields.
    expect(proof({ granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 }).verification_evidence_sha256)
      .toBe("sha256:0f41f001d13d6f10662a21cd8f27488ec764d5452d1735658fbb52769dd7860f");
  });

  it("accepts a fresh exact provider proof without changing the baseline approval connection", () => {
    expect(() => assertSlackPublicChannelContextConnectionV1({ connection, verified: proof() })).not.toThrow();
    expect(connection.required_provider_scopes).toEqual(SLACK_PRIVATE_APP_BOT_SCOPES_V1);
  });

  it("refuses stale approval-only evidence and unsupported scope sets", () => {
    for (const scopes of [SLACK_PRIVATE_APP_BOT_SCOPES_V1, [...SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, "groups:history"].sort(),
      [...SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1, "channels:read"].sort(), [...SLACK_PUBLIC_CHANNEL_CONTEXT_BOT_SCOPES_V1].reverse()]) {
      expect(() => assertSlackPublicChannelContextConnectionV1({ connection, verified: proof({ granted_scopes: scopes }) })).toThrow("Slack public-channel context is not available");
    }
  });

  it("refuses a different provider identity or a digest that does not prove the exact observed fields", () => {
    for (const changed of [{ team_id: "TOTHER123" }, { enterprise_id: "EOTHER123" }, { app_id: "AOTHER123" },
      { bot_id: "BOTHER123" }, { bot_user_id: "UOTHER123" }, { verification_evidence_sha256: canonicalSha256({ forged: true }) }]) {
      expect(() => assertSlackPublicChannelContextConnectionV1({ connection, verified: proof(changed) })).toThrow("Slack public-channel context is not available");
    }
  });
});
