import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalSha256,
} from "../src/canonical/canonical-json.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  buildPersonSlackApprovalBindingContractV2,
} from "../src/application/person-slack-approval-contracts-v2.js";
import { activatePersonSlackApprovalV2 } from "../src/application/person-slack-approval-activation-v2.js";
import { applyOrganizationControlBaselineV1 } from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-database.js";
import {
  SqlitePersonSlackApprovalActivationCoordinatorV2,
  type StableAuthorityAdministratorFenceV2,
} from "../src/persistence/sqlite-person-slack-approval-activation-v2.js";

const directories: string[] = [];
const ADMIN = Object.freeze({
  actor_kind: "authority-administrator-credential" as const,
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "sln_00000000-0000-4000-8000-000000000001",
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
  membership_type: "owner" as const,
});
const MEMBER = Object.freeze({
  principal_id: "prn_00000000-0000-4000-8000-000000000002",
  membership_id: "mem_00000000-0000-4000-8000-000000000002",
  membership_type: "employee" as const,
});
const POLICIES = Object.freeze([
  Object.freeze({
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_contract_sha256:
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_CONTRACT_SHA256,
    actions: Object.freeze(["approve", "reject"] as const),
  }),
  Object.freeze({
    policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    policy_contract_sha256: RESTRICTED_REVIEWER_PERSON_POLICY_CONTRACT_SHA256,
    actions: Object.freeze(["approve", "reject"] as const),
  }),
] as const);

function path(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "echo-sqlite-approval-activation-"),
  );
  directories.push(directory);
  return join(directory, "integrations.sqlite");
}

function command(command_id = "command_01") {
  return {
    command_id,
    target_external_identity_link_id:
      "clm_00000000-0000-4000-8000-000000000002",
    provider_connection_id: "con_00000000-0000-4000-8000-000000000001",
    approval_adapter_instance_id: "approvals_primary",
    approval_adapter_version: "1.0.0",
    approval_channel_id: "C_APPROVAL",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    policy_capabilities: POLICIES,
  };
}

function authorityFence(): StableAuthorityAdministratorFenceV2 {
  return {
    async withStableAdministratorFence(_credential, commit) {
      return commit({
        administrator: ADMIN,
        currentMembership: ({ principal_id, membership_id }) => {
          if (
            principal_id === ADMIN.principal_id &&
            membership_id === ADMIN.membership_id
          )
            return ADMIN;
          if (
            principal_id === MEMBER.principal_id &&
            membership_id === MEMBER.membership_id
          )
            return MEMBER;
          return undefined;
        },
      });
    },
  };
}

function seed(database: Database.Database) {
  const connection = buildOrganizationToolConnectionContractV2({
    authority_id: ADMIN.authority_id,
    organization_id: ADMIN.organization_id,
    state_lineage_id: ADMIN.state_lineage_id,
    connection_id: "con_00000000-0000-4000-8000-000000000001",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: null,
    tool_kind: "slack",
    provider_app_id: "A01",
    provider_bot_id: "B01",
    provider_bot_user_id: "U_BOT",
    required_provider_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    public_connection_configuration_sha256: canonicalSha256({ config: 1 }),
  });
  const connectionSha = canonicalSha256(connection);
  const state = buildOrganizationToolConnectionStateV2({
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    connection_status: "active",
    credential_reference_sha256: canonicalSha256({ credential: 1 }),
    observed_granted_scopes: SLACK_APPROVAL_REQUIRED_PROVIDER_SCOPES,
    verification_event_id: "verify_01",
    verification_evidence_sha256: canonicalSha256({ evidence: 1 }),
    verification_revision: 1,
    verified_at: "2026-08-22T00:00:00.000Z",
  });
  const link = buildExternalHumanIdentityLinkContractV2({
    authority_id: ADMIN.authority_id,
    organization_id: ADMIN.organization_id,
    state_lineage_id: ADMIN.state_lineage_id,
    external_identity_link_id: "clm_00000000-0000-4000-8000-000000000002",
    provider_issuer: "https://slack.com",
    provider_tenant_kind: "workspace",
    provider_tenant_id: "T01",
    provider_enterprise_id: null,
    provider_subject_id: "U_EMPLOYEE",
    ...MEMBER,
    verification_event_id: "link_verify_01",
    verification_evidence_sha256: canonicalSha256({ link: 1 }),
    verified_at: "2026-08-22T00:00:00.000Z",
  });
  const linkSha = canonicalSha256(link);
  const eligible = buildPersonSlackApprovalBindingContractV2({
    authority_id: ADMIN.authority_id,
    organization_id: ADMIN.organization_id,
    state_lineage_id: ADMIN.state_lineage_id,
    approval_binding_id: "bnd_00000000-0000-4000-8000-000000000001",
    connection_id: connection.connection_id,
    connection_contract_sha256: connectionSha,
    approval_adapter_kind: "approval-surface",
    approval_adapter_id: "slack-reactions",
    approval_adapter_instance_id: "approvals_primary",
    approval_adapter_version: "1.0.0",
    approval_channel_id: "C_APPROVAL",
    approve_reaction: "white_check_mark",
    reject_reaction: "x",
    supported_policy_actions: POLICIES,
  });
  const eligibleSha = canonicalSha256(eligible);
  database
    .prepare(
      `INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?, ?)`,
    )
    .run(
      connection.connection_id,
      canonicalJson(connection),
      connectionSha,
      "2026-08-22T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      connection.connection_id,
      connectionSha,
      canonicalJson(state),
      canonicalSha256(state),
      "active",
      "2026-08-22T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)`,
    )
    .run(
      link.external_identity_link_id,
      linkSha,
      canonicalJson(link),
      "2026-08-22T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      link.external_identity_link_id,
      linkSha,
      link.provider_issuer,
      link.provider_tenant_kind,
      link.provider_tenant_id,
      link.provider_enterprise_id,
      link.provider_subject_id,
      link.principal_id,
      link.membership_id,
      "active",
      "2026-08-22T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO organization_approval_binding_contracts VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      eligible.approval_binding_id,
      canonicalJson(eligible),
      eligibleSha,
      eligible.connection_id,
      "2026-08-22T00:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO organization_approval_binding_current VALUES (?, ?, 'active', ?)`,
    )
    .run(eligible.approval_binding_id, eligibleSha, "2026-08-22T00:00:00.000Z");
  return { link };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("private SQLite Person Slack approval activation v2", () => {
  it("reproves current rows and saves one binding, four capabilities, resource, and receipts atomically", async () => {
    const database = openOrganizationControlDatabase(path());
    applyOrganizationControlBaselineV1(database);
    seed(database);
    let sequence = 0;
    const coordinator = new SqlitePersonSlackApprovalActivationCoordinatorV2({
      database,
      authority_fence: authorityFence(),
      now: () => `2026-08-22T00:00:0${String(++sequence)}.000Z`,
    });
    const run = (value = command()) =>
      activatePersonSlackApprovalV2({
        credential: { stable: true },
        command: value,
        coordinator,
        codec: { sha256: canonicalSha256 },
        ids: {
          next: (kind) =>
            kind === "approval_binding"
              ? "bnd_00000000-0000-4000-8000-000000000010"
              : `cap_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        },
      });
    try {
      const first = await run();
      expect(first.action_capabilities).toHaveLength(4);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_resources`,
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_commands`,
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_action_capability_contracts`,
          )
          .pluck()
          .get(),
      ).toBe(4);
      await expect(run()).resolves.toEqual(first);
      const resourceReuse = await run(command("command_02"));
      expect(resourceReuse.command_id).toBe("command_02");
      await expect(run(command("command_02"))).resolves.toEqual(resourceReuse);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_resources`,
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_commands`,
          )
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_action_capability_contracts`,
          )
          .pluck()
          .get(),
      ).toBe(4);
    } finally {
      database.close();
    }
  });

  it("rolls back the whole initial write when a capability identifier collides", async () => {
    const database = openOrganizationControlDatabase(path());
    applyOrganizationControlBaselineV1(database);
    seed(database);
    const coordinator = new SqlitePersonSlackApprovalActivationCoordinatorV2({
      database,
      authority_fence: authorityFence(),
      now: () => "2026-08-22T00:00:00.000Z",
    });
    try {
      await expect(
        activatePersonSlackApprovalV2({
          credential: { stable: true },
          command: command(),
          coordinator,
          codec: { sha256: canonicalSha256 },
          ids: {
            next: (kind) =>
              kind === "approval_binding"
                ? "bnd_00000000-0000-4000-8000-000000000010"
                : "cap_00000000-0000-4000-8000-000000000010",
          },
        }),
      ).rejects.toThrow();
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_resources`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_activation_commands`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_action_capability_contracts`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM organization_approval_binding_contracts`,
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("uses the active current link instead of the latest historical timestamp", async () => {
    const database = openOrganizationControlDatabase(path());
    applyOrganizationControlBaselineV1(database);
    const { link } = seed(database);
    const historical = buildExternalHumanIdentityLinkContractV2({
      ...link,
      verification_event_id: "link_verify_historical",
      verification_evidence_sha256: canonicalSha256({ link: "historical" }),
      verified_at: "2026-08-20T00:00:00.000Z",
    });
    const historicalSha = canonicalSha256(historical);
    database
      .prepare(
        `INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)`,
      )
      .run(
        historical.external_identity_link_id,
        historicalSha,
        canonicalJson(historical),
        "2099-01-01T00:00:00.000Z",
      );
    let capability = 0;
    const coordinator = new SqlitePersonSlackApprovalActivationCoordinatorV2({
      database,
      authority_fence: authorityFence(),
      now: () => "2026-08-22T00:00:00.000Z",
    });
    try {
      await expect(
        activatePersonSlackApprovalV2({
          credential: { stable: true },
          command: command(),
          coordinator,
          codec: { sha256: canonicalSha256 },
          ids: {
            next: (kind) =>
              kind === "approval_binding"
                ? "bnd_00000000-0000-4000-8000-000000000010"
                : `cap_00000000-0000-4000-8000-${String(++capability).padStart(12, "0")}`,
          },
        }),
      ).resolves.toMatchObject({ command_id: "command_01" });
    } finally {
      database.close();
    }
  });
});
