import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  type ApprovalContractSha256,
} from "../../../organization-control-plane/src/application/person-slack-approval-contracts-v2.js";
import { applyOrganizationControlBaselineV1 } from "../../../organization-control-plane/src/persistence/baseline.js";
import {
  resolveCurrentPrivateSlackConnectionV1,
  type PrivateSlackConnectionCoordinatesV1,
} from "../../src/composition/resolve-current-private-slack-connection-v1.js";

const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-28T00:00:00.000Z";
const databases: Database.Database[] = [];

function publicConfigurationSha256(): `sha256:${string}` {
  return canonicalSha256({
    approval_adapter_id: "slack-reactions",
    approval_channel_id: "C_RETIRED_SHARED_APPROVAL",
    approve_reaction: "white_check_mark",
    kind: "echo-clean-slack-connection-public-configuration-v1",
    reject_reaction: "x",
  });
}

function seed(
  input: Partial<{
    readonly connection_id: string;
    readonly contract_coordinates: PrivateSlackConnectionCoordinatesV1;
    readonly row_status: "active" | "revoked";
    readonly state_status: "active" | "revoked";
    readonly state_contract_sha256: ApprovalContractSha256;
    readonly contract_json: string;
    readonly contract_sha256: string;
    readonly state_json: string;
    readonly state_sha256: string;
  }> = {},
): Database.Database {
  const database = new Database(":memory:");
  applyOrganizationControlBaselineV1(database);
  databases.push(database);
  const connection = buildOrganizationToolConnectionContractV2({
    ...(input.contract_coordinates ?? COORDINATES),
    connection_id: input.connection_id ?? CONNECTION_ID,
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: "E01",
    tool_kind: "slack",
    provider_app_id: "A01",
    provider_bot_id: "B01",
    provider_bot_user_id: "U01BOT",
    required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: publicConfigurationSha256(),
  });
  const contractSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id,
    connection_contract_sha256:
      input.state_contract_sha256 ?? contractSha,
    connection_status: input.state_status ?? "active",
    credential_reference_sha256: canonicalSha256({ credential: "opaque" }),
    observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "verify_connection_01",
    verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
    verification_revision: 1,
    verified_at: NOW,
  });
  const storedContractJson = input.contract_json ?? canonicalJson(connection);
  const storedContractSha = input.contract_sha256 ?? contractSha;
  const storedStateJson = input.state_json ?? canonicalJson(state);
  const storedStateSha = input.state_sha256 ?? canonicalSha256(state);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts
       (connection_id, contract_json, contract_sha256, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(connection.connection_id, storedContractJson, storedContractSha, NOW);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state
       (connection_id, connection_contract_sha256, state_json, state_sha256,
        current_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      connection.connection_id,
      storedContractSha,
      storedStateJson,
      storedStateSha,
      input.row_status ?? "active",
      NOW,
    );
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("resolveCurrentPrivateSlackConnectionV1", () => {
  it("reproves precisely the manifest-pinned active Slack installation without a shared approval binding", () => {
    const database = seed();

    const actual = resolveCurrentPrivateSlackConnectionV1(
      database,
      CONNECTION_ID,
      COORDINATES,
    );

    expect(actual).toEqual({
      connection_id: CONNECTION_ID,
      connection_contract_sha256: expect.stringMatching(/^sha256:/),
      connection_state_sha256: expect.stringMatching(/^sha256:/),
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U01BOT",
      provider_tenant_id: "T01",
      provider_enterprise_id: "E01",
    });
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it("does not select another active connection when the manifest-pinned connection is missing", () => {
    const database = seed({
      connection_id: "con_00000000-0000-4000-8000-000000000002",
    });

    expect(() =>
      resolveCurrentPrivateSlackConnectionV1(
        database,
        CONNECTION_ID,
        COORDINATES,
      ),
    ).toThrow("no current founder Slack connection");
  });

  it.each([
    ["revoked current row", { row_status: "revoked" as const }],
    ["revoked state body", { state_status: "revoked" as const }],
    [
      "foreign lineage",
      {
        contract_coordinates: {
          ...COORDINATES,
          state_lineage_id: "lineage-00000000-0000-4000-8000-000000000099",
        },
      },
    ],
    [
      "foreign authority",
      {
        contract_coordinates: {
          ...COORDINATES,
          authority_id: "oau_00000000-0000-4000-8000-000000000099",
        },
      },
    ],
  ])("fails closed for %s", (_name, input) => {
    const database = seed(input);

    expect(() =>
      resolveCurrentPrivateSlackConnectionV1(
        database,
        CONNECTION_ID,
        COORDINATES,
      ),
    ).toThrow("missing, inactive, or drifted");
  });

  it("fails closed when canonical or digest proof is altered", () => {
    const database = seed();
    database
      .prepare(
        `UPDATE organization_tool_connection_current_state
            SET state_sha256 = ?
          WHERE connection_id = ?`,
      )
      .run(canonicalSha256({ altered: true }), CONNECTION_ID);

    expect(() =>
      resolveCurrentPrivateSlackConnectionV1(
        database,
        CONNECTION_ID,
        COORDINATES,
      ),
    ).toThrow("missing, inactive, or drifted");
  });
});
