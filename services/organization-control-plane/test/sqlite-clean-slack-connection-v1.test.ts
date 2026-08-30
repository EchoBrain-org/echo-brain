import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
  type VerifiedSlackChannel,
  type VerifiedSlackConnection,
} from "../src/application/contracts.js";
import { canonicalSha256 } from "../src/canonical/canonical-json.js";
import { applyOrganizationControlBaselineV1 } from "../src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../src/persistence/open-organization-control-database.js";
import {
  CleanSlackConnectionConflictError,
  connectCleanSlackV1,
  runCleanSlackConnectCommandV1,
  type CleanSlackConnectionVerifierV1,
} from "../src/persistence/sqlite-clean-slack-connection-v1.js";
import { FileOrganizationSecretStore } from "../src/security/file-secret-store.js";

const directories: string[] = [];
type CleanSlackCoordinates = Readonly<{
  authority_id: string;
  organization_id: string;
  state_lineage_id: string;
  connection_id: string;
  approval_channel_id: string;
}>;

const COORDINATES: CleanSlackCoordinates = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
  connection_id: "con_00000000-0000-4000-8000-000000000001",
  approval_channel_id: "C_APPROVAL",
});

function directory(): string {
  const value = realpathSync(
    mkdtempSync(join(tmpdir(), "echo-clean-slack-connection-")),
  );
  directories.push(value);
  return value;
}

function setup(): {
  readonly database: Database.Database;
  readonly directory: string;
} {
  const stateDirectory = directory();
  const database = openOrganizationControlDatabase(
    join(stateDirectory, "integrations.sqlite"),
  );
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
  return { database, directory: stateDirectory };
}

function verifier(
  input: Partial<{
    readonly connection: VerifiedSlackConnection;
    readonly channel: VerifiedSlackChannel;
    readonly connection_error: Error;
    readonly channel_error: Error;
  }> = {},
): CleanSlackConnectionVerifierV1 & {
  readonly verifyConnection: ReturnType<typeof vi.fn>;
  readonly verifyChannel: ReturnType<typeof vi.fn>;
} {
  const connection =
    input.connection ??
    ({
      team_id: "T01",
      enterprise_id: null,
      bot_user_id: "U_BOT",
      bot_id: "B01",
      app_id: "A01",
      granted_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
      verification_evidence_sha256: canonicalSha256({ connection: "ok" }),
    } satisfies VerifiedSlackConnection);
  const channel =
    input.channel ??
    ({
      team_id: "T01",
      channel_id: COORDINATES.approval_channel_id,
      is_public_organization_channel: true,
      is_active: true,
      bot_membership_verified: true,
      bot_access_verified: true,
      verification_evidence_sha256: canonicalSha256({ channel: "ok" }),
    } satisfies VerifiedSlackChannel);
  return {
    verifyConnection: vi.fn(async () => {
      if (input.connection_error !== undefined) throw input.connection_error;
      return connection;
    }),
    verifyChannel: vi.fn(async () => {
      if (input.channel_error !== undefined) throw input.channel_error;
      return channel;
    }),
  };
}

function request(
  database: Database.Database,
  secrets: Pick<OrganizationSecretStore, "create" | "remove">,
  slack: CleanSlackConnectionVerifierV1,
  overrides: Partial<typeof COORDINATES> = {},
) {
  return {
    ...COORDINATES,
    ...overrides,
    slack_bot_token: "xoxb-test-token-only",
    database,
    secrets,
    verifier: slack,
    now: () => "2026-08-22T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const value of directories.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("clean stopped-state Slack connection v1", () => {
  it("persists one verified active D2 connection and only a credential-reference digest", async () => {
    const state = setup();
    const secrets = new FileOrganizationSecretStore(
      join(state.directory, "secrets"),
    );
    const slack = verifier();

    const result = await connectCleanSlackV1(
      request(state.database, secrets, slack),
    );

    expect(result.idempotent).toBe(false);
    expect(result.connection.connection_id).toBe(COORDINATES.connection_id);
    expect(result.state.connection_status).toBe("active");
    expect(result.state.credential_reference_sha256).toMatch(/^sha256:/);
    expect(slack.verifyConnection).toHaveBeenCalledTimes(1);
    expect(slack.verifyChannel).toHaveBeenCalledWith(
      "xoxb-test-token-only",
      COORDINATES.approval_channel_id,
      "T01",
      undefined,
    );
    expect(secrets.listReferences()).toHaveLength(1);
    const reference = secrets.listReferences()[0]!;
    expect(statSync(join(state.directory, "secrets")).mode & 0o777).toBe(0o700);
    expect(
      statSync(
        join(
          state.directory,
          "secrets",
          `${reference.secret_handle_id}.secret`,
        ),
      ).mode & 0o777,
    ).toBe(0o600);
    const persisted = state.database
      .prepare(
        `SELECT contract_json, state_json FROM organization_tool_connection_contracts
         JOIN organization_tool_connection_current_state USING (connection_id)`,
      )
      .get() as { contract_json: string; state_json: string };
    expect(`${persisted.contract_json}${persisted.state_json}`).not.toContain(
      "xoxb-test-token-only",
    );
    expect(`${persisted.contract_json}${persisted.state_json}`).not.toContain(
      reference.secret_handle_id,
    );
  });

  it("returns the exact active public connection on retry without a second secret or provider call", async () => {
    const state = setup();
    const secrets = new FileOrganizationSecretStore(
      join(state.directory, "secrets"),
    );
    const slack = verifier();
    const first = await connectCleanSlackV1(
      request(state.database, secrets, slack),
    );
    const retried = await connectCleanSlackV1(
      request(state.database, secrets, slack),
    );

    expect(retried).toEqual({ ...first, idempotent: true });
    expect(secrets.listReferences()).toHaveLength(1);
    expect(slack.verifyConnection).toHaveBeenCalledTimes(1);
    expect(slack.verifyChannel).toHaveBeenCalledTimes(1);
  });

  it("keeps the private token behind the stopped-state command's injected reader", async () => {
    const state = setup();
    const secrets = new FileOrganizationSecretStore(
      join(state.directory, "secrets"),
    );
    const readSlackBotToken = vi.fn(() => "xoxb-test-token-only");
    const result = await runCleanSlackConnectCommandV1({
      ...COORDINATES,
      database: state.database,
      secrets,
      verifier: verifier(),
      now: () => "2026-08-22T00:00:00.000Z",
      read_slack_bot_token: readSlackBotToken,
    });

    expect(result.idempotent).toBe(false);
    expect(readSlackBotToken).toHaveBeenCalledOnce();
  });

  it("rejects a different public command once a clean connection is active", async () => {
    const state = setup();
    const secrets = new FileOrganizationSecretStore(
      join(state.directory, "secrets"),
    );
    const slack = verifier();
    await connectCleanSlackV1(request(state.database, secrets, slack));

    await expect(
      connectCleanSlackV1(
        request(state.database, secrets, slack, {
          approval_channel_id: "C_DIFFERENT",
        }),
      ),
    ).rejects.toBeInstanceOf(CleanSlackConnectionConflictError);
    expect(secrets.listReferences()).toHaveLength(1);
    expect(slack.verifyConnection).toHaveBeenCalledTimes(1);
  });

  it("does not create a secret for missing scopes or failed provider verification", async () => {
    const state = setup();
    const secrets = new FileOrganizationSecretStore(
      join(state.directory, "secrets"),
    );
    const missingScope = verifier({
      connection: {
        team_id: "T01",
        enterprise_id: null,
        bot_user_id: "U_BOT",
        bot_id: "B01",
        app_id: "A01",
        granted_scopes: ["users:read"],
        verification_evidence_sha256: canonicalSha256({ connection: "bad" }),
      },
    });
    await expect(
      connectCleanSlackV1(request(state.database, secrets, missingScope)),
    ).rejects.toThrow("missing required scope");
    const unavailable = verifier({
      connection_error: new Error("provider unavailable"),
    });
    await expect(
      connectCleanSlackV1(request(state.database, secrets, unavailable)),
    ).rejects.toThrow("provider unavailable");
    expect(secrets.listReferences()).toEqual([]);
  });

  it.each(["im:history", "im:write"] as const)(
    "refuses an otherwise complete token missing private-DM scope %s",
    async (missingScope) => {
      const state = setup();
      const secrets = new FileOrganizationSecretStore(
        join(state.directory, "secrets"),
      );
      const missingPrivateDmScope = verifier({
        connection: {
          team_id: "T01",
          enterprise_id: null,
          bot_user_id: "U_BOT",
          bot_id: "B01",
          app_id: "A01",
          granted_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES.filter(
            (scope) => scope !== missingScope,
          ),
          verification_evidence_sha256: canonicalSha256({
            connection: `missing-private-dm-${missingScope}`,
          }),
        },
      });

      await expect(
        connectCleanSlackV1(
          request(state.database, secrets, missingPrivateDmScope),
        ),
      ).rejects.toThrow(`missing required scope ${missingScope}`);
      expect(secrets.listReferences()).toEqual([]);
    },
  );

  it("removes a newly written secret when the SQLite transaction cannot persist it", async () => {
    const state = setup();
    const created: OrganizationSecretReference[] = [];
    const removed: OrganizationSecretReference[] = [];
    const secrets = {
      create: vi.fn((_: string) => {
        const reference = {
          secret_backend_id: "authority-file-v1" as const,
          secret_handle_id: "sch_00000000-0000-4000-8000-000000000001",
        };
        created.push(reference);
        return reference;
      }),
      remove: vi.fn((reference: OrganizationSecretReference) => {
        removed.push(reference);
      }),
    };
    state.database
      .prepare(
        `INSERT INTO organization_tool_connection_contracts
         (connection_id, contract_json, contract_sha256, created_at)
         VALUES (?, '{}', ?, ?)`,
      )
      .run(
        COORDINATES.connection_id,
        canonicalSha256({ occupied: true }),
        "2026-08-22T00:00:00.000Z",
      );

    await expect(
      connectCleanSlackV1(request(state.database, secrets, verifier())),
    ).rejects.toThrow();
    expect(created).toHaveLength(1);
    expect(removed).toEqual(created);
    expect(
      state.database
        .prepare(
          "SELECT count(*) FROM organization_tool_connection_current_state",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });
});
