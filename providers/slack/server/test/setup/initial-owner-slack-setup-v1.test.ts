import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { applyOrganizationControlBaselineV3, openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import { serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { activateNangoSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";
import { plannedSlackConnectionIsActiveV1, readInitialOwnerSlackSetupStatusV1 } from "../../src/setup/initial-owner-slack-setup-v1.js";

const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const OWNER = Object.freeze({ principal_id: "prn_owner", membership_id: "mem_owner" });
const NOW = "2026-09-30T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("initial-owner Slack setup status", () => {
  it("reports Slack connected, and the owner linked, only through the active Nango connection's workspace", async () => {
    const state_directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-initial-owner-slack-")));
    directories.push(state_directory);
    const database = openOrganizationControlDatabase(join(state_directory, "integrations.sqlite"));
    try {
      applyOrganizationControlBaselineV3(database);
      database.prepare(`INSERT INTO organization_control_plane_metadata (singleton, control_plane_id, organization_id, authority_id,
        authority_descriptor_sha256, created_at) VALUES (1, 'ocp_1', ?, ?, ?, ?)`)
        .run(COORDINATES.organization_id, COORDINATES.authority_id, canonicalSha256({ descriptor: "test" }), NOW);
      const status = () => readInitialOwnerSlackSetupStatusV1({ state_directory, ...OWNER });
      const link = (id: string, tenant: string, membership: string) => {
        database.prepare("INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)").run(id, canonicalSha256(id), `{"link":"${id}"}`, NOW);
        database.prepare("INSERT INTO organization_external_human_link_current VALUES (?, ?, 'https://slack.com', 'workspace', ?, NULL, ?, 'prn_owner', ?, 'active', ?)")
          .run(id, canonicalSha256(id), tenant, `U_${id}`, membership, NOW);
      };
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
    } finally {
      database.close();
    }
  });
});
