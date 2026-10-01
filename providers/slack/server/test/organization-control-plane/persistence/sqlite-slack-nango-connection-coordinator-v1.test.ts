import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSha256 } from "../../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { applyOrganizationControlBaselineV3 } from "../../../../../../packages/organization-control-plane/src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../../../../../../packages/organization-control-plane/src/persistence/open-organization-control-database.js";
import { FileOrganizationSecretStore } from "../../../../../../packages/organization-control-plane/src/security/file-secret-store.js";
import type { NangoSlackConnectionV1 } from "../../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES, type OrganizationSecretStore, type VerifiedSlackConnection } from "../../../src/organization-control-plane/application/slack-integration-contracts.js";
import { readActiveSlackConnectionV1, slackNangoAppPublicConfigurationSha256V1, type StoredSlackConnectionV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { connectSlackConnectionV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-connection-coordinator-v1.js";
import { activateNangoSlackConnectionV1, SlackConnectionRefusedErrorV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";

const COORDINATES = Object.freeze({
  authority_id: "oau_00000000-0000-4000-8000-000000000001",
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  state_lineage_id: "lineage-00000000-0000-4000-8000-000000000001",
});
const NOW = "2026-09-30T00:00:00.000Z";
const LATER = "2026-09-30T00:10:00.000Z";
const BOT_TOKEN = "xoxb-nango-bot-token-only";
const directories: string[] = [];

interface TestState {
  readonly database: Database.Database;
  readonly directory: string;
  readonly secrets: FileOrganizationSecretStore;
}

function setup(): TestState {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-nango-")));
  directories.push(directory);
  const database = openOrganizationControlDatabase(join(directory, "integrations.sqlite"));
  applyOrganizationControlBaselineV3(database);
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata
       (singleton, control_plane_id, organization_id, authority_id,
        authority_descriptor_sha256, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run("ocp_00000000-0000-4000-8000-000000000001", COORDINATES.organization_id, COORDINATES.authority_id, canonicalSha256({ descriptor: "test" }), NOW);
  return { database, directory, secrets: new FileOrganizationSecretStore(join(directory, "secrets")) };
}

function pendingBundle(state: TestState, appId = "A0APP1") {
  const credentials: SlackAppCredentialsV1 = {
    kind: "echo-slack-app-credentials-v1",
    app_id: appId,
    client_id: "1234.5678",
    client_secret: `client-secret-${appId}`,
    signing_secret: `signing-secret-${appId}`,
    nango_connection_id: null,
  };
  return { reference: state.secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials };
}

function nangoInstall(overrides: Partial<NangoSlackConnectionV1> = {}): NangoSlackConnectionV1 {
  return {
    connection_id: "nango-conn-1",
    tags: {},
    team_id: "T01",
    enterprise_id: null,
    is_enterprise_install: false,
    app_id: "A0APP1",
    bot_user_id: "U_BOT",
    granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    bot_token: BOT_TOKEN,
    updated_at: NOW,
    ...overrides,
  };
}

function authTest(nango: NangoSlackConnectionV1, overrides: Partial<VerifiedSlackConnection> = {}) {
  return {
    verifyConnection: vi.fn(async (): Promise<VerifiedSlackConnection> => ({
      team_id: nango.team_id,
      enterprise_id: nango.enterprise_id,
      bot_user_id: nango.bot_user_id,
      bot_id: "B01",
      app_id: nango.app_id,
      granted_scopes: nango.granted_scopes,
      verification_evidence_sha256: canonicalSha256({ verified: nango.connection_id }),
      ...overrides,
    })),
  };
}

function activate(
  state: TestState,
  input: {
    readonly credential: ReturnType<typeof pendingBundle>;
    readonly nango: NangoSlackConnectionV1;
    readonly verifier?: ReturnType<typeof authTest>;
    readonly connection_id?: string;
  },
) {
  return activateNangoSlackConnectionV1({
    ...COORDINATES,
    database: state.database,
    secrets: state.secrets,
    verifier: input.verifier ?? authTest(input.nango),
    credential: input.credential,
    nango: input.nango,
    now: () => NOW,
    new_connection_id: () => input.connection_id ?? "con_nango_1",
  });
}

async function expectRefused(promise: Promise<unknown>, reason: SlackConnectionRefusedErrorV1["reason"]) {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SlackConnectionRefusedErrorV1);
  expect(error).toMatchObject({ reason });
}

function rowCount(database: Database.Database, table: string): unknown {
  return database.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}

function refs(state: TestState): string[] {
  return state.secrets.listReferences().map((reference) => reference.secret_handle_id).sort();
}

function seedOwnerLink(database: Database.Database, active: StoredSlackConnectionV1): `sha256:${string}` {
  const linkSha = canonicalSha256({ link: "owner", tenant: active.connection.provider_tenant_id });
  database.prepare("INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)").run("clm_owner", linkSha, '{"link":"owner"}', NOW);
  database
    .prepare("INSERT INTO organization_external_human_link_current VALUES (?, ?, 'https://slack.com', 'workspace', ?, ?, 'U_OWNER', 'prn_owner', 'mem_owner', 'active', ?)")
    .run("clm_owner", linkSha, active.connection.provider_tenant_id, active.connection.provider_enterprise_id, NOW);
  return linkSha;
}

function seedPendingApproval(database: Database.Database, active: StoredSlackConnectionV1, linkSha: string): void {
  database
    .prepare(
      `INSERT INTO organization_private_approval_pending_contracts_v2
       (approval_id, candidate_id, organization_id, authority_id, pending_json, pending_sha256,
        card_binding_json, card_binding_sha256, stage_command_id, connection_id,
        connection_contract_sha256, connection_state_sha256, external_identity_link_id,
        external_identity_link_contract_sha256, assignee_principal_id, assignee_membership_id,
        slack_workspace_id, slack_enterprise_id, slack_subject_id, dm_channel_id,
        provider_message_ts, card_sha256, created_at)
       VALUES ('apr_1', 'cnd_1', ?, ?, '{"pending":1}', ?, '{"card":1}', ?, 'pas_1', ?, ?, ?,
               'clm_owner', ?, 'prn_owner', 'mem_owner', ?, NULL, 'U_OWNER', 'D_OWNER', '1.0001', ?, ?)`,
    )
    .run(
      COORDINATES.organization_id,
      COORDINATES.authority_id,
      canonicalSha256({ pending: 1 }),
      canonicalSha256({ card_binding: 1 }),
      active.connection.connection_id,
      active.contract_sha256,
      active.state_sha256,
      linkSha,
      active.connection.provider_tenant_id,
      canonicalSha256({ card: 1 }),
      NOW,
    );
}

async function connectLegacy(state: TestState): Promise<void> {
  await connectSlackConnectionV1({
    ...COORDINATES,
    connection_id: "con_legacy",
    approval_channel_id: "C_APPROVAL",
    slack_bot_token: "xoxb-legacy-token-only",
    database: state.database,
    secrets: state.secrets,
    verifier: {
      verifyConnection: async () => ({
        team_id: "T01",
        enterprise_id: null,
        bot_user_id: "U_LEGACY",
        bot_id: "B_LEGACY",
        app_id: "A_LEGACY",
        granted_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
        verification_evidence_sha256: canonicalSha256({ legacy: "connection" }),
      }),
      verifyChannel: async () => ({
        team_id: "T01",
        channel_id: "C_APPROVAL",
        is_public_organization_channel: true,
        is_active: true,
        bot_membership_verified: true,
        bot_access_verified: true,
        verification_evidence_sha256: canonicalSha256({ legacy: "channel" }),
      }),
    },
    now: () => NOW,
  });
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Nango Slack connection activation v1", () => {
  it("creates the first connection, stores the Nango connection id in the bundle, and keeps every secret out of SQLite", async () => {
    const state = setup();
    const pending = pendingBundle(state);
    const verifier = authTest(nangoInstall());

    const result = await activate(state, { credential: pending, nango: nangoInstall(), verifier });

    expect(result.kind).toBe("created");
    expect(verifier.verifyConnection).toHaveBeenCalledWith(BOT_TOKEN, undefined);
    expect(result.connection).toMatchObject({
      connection_id: "con_nango_1",
      provider_tenant_id: "T01",
      provider_app_id: "A0APP1",
      provider_bot_id: "B01",
      provider_bot_user_id: "U_BOT",
      required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
      public_connection_configuration_sha256: slackNangoAppPublicConfigurationSha256V1(),
    });
    expect(result.state).toMatchObject({ verification_event_id: "nango_con_nango_1", verification_revision: 1 });
    const active = readActiveSlackConnectionV1(state.database);
    expect(active).toMatchObject({ kind: "nango", state_sha256: canonicalSha256(result.state) });
    expect(state.secrets.listReferences()).toHaveLength(1);
    expect(refs(state)).not.toContain(pending.reference.secret_handle_id);
    const bundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, result.state.credential_reference_sha256);
    expect(bundle.credentials).toEqual({ ...pending.credentials, nango_connection_id: "nango-conn-1" });

    state.database.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(state.directory, `integrations.sqlite${suffix}`);
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path).toString("latin1");
      for (const secret of [BOT_TOKEN, pending.credentials.client_secret, pending.credentials.signing_secret]) {
        expect(bytes).not.toContain(secret);
      }
    }
  });

  it("commits the connection even when removing the superseded pending bundle afterward fails", async () => {
    const state = setup();
    const pending = pendingBundle(state);
    const secrets: OrganizationSecretStore = {
      create: (secret) => state.secrets.create(secret),
      read: (reference) => state.secrets.read(reference),
      listReferences: () => state.secrets.listReferences(),
      remove: (reference) => {
        if (reference.secret_handle_id === pending.reference.secret_handle_id) throw new Error("disk is full");
        state.secrets.remove(reference);
      },
    };

    const result = await activateNangoSlackConnectionV1({
      ...COORDINATES, database: state.database, secrets, verifier: authTest(nangoInstall()),
      credential: pending, nango: nangoInstall(), now: () => NOW, new_connection_id: () => "con_nango_1",
    });

    expect(result.kind).toBe("created");
    expect(readActiveSlackConnectionV1(state.database)).toMatchObject({ kind: "nango", connection: { connection_id: "con_nango_1" } });
    // Best-effort: the write already committed, so the orphaned pending bundle must not surface as a failure.
    expect(refs(state)).toContain(pending.reference.secret_handle_id);
  });

  it("refuses partial scopes from Nango or from auth.test", async () => {
    const state = setup();
    const pending = pendingBundle(state);
    const partial = SLACK_PRIVATE_APP_BOT_SCOPES_V1.filter((scope) => scope !== "im:write");
    const nangoPartial = authTest(nangoInstall());
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall({ granted_scopes: partial }), verifier: nangoPartial }), "permissions_missing");
    expect(nangoPartial.verifyConnection).not.toHaveBeenCalled();
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall(), verifier: authTest(nangoInstall(), { granted_scopes: partial }) }), "permissions_missing");
    expect(refs(state)).toEqual([pending.reference.secret_handle_id]);
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(0);
  });

  it("refuses an enterprise install", async () => {
    const state = setup();
    const pending = pendingBundle(state);
    const verifier = authTest(nangoInstall());
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall({ is_enterprise_install: true, enterprise_id: "E01" }), verifier }), "workspace_mismatch");
    expect(verifier.verifyConnection).not.toHaveBeenCalled();
    expect(refs(state)).toEqual([pending.reference.secret_handle_id]);
  });

  it("refuses an app or team mismatch between Nango and auth.test", async () => {
    const state = setup();
    const pending = pendingBundle(state);
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall({ app_id: "A0OTHER" }) }), "workspace_mismatch");
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall(), verifier: authTest(nangoInstall(), { team_id: "T99" }) }), "workspace_mismatch");
    await expectRefused(activate(state, { credential: pending, nango: nangoInstall(), verifier: authTest(nangoInstall(), { app_id: "A0OTHER" }) }), "workspace_mismatch");
    expect(refs(state)).toEqual([pending.reference.secret_handle_id]);
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(0);
  });

  it("reconnects on the same Nango connection without any write, keeping the state hash", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const before = refs(state);
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);

    const result = await activate(state, { credential: activeBundle, nango: nangoInstall({ updated_at: LATER }), connection_id: "con_nango_2" });

    expect(result).toEqual({ kind: "reconnected", connection: created.connection, state: created.state });
    expect(readActiveSlackConnectionV1(state.database)?.state_sha256).toBe(canonicalSha256(created.state));
    expect(refs(state)).toEqual(before);
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(1);
  });

  it("refuses a different Nango connection id for the same app, writing nothing", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);

    await expectRefused(
      activate(state, { credential: activeBundle, nango: nangoInstall({ connection_id: "nango-conn-2" }), connection_id: "con_nango_2" }),
      "already_connected",
    );
    expect(readActiveSlackConnectionV1(state.database)?.connection.connection_id).toBe("con_nango_1");
    expect(state.secrets.listReferences()).toHaveLength(1);
  });

  it("refuses a reconnect that lands in a different team, writing nothing", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    const nango = nangoInstall({ team_id: "T02" });

    await expectRefused(
      activate(state, { credential: activeBundle, nango, verifier: authTest(nango), connection_id: "con_nango_2" }),
      "already_connected",
    );
    expect(readActiveSlackConnectionV1(state.database)?.connection.provider_tenant_id).toBe("T01");
    expect(state.secrets.listReferences()).toHaveLength(1);
  });

  it("refuses a different app while a connection is active, writing nothing and leaving every waiting card alone", async () => {
    const state = setup();
    await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const active = readActiveSlackConnectionV1(state.database)!;
    seedPendingApproval(state.database, active, seedOwnerLink(state.database, active));
    const replacement = pendingBundle(state, "A0APP2");
    const before = refs(state);

    await expectRefused(
      activate(state, { credential: replacement, nango: nangoInstall({ connection_id: "nango-conn-2", app_id: "A0APP2" }), connection_id: "con_nango_2" }),
      "already_connected",
    );
    expect(refs(state)).toEqual(before);
    expect(readActiveSlackConnectionV1(state.database)?.state_sha256).toBe(active.state_sha256);
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(1);
    expect(rowCount(state.database, "organization_private_approval_pending_contracts_v2")).toBe(1);
  });

  it("refuses a Nango install while a legacy connection is active, writing nothing", async () => {
    const state = setup();
    await connectLegacy(state);
    const pending = pendingBundle(state);
    const before = refs(state);

    await expectRefused(activate(state, { credential: pending, nango: nangoInstall() }), "already_connected");

    expect(refs(state)).toEqual(before);
    expect(readActiveSlackConnectionV1(state.database)).toMatchObject({ kind: "legacy", connection: { connection_id: "con_legacy" } });
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(1);
  });

  it("reads a connection made by today's legacy coordinator as kind legacy", async () => {
    const state = setup();
    await connectLegacy(state);

    expect(readActiveSlackConnectionV1(state.database)).toMatchObject({
      kind: "legacy",
      connection: { connection_id: "con_legacy", required_provider_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES },
    });
  });
});
