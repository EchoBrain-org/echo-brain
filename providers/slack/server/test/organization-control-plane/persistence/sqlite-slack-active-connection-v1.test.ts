import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { readActiveSlackConnectionV1, type SlackConnectionCoordinatesV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { CONNECTION_ID, COORDINATES, openSlackControlDatabase, seedSlackConnection } from "../../control-database-fixture.js";

/** One stored Nango-kind connection, or none with `seed: false`. */
function database(input: { readonly seed?: boolean; readonly coordinates?: SlackConnectionCoordinatesV1; readonly row_status?: "active" | "revoked" } = {}) {
  const opened = openSlackControlDatabase();
  if (input.seed !== false) seedSlackConnection(opened, { contract: { ...input.coordinates, provider_enterprise_id: "E01" }, current_status: input.row_status });
  return opened;
}

describe("readActiveSlackConnectionV1", () => {
  it("reads the organization's one active connection with its frozen provider commitments", () => {
    const actual = readActiveSlackConnectionV1(database(), COORDINATES)!;

    expect(actual.connection).toMatchObject({
      connection_id: CONNECTION_ID,
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U_BOT",
      provider_tenant_id: "T01",
      provider_enterprise_id: "E01",
    });
    expect(actual.contract_sha256).toBe(canonicalSha256(actual.connection));
    expect(actual.state_sha256).toBe(canonicalSha256(actual.state));
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it.each([
    ["no stored connection", { seed: false }],
    ["a revoked connection", { row_status: "revoked" as const }],
  ])("reads nothing with %s", (_name, input) => {
    expect(readActiveSlackConnectionV1(database(input), COORDINATES)).toBeUndefined();
  });

  it.each([
    ["foreign lineage", { ...COORDINATES, state_lineage_id: "lineage-00000000-0000-4000-8000-000000000099" }],
    ["foreign authority", { ...COORDINATES, authority_id: "oau_00000000-0000-4000-8000-000000000099" }],
  ])("fails closed for a %s", (_name, coordinates) => {
    expect(() => readActiveSlackConnectionV1(database({ coordinates }), COORDINATES)).toThrow("is drifted");
  });

  it("fails closed when the digest proof is altered", () => {
    const opened = database();
    opened.prepare("UPDATE organization_tool_connection_current_state SET state_sha256 = ?").run(canonicalSha256({ altered: true }));

    expect(() => readActiveSlackConnectionV1(opened, COORDINATES)).toThrow("digest chain is invalid");
  });
});
