import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalHumanIdentityLinkContractV2,
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
} from "../src/application/person-slack-reaction-approval-contracts-v2.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../src/canonical/canonical-json.js";
import { runCleanPersonSlackReactionApprovalActivateCli } from "../src/composition/clean-person-slack-reaction-approval-activate-cli.js";
import {
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
  applyOrganizationControlBaselineV2,
  organizationControlBaselineSha256V2,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-organization-control-database.js";

const directories: string[] = [];
const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const OWNER = Object.freeze({
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
});
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const APPROVAL_CHANNEL_ID = "C_APPROVAL";

function rootManifest() {
  return {
    schema_version: 1,
    kind: "echo-state-lineage-root-manifest-v1",
    ...COORDINATES,
    databases: [
      {
        role: "authority",
        location: { kind: "state_file", filename: "authority.sqlite" },
        application_id: 0x45434155,
      },
      {
        role: "control-plane",
        location: { kind: "state_file", filename: "integrations.sqlite" },
        application_id: 0x45434f50,
      },
      {
        role: "record-log",
        location: { kind: "state_file", filename: "record-log.sqlite" },
        application_id: 0x4543524c,
      },
      {
        role: "record-derived",
        location: { kind: "state_file", filename: "record-derived.sqlite" },
        application_id: 0x45435244,
      },
      {
        role: "retrieval-facts",
        location: {
          kind: "retrieval_segment_tree",
          directory: "record-retrieval",
          filename: "facts.sqlite",
        },
        application_id: 0x45524654,
      },
      {
        role: "retrieval-lexical",
        location: {
          kind: "retrieval_segment_tree",
          directory: "record-retrieval",
          filename: "lexical.sqlite",
        },
        application_id: 0x45524c58,
      },
      {
        role: "retrieval-content",
        location: {
          kind: "retrieval_segment_tree",
          directory: "record-retrieval",
          filename: "content.sqlite",
        },
        application_id: 0x45524354,
      },
    ],
    created_at: "2026-08-22T00:00:00.000Z",
    creating_artifact_revision: "test",
  };
}

function cleanConnectionConfigurationSha256() {
  return canonicalSha256({
    approval_adapter_id: "slack-reactions",
    approval_channel_id: APPROVAL_CHANNEL_ID,
    approve_reaction: "white_check_mark",
    kind: "echo-clean-slack-connection-public-configuration-v1",
    reject_reaction: "x",
  });
}

function stateDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-clean-approval-activate-")),
  );
  chmodSync(directory, 0o700);
  directories.push(directory);
  writeFileSync(
    join(directory, "state-lineage-root.v1.json"),
    canonicalJson(rootManifest()),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return directory;
}

function setupState(includeLink = true): string {
  const directory = stateDirectory();
  const authority = new Database(join(directory, "authority.sqlite"));
  try {
    authority.exec(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../organization-authority/baselines/authority-baseline-v1.sql",
        ),
        "utf8",
      ),
    );
    authority.pragma("application_id = 0x45434155");
    authority.pragma("user_version = 1");
    const authorityManifest = {
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role: "authority",
      ...COORDINATES,
      database_schema_version: 1,
      schema_sha256:
        "sha256:007a1498dd1db87d03ba2876086c5ec6b6c655f77e5c25691abafd18451465d6",
      created_at: "2026-08-22T00:00:00.000Z",
      creating_artifact_revision: "test",
    };
    authority.exec(
      `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`,
    );
    authority
      .prepare(
        `INSERT INTO echo_state_lineage_manifest
         (singleton, manifest_json, manifest_sha256) VALUES (1, ?, ?)`,
      )
      .run(
        canonicalJson(authorityManifest),
        canonicalSha256(authorityManifest),
      );
    authority
      .prepare(
        `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
         VALUES (1, ?, ?, 'Founder org', '{}', ?, ?)`,
      )
      .run(
        COORDINATES.authority_id,
        COORDINATES.organization_id,
        "2026-08-22T00:00:00.000Z",
        "2026-08-22T00:00:00.000Z",
      );
    authority
      .prepare(
        `INSERT INTO authority_principals
         (principal_id, organization_id, display_name, provisioned_at)
         VALUES (?, ?, 'Founder', ?)`,
      )
      .run(
        OWNER.principal_id,
        COORDINATES.organization_id,
        "2026-08-22T00:00:00.000Z",
      );
    authority
      .prepare(
        `INSERT INTO authority_memberships
         (membership_id, organization_id, principal_id, membership_type,
          status, provisioned_at, revoked_at, revocation_reason)
         VALUES (?, ?, ?, 'owner', 'active', ?, NULL, NULL)`,
      )
      .run(
        OWNER.membership_id,
        COORDINATES.organization_id,
        OWNER.principal_id,
        "2026-08-22T00:00:00.000Z",
      );
  } finally {
    authority.close();
  }
  chmodSync(join(directory, "authority.sqlite"), 0o600);

  const database = openOrganizationControlDatabase(
    join(directory, "integrations.sqlite"),
  );
  try {
    applyOrganizationControlBaselineV2(database);
    database
      .prepare(
        `INSERT INTO organization_control_plane_metadata
         (singleton, control_plane_id, organization_id, authority_id,
          authority_descriptor_sha256, created_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ocp_00000000-0000-4000-8000-000000000001",
        COORDINATES.organization_id,
        COORDINATES.authority_id,
        canonicalSha256({ descriptor: "test" }),
        "2026-08-22T00:00:00.000Z",
      );
    const manifest = {
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role: "control-plane",
      ...COORDINATES,
      database_schema_version: ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V2,
      schema_sha256: organizationControlBaselineSha256V2(),
      created_at: "2026-08-22T00:00:00.000Z",
      creating_artifact_revision: "test",
    };
    database.exec(
      `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`,
    );
    database
      .prepare(
        `INSERT INTO echo_state_lineage_manifest
         (singleton, manifest_json, manifest_sha256) VALUES (1, ?, ?)`,
      )
      .run(canonicalJson(manifest), canonicalSha256(manifest));
    const connection = buildOrganizationToolConnectionContractV2({
      ...COORDINATES,
      connection_id: CONNECTION_ID,
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: "T01",
      provider_enterprise_id: null,
      tool_kind: "slack",
      provider_app_id: "A01",
      provider_bot_id: "B01",
      provider_bot_user_id: "U_BOT",
      required_provider_scopes: SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
      public_connection_configuration_sha256:
        cleanConnectionConfigurationSha256(),
    });
    const connectionSha = canonicalSha256(connection);
    const connectionState = buildOrganizationToolConnectionStateV2({
      connection_id: CONNECTION_ID,
      connection_contract_sha256: connectionSha,
      connection_status: "active",
      credential_reference_sha256: canonicalSha256({ secret: "opaque" }),
      observed_granted_scopes: SLACK_REACTION_APPROVAL_REQUIRED_PROVIDER_SCOPES,
      verification_event_id: "verify_clean_connection",
      verification_evidence_sha256: canonicalSha256({ verified: true }),
      verification_revision: 1,
      verified_at: "2026-08-22T00:00:00.000Z",
    });
    database
      .prepare(
        `INSERT INTO organization_tool_connection_contracts VALUES (?, ?, ?, ?)`,
      )
      .run(
        CONNECTION_ID,
        canonicalJson(connection),
        connectionSha,
        "2026-08-22T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO organization_tool_connection_current_state VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        CONNECTION_ID,
        connectionSha,
        canonicalJson(connectionState),
        canonicalSha256(connectionState),
        "2026-08-22T00:00:00.000Z",
      );
    if (includeLink) {
      const link = buildExternalHumanIdentityLinkContractV2({
        ...COORDINATES,
        external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001",
        provider_issuer: "https://slack.com",
        provider_tenant_kind: "workspace",
        provider_tenant_id: "T01",
        provider_enterprise_id: null,
        provider_subject_id: "U_FOUNDER",
        ...OWNER,
        membership_type: "owner",
        verification_event_id: "verify_clean_founder_link",
        verification_evidence_sha256: canonicalSha256({ linked: true }),
        verified_at: "2026-08-22T00:00:00.000Z",
      });
      const linkSha = canonicalSha256(link);
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
          `INSERT INTO organization_external_human_link_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
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
          "2026-08-22T00:00:00.000Z",
        );
    }
  } finally {
    database.close();
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("clean stopped-state Person Slack reaction approval activation command", () => {
  it("activates the current founder link on the verified clean connection and is replay-safe", async () => {
    const directory = setupState();
    const output: string[] = [];
    let identifiers = 0;
    const dependencies = {
      now: () => "2026-08-22T00:00:00.000Z",
      next_id: (kind: "approval_binding" | "action_capability") => {
        identifiers += 1;
        return `${kind === "approval_binding" ? "bnd" : "cap"}_${identifiers}`;
      },
      verify_state: (
        await import("../src/persistence/verified-clean-control-plane-state-v1.js")
      ).verifyCleanControlPlaneStateV1,
    };
    const arguments_ = [
      "--state-dir",
      directory,
      "--connection-id",
      CONNECTION_ID,
      "--approval-channel-id",
      APPROVAL_CHANNEL_ID,
    ];
    await expect(
      runCleanPersonSlackReactionApprovalActivateCli(
        arguments_,
        { stdout: (line) => output.push(line) },
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(identifiers).toBe(5);
    expect(JSON.parse(output[0]!)).toMatchObject({
      approval_binding_id: "bnd_1",
      action_capability_ids: ["cap_2", "cap_3", "cap_4", "cap_5"],
      external_identity_link_id: "clm_00000000-0000-4000-8000-000000000001",
      provider_connection_id: CONNECTION_ID,
    });
    await expect(
      runCleanPersonSlackReactionApprovalActivateCli(
        arguments_,
        { stdout: (line) => output.push(line) },
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(identifiers).toBe(5);
    expect(output[1]).toBe(output[0]);
  });

  it("requires the current founder Slack identity link", async () => {
    const directory = setupState(false);
    await expect(
      runCleanPersonSlackReactionApprovalActivateCli([
        "--state-dir",
        directory,
        "--connection-id",
        CONNECTION_ID,
        "--approval-channel-id",
        APPROVAL_CHANNEL_ID,
      ]),
    ).rejects.toThrow("one current owner Slack identity link");
  });
});
