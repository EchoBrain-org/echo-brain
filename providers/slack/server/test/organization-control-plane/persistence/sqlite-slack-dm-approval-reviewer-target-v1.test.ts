import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalHumanIdentityLinkContractV2, buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2, type ExternalHumanIdentityLinkContractV2, type PersonMembershipType } from "../../../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../../src/organization-control-plane/application/slack-integration-contracts.js";
import { canonicalJson, canonicalSha256 } from "../../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { resolveCurrentSlackDmApprovalReviewerTargetV1, type SlackDmApprovalReviewerTargetCoordinatesV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-dm-approval-reviewer-target-v1.js";
import { slackNangoAppPublicConfigurationSha256V1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { applyOrganizationControlBaselineV4 } from "../../../../../../packages/organization-control-plane/src/persistence/baseline.js";

const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const OWNER = Object.freeze({
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
  membership_type: "owner" as const,
});
const NOW = "2026-08-28T00:00:00.000Z";
const databases: Database.Database[] = [];

function scopes(without?: string): readonly string[] {
  return Object.freeze(SLACK_PRIVATE_APP_BOT_SCOPES_V1.filter((scope) => scope !== without));
}

function openDatabase(): Database.Database {
  const database = new Database(":memory:");
  applyOrganizationControlBaselineV4(database);
  databases.push(database);
  return database;
}

function insertLink(
  database: Database.Database,
  input: Partial<{
    readonly external_identity_link_id: string;
    readonly provider_subject_id: string;
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: PersonMembershipType;
    readonly provider_tenant_id: string;
    readonly provider_enterprise_id: string | null;
    readonly current_status: "active" | "revoked";
    readonly stored_json: string;
    readonly stored_sha256: string;
    /** Stores the body under another relational row id. */
    readonly row_link_id: string;
  }> = {},
): ExternalHumanIdentityLinkContractV2 {
  const link = buildExternalHumanIdentityLinkContractV2({
    ...COORDINATES,
    external_identity_link_id:
      input.external_identity_link_id ??
      "clm_00000000-0000-4000-8000-000000000001",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: input.provider_tenant_id ?? "T01",
    provider_enterprise_id: input.provider_enterprise_id ?? null,
    provider_subject_id: input.provider_subject_id ?? "U012ABC",
    principal_id: input.principal_id ?? OWNER.principal_id,
    membership_id: input.membership_id ?? OWNER.membership_id,
    membership_type: input.membership_type ?? OWNER.membership_type,
    verification_event_id: "verify_link_01",
    verification_evidence_sha256: canonicalSha256({ link: "ok" }),
    verified_at: NOW,
  });
  const contractJson = input.stored_json ?? canonicalJson(link);
  const contractSha = input.stored_sha256 ?? canonicalSha256(link);
  const rowLinkId = input.row_link_id ?? link.external_identity_link_id;
  database
    .prepare(
      `INSERT INTO organization_external_human_link_contracts
       (external_identity_link_id, contract_sha256, contract_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(rowLinkId, contractSha, contractJson, NOW);
  database
    .prepare(
      `INSERT INTO organization_external_human_link_current
       (external_identity_link_id, contract_sha256, provider_issuer,
        provider_tenant_kind, provider_tenant_id, provider_enterprise_id,
        provider_subject_id, principal_id, membership_id, current_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rowLinkId,
      contractSha,
      link.provider_issuer,
      link.provider_tenant_kind,
      link.provider_tenant_id,
      link.provider_enterprise_id,
      link.provider_subject_id,
      link.principal_id,
      link.membership_id,
      input.current_status ?? "active",
      NOW,
    );
  return link;
}

function seed(
  input: Partial<{
    readonly observed_scope_without: string;
    readonly connection_enterprise_id: string | null;
    readonly connection_state_status: "active" | "revoked";
    readonly connection_coordinates: SlackDmApprovalReviewerTargetCoordinatesV1;
    readonly link: Parameters<typeof insertLink>[1];
    readonly include_link: boolean;
    /** Builds the contract and state for another connection but stores them under CONNECTION_ID. */
    readonly contract_connection_id: string;
  }> = {},
): Database.Database {
  const database = openDatabase();
  const connection = buildOrganizationToolConnectionContractV2({
    ...(input.connection_coordinates ?? COORDINATES),
    connection_id: input.contract_connection_id ?? CONNECTION_ID,
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: input.connection_enterprise_id ?? null,
    tool_kind: "slack",
    provider_app_id: "A01",
    provider_bot_id: "B01",
    provider_bot_user_id: "U_BOT",
    required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    public_connection_configuration_sha256:
      slackNangoAppPublicConfigurationSha256V1(),
  });
  const connectionSha = canonicalSha256(connection);
  const connectionState = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    connection_status: input.connection_state_status ?? "active",
    credential_reference_sha256: canonicalSha256({ credential: "opaque" }),
    observed_granted_scopes: scopes(input.observed_scope_without),
    verification_event_id: "verify_connection_01",
    verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
    verification_revision: 1,
    verified_at: NOW,
  });
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts
       (connection_id, contract_json, contract_sha256, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(CONNECTION_ID, canonicalJson(connection), connectionSha, NOW);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state
       (connection_id, connection_contract_sha256, state_json, state_sha256,
        current_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CONNECTION_ID,
      connectionSha,
      canonicalJson(connectionState),
      canonicalSha256(connectionState),
      input.connection_state_status ?? "active",
      NOW,
    );
  if (input.include_link !== false) insertLink(database, input.link);
  return database;
}

function resolve(database: Database.Database) {
  return resolveCurrentSlackDmApprovalReviewerTargetV1(
    database,
    COORDINATES,
    CONNECTION_ID,
    OWNER,
  );
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("resolveCurrentSlackDmApprovalReviewerTargetV1", () => {
  it.each(["U012ABC", "W012ABC"])(
    "resolves an exact current %s Slack identity and freezes its proof chain",
    (provider_subject_id) => {
      const database = seed({ link: { provider_subject_id } });

      const result = resolve(database);

      expect(result).toMatchObject({
        connection: { body: { connection_id: CONNECTION_ID } },
        connection_state: { body: { connection_status: "active" } },
        current_slack_identity_link: {
          provider: "slack",
          provider_subject_id,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result!.connection)).toBe(true);
      expect(Object.isFrozen(result!.connection_state)).toBe(true);
      expect(Object.isFrozen(result!.current_slack_identity_link)).toBe(true);
    },
  );

  it.each(SLACK_PRIVATE_APP_BOT_SCOPES_V1)(
    "does not select a DM target without %s",
    (missingScope) => {
      expect(resolve(seed({ observed_scope_without: missingScope }))).toBeUndefined();
    },
  );

  it.each<readonly [string, Parameters<typeof seed>[0]]>([
    ["the link is absent", { include_link: false }],
    ["the link is revoked", { link: { current_status: "revoked" } }],
    ["the link belongs to another workspace", { link: { provider_tenant_id: "T02" } }],
    [
      "the link belongs to another enterprise",
      { connection_enterprise_id: "E01", link: { provider_enterprise_id: "E02" } },
    ],
    [
      "the link belongs to another membership",
      { link: { membership_id: "mem_00000000-0000-4000-8000-000000000099" } },
    ],
    ["the linked membership is not an owner", { link: { membership_type: "employee" } }],
    ["the linked subject is not a Slack human", { link: { provider_subject_id: "X012ABC" } }],
    ["the connection is inactive", { connection_state_status: "revoked" }],
    [
      "the connection belongs to another lineage",
      { connection_coordinates: { ...COORDINATES, state_lineage_id: "lineage-foreign" } },
    ],
  ])("returns no target when %s", (_label, input) => {
    expect(resolve(seed(input))).toBeUndefined();
  });

  it("returns no target for an ambiguous current member link set", () => {
    const database = seed();
    database.exec(
      "DROP INDEX organization_external_human_link_one_active_membership",
    );
    insertLink(database, {
      external_identity_link_id: "clm_00000000-0000-4000-8000-000000000002",
      provider_subject_id: "U012DEF",
    });

    expect(resolve(database)).toBeUndefined();
  });

  it("throws when the stored canonical link digest or body is corrupt", () => {
    const digestCorrupt = seed({
      link: {
        stored_sha256: canonicalSha256({ unrelated: true }),
      },
    });
    expect(() => resolve(digestCorrupt)).toThrow("identity link digest is invalid");

    const bodyCorrupt = seed({
      link: {
        stored_json: "{}",
        stored_sha256: canonicalSha256({}),
      },
    });
    expect(() => resolve(bodyCorrupt)).toThrow("external human link contract v2");
  });

  it("throws when valid canonical bodies do not match their selected relational rows", () => {
    expect(() =>
      resolve(seed({ include_link: false, contract_connection_id: "con_00000000-0000-4000-8000-000000000002" })),
    ).toThrow("connection state is inconsistent");
    expect(() =>
      resolve(
        seed({
          link: {
            external_identity_link_id: "clm_00000000-0000-4000-8000-000000000002",
            row_link_id: "clm_00000000-0000-4000-8000-000000000001",
          },
        }),
      ),
    ).toThrow("identity link is inconsistent");
  });
});
