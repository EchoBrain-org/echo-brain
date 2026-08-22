import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  type VerifiedSlackChannel,
  type VerifiedSlackConnection,
} from "../src/application/contracts.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../src/canonical/canonical-json.js";
import { runCleanSlackConnectCli } from "../src/composition/clean-slack-connect-cli.js";
import {
  ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
  applyOrganizationControlBaselineV1,
  organizationControlBaselineSha256V1,
} from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-unmigrated-database.js";
import type { CleanSlackConnectionVerifierV1 } from "../src/persistence/sqlite-clean-slack-connection-v1.js";
import { verifyCleanControlPlaneStateV1 } from "../src/persistence/verified-clean-control-plane-state-v1.js";

const directories: string[] = [];
const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});

function stateDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-clean-slack-cli-")),
  );
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

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

function setupCleanState(): string {
  const directory = stateDirectory();
  writeFileSync(
    join(directory, "state-lineage-root.v1.json"),
    canonicalJson(rootManifest()),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const database = openOrganizationControlDatabase(
    join(directory, "integrations.sqlite"),
  );
  try {
    applyOrganizationControlBaselineV1(database);
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
      database_schema_version: ORGANIZATION_CONTROL_BASELINE_SCHEMA_VERSION_V1,
      schema_sha256: organizationControlBaselineSha256V1(),
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
  } finally {
    database.close();
  }
  return directory;
}

function verifier(): CleanSlackConnectionVerifierV1 & {
  readonly verifyConnection: ReturnType<typeof vi.fn>;
  readonly verifyChannel: ReturnType<typeof vi.fn>;
} {
  const connection = {
    team_id: "T01",
    enterprise_id: null,
    bot_user_id: "U_BOT",
    bot_id: "B01",
    app_id: "A01",
    granted_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
    verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
  } satisfies VerifiedSlackConnection;
  const channel = {
    team_id: "T01",
    channel_id: "C_APPROVAL",
    verification_evidence_sha256: canonicalSha256({ channel: "ok" }),
  } satisfies VerifiedSlackChannel;
  return {
    verifyConnection: vi.fn(async () => connection),
    verifyChannel: vi.fn(async () => channel),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("clean Slack connect founder command", () => {
  it("derives clean coordinates, reads one injected stdin token, and prints only public fields", async () => {
    const directory = setupCleanState();
    const slack = verifier();
    const output: string[] = [];
    const token = "xoxb-cli-test-token";
    const result = await runCleanSlackConnectCli(
      [
        "--state-dir",
        directory,
        "--approval-channel-id",
        "C_APPROVAL",
        "--connection-id",
        "con_00000000-0000-4000-8000-000000000001",
      ],
      {
        stdout: (value) => output.push(value),
        read_stdin: async () => `${token}\n`,
      },
      {
        verify_state: verifyCleanControlPlaneStateV1,
        create_verifier: () => slack,
        now: () => "2026-08-22T00:00:00.000Z",
      },
    );

    expect(result).toBe(0);
    expect(slack.verifyConnection).toHaveBeenCalledWith(token, undefined);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(token);
    const parsed = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      connection_id: "con_00000000-0000-4000-8000-000000000001",
      organization_id: COORDINATES.organization_id,
      provider_tenant_id: "T01",
      state_lineage_id: COORDINATES.state_lineage_id,
    });
    expect(Object.keys(parsed)).not.toContain("slack_bot_token");
    expect(parsed.credential_reference_sha256).toMatch(/^sha256:/);
  });

  it("refuses multiple stdin tokens before selecting a provider", async () => {
    const directory = setupCleanState();
    const createVerifier = vi.fn(() => verifier());
    await expect(
      runCleanSlackConnectCli(
        ["--state-dir", directory, "--approval-channel-id", "C_APPROVAL"],
        { stdout: vi.fn(), read_stdin: async () => "xoxb-one\nxoxb-two\n" },
        {
          verify_state: (path) => ({
            state_directory: path,
            integrations_database_path: join(path, "integrations.sqlite"),
            ...COORDINATES,
          }),
          create_verifier: createVerifier,
          now: () => "2026-08-22T00:00:00.000Z",
        },
      ),
    ).rejects.toThrow("exactly one token");
    expect(createVerifier).not.toHaveBeenCalled();
  });
});
