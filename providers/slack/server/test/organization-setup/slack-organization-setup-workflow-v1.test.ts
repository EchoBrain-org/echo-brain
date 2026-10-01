import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { applyOrganizationControlBaselineV3, openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1 } from "@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1";
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-browser-link";
import { NangoClientErrorV1, type NangoConnectionClientV1, type NangoSlackConnectionV1 } from "../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { buildEchoSlackAppManifestV1, SLACK_PRIVATE_APP_BOT_SCOPES_V1, SlackAppManifestProviderErrorV1 } from "../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { SlackIdentityProviderErrorV1 } from "../../src/organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { findPendingSlackAppCredentialsV1, serializeSlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { SlackConnectionHealthV1 } from "../../src/organization-control-plane/application/slack-connection-health-v1.js";
import { createSlackBotTokenSourceV1 } from "../../src/organization-control-plane/application/slack-bot-token-source-v1.js";
import { readActiveSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { SlackOrganizationSetupWorkflowV1 } from "../../src/organization-setup/slack-organization-setup-workflow-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "../../src/person-identity/slack-person-external-identity-runtime-bundle-v1.js";

const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const STATE_LINEAGE_ID = "lineage-00000000-0000-4000-8000-000000000001";
const AUTHORITY_URL = "https://authority.example.com";
const NANGO_CALLBACK = "https://api.nango.dev/oauth/callback";
const T0 = "2026-09-30T00:00:00.000Z";
const CONFIG_TOKEN = "xoxe.xoxp-1-config-token-never-echoed";
const CLIENT_SECRET = "client-secret-never-echoed";
const SIGNING_SECRET = "signing-secret-never-echoed";
const BOT_TOKEN = "xoxb-bot-token-never-echoed";
const NANGO_KEY = "nango-secret-key-never-echoed";
const SECRETS = [CONFIG_TOKEN, CLIENT_SECRET, SIGNING_SECRET, BOT_TOKEN, NANGO_KEY];
const LINK = "https://connect.nango.dev/?session_token=opaque";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function person(membership_type: "owner" | "employee", n: number, family = n): PersonAccessAuthorization {
  return {
    organization_id: ORGANIZATION_ID, principal_id: `prn_${uuid(n)}`, membership_id: `mem_${uuid(n)}`, membership_type,
    identity_binding_id: `oib_${uuid(n)}`, session_family_id: `psf_${uuid(family)}`,
    access_credential_sha256: canonicalSha256("access"), access_expires_at: "2026-10-01T00:00:00.000Z",
    hard_reauthentication_at: "2026-10-01T00:00:00.000Z", person_state_sha256: canonicalSha256("person"),
    session_state_sha256: canonicalSha256("session"), checked_at: T0,
  };
}
const SESSIONS: Record<string, PersonAccessAuthorization> = { owner: person("owner", 1), "owner-2": person("owner", 1, 2), employee: person("employee", 3) };
const authentication = {
  authenticateAccess: ({ access_token }: { readonly access_token: string }) => {
    const found = SESSIONS[access_token];
    if (found === undefined) throw new Error("unknown test session");
    return found;
  },
};

const directories: string[] = [];
const contexts: { outputs: unknown[] }[] = [];

afterEach(() => {
  // Never echoes secrets: every response and thrown error of every test.
  const text = JSON.stringify(contexts.splice(0).flatMap((context) => context.outputs));
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function controlDatabase(): { directory: string; database: Database.Database } {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-setup-")));
  directories.push(directory);
  const database = openOrganizationControlDatabase(join(directory, "integrations.sqlite"));
  applyOrganizationControlBaselineV3(database);
  database.prepare(`INSERT INTO organization_control_plane_metadata (singleton, control_plane_id, organization_id, authority_id,
    authority_descriptor_sha256, created_at) VALUES (1, ?, ?, ?, ?, ?)`)
    .run(`ocp_${uuid(1)}`, ORGANIZATION_ID, AUTHORITY_ID, canonicalSha256({ descriptor: "test" }), T0);
  return { directory, database };
}

function fakes() {
  const connections = new Map<string, NangoSlackConnectionV1>();
  const session = async (_input: { readonly tags: Readonly<Record<string, string>> }) => ({ connect_link: LINK, expires_at: "2026-09-30T00:30:00.000Z" });
  const manifest = {
    createApp: vi.fn(async (_input: { configuration_token: string }) => ({ app_id: "A0APP1", client_id: "1234.5678", client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET })),
    updateApp: vi.fn(async (_input: { configuration_token: string; app_id: string }) => undefined),
  };
  const nango = {
    createConnectSession: vi.fn(session),
    createReconnectSession: vi.fn(session),
    findConnectionIdByTag: vi.fn(async (input: { key: string; value: string }) =>
      [...connections.values()].find((connection) => connection.tags[input.key] === input.value)?.connection_id),
    getSlackConnection: vi.fn(async (input: { connection_id: string }) => {
      const found = connections.get(input.connection_id);
      if (found === undefined) throw new NangoClientErrorV1("not_found", "Nango connection was not found");
      return found;
    }),
    deleteConnection: vi.fn(async () => undefined),
  } satisfies NangoConnectionClientV1;
  const verifier = {
    verifyConnection: vi.fn(async (token: string) => {
      const found = [...connections.values()].find((connection) => connection.bot_token === token)!;
      return { team_id: found.team_id, enterprise_id: null, bot_user_id: found.bot_user_id, bot_id: "B01", app_id: found.app_id,
        granted_scopes: found.granted_scopes, verification_evidence_sha256: canonicalSha256({ verified: found.connection_id }) };
    }),
  };
  return { connections, manifest, nango, verifier };
}

/** The owner finishing the Nango Connect flow for the last session ECHO created. */
function finishConnectFor(f: ReturnType<typeof fakes>, overrides: Partial<NangoSlackConnectionV1> = {}): NangoSlackConnectionV1 {
  const tags = f.nango.createConnectSession.mock.lastCall![0]!.tags;
  const id = `nango-conn-${String(f.connections.size + 1)}`;
  const connection: NangoSlackConnectionV1 = {
    connection_id: id, tags, team_id: "T01", enterprise_id: null, is_enterprise_install: false, app_id: "A0APP1",
    bot_user_id: "UBOT", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: `${BOT_TOKEN}-${id}`, updated_at: T0, ...overrides,
  };
  f.connections.set(connection.connection_id, connection);
  return connection;
}

/** Records every result and thrown error so the afterEach hook can prove none echoes a secret. */
function recorded<T extends object>(target: T, outputs: unknown[]): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const record = (error: unknown) => { outputs.push({ text: String(error), ...(error as object) }); throw error; };
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(object, args);
          if (result instanceof Promise) return result.then((resolved) => { outputs.push(resolved); return resolved; }, record);
          outputs.push(result);
          return result;
        } catch (error) { return record(error); }
      };
    },
  });
}

function setup() {
  const { database } = controlDatabase();
  const secrets = new FileOrganizationSecretStore(join(directories.at(-1)!, "secrets"));
  const health = new SlackConnectionHealthV1();
  const f = fakes();
  const context = { outputs: [] as unknown[], clock: T0 };
  contexts.push(context);
  let connectionNumber = 0;
  const workflow = recorded(new SlackOrganizationSetupWorkflowV1({
    database, secrets, authority_id: AUTHORITY_ID, organization_id: ORGANIZATION_ID, state_lineage_id: STATE_LINEAGE_ID,
    authentication, authority_url: AUTHORITY_URL, nango: { client: f.nango, callback_url: NANGO_CALLBACK },
    manifest_provider: f.manifest, verifier: f.verifier, health,
    now: () => context.clock, new_connection_id: () => `con_${uuid(++connectionNumber)}`,
  }), context.outputs);
  const finishConnect = (overrides: Partial<NangoSlackConnectionV1> = {}) => finishConnectFor(f, overrides);
  /** Settled attempts must not keep the app's client or signing secret in memory. */
  const heldAttempts = () => JSON.stringify([...(workflow as unknown as { attempts: Map<string, unknown> }).attempts.values()]);
  const connect = async () => {
    await workflow.setup({ request_id: `oss_${uuid(1)}`, configuration_token: CONFIG_TOKEN }, "owner");
    const begun = await workflow.beginInstall({ request_id: `osi_${uuid(1)}` }, "owner");
    finishConnect();
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    return readActiveSlackConnectionV1(database)!;
  };
  return { ...f, database, secrets, health, context, workflow, finishConnect, connect, heldAttempts };
}

function seedWaitingCard(database: Database.Database): void {
  const active = readActiveSlackConnectionV1(database)!;
  const linkSha = canonicalSha256({ link: "owner" });
  database.prepare("INSERT INTO organization_external_human_link_contracts VALUES (?, ?, ?, ?)").run("clm_owner", linkSha, '{"link":"owner"}', T0);
  database.prepare("INSERT INTO organization_external_human_link_current VALUES (?, ?, 'https://slack.com', 'workspace', ?, NULL, 'U_OWNER', 'prn_owner', 'mem_owner', 'active', ?)")
    .run("clm_owner", linkSha, active.connection.provider_tenant_id, T0);
  database.prepare(`INSERT INTO organization_private_approval_pending_contracts_v2 (approval_id, candidate_id, organization_id, authority_id,
      pending_json, pending_sha256, card_binding_json, card_binding_sha256, stage_command_id, connection_id, connection_contract_sha256,
      connection_state_sha256, external_identity_link_id, external_identity_link_contract_sha256, assignee_principal_id,
      assignee_membership_id, slack_workspace_id, slack_enterprise_id, slack_subject_id, dm_channel_id, provider_message_ts, card_sha256, created_at)
    VALUES ('apr_1', 'cnd_1', ?, ?, '{"pending":1}', ?, '{"card":1}', ?, 'pas_1', ?, ?, ?, 'clm_owner', ?, 'prn_owner', 'mem_owner', ?, NULL,
      'U_OWNER', 'D_OWNER', '1.0001', ?, ?)`)
    .run(ORGANIZATION_ID, AUTHORITY_ID, canonicalSha256({ pending: 1 }), canonicalSha256({ card_binding: 1 }), active.connection.connection_id,
      active.contract_sha256, active.state_sha256, linkSha, active.connection.provider_tenant_id, canonicalSha256({ card: 1 }), T0);
}

const SETUP_REQUEST = { request_id: `oss_${uuid(1)}`, configuration_token: CONFIG_TOKEN };
const BEGIN_REQUEST = { request_id: `osi_${uuid(1)}` };

describe("Slack organization setup workflow v1", () => {
  it("refuses employees on every route", async () => {
    const { workflow, manifest, nango } = setup();
    const attempt = { attempt_id: `ssi_${uuid(1)}` };
    for (const call of [
      () => workflow.setup(SETUP_REQUEST, "employee"), () => workflow.beginInstall(BEGIN_REQUEST, "employee"),
      () => workflow.installStatus(attempt, "employee"), () => workflow.cancelInstall(attempt, "employee"),
    ]) await expect(call()).rejects.toMatchObject({ code: "unauthorized" });
    expect(workflow.organizationSetupForCaller("employee")).toBeNull();
    expect(manifest.createApp).not.toHaveBeenCalled();
    expect(nango.createConnectSession).not.toHaveBeenCalled();
  });

  it("creates the app once, stores a pending bundle and updates it on a new token", async () => {
    const { workflow, manifest, secrets } = setup();
    expect(workflow.organizationSetup()).toBe("not_set_up");
    await expect(workflow.setup(SETUP_REQUEST, "owner")).resolves.toEqual({
      schema_version: 1, kind: "echo-organization-slack-setup-v1", app_id: "A0APP1", organization_setup: "app_created" });
    const recipe = buildEchoSlackAppManifestV1({ authority_url: AUTHORITY_URL, nango_callback_url: NANGO_CALLBACK });
    expect(manifest.createApp).toHaveBeenCalledWith(expect.objectContaining({ configuration_token: CONFIG_TOKEN, manifest: recipe }));
    expect(findPendingSlackAppCredentialsV1(secrets)?.credentials).toEqual({ kind: "echo-slack-app-credentials-v1", app_id: "A0APP1",
      client_id: "1234.5678", client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET, nango_connection_id: null });
    expect(workflow.organizationSetup()).toBe("app_created");
    await workflow.setup({ ...SETUP_REQUEST, request_id: `oss_${uuid(2)}` }, "owner");
    expect(manifest.createApp).toHaveBeenCalledOnce();
    expect(manifest.updateApp).toHaveBeenCalledWith(expect.objectContaining({ app_id: "A0APP1", manifest: recipe }));
    expect(secrets.listReferences()).toHaveLength(1);
  });

  it("updates the connected app on a new token", async () => {
    const { workflow, manifest, secrets, connect } = setup();
    await connect();
    const references = secrets.listReferences().length;
    await expect(workflow.setup({ ...SETUP_REQUEST, request_id: `oss_${uuid(2)}` }, "owner")).resolves.toEqual({
      schema_version: 1, kind: "echo-organization-slack-setup-v1", app_id: "A0APP1", organization_setup: "connected" });
    expect(manifest.updateApp).toHaveBeenLastCalledWith(expect.objectContaining({ app_id: "A0APP1" }));
    expect(manifest.createApp).toHaveBeenCalledOnce();
    expect(secrets.listReferences()).toHaveLength(references);
  });

  it("maps Slack setup errors to fixed messages and stores nothing", async () => {
    const { workflow, manifest, secrets } = setup();
    for (const [error, code] of [
      [new SlackAppManifestProviderErrorV1("invalid_token", `rejected ${CONFIG_TOKEN}`), "invalid_request"],
      [new SlackAppManifestProviderErrorV1("invalid_manifest", "bad manifest"), "invalid_output"],
      [new Error(`socket closed ${CONFIG_TOKEN}`), "unavailable"],
    ] as const) {
      manifest.createApp.mockRejectedValueOnce(error);
      await expect(workflow.setup(SETUP_REQUEST, "owner")).rejects.toMatchObject({ code });
    }
    expect(secrets.listReferences()).toHaveLength(0);
    await expect(workflow.setup({ ...SETUP_REQUEST, configuration_token: "short" }, "owner")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a concurrent setup while one is in flight", async () => {
    const { workflow, manifest } = setup();
    let release!: () => void;
    manifest.createApp.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { app_id: "A0APP1", client_id: "1234.5678", client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET };
    });
    const first = workflow.setup(SETUP_REQUEST, "owner");
    await expect(workflow.setup(SETUP_REQUEST, "owner-2")).rejects.toMatchObject({ code: "conflict", message: "Slack setup is in progress" });
    release();
    await expect(first).resolves.toMatchObject({ organization_setup: "app_created" });
  });

  it("replays a begin with the same request id, and replaces the owner's own attempt on a new one", async () => {
    const { workflow, nango } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const first = await workflow.beginInstall(BEGIN_REQUEST, "owner");
    await expect(workflow.beginInstall(BEGIN_REQUEST, "owner")).resolves.toEqual(first);
    expect(nango.createConnectSession).toHaveBeenCalledOnce();
    const second = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(second.attempt_id).not.toBe(first.attempt_id);
    await expect(workflow.installStatus({ attempt_id: first.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
    await expect(workflow.installStatus({ attempt_id: second.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps an install alive across Nango blips while polling", async () => {
    const { workflow, nango, finishConnect } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const begun = await workflow.beginInstall(BEGIN_REQUEST, "owner");
    finishConnect();
    nango.findConnectionIdByTag.mockRejectedValueOnce(new NangoClientErrorV1("unavailable", `down ${NANGO_KEY}`));
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending", failure_reason: null });
    nango.getSlackConnection.mockRejectedValueOnce(new NangoClientErrorV1("unavailable", `down ${NANGO_KEY}`));
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete", result: { kind: "created" } });
  });

  it("begins a tagged connect session with the app's client and the recipe scopes, then completes as created", async () => {
    const { workflow, nango, verifier, finishConnect, database, health, heldAttempts } = setup();
    await expect(workflow.beginInstall(BEGIN_REQUEST, "owner")).rejects.toMatchObject({ code: "conflict", message: "Slack app is not set up" });
    await workflow.setup(SETUP_REQUEST, "owner");
    const begun = await workflow.beginInstall(BEGIN_REQUEST, "owner");
    expect(begun).toEqual({ schema_version: 1, kind: "echo-organization-slack-install-v1", attempt_id: expect.stringMatching(/^ssi_/),
      connect_link: LINK, expires_at: "2026-09-30T00:10:00.000Z" });
    expect(nango.createConnectSession).toHaveBeenCalledWith({
      tags: { echo_organization_id: ORGANIZATION_ID, echo_membership_id: SESSIONS.owner!.membership_id, echo_attempt_id: begun.attempt_id },
      client_id: "1234.5678", client_secret: CLIENT_SECRET, scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 });
    const pending = { schema_version: 1, kind: "echo-organization-slack-install-status-v1", attempt_id: begun.attempt_id,
      status: "pending", failure_reason: null, result: null };
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toEqual(pending);
    expect(verifier.verifyConnection).not.toHaveBeenCalled();
    finishConnect();
    health.markNeedsReinstall("sha256:stale");
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toEqual({ ...pending, status: "complete",
      result: { kind: "created", workspace_id: "T01" } });
    expect(readActiveSlackConnectionV1(database)).toMatchObject({ kind: "nango" });
    expect(workflow.organizationSetup()).toBe("connected");
    expect(health.needsReinstall("sha256:stale")).toBe(false);
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    for (const secret of [CLIENT_SECRET, SIGNING_SECRET]) expect(heldAttempts()).not.toContain(secret);
  });

  it("refuses a connection whose tags name another attempt, organization or owner", async () => {
    const { workflow, nango, connections, finishConnect, database } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const foreign: Record<string, string>[] = [{ echo_organization_id: `org_${uuid(9)}` }, { echo_membership_id: `mem_${uuid(9)}` }, { echo_attempt_id: `ssi_${uuid(9)}` }];
    for (const [index, tags] of foreign.entries()) {
      const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(index + 10)}` }, "owner");
      const connection = finishConnect();
      connections.set(connection.connection_id, { ...connection, tags: { ...connection.tags, ...tags } });
      nango.findConnectionIdByTag.mockResolvedValueOnce(connection.connection_id);
      await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: "workspace_mismatch" });
    }
    expect(readActiveSlackConnectionV1(database)).toBeUndefined();
  });

  it("lets only the beginning owner session read, commit or cancel the attempt", async () => {
    const { workflow, finishConnect, verifier, database } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const begun = await workflow.beginInstall(BEGIN_REQUEST, "owner");
    finishConnect();
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner-2")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(workflow.cancelInstall({ attempt_id: begun.attempt_id }, "owner-2")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner-2")).rejects.toMatchObject({ code: "conflict" });
    expect(verifier.verifyConnection).not.toHaveBeenCalled();
    expect(readActiveSlackConnectionV1(database)).toBeUndefined();
    await expect(workflow.cancelInstall({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("reconnects the connected app on the same Nango connection and keeps the state hash", async () => {
    const { workflow, nango, connections, connect, health, database, secrets } = setup();
    const before = await connect();
    health.markNeedsReinstall(before.state_sha256);
    expect(workflow.organizationSetup()).toBe("needs_reinstall");
    // A stray pending bundle for the same app is dropped in favour of the active one (ruling P5).
    secrets.create(serializeSlackAppCredentialsV1({ kind: "echo-slack-app-credentials-v1", app_id: "A0APP1", client_id: "1234.5678",
      client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET, nango_connection_id: null }));
    // Creating the reconnect session may itself touch the connection; that must not read as finished.
    nango.createReconnectSession.mockImplementationOnce(async () => {
      connections.set("nango-conn-1", { ...connections.get("nango-conn-1")!, updated_at: "2026-09-30T00:00:30.000Z" });
      return { connect_link: LINK, expires_at: "2026-09-30T00:30:00.000Z" };
    });
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(findPendingSlackAppCredentialsV1(secrets)).toBeUndefined();
    expect(nango.createConnectSession).toHaveBeenCalledOnce();
    expect(nango.createReconnectSession).toHaveBeenCalledWith({ connection_id: "nango-conn-1",
      tags: { echo_organization_id: ORGANIZATION_ID, echo_membership_id: SESSIONS.owner!.membership_id, echo_attempt_id: begun.attempt_id },
      client_id: "1234.5678", client_secret: CLIENT_SECRET, scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    connections.set("nango-conn-1", { ...connections.get("nango-conn-1")!, updated_at: "2026-09-30T00:01:00.000Z" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete",
      result: { kind: "reconnected", workspace_id: "T01" } });
    expect(readActiveSlackConnectionV1(database)?.state_sha256).toBe(before.state_sha256);
    expect(workflow.organizationSetup()).toBe("connected");
  });

  it("refuses a reconnect that lands in a different team, writing nothing and leaving the waiting card alone", async () => {
    const { workflow, connections, connect, database } = setup();
    const before = await connect();
    seedWaitingCard(database);
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    // The owner's browser ends up authorizing a different workspace while nominally reconnecting the same app.
    connections.set("nango-conn-1", { ...connections.get("nango-conn-1")!, team_id: "T02", updated_at: "2026-09-30T00:01:00.000Z" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: "already_connected" });
    expect(readActiveSlackConnectionV1(database)?.state_sha256).toBe(before.state_sha256);
  });

  it("maps Nango and Slack failures during status to fixed reasons", async () => {
    const { workflow, nango, verifier, finishConnect } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const cases = [
      [() => nango.findConnectionIdByTag.mockRejectedValueOnce(new NangoClientErrorV1("unauthorized", `bad ${NANGO_KEY}`)), "provider_rejected"],
      [() => verifier.verifyConnection.mockRejectedValueOnce(new SlackIdentityProviderErrorV1(`no users:read for ${BOT_TOKEN}`, "unauthorized")), "provider_rejected"],
      [() => verifier.verifyConnection.mockRejectedValueOnce(new Error(`auth.test failed for ${BOT_TOKEN}`)), "provider_unavailable"],
      [() => nango.getSlackConnection.mockRejectedValueOnce(new NangoClientErrorV1("invalid_response", "bad connection")), "provider_unavailable"],
    ] as const;
    for (const [index, [arrange, reason]] of cases.entries()) {
      const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(index + 30)}` }, "owner");
      finishConnect();
      arrange();
      await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: reason });
    }
  });

  it("expires an attempt after ten minutes and treats an unknown attempt as expired", async () => {
    const { workflow, context } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const begun = await workflow.beginInstall(BEGIN_REQUEST, "owner");
    context.clock = "2026-09-30T00:10:00.000Z";
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "expired", failure_reason: null });
    await expect(workflow.installStatus({ attempt_id: `ssi_${uuid(77)}` }, "owner")).resolves.toMatchObject({ status: "expired" });
  });
});

describe("Slack runtime bundle with organization setup", () => {
  function open(options: { readonly setup?: boolean; readonly connection_health?: SlackConnectionHealthV1; readonly setup_health?: SlackConnectionHealthV1 } = {}) {
    const { directory, database } = controlDatabase();
    database.close();
    const f = fakes();
    const context = { outputs: [] as unknown[] };
    contexts.push(context);
    // The DM link reaches Slack only through these fakes, with the token the bundle's source fetched from Nango.
    const provider = {
      verifyConnection: f.verifier.verifyConnection,
      verifyChannel: vi.fn(async () => { throw new Error("a Nango connection has no channel"); }),
      verifyHuman: vi.fn(),
      openIdentityLinkDirectMessage: vi.fn(async (_token: string, user: string, team: string) => ({ team_id: team, channel_id: "D0EMPLOYEE", recipient_user_id: user })),
      postIdentityLinkChallenge: vi.fn(async (_token: string, input: { channel_id: string }) => ({ team_id: "T01", channel_id: input.channel_id, challenge_message_ts: "100.000001" })),
      observeIdentityLinkChallenge: vi.fn(),
    };
    const opened = createSlackPersonExternalIdentityRuntimeBundleV1({
      identity_link_channel_id: "C123",
      provider,
      bot_token_source: createSlackBotTokenSourceV1({ secrets: new FileOrganizationSecretStore(join(directory, "secrets")), nango: f.nango }),
      ...(options.connection_health === undefined ? {} : { connection_health: options.connection_health }),
      ...(options.setup === false ? {} : { organization_setup: { authority_url: AUTHORITY_URL, nango: { client: f.nango, callback_url: NANGO_CALLBACK },
        manifest_provider: f.manifest, verifier: f.verifier, ...(options.setup_health === undefined ? {} : { health: options.setup_health }) } }),
    }).open({ state_directory: directory, authority_id: AUTHORITY_ID, organization_id: ORGANIZATION_ID, state_lineage_id: STATE_LINEAGE_ID,
      authentication, membership_type: ({ membership_id }) => (membership_id === SESSIONS.owner!.membership_id ? "owner" : "employee") });
    /** Records results and thrown errors for the afterEach secret scan. */
    const record = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        const value = await run();
        context.outputs.push(value);
        return value;
      } catch (error) {
        context.outputs.push({ text: String(error), ...(error as object) });
        throw error;
      }
    };
    const call = (path: string, token: string, body?: unknown) => record(async () => {
      const route = opened.application.routes.find((candidate) => candidate.path === path)!;
      return opened.application.accept({ route_id: route.route_id, method: route.method, path,
        raw_body: Buffer.from(body === undefined ? "" : JSON.stringify(body)), content_type: "application/json",
        headers: { authorization: `Bearer ${token}` } });
    });
    const tools = (token: string) => record(() => opened.tools(token));
    return { opened, call, tools, f, directory, provider };
  }

  /** The owner's whole setup over the provider routes, ending with an active Nango connection. */
  async function installOverRoutes(context: ReturnType<typeof open>): Promise<void> {
    await context.call(ORGANIZATION_API_SLACK_SETUP_PATH_V1, "owner", SETUP_REQUEST);
    const begun = await context.call(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, "owner", BEGIN_REQUEST) as { body: { attempt_id: string } };
    finishConnectFor(context.f);
    await expect(context.call(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, "owner", { attempt_id: begun.body.attempt_id }))
      .resolves.toMatchObject({ body: { status: "complete" } });
  }

  function activeStateSha256(directory: string): `sha256:${string}` {
    const database = openOrganizationControlDatabase(join(directory, "integrations.sqlite"), { fileMustExist: true });
    try { return readActiveSlackConnectionV1(database)!.state_sha256; } finally { database.close(); }
  }

  it("mounts the setup routes only when setup options are provided", () => {
    const without = open({ setup: false });
    expect(without.opened.application.routes.some((route) => route.path.startsWith("/v2/organization/tools/slack/"))).toBe(false);
    without.opened.close();
    const mounted = open();
    expect(mounted.opened.application.routes.filter((route) => route.path.startsWith("/v2/organization/tools/slack/"))).toHaveLength(4);
    mounted.opened.close();
  });

  it("serves setup over the provider routes, reports the owner's status, and writes no setup token to disk", async () => {
    const { opened, call, tools, directory } = open();
    try {
      await expect(tools("owner")).resolves.toEqual([{ tool_id: "slack", display_name: "Slack", availability: "unavailable",
        personal_status: "unavailable", external_scope_id: null, external_subject_id: null, organization_setup: "not_set_up" }]);
      await expect(call(ORGANIZATION_API_SLACK_SETUP_PATH_V1, "owner", SETUP_REQUEST)).resolves.toMatchObject({ status: 201, body: { organization_setup: "app_created" } });
      await expect(tools("owner")).resolves.toMatchObject([{ organization_setup: "app_created" }]);
      await expect(tools("employee")).resolves.toMatchObject([{ organization_setup: null }]);
      await expect(call(ORGANIZATION_API_SLACK_SETUP_PATH_V1, "owner", { ...SETUP_REQUEST, configuration_token: `${CONFIG_TOKEN} x` })).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      opened.close();
    }
    const secretFiles = readdirSync(join(directory, "secrets")).map((name) => join(directory, "secrets", name));
    const databaseFiles = readdirSync(directory).filter((name) => name.startsWith("integrations.sqlite")).map((name) => join(directory, name));
    expect(secretFiles).toHaveLength(1);
    for (const file of [...secretFiles, ...databaseFiles]) expect(readFileSync(file).toString("latin1")).not.toContain(CONFIG_TOKEN);
    for (const file of databaseFiles) {
      for (const secret of [CLIENT_SECRET, SIGNING_SECRET]) expect(readFileSync(file).toString("latin1")).not.toContain(secret);
    }
  });

  it("lists a connected Nango Slack to everyone, with the owner's connected and needs_reinstall status", async () => {
    const health = new SlackConnectionHealthV1();
    const context = open({ connection_health: health });
    try {
      await installOverRoutes(context);
      const enabled = { tool_id: "slack", display_name: "Slack", availability: "enabled", personal_status: "unlinked",
        external_scope_id: "T01", external_subject_id: null };
      await expect(context.tools("owner")).resolves.toEqual([{ ...enabled, organization_setup: "connected" }]);
      await expect(context.tools("employee")).resolves.toEqual([{ ...enabled, organization_setup: null }]);
      health.markNeedsReinstall(activeStateSha256(context.directory));
      await expect(context.tools("owner")).resolves.toEqual([{ ...enabled, organization_setup: "needs_reinstall" }]);
      await expect(context.tools("employee")).resolves.toEqual([{ ...enabled, organization_setup: null }]);
    } finally {
      context.opened.close();
    }
  });

  it("runs the DM link and the browser link on the Nango connection the owner installed", async () => {
    const context = open();
    try {
      await installOverRoutes(context);
      await expect(context.call(ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, "employee", {
        request_id: `psb_${uuid(1)}`, recipient_user_id: "U0EMPLOYEE",
        challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(Buffer.alloc(32).toString("base64url")),
      })).resolves.toMatchObject({ status: 201, body: { channel_id: "D0EMPLOYEE", provider_tenant_id: "T01" } });
      expect(context.provider.verifyChannel).not.toHaveBeenCalled();
      expect(context.provider.postIdentityLinkChallenge).toHaveBeenCalledWith(`${BOT_TOKEN}-nango-conn-1`, expect.anything(), undefined);
      // The browser link is mounted by setup alone and uses the installed app's own client.
      const browser = await context.call(ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, "owner", { request_id: `psb_${uuid(2)}` }) as { body: { authorization_url: string } };
      const authorization = new URL(browser.body.authorization_url);
      expect(authorization.searchParams.get("client_id")).toBe("1234.5678");
      expect(authorization.searchParams.get("redirect_uri")).toBe(`${AUTHORITY_URL}/v2/person/external-identities/slack/browser/callback`);
      expect(authorization.searchParams.get("team")).toBe("T01");
    } finally {
      context.opened.close();
    }
  });

  it("uses the bundle's one connection health for setup and refuses two different ones", async () => {
    expect(() => open({ connection_health: new SlackConnectionHealthV1(), setup_health: new SlackConnectionHealthV1() })).toThrow(/single instance/);
    const health = new SlackConnectionHealthV1();
    health.markNeedsReinstall("sha256:stale");
    const { opened, call, f } = open({ connection_health: health });
    try {
      await call(ORGANIZATION_API_SLACK_SETUP_PATH_V1, "owner", SETUP_REQUEST);
      const begun = await call(ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, "owner", BEGIN_REQUEST);
      expect(begun.status).toBe(201);
      const attempt = { attempt_id: (begun as { body: { attempt_id: string } }).body.attempt_id };
      finishConnectFor(f);
      await expect(call(ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, "owner", attempt)).resolves.toMatchObject({ status: 200, body: { status: "complete" } });
      expect(health.needsReinstall("sha256:stale")).toBe(false);
      await expect(call(ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, "owner", attempt)).resolves.toMatchObject({ status: 200, body: { status: "complete" } });
    } finally {
      opened.close();
    }
  });
});
