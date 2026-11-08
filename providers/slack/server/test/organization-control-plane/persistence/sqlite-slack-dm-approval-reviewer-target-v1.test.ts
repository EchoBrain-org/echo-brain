import { describe, expect, it } from "vitest";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../../src/organization-control-plane/application/slack-integration-contracts.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { isCurrentSlackDmApprovalTargetV1, matchSlackApprovalClickActorV1, resolveSlackDmApprovalTargetV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-dm-approval-reviewer-target-v1.js";
import { CONNECTION_ID, COORDINATES, OWNER, openSlackControlDatabase, seedSlackConnection, seedSlackIdentityLink } from "../../control-database-fixture.js";

function scopes(without?: string): readonly string[] {
  return Object.freeze(SLACK_PRIVATE_APP_BOT_SCOPES_V1.filter((scope) => scope !== without));
}

/** The active connection and, unless `link` is null, the owner's link on it. */
function seed(input: Parameters<typeof seedSlackConnection>[1] & { readonly link?: Parameters<typeof seedSlackIdentityLink>[1] | null } = {}) {
  const database = openSlackControlDatabase();
  seedSlackConnection(database, input);
  if (input.link !== null) seedSlackIdentityLink(database, input.link);
  return database;
}

/** The owner's card target on the active connection, as the Authority picks one. */
function resolve(database: ReturnType<typeof seed>) {
  return resolveSlackDmApprovalTargetV1(database, COORDINATES, OWNER);
}

describe("a reviewer's Slack DM target", () => {
  it.each(["U012ABC", "W012ABC"])(
    "resolves an exact current %s Slack identity on the active connection",
    (provider_subject_id) => {
      expect(resolve(seed({ link: { provider_subject_id } }))).toMatchObject({ connection_id: CONNECTION_ID, slack_subject_id: provider_subject_id });
    },
  );

  it.each(SLACK_PRIVATE_APP_BOT_SCOPES_V1)(
    "does not select a DM target without %s",
    (missingScope) => {
      expect(resolve(seed({ state: { observed_granted_scopes: scopes(missingScope) } }))).toBeNull();
    },
  );

  it.each<readonly [string, Parameters<typeof seed>[0]]>([
    ["the link is absent", { link: null }],
    ["the link is revoked", { link: { current_status: "revoked" } }],
    ["the link belongs to another workspace", { link: { provider_tenant_id: "T02" } }],
    [
      "the link belongs to another enterprise",
      { contract: { provider_enterprise_id: "E01" }, link: { provider_enterprise_id: "E02" } },
    ],
    [
      "the link belongs to another membership",
      { link: { membership_id: "mem_00000000-0000-4000-8000-000000000099" } },
    ],
    ["the linked membership is not an owner", { link: { membership_type: "employee" } }],
    ["the linked subject is not a Slack human", { link: { provider_subject_id: "X012ABC" } }],
    ["the connection is inactive", { state: { connection_status: "revoked" } }],
    // A body stored under another connection's row is no target.
    ["the connection row holds another connection's body", { contract: { connection_id: "con_00000000-0000-4000-8000-000000000002" } }],
  ])("returns no target when %s", (_label, input) => {
    expect(resolve(seed(input))).toBeNull();
  });

  it("returns no target for an ambiguous current member link set", () => {
    const database = seed();
    database.exec(
      "DROP INDEX organization_external_human_link_one_active_membership",
    );
    seedSlackIdentityLink(database, {
      external_identity_link_id: "clm_00000000-0000-4000-8000-000000000002",
      provider_subject_id: "U012DEF",
    });

    expect(resolve(database)).toBeNull();
  });

  it("throws when the stored canonical link digest or body is corrupt", () => {
    const digestCorrupt = seed({
      link: {
        contract_sha256: canonicalSha256({ unrelated: true }),
      },
    });
    expect(() => resolve(digestCorrupt)).toThrow("identity link digest is invalid");

    const bodyCorrupt = seed({
      link: {
        contract_json: "{}",
        contract_sha256: canonicalSha256({}),
      },
    });
    expect(() => resolve(bodyCorrupt)).toThrow("external human link contract v2");
  });

  it("throws when the connection belongs to another lineage, or a valid canonical body does not match its selected row", () => {
    expect(() => resolve(seed({ contract: { state_lineage_id: "lineage-foreign" } }))).toThrow("drifted");
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

describe("Slack approval card targets", () => {
  it("picks a reviewer's card target, rechecks it, and matches a click to that one member", () => {
    const database = seed();
    const target = resolveSlackDmApprovalTargetV1(database, COORDINATES, OWNER)!;
    expect(target).toMatchObject({ connection_id: CONNECTION_ID, slack_workspace_id: "T01", slack_subject_id: "U012ABC", api_app_id: "A01" });
    expect(isCurrentSlackDmApprovalTargetV1(database, COORDINATES, target)).toBe(true);
    expect(isCurrentSlackDmApprovalTargetV1(database, COORDINATES, { ...target, slack_subject_id: "U012DEF" })).toBe(false);
    expect(isCurrentSlackDmApprovalTargetV1(database, COORDINATES, { ...target, api_app_id: "A02" })).toBe(false);

    const member = { organization_id: COORDINATES.organization_id, ...OWNER };
    expect(matchSlackApprovalClickActorV1(database, COORDINATES, { workspace_id: "T01", subject_id: "U012ABC" }, [member])).toEqual({
      organization_id: member.organization_id, principal_id: OWNER.principal_id, membership_id: OWNER.membership_id,
      connection_id: CONNECTION_ID, api_app_id: "A01", external_identity_link_id: target.external_identity_link_id,
      contract_sha256: target.external_identity_link_contract_sha256,
    });
    expect(matchSlackApprovalClickActorV1(database, COORDINATES, { workspace_id: "T02", subject_id: "U012ABC" }, [member])).toBeNull();
    expect(matchSlackApprovalClickActorV1(database, COORDINATES, { workspace_id: "T01", subject_id: "U012DEF" }, [member])).toBeNull();
  });
});
