import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2 } from "../../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { slackNangoAppPublicConfigurationSha256V1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { applyOrganizationControlBaselineV3 } from "../../../../../packages/organization-control-plane/src/persistence/baseline.js";
import { resolveActivePrivateSlackConnectionV1, type PrivateSlackConnectionCoordinatesV1 } from "../../src/private-approval/resolve-current-private-slack-connection-v1.js";

const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-28T00:00:00.000Z";
const databases: Database.Database[] = [];

/** One stored Nango-kind connection, or none with `seed: false`. */
function database(input: { readonly seed?: boolean; readonly coordinates?: PrivateSlackConnectionCoordinatesV1; readonly row_status?: "active" | "revoked" } = {}) {
  const opened = new Database(":memory:");
  applyOrganizationControlBaselineV3(opened);
  databases.push(opened);
  if (input.seed === false) return opened;
  const connection = buildOrganizationToolConnectionContractV2({
    ...(input.coordinates ?? COORDINATES), connection_id: CONNECTION_ID, provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace", provider_tenant_id: "T01", provider_enterprise_id: "E01", tool_kind: "slack",
    provider_app_id: "A01", provider_bot_id: "B01", provider_bot_user_id: "U01BOT",
    required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, public_connection_configuration_sha256: slackNangoAppPublicConfigurationSha256V1(),
  });
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: CONNECTION_ID, connection_contract_sha256: canonicalSha256(connection), connection_status: "active",
    credential_reference_sha256: canonicalSha256({ credential: "bundle" }), observed_granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    verification_event_id: "nango_connection_01", verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
    verification_revision: 1, verified_at: NOW,
  });
  opened.prepare(`INSERT INTO organization_tool_connection_contracts (connection_id, contract_json, contract_sha256, created_at)
    VALUES (?, ?, ?, ?)`).run(CONNECTION_ID, canonicalJson(connection), canonicalSha256(connection), NOW);
  opened.prepare(`INSERT INTO organization_tool_connection_current_state (connection_id, connection_contract_sha256, state_json,
    state_sha256, current_status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(CONNECTION_ID, canonicalSha256(connection), canonicalJson(state), canonicalSha256(state), input.row_status ?? "active", NOW);
  return opened;
}

afterEach(() => {
  for (const opened of databases.splice(0)) opened.close();
});

describe("resolveActivePrivateSlackConnectionV1", () => {
  it("resolves the organization's one active connection with its frozen provider commitments", () => {
    const actual = resolveActivePrivateSlackConnectionV1(database(), COORDINATES);

    expect(actual.current).toEqual({
      connection_id: CONNECTION_ID,
      connection_contract_sha256: actual.stored.contract_sha256,
      connection_state_sha256: actual.stored.state_sha256,
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U01BOT",
      provider_tenant_id: "T01",
      provider_enterprise_id: "E01",
    });
    expect(Object.isFrozen(actual.current)).toBe(true);
  });

  it.each([
    ["no stored connection", { seed: false }],
    ["a revoked connection", { row_status: "revoked" as const }],
  ])("fails closed with %s", (_name, input) => {
    expect(() => resolveActivePrivateSlackConnectionV1(database(input), COORDINATES)).toThrow("has no active Slack connection");
  });

  it.each([
    ["foreign lineage", { ...COORDINATES, state_lineage_id: "lineage-00000000-0000-4000-8000-000000000099" }],
    ["foreign authority", { ...COORDINATES, authority_id: "oau_00000000-0000-4000-8000-000000000099" }],
  ])("fails closed for a %s", (_name, coordinates) => {
    expect(() => resolveActivePrivateSlackConnectionV1(database({ coordinates }), COORDINATES)).toThrow("is drifted");
  });

  it("fails closed when the digest proof is altered", () => {
    const opened = database();
    opened.prepare("UPDATE organization_tool_connection_current_state SET state_sha256 = ?").run(canonicalSha256({ altered: true }));

    expect(() => resolveActivePrivateSlackConnectionV1(opened, COORDINATES)).toThrow("digest chain is invalid");
  });
});
