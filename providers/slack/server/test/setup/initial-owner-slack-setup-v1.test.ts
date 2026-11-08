import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import { serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { activateNangoSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";
import { plannedSlackConnectionIsActiveV1, readInitialOwnerSlackSetupStatusV1 } from "../../src/setup/initial-owner-slack-setup-v1.js";
import { COORDINATES, openSlackControlDatabase, seedSlackIdentityLink, slackStateDirectory } from "../control-database-fixture.js";

const OWNER = Object.freeze({ principal_id: "prn_owner", membership_id: "mem_owner" });
const NOW = "2026-09-30T00:00:00.000Z";

describe("initial-owner Slack setup status", () => {
  it("reports Slack connected, and the owner linked, only through the active Nango connection's workspace", async () => {
    const state_directory = slackStateDirectory();
    const database = openSlackControlDatabase(state_directory);
    const status = () => readInitialOwnerSlackSetupStatusV1({ state_directory, ...OWNER });
    const link = (id: string, tenant: string, membership: string) => seedSlackIdentityLink(database, { external_identity_link_id: id,
      provider_tenant_id: tenant, provider_subject_id: `U_${id}`, principal_id: OWNER.principal_id, membership_id: membership });
    expect(plannedSlackConnectionIsActiveV1(state_directory)).toBe(false);
    expect(status()).toEqual({ identity_link_active: false });

    const secrets = new FileOrganizationSecretStore(join(state_directory, "secrets"));
    const credentials: SlackAppCredentialsV1 = { kind: "echo-slack-app-credentials-v1", app_id: "A0APP1", client_id: "1234.5678",
      client_secret: "client-secret-value", signing_secret: "signing-secret-value", nango_connection_id: null };
    await activateNangoSlackConnectionV1({ database, secrets, ...COORDINATES,
      verifier: { verifyConnection: vi.fn(async () => ({ team_id: "T01", enterprise_id: null, bot_user_id: "U_BOT", bot_id: "B01",
        app_id: "A0APP1", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, verification_evidence_sha256: canonicalSha256("verified") })) },
      credential: { reference: secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials },
      nango: { connection_id: "nango-conn-1", tags: {}, team_id: "T01", app_id: "A0APP1",
        bot_user_id: "U_BOT", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: "xoxb-token" },
      now: () => NOW, new_connection_id: () => "con_nango_1" });
    expect(plannedSlackConnectionIsActiveV1(state_directory)).toBe(true);

    link("clm_other_workspace", "T02", OWNER.membership_id);
    link("clm_other_member", "T01", "mem_other");
    expect(status()).toEqual({ identity_link_active: false });
    link("clm_owner", "T01", OWNER.membership_id);
    expect(status()).toEqual({ identity_link_active: true });
  });
});
