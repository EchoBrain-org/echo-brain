import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalSha256 } from "../../../../../../packages/organization-control-plane/src/canonical/canonical-json.js";
import { applyOrganizationControlBaselineV3 } from "../../../../../../packages/organization-control-plane/src/persistence/baseline.js";
import { openOrganizationControlDatabase } from "../../../../../../packages/organization-control-plane/src/persistence/open-organization-control-database.js";
import { FileOrganizationSecretStore } from "../../../../../../packages/organization-control-plane/src/security/file-secret-store.js";
import type { NangoSlackConnectionV1 } from "../../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { buildOrganizationToolConnectionContractV2 } from "../../../src/organization-control-plane/application/organization-tool-connection-contracts-v2.js";
import type { OrganizationSecretStore, VerifiedSlackConnection } from "../../../src/organization-control-plane/application/slack-integration-contracts.js";
import { readActiveSlackConnectionV1, slackNangoAppPublicConfigurationSha256V1, type StoredSlackConnectionV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { activateNangoSlackConnectionV1, rebindNangoSlackConnectionV1, SlackConnectionConflictError, SlackConnectionRefusedErrorV1 } from "../../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";

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
      enterprise_id: null,
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

/** A rebind of the active connection onto `nango`, whose auth.test reproduces the first install's evidence unless overridden. */
function rebind(
  state: TestState,
  input: {
    readonly credential: ReturnType<typeof pendingBundle>;
    readonly nango: NangoSlackConnectionV1;
    readonly rebind: { readonly state_sha256: `sha256:${string}`; readonly nango_connection_id: string };
    readonly verified?: Partial<VerifiedSlackConnection>;
    readonly verifier?: ReturnType<typeof authTest>;
    readonly assert_lost?: () => Promise<void>;
    readonly assert_owner?: () => void;
  },
) {
  return rebindNangoSlackConnectionV1({
    ...COORDINATES,
    database: state.database,
    secrets: state.secrets,
    verifier: input.verifier ?? authTest(input.nango, { verification_evidence_sha256: canonicalSha256({ verified: "nango-conn-1" }), ...input.verified }),
    credential: input.credential,
    nango: input.nango,
    rebind: input.rebind,
    assert_lost: input.assert_lost ?? (async () => undefined),
    assert_owner: input.assert_owner ?? (() => undefined),
    now: () => LATER,
    new_connection_id: () => "con_nango_2",
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

const PREDATES_IN_APP_SETUP = "stored Slack connection predates in-app setup; install this release's host tooling, then run replace-rehearsal";
const SEVEN_PRE_IN_APP_SCOPES = ["channels:history", "channels:read", "chat:write", "im:history", "im:write", "reactions:read", "users:read"];

/** A connection stored by the removed bot-token-and-channel setup: seven scopes and a channel configuration. */
function seedPreInAppConnection(database: Database.Database): void {
  const contract = {
    schema_version: 2, kind: "echo-organization-tool-connection-v2", ...COORDINATES, connection_id: "con_legacy",
    provider_issuer: "https://slack.com", provider_tenant_kind: "workspace", provider_tenant_id: "T01", provider_enterprise_id: null,
    tool_kind: "slack", provider_app_id: "A_LEGACY", provider_bot_id: "B_LEGACY", provider_bot_user_id: "U_LEGACY",
    required_provider_scopes: SEVEN_PRE_IN_APP_SCOPES,
    public_connection_configuration_sha256: canonicalSha256({ approval_channel_id: "C_APPROVAL", kind: "echo-clean-slack-connection-public-configuration-v1" }),
  };
  const state = {
    schema_version: 2, kind: "echo-organization-tool-connection-state-v2", connection_id: "con_legacy",
    connection_contract_sha256: canonicalSha256(contract), connection_status: "active",
    credential_reference_sha256: canonicalSha256({ legacy: "token" }), observed_granted_scopes: contract.required_provider_scopes,
    verification_event_id: "verify_con_legacy", verification_evidence_sha256: canonicalSha256({ legacy: "verified" }),
    verification_revision: 1, verified_at: NOW,
  };
  database.prepare(`INSERT INTO organization_tool_connection_contracts (connection_id, contract_json, contract_sha256, created_at)
    VALUES (?, ?, ?, ?)`).run("con_legacy", canonicalJson(contract), canonicalSha256(contract), NOW);
  database.prepare(`INSERT INTO organization_tool_connection_current_state (connection_id, connection_contract_sha256, state_json,
    state_sha256, current_status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`)
    .run("con_legacy", canonicalSha256(contract), canonicalJson(state), canonicalSha256(state), NOW);
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
    expect(active).toMatchObject({ connection: result.connection, state_sha256: canonicalSha256(result.state) });
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
      replace: (reference, secret) => state.secrets.replace(reference, secret),
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
    expect(readActiveSlackConnectionV1(state.database)).toMatchObject({ connection: { connection_id: "con_nango_1" } });
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

  it("refuses a reconnect that lands in a different team or bot as a workspace mismatch, writing nothing", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    const team = nangoInstall({ team_id: "T02" });

    await expectRefused(activate(state, { credential: activeBundle, nango: team, verifier: authTest(team), connection_id: "con_nango_2" }), "workspace_mismatch");
    await expectRefused(
      activate(state, { credential: activeBundle, nango: nangoInstall(), verifier: authTest(nangoInstall(), { bot_id: "B02" }), connection_id: "con_nango_2" }),
      "workspace_mismatch",
    );
    expect(readActiveSlackConnectionV1(state.database)?.connection.provider_tenant_id).toBe("T01");
    expect(state.secrets.listReferences()).toHaveLength(1);
    expect(findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256)).toEqual(activeBundle);
  });

  it("rebinds a lost Nango connection under the same handle, keeping the state hash and every waiting card", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const active = readActiveSlackConnectionV1(state.database)!;
    seedPendingApproval(state.database, active, seedOwnerLink(state.database, active));
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    const before = refs(state);

    const result = await rebind(state, { credential: activeBundle, nango: nangoInstall({ connection_id: "nango-conn-2", updated_at: LATER }),
      rebind: { state_sha256: active.state_sha256, nango_connection_id: "nango-conn-1" } });

    expect(result).toEqual({ kind: "reconnected", connection: created.connection, state: created.state });
    expect(readActiveSlackConnectionV1(state.database)).toEqual(active);
    expect(refs(state)).toEqual(before);
    const rebound = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    expect(rebound).toEqual({ reference: activeBundle.reference, credentials: { ...activeBundle.credentials, nango_connection_id: "nango-conn-2" } });
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(1);
    expect(state.database.prepare("SELECT connection_state_sha256 FROM organization_private_approval_pending_contracts_v2").pluck().all())
      .toEqual([active.state_sha256]);
  });

  it("refuses a rebind to another team, bot or verification evidence as a workspace mismatch, writing nothing", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const active = readActiveSlackConnectionV1(state.database)!;
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    const lost = { state_sha256: active.state_sha256, nango_connection_id: "nango-conn-1" };
    const replacement = nangoInstall({ connection_id: "nango-conn-2" });

    for (const [nango, verified] of [
      [nangoInstall({ connection_id: "nango-conn-2", team_id: "T02" }), {}],
      [replacement, { bot_id: "B02" }],
      [replacement, { enterprise_id: "E01" }],
      // Same ids, but auth.test no longer reproduces the stored evidence (say, other scopes).
      [replacement, { verification_evidence_sha256: canonicalSha256({ verified: "nango-conn-2" }) }],
    ] as const) {
      await expectRefused(rebind(state, { credential: activeBundle, nango, rebind: lost, verified }), "workspace_mismatch");
    }
    expect(findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256)).toEqual(activeBundle);
    expect(readActiveSlackConnectionV1(state.database)).toEqual(active);
  });

  it("refuses a rebind once the active state or its bundle changed since the install began", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const active = readActiveSlackConnectionV1(state.database)!;
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    const nango = nangoInstall({ connection_id: "nango-conn-2" });
    const lost = { state_sha256: active.state_sha256, nango_connection_id: "nango-conn-1" };

    for (const [credential, rebound] of [
      [activeBundle, { ...lost, state_sha256: canonicalSha256({ state: "other" }) }],
      [activeBundle, { ...lost, nango_connection_id: "nango-conn-0" }],
      [{ ...activeBundle, credentials: { ...activeBundle.credentials, signing_secret: "signing-secret-rotated" } }, lost],
    ] as const) {
      await expect(rebind(state, { credential, nango, rebind: rebound })).rejects.toBeInstanceOf(SlackConnectionConflictError);
    }
    expect(findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256)).toEqual(activeBundle);
  });

  it("runs the lost-connection and owner fences after Slack verification, before replacing the bundle", async () => {
    const state = setup();
    const created = await activate(state, { credential: pendingBundle(state), nango: nangoInstall() });
    const active = readActiveSlackConnectionV1(state.database)!;
    const activeBundle = findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256);
    let verified = false;
    let lostChecked = false;
    let ownerChecked = false;
    const nango = nangoInstall({ connection_id: "nango-conn-2" });
    const verifier = {
      verifyConnection: vi.fn(async () => {
        verified = true;
        return authTest(nango, { verification_evidence_sha256: canonicalSha256({ verified: "nango-conn-1" }) }).verifyConnection();
      }),
    };

    await expect(rebind(state, {
      credential: activeBundle,
      nango,
      rebind: { state_sha256: active.state_sha256, nango_connection_id: "nango-conn-1" },
      verifier,
      assert_lost: async () => {
        expect(verified).toBe(true);
        lostChecked = true;
      },
      assert_owner: () => {
        expect(lostChecked).toBe(true);
        ownerChecked = true;
        throw new SlackConnectionConflictError("the owner changed during activation");
      },
    })).rejects.toBeInstanceOf(SlackConnectionConflictError);
    expect(lostChecked).toBe(true);
    expect(ownerChecked).toBe(true);
    expect(findSlackAppCredentialsByReferenceSha256V1(state.secrets, created.state.credential_reference_sha256)).toEqual(activeBundle);
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

  it("refuses an install while a connection from before in-app setup is stored, writing nothing", async () => {
    const state = setup();
    seedPreInAppConnection(state.database);
    const pending = pendingBundle(state);
    const before = refs(state);

    expect(() => readActiveSlackConnectionV1(state.database)).toThrow(new Error(PREDATES_IN_APP_SETUP));
    await expect(activate(state, { credential: pending, nango: nangoInstall() })).rejects.toThrow(new Error(PREDATES_IN_APP_SETUP));

    expect(refs(state)).toEqual(before);
    expect(rowCount(state.database, "organization_tool_connection_contracts")).toBe(1);
  });

  it("accepts only the recipe's four scopes in a connection contract", () => {
    const contract = {
      ...COORDINATES, connection_id: "con_nango_1", provider_issuer: "https://slack.com" as const, provider_tenant_kind: "workspace" as const,
      provider_tenant_id: "T01", provider_enterprise_id: null, tool_kind: "slack" as const, provider_app_id: "A0APP1",
      provider_bot_id: "B01", provider_bot_user_id: "U_BOT", public_connection_configuration_sha256: slackNangoAppPublicConfigurationSha256V1(),
    };
    expect(buildOrganizationToolConnectionContractV2({ ...contract, required_provider_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 })
      .required_provider_scopes).toEqual(SLACK_PRIVATE_APP_BOT_SCOPES_V1);
    expect(() => buildOrganizationToolConnectionContractV2({ ...contract, required_provider_scopes: SEVEN_PRE_IN_APP_SCOPES }))
      .toThrow("exact Slack approval scope set");
  });
});
