import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { applyOrganizationControlBaselineV3, openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { ORGANIZATION_API_SLACK_INSTALL_BEGIN_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_CANCEL_PATH_V1, ORGANIZATION_API_SLACK_INSTALL_STATUS_PATH_V1, ORGANIZATION_API_SLACK_SETUP_PATH_V1, type OrganizationSlackInstallFailureReasonV1 } from "@echo-brain/provider-slack-client/organization-api/organization-slack-setup-v1";
import { ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH, organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import { ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH } from "@echo-brain/provider-slack-client/organization-api/person-slack-browser-link";
import { NangoClientErrorV1, type NangoConnectionClientV1, type NangoSlackConnectionV1 } from "../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { buildEchoSlackAppManifestV1, SlackAppManifestProviderErrorV1 } from "../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { SlackIdentityProviderErrorV1 } from "../../src/organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { findPendingSlackAppCredentialsV1, findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { createSlackBotTokenSourceV1 } from "../../src/organization-control-plane/application/slack-bot-token-source-v1.js";
import { SlackConnectionHealthV1 } from "../../src/organization-control-plane/application/slack-connection-health-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import { slackConnectionVerificationEvidenceSha256V1 } from "../../src/organization-control-plane/application/slack-connection-verification-evidence-v1.js";
import { readActiveSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { SlackOrganizationSetupWorkflowV1 } from "../../src/organization-setup/slack-organization-setup-workflow-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "../../src/person-identity/slack-person-external-identity-runtime-bundle-v1.js";

/** The six scopes the retired public-channel option granted; a legacy token may still hold them. */
const LEGACY_SIX_SCOPES = Object.freeze(["channels:history", "channels:read", ...SLACK_PRIVATE_APP_BOT_SCOPES_V1]);

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
  const session = async (_input: { readonly tags: Readonly<Record<string, string>> }) => ({ connect_link: LINK });
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
  } satisfies NangoConnectionClientV1;
  // Like Slack's auth.test and bots.info, the evidence covers the identity and scopes, not the Nango connection.
  const verifier = {
    verifyConnection: vi.fn(async (token: string) => {
      const found = [...connections.values()].find((connection) => connection.bot_token === token)!;
      const identity = { team_id: found.team_id, enterprise_id: null, bot_user_id: found.bot_user_id, bot_id: "B01", app_id: found.app_id,
        granted_scopes: found.granted_scopes };
      return { ...identity, verification_evidence_sha256: slackConnectionVerificationEvidenceSha256V1(identity) };
    }),
  };
  return { connections, manifest, nango, verifier };
}

/** The owner finishing the Nango Connect flow for the last session ECHO created. */
function finishConnectFor(f: ReturnType<typeof fakes>, overrides: Partial<NangoSlackConnectionV1> = {}): NangoSlackConnectionV1 {
  const tags = f.nango.createConnectSession.mock.lastCall![0]!.tags;
  const id = `nango-conn-${String(f.connections.size + 1)}`;
  const connection: NangoSlackConnectionV1 = {
    connection_id: id, tags, team_id: "T01", app_id: "A0APP1",
    bot_user_id: "UBOT", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: `${BOT_TOKEN}-${id}`, ...overrides,
  };
  f.connections.set(connection.connection_id, connection);
  return connection;
}

/** The owner completed the last reconnect session on its original connection. */
function finishReconnectFor(f: ReturnType<typeof fakes>, overrides: Partial<NangoSlackConnectionV1> = {}): NangoSlackConnectionV1 {
  const reconnect = f.nango.createReconnectSession.mock.lastCall![0]!;
  const existing = f.connections.get("nango-conn-1")!;
  const connection: NangoSlackConnectionV1 = { ...existing, tags: reconnect.tags, ...overrides };
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
  const workflowOptions = {
    database, secrets, authority_id: AUTHORITY_ID, organization_id: ORGANIZATION_ID, state_lineage_id: STATE_LINEAGE_ID,
    authentication, authority_url: AUTHORITY_URL, nango: { client: f.nango, callback_url: NANGO_CALLBACK },
    manifest_provider: f.manifest, verifier: f.verifier, health,
    now: () => context.clock, new_connection_id: () => `con_${uuid(++connectionNumber)}`,
  };
  const restart = () => recorded(new SlackOrganizationSetupWorkflowV1(workflowOptions), context.outputs);
  const workflow = restart();
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
  return { ...f, database, secrets, health, context, workflow, finishConnect, connect, heldAttempts, restart };
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
const EXISTING_APP = { app_id: "A0C6AEG49TQ", client_id: "9999.8888", client_secret: `${CLIENT_SECRET}-existing`, signing_secret: `${SIGNING_SECRET}-existing` };
const ADOPT_REQUEST = { ...SETUP_REQUEST, existing_app: EXISTING_APP };

describe("Slack organization setup workflow v1", () => {
  it("adopts an existing app under the single pending handle and retires its old install attempt", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const pending = findPendingSlackAppCredentialsV1(f.secrets)!;
    const oldAttempt = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect();

    await expect(f.workflow.setup(ADOPT_REQUEST, "owner")).resolves.toMatchObject({ app_id: EXISTING_APP.app_id, organization_setup: "app_created" });
    expect(f.manifest.createApp).toHaveBeenCalledOnce();
    expect(f.manifest.updateApp).toHaveBeenCalledWith(expect.objectContaining({ configuration_token: CONFIG_TOKEN, app_id: EXISTING_APP.app_id }));
    expect(f.secrets.listReferences()).toEqual([pending.reference]);
    expect(findPendingSlackAppCredentialsV1(f.secrets)).toEqual({ reference: pending.reference,
      credentials: { kind: "echo-slack-app-credentials-v1", ...EXISTING_APP, nango_connection_id: null } });
    await expect(f.workflow.installStatus({ attempt_id: oldAttempt.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
    expect(readActiveSlackConnectionV1(f.database)).toBeUndefined();
    expect(f.verifier.verifyConnection).not.toHaveBeenCalled();

    // Restart proves the next install reads the adopted app's durable credentials.
    const restarted = f.restart();
    const next = await restarted.beginInstall({ request_id: `osi_${uuid(2)}` }, "owner");
    expect(f.nango.createConnectSession).toHaveBeenLastCalledWith(expect.objectContaining({ client_id: EXISTING_APP.client_id, client_secret: EXISTING_APP.client_secret }));
    f.finishConnect({ app_id: EXISTING_APP.app_id });
    await expect(restarted.installStatus({ attempt_id: next.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    expect(readActiveSlackConnectionV1(f.database)?.connection.provider_app_id).toBe(EXISTING_APP.app_id);
  });

  it("adopts an existing app without creating a Slack app and refuses non-owners", async () => {
    const f = setup();
    await expect(f.workflow.setup(ADOPT_REQUEST, "employee")).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.manifest.updateApp).not.toHaveBeenCalled();
    expect(f.secrets.listReferences()).toHaveLength(0);
    await f.workflow.setup(ADOPT_REQUEST, "owner");
    expect(f.manifest.createApp).not.toHaveBeenCalled();
    expect(f.secrets.listReferences()).toHaveLength(1);
    expect(findPendingSlackAppCredentialsV1(f.secrets)?.credentials).toMatchObject({ ...EXISTING_APP, nango_connection_id: null });
  });

  it("refuses adoption before touching Slack when any connection is active, even if its credentials are unavailable", async () => {
    const f = setup();
    const active = await f.connect();
    const read = vi.spyOn(f.secrets, "read").mockImplementation(() => { throw new Error("unavailable fixture store"); });
    try {
      for (const app_id of ["A0APP1", EXISTING_APP.app_id]) {
        await expect(f.workflow.setup({ ...ADOPT_REQUEST, existing_app: { ...EXISTING_APP, app_id } }, "owner")).rejects.toMatchObject({ code: "conflict" });
      }
      expect(f.manifest.updateApp).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(readActiveSlackConnectionV1(f.database)).toEqual(active);
    } finally { read.mockRestore(); }
  });

  it.each(["provider", "store"] as const)("keeps the pending app and install usable after an adoption %s failure", async (failure) => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const pending = findPendingSlackAppCredentialsV1(f.secrets)!;
    const begun = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    if (failure === "provider") f.manifest.updateApp.mockRejectedValueOnce(new Error(`failed ${CONFIG_TOKEN}`));
    else vi.spyOn(f.secrets, "replace").mockImplementationOnce(() => { throw new Error("fixture write failed"); });
    await expect(f.workflow.setup(ADOPT_REQUEST, "owner")).rejects.toMatchObject({ code: "unavailable" });
    expect(findPendingSlackAppCredentialsV1(f.secrets)).toEqual(pending);
    expect(f.secrets.listReferences()).toEqual([pending.reference]);
    f.finishConnect();
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    expect(readActiveSlackConnectionV1(f.database)?.connection.provider_app_id).toBe("A0APP1");
  });

  it("retires the old attempt if the store reports failure after replacing the pending bundle", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const reference = findPendingSlackAppCredentialsV1(f.secrets)!.reference;
    const begun = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    const replace = f.secrets.replace.bind(f.secrets);
    vi.spyOn(f.secrets, "replace").mockImplementationOnce((handle, secret) => {
      replace(handle, secret);
      throw new Error("fixture directory sync failed");
    });
    await expect(f.workflow.setup(ADOPT_REQUEST, "owner")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.secrets.listReferences()).toEqual([reference]);
    expect(findPendingSlackAppCredentialsV1(f.secrets)?.credentials.app_id).toBe(EXISTING_APP.app_id);
    f.finishConnect();
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
    expect(readActiveSlackConnectionV1(f.database)).toBeUndefined();
  });

  it("blocks install work while adoption updates the manifest, then cancels the previous attempt", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const begun = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect();
    let release!: () => void;
    f.manifest.updateApp.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
    const adopting = f.workflow.setup(ADOPT_REQUEST, "owner");
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    await expect(f.workflow.beginInstall({ request_id: `osi_${uuid(2)}` }, "owner")).rejects.toMatchObject({ code: "conflict" });
    expect(f.verifier.verifyConnection).not.toHaveBeenCalled();
    release();
    await adopting;
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("refuses adoption while a status check is activating the current pending app", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const begun = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect();
    let release!: () => void;
    const verify = f.verifier.verifyConnection.getMockImplementation()!;
    f.verifier.verifyConnection.mockImplementationOnce(async (token) => {
      await new Promise<void>(resolve => { release = resolve; });
      return verify(token);
    });
    const checking = f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner");
    await vi.waitFor(() => expect(f.verifier.verifyConnection).toHaveBeenCalledOnce());
    await expect(f.workflow.setup(ADOPT_REQUEST, "owner")).rejects.toMatchObject({ code: "conflict" });
    expect(f.manifest.updateApp).not.toHaveBeenCalled();
    release();
    await expect(checking).resolves.toMatchObject({ status: "complete" });
  });

  it("fences an old credential snapshot replaced by another workflow during Slack verification", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const begun = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect();
    const verify = f.verifier.verifyConnection.getMockImplementation()!;
    f.verifier.verifyConnection.mockImplementationOnce(async (token) => {
      const verified = await verify(token);
      await f.restart().setup(ADOPT_REQUEST, "owner");
      return verified;
    });
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "cancelled" });
    expect(readActiveSlackConnectionV1(f.database)).toBeUndefined();
    expect(findPendingSlackAppCredentialsV1(f.secrets)?.credentials.app_id).toBe(EXISTING_APP.app_id);
  });

  it("rechecks the owner's authority after the manifest update before replacing the pending app", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const pending = findPendingSlackAppCredentialsV1(f.secrets)!;
    SESSIONS.demoted = person("owner", 5);
    try {
      f.manifest.updateApp.mockImplementationOnce(async () => { SESSIONS.demoted = person("employee", 5); });
      await expect(f.workflow.setup(ADOPT_REQUEST, "demoted")).rejects.toMatchObject({ code: "unauthorized" });
      expect(findPendingSlackAppCredentialsV1(f.secrets)).toEqual(pending);
    } finally { delete SESSIONS.demoted; }
  });

  it("preserves a connection activated by another workflow while the manifest update was in flight", async () => {
    const f = setup();
    await f.workflow.setup(SETUP_REQUEST, "owner");
    const installer = f.restart();
    const begun = await installer.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect();
    f.manifest.updateApp.mockImplementationOnce(async () => {
      await expect(installer.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    });
    await expect(f.workflow.setup(ADOPT_REQUEST, "owner")).rejects.toMatchObject({ code: "conflict" });
    const active = readActiveSlackConnectionV1(f.database)!;
    expect(active.connection.provider_app_id).toBe("A0APP1");
    expect(findPendingSlackAppCredentialsV1(f.secrets)).toBeUndefined();
    expect(findSlackAppCredentialsByReferenceSha256V1(f.secrets, active.state.credential_reference_sha256).credentials.app_id).toBe("A0APP1");
  });

  it("pushes the four-scope delivery manifest to the connected app through ordinary setup, leaving cards and links alone", async () => {
    const f = setup();
    const before = await f.connect();
    seedWaitingCard(f.database);
    const rerun = f.restart();
    await rerun.setup({ ...SETUP_REQUEST, request_id: `oss_${uuid(2)}` }, "owner");
    expect(f.manifest.createApp).toHaveBeenCalledOnce();
    expect(f.manifest.updateApp).toHaveBeenLastCalledWith(expect.objectContaining({ app_id: before.connection.provider_app_id,
      manifest: expect.objectContaining({ oauth_config: expect.objectContaining({ scopes: { bot: SLACK_PRIVATE_APP_BOT_SCOPES_V1, user: ["openid", "profile"] } }) }) }));
    expect(readActiveSlackConnectionV1(f.database)).toEqual(before);
    expect(f.database.prepare("SELECT current_status FROM organization_external_human_link_current WHERE external_identity_link_id = 'clm_owner'").get())
      .toEqual({ current_status: "active" });
  });

  it("does not finish a reconnect with stale, foreign or missing attempt tags", async () => {
    const f = setup();
    await f.connect();
    const verifierCalls = f.verifier.verifyConnection.mock.calls.length;
    const begun = await f.workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    const completedTags = f.nango.createReconnectSession.mock.lastCall![0]!.tags;
    const { echo_attempt_id: _attempt, ...withoutAttempt } = completedTags;
    const staleTags = f.connections.get("nango-conn-1")!.tags;
    const cases = [
      staleTags,
      { ...completedTags, echo_attempt_id: `ssi_${uuid(9)}` },
      withoutAttempt,
    ];

    for (const tags of cases) {
      f.connections.set("nango-conn-1", { ...f.connections.get("nango-conn-1")!, tags });
      await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner"))
        .resolves.toMatchObject({ status: "pending", result: null });
    }
    expect(f.verifier.verifyConnection).toHaveBeenCalledTimes(verifierCalls);
  });

  it("rejects current-attempt reconnect tags that name another owner or organization without touching cards or links", async () => {
    const foreignTags: Readonly<Record<string, string>>[] = [
      { echo_membership_id: `mem_${uuid(9)}` },
      { echo_organization_id: `org_${uuid(9)}` },
    ];
    for (const wrongTag of foreignTags) {
      const f = setup();
      const before = await f.connect();
      seedWaitingCard(f.database);
      const snapshot = () => [
        f.database.prepare("SELECT * FROM organization_private_approval_pending_contracts_v2").all(),
        f.database.prepare("SELECT * FROM organization_external_human_link_current").all(),
      ];
      const frozen = snapshot();
      const begun = await f.workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
      const reconnect = f.nango.createReconnectSession.mock.lastCall![0]!;
      f.connections.set("nango-conn-1", { ...f.connections.get("nango-conn-1")!, tags: { ...reconnect.tags, ...wrongTag } });

      await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner"))
        .resolves.toMatchObject({ status: "failed", failure_reason: "attempt_mismatch" });
      expect(readActiveSlackConnectionV1(f.database)).toEqual(before);
      expect(snapshot()).toEqual(frozen);
    }
  });

  it("preserves a six-scope token, approval cards and identity links when reconnecting under the baseline profile", async () => {
    const f = setup();
    const before = await f.connect();
    seedWaitingCard(f.database);
    const snapshot = () => [
      f.database.prepare("SELECT * FROM organization_private_approval_pending_contracts_v2").all(),
      f.database.prepare("SELECT * FROM organization_external_human_link_current").all(),
    ];
    const frozen = snapshot();
    f.connections.set("nango-conn-1", { ...f.connections.get("nango-conn-1")!, granted_scopes: LEGACY_SIX_SCOPES });
    const baseline = f.restart();
    const begun = await baseline.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(f.nango.createReconnectSession).toHaveBeenLastCalledWith(expect.objectContaining({ scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 }));
    finishReconnectFor(f);
    expect(await baseline.installStatus({ attempt_id: begun.attempt_id }, "owner")).toMatchObject({ status: "complete", result: { kind: "reconnected" } });
    expect(readActiveSlackConnectionV1(f.database)).toEqual(before);
    expect(snapshot()).toEqual(frozen);
  });

  it("refuses employees on every route", async () => {
    const { workflow, manifest, nango } = setup();
    const attempt = { attempt_id: `ssi_${uuid(1)}` };
    for (const call of [
      () => workflow.setup(SETUP_REQUEST, "employee"), () => workflow.beginInstall(BEGIN_REQUEST, "employee"),
      () => workflow.installStatus(attempt, "employee"), () => workflow.cancelInstall(attempt, "employee"),
    ]) await expect(call()).rejects.toMatchObject({ code: "unauthorized", message: "Only an organization owner can set up Slack." });
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

  it("updates the connected app to the current recipe, sign-in scopes included, on a new token", async () => {
    const { workflow, manifest, secrets, connect } = setup();
    await connect();
    const references = secrets.listReferences().length;
    await expect(workflow.setup({ ...SETUP_REQUEST, request_id: `oss_${uuid(2)}` }, "owner")).resolves.toEqual({
      schema_version: 1, kind: "echo-organization-slack-setup-v1", app_id: "A0APP1", organization_setup: "connected" });
    // How an app created before the recipe declared the sign-in scopes gets them.
    const recipe = buildEchoSlackAppManifestV1({ authority_url: AUTHORITY_URL, nango_callback_url: NANGO_CALLBACK });
    expect((recipe.oauth_config as { scopes: { user: unknown } }).scopes.user).toEqual(["openid", "profile"]);
    expect(manifest.updateApp).toHaveBeenLastCalledWith(expect.objectContaining({ app_id: "A0APP1", manifest: recipe }));
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
    expect(readActiveSlackConnectionV1(database)).toMatchObject({ connection: { provider_app_id: "A0APP1" } });
    expect(workflow.organizationSetup()).toBe("connected");
    expect(health.needsReinstall("sha256:stale")).toBe(false);
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete" });
    for (const secret of [CLIENT_SECRET, SIGNING_SECRET]) expect(heldAttempts()).not.toContain(secret);
  });

  it("reports an attempt mismatch when a connection's tags name another attempt, organization or owner", async () => {
    const { workflow, nango, connections, finishConnect, database } = setup();
    await workflow.setup(SETUP_REQUEST, "owner");
    const foreign: Record<string, string>[] = [{ echo_organization_id: `org_${uuid(9)}` }, { echo_membership_id: `mem_${uuid(9)}` }, { echo_attempt_id: `ssi_${uuid(9)}` }];
    for (const [index, tags] of foreign.entries()) {
      const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(index + 10)}` }, "owner");
      const connection = finishConnect();
      connections.set(connection.connection_id, { ...connection, tags: { ...connection.tags, ...tags } });
      nango.findConnectionIdByTag.mockResolvedValueOnce(connection.connection_id);
      await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: "attempt_mismatch" });
    }
    expect(readActiveSlackConnectionV1(database)).toBeUndefined();
  });

  it("retries an adopted app with its saved credentials after an app mismatch", async () => {
    const f = setup();
    await f.workflow.setup(ADOPT_REQUEST, "owner");
    const first = await f.workflow.beginInstall(BEGIN_REQUEST, "owner");
    f.finishConnect({ app_id: "A0OTHER" });
    await expect(f.workflow.installStatus({ attempt_id: first.attempt_id }, "owner"))
      .resolves.toMatchObject({ status: "failed", failure_reason: "app_mismatch" });

    const retry = await f.workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(retry.attempt_id).not.toBe(first.attempt_id);
    expect(f.nango.createConnectSession).toHaveBeenLastCalledWith(expect.objectContaining({
      client_id: EXISTING_APP.client_id,
      client_secret: EXISTING_APP.client_secret,
      scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
    }));
    expect(f.manifest.createApp).not.toHaveBeenCalled();
    expect(f.manifest.updateApp).toHaveBeenCalledTimes(1);
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

  it("re-checks ownership after Slack's check: an owner demoted mid-status activates nothing", async () => {
    const { workflow, verifier, finishConnect, database } = setup();
    SESSIONS.demoted = person("owner", 5);
    try {
      await workflow.setup(SETUP_REQUEST, "demoted");
      const begun = await workflow.beginInstall(BEGIN_REQUEST, "demoted");
      finishConnect();
      const verify = verifier.verifyConnection.getMockImplementation()!;
      verifier.verifyConnection.mockImplementationOnce(async (token: string) => {
        SESSIONS.demoted = person("employee", 5);
        return verify(token);
      });
      await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "demoted")).rejects.toMatchObject({ code: "unauthorized" });
      expect(verifier.verifyConnection).toHaveBeenCalledOnce();
      expect(readActiveSlackConnectionV1(database)).toBeUndefined();
      // The attempt ended, so another owner may begin at once.
      await expect(workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner")).resolves.toMatchObject({ attempt_id: expect.stringMatching(/^ssi_/) });
    } finally {
      delete SESSIONS.demoted;
    }
  });

  it("reconnects the connected app on the same Nango connection and keeps the state hash", async () => {
    const f = setup();
    const { workflow, nango, health, database, secrets } = f;
    const before = await f.connect();
    health.markNeedsReinstall(before.state_sha256);
    expect(workflow.organizationSetup()).toBe("needs_reinstall");
    // A stray pending bundle for the same app is dropped in favour of the active one.
    secrets.create(serializeSlackAppCredentialsV1({ kind: "echo-slack-app-credentials-v1", app_id: "A0APP1", client_id: "1234.5678",
      client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET, nango_connection_id: null }));
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(findPendingSlackAppCredentialsV1(secrets)).toBeUndefined();
    expect(nango.createConnectSession).toHaveBeenCalledOnce();
    expect(nango.createReconnectSession).toHaveBeenCalledWith({ connection_id: "nango-conn-1",
      tags: { echo_organization_id: ORGANIZATION_ID, echo_membership_id: SESSIONS.owner!.membership_id, echo_attempt_id: begun.attempt_id },
      client_id: "1234.5678", client_secret: CLIENT_SECRET, scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    finishReconnectFor(f);
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete",
      result: { kind: "reconnected", workspace_id: "T01" } });
    expect(readActiveSlackConnectionV1(database)?.state_sha256).toBe(before.state_sha256);
    expect(workflow.organizationSetup()).toBe("connected");
  });

  it.each(["reconnect", "rebind"] as const)("keeps the active app authoritative during %s with an unrelated pending app", async (mode) => {
    const f = setup();
    const before = await f.connect();
    seedWaitingCard(f.database);
    const frozen = () => [
      readActiveSlackConnectionV1(f.database),
      f.database.prepare("SELECT * FROM organization_private_approval_pending_contracts_v2").all(),
      f.database.prepare("SELECT * FROM organization_external_human_link_current").all(),
    ];
    const snapshot = frozen();
    const bundle = findSlackAppCredentialsByReferenceSha256V1(f.secrets, before.state.credential_reference_sha256);
    const orphan = serializeSlackAppCredentialsV1({ kind: "echo-slack-app-credentials-v1", ...EXISTING_APP, nango_connection_id: null });
    const orphanReference = f.secrets.create(orphan);
    if (mode === "rebind") f.connections.delete("nango-conn-1");

    await expect(f.workflow.setup(SETUP_REQUEST, "owner")).resolves.toMatchObject({ app_id: "A0APP1", organization_setup: "connected" });
    expect(f.manifest.updateApp).toHaveBeenLastCalledWith(expect.objectContaining({ app_id: "A0APP1" }));
    const begun = await f.workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    const session = mode === "reconnect" ? f.nango.createReconnectSession : f.nango.createConnectSession;
    expect(session).toHaveBeenLastCalledWith(expect.objectContaining({ client_id: "1234.5678", client_secret: CLIENT_SECRET }));
    if (mode === "reconnect") {
      expect(f.nango.createConnectSession).toHaveBeenCalledOnce();
      finishReconnectFor(f);
    } else {
      expect(f.nango.createReconnectSession).not.toHaveBeenCalled();
      f.finishConnect({ connection_id: "nango-conn-2" });
    }
    await expect(f.workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete", result: { kind: "reconnected" } });
    expect(frozen()).toEqual(snapshot);
    expect(findSlackAppCredentialsByReferenceSha256V1(f.secrets, before.state.credential_reference_sha256)).toEqual({
      ...bundle, credentials: { ...bundle.credentials, nango_connection_id: mode === "reconnect" ? "nango-conn-1" : "nango-conn-2" },
    });
    expect(f.secrets.read(orphanReference)).toBe(orphan);
    expect(f.manifest.createApp).toHaveBeenCalledOnce();
  });

  it("refuses a reconnect that lands in a different team, then reconnects to the original one with the same state hash", async () => {
    const f = setup();
    const { workflow, database } = f;
    const before = await f.connect();
    seedWaitingCard(database);
    const snapshot = () => [
      database.prepare("SELECT * FROM organization_private_approval_pending_contracts_v2").all(),
      database.prepare("SELECT * FROM organization_external_human_link_current").all(),
    ];
    const frozen = snapshot();
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    // The owner's browser ends up authorizing a different workspace while nominally reconnecting the same app.
    finishReconnectFor(f, { team_id: "T02" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: "workspace_mismatch" });
    expect(readActiveSlackConnectionV1(database)?.state_sha256).toBe(before.state_sha256);
    expect(snapshot()).toEqual(frozen);
    // Nango's connection now holds the other workspace, so the owner sees it at once.
    expect(workflow.organizationSetup()).toBe("needs_reinstall");

    const again = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(3)}` }, "owner");
    finishReconnectFor(f, { team_id: "T01" });
    await expect(workflow.installStatus({ attempt_id: again.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete",
      result: { kind: "reconnected", workspace_id: "T01" } });
    expect(readActiveSlackConnectionV1(database)?.state_sha256).toBe(before.state_sha256);
    expect(workflow.organizationSetup()).toBe("connected");
  });

  it("marks needs reinstall when Nango loses a reconnecting connection before status", async () => {
    const { workflow, connections, connect, nango, health } = setup();
    const before = await connect();
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    // It existed at begin, so this was a reconnect, but disappears before the
    // first status read can observe the completed session.
    connections.delete("nango-conn-1");

    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({
      status: "failed", failure_reason: "provider_unavailable",
    });
    expect(health.needsReinstall(before.state_sha256)).toBe(true);
    expect(workflow.organizationSetup()).toBe("needs_reinstall");

    await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(3)}` }, "owner");
    expect(nango.createReconnectSession).toHaveBeenCalledOnce();
    expect(nango.createConnectSession).toHaveBeenCalledTimes(2);
  });

  it("rebinds the active connection to a new Nango connection after Nango lost it, keeping the handle and the state hash", async () => {
    const { workflow, nango, connections, connect, finishConnect, database, secrets, health } = setup();
    const before = await connect();
    seedWaitingCard(database);
    const bundle = findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256);
    connections.delete("nango-conn-1");
    health.markNeedsReinstall(before.state_sha256);

    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    expect(nango.createReconnectSession).not.toHaveBeenCalled();
    expect(nango.createConnectSession).toHaveBeenLastCalledWith({
      tags: { echo_organization_id: ORGANIZATION_ID, echo_membership_id: SESSIONS.owner!.membership_id, echo_attempt_id: begun.attempt_id },
      client_id: "1234.5678", client_secret: CLIENT_SECRET, scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1 });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    const replacement = finishConnect({ connection_id: "nango-conn-2" });
    // A Nango blip on the re-read of the lost connection is not an outcome either.
    nango.getSlackConnection.mockResolvedValueOnce(replacement).mockRejectedValueOnce(new NangoClientErrorV1("unavailable", `down ${NANGO_KEY}`));
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "pending" });
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "complete",
      result: { kind: "reconnected", workspace_id: "T01" } });

    expect(readActiveSlackConnectionV1(database)).toEqual(before);
    expect(secrets.listReferences()).toEqual([bundle.reference]);
    expect(findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256).credentials)
      .toEqual({ ...bundle.credentials, nango_connection_id: "nango-conn-2" });
    expect(workflow.organizationSetup()).toBe("connected");
  });

  it("rebinds only a connection with its own attempt tags in the original workspace, writing nothing otherwise", async () => {
    const { workflow, nango, connections, connect, finishConnect, database, secrets } = setup();
    const before = await connect();
    const bundle = findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256);
    connections.delete("nango-conn-1");
    const cases: [Partial<NangoSlackConnectionV1>, Record<string, string>, OrganizationSlackInstallFailureReasonV1][] = [
      [{ connection_id: "nango-conn-2" }, { echo_attempt_id: `ssi_${uuid(9)}` }, "attempt_mismatch"],
      [{ connection_id: "nango-conn-3" }, { echo_membership_id: `mem_${uuid(9)}` }, "attempt_mismatch"],
      [{ connection_id: "nango-conn-4", team_id: "T02" }, {}, "workspace_mismatch"],
      [{ connection_id: "nango-conn-5", bot_user_id: "UOTHER" }, {}, "workspace_mismatch"],
    ];
    for (const [index, [overrides, tags, expectedReason]] of cases.entries()) {
      const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(index + 10)}` }, "owner");
      const connection = finishConnect(overrides);
      connections.set(connection.connection_id, { ...connection, tags: { ...connection.tags, ...tags } });
      nango.findConnectionIdByTag.mockResolvedValueOnce(connection.connection_id);
      await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: expectedReason });
      expect(workflow.organizationSetup()).toBe("needs_reinstall");
    }
    expect(nango.createReconnectSession).not.toHaveBeenCalled();
    expect(readActiveSlackConnectionV1(database)).toEqual(before);
    expect(findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256)).toEqual(bundle);
  });

  it("leaves a lost Nango connection that came back to the owner's next reconnect", async () => {
    const { workflow, nango, connections, connect, finishConnect, secrets } = setup();
    const before = await connect();
    const bundle = findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256);
    const lost = connections.get("nango-conn-1")!;
    connections.delete("nango-conn-1");
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    finishConnect({ connection_id: "nango-conn-2" });
    // Nango answered 404 at begin but has the connection again by the time the owner finishes.
    connections.set("nango-conn-1", lost);
    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({ status: "failed", failure_reason: "provider_unavailable" });
    expect(findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256)).toEqual(bundle);
    await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(3)}` }, "owner");
    expect(nango.createReconnectSession).toHaveBeenCalledWith(expect.objectContaining({ connection_id: "nango-conn-1" }));
  });

  it("refuses a rebind when the old Nango connection returns during Slack verification", async () => {
    const { workflow, connections, connect, finishConnect, secrets, verifier, nango } = setup();
    const before = await connect();
    const bundle = findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256);
    const old = connections.get("nango-conn-1")!;
    connections.delete("nango-conn-1");
    const begun = await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(2)}` }, "owner");
    finishConnect({ connection_id: "nango-conn-2" });
    const verify = verifier.verifyConnection.getMockImplementation()!;
    verifier.verifyConnection.mockImplementationOnce(async (token: string) => {
      const verified = await verify(token);
      // Nango restores the old connection while Slack's auth.test is in flight.
      connections.set("nango-conn-1", old);
      return verified;
    });

    await expect(workflow.installStatus({ attempt_id: begun.attempt_id }, "owner")).resolves.toMatchObject({
      status: "failed", failure_reason: "provider_unavailable",
    });
    expect(findSlackAppCredentialsByReferenceSha256V1(secrets, before.state.credential_reference_sha256)).toEqual(bundle);

    await workflow.beginInstall({ ...BEGIN_REQUEST, request_id: `osi_${uuid(3)}` }, "owner");
    expect(connections.get("nango-conn-1")).toEqual(old);
    expect(nango.createReconnectSession).toHaveBeenCalledWith(expect.objectContaining({ connection_id: "nango-conn-1" }));
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
  function open(options: { readonly connection_health?: SlackConnectionHealthV1 } = {}) {
    const { directory, database } = controlDatabase();
    database.close();
    const f = fakes();
    const context = { outputs: [] as unknown[] };
    contexts.push(context);
    // The DM link reaches Slack only through these fakes, with the token the bundle's source fetched from Nango.
    const provider = {
      verifyConnection: f.verifier.verifyConnection,
      openIdentityLinkDirectMessage: vi.fn(async (_token: string, user: string, team: string) => ({ team_id: team, channel_id: "D0EMPLOYEE", recipient_user_id: user })),
      postIdentityLinkChallenge: vi.fn(async (_token: string, input: { channel_id: string }) => ({ team_id: "T01", channel_id: input.channel_id, challenge_message_ts: "100.000001" })),
      observeIdentityLinkChallenge: vi.fn(),
    };
    const health = options.connection_health ?? new SlackConnectionHealthV1();
    const opened = createSlackPersonExternalIdentityRuntimeBundleV1({
      provider,
      bot_token_source: createSlackBotTokenSourceV1({ secrets: new FileOrganizationSecretStore(join(directory, "secrets")), nango: f.nango, health }),
      connection_health: health,
      organization_setup: { authority_url: AUTHORITY_URL, nango: { client: f.nango, callback_url: NANGO_CALLBACK }, manifest_provider: f.manifest },
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

  it("mounts the identity, browser and setup routes", async () => {
    const mounted = open();
    expect(mounted.opened.application.routes).toHaveLength(12);
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

  it("keeps the owner's tools listing serving when the secret store holds two pending apps or a corrupt one", async () => {
    const context = open();
    try {
      const secrets = new FileOrganizationSecretStore(join(context.directory, "secrets"));
      for (const app_id of ["A0APP1", "A0APP2"]) {
        secrets.create(serializeSlackAppCredentialsV1({ kind: "echo-slack-app-credentials-v1", app_id, client_id: "1234.5678",
          client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET, nango_connection_id: null }));
      }
      await expect(context.tools("owner")).resolves.toMatchObject([{ availability: "unavailable", organization_setup: "needs_reinstall" }]);
      await expect(context.tools("employee")).resolves.toMatchObject([{ organization_setup: null }]);
      for (const reference of secrets.listReferences()) secrets.remove(reference);
      secrets.create(JSON.stringify({ kind: "echo-slack-app-credentials-v1", app_id: "corrupt" }));
      await expect(context.tools("owner")).resolves.toMatchObject([{ organization_setup: "needs_reinstall" }]);
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
      expect(context.provider.postIdentityLinkChallenge).toHaveBeenCalledWith(`${BOT_TOKEN}-nango-conn-1`, expect.anything(), undefined);
      // The browser link is mounted by setup alone and uses the installed app's own client.
      const browser = await context.call(ORGANIZATION_API_PERSON_SLACK_BROWSER_LINK_BEGIN_PATH, "owner", { request_id: `psb_${uuid(2)}` }) as { body: { authorization_url: string } };
      const authorization = new URL(browser.body.authorization_url);
      expect(authorization.searchParams.get("client_id")).toBe("1234.5678");
      expect(authorization.searchParams.get("redirect_uri")).toBe(`${AUTHORITY_URL}/v2/person/external-identities/slack/browser/callback`);
      expect(authorization.searchParams.get("team")).toBe("T01");
      // The sign-in requests exactly the user scopes the app the owner created declares.
      const created = context.f.manifest.createApp.mock.calls[0]![0] as unknown as { manifest: { oauth_config: { scopes: { user: unknown } } } };
      expect(authorization.searchParams.get("scope")!.split(" ")).toEqual(created.manifest.oauth_config.scopes.user);
    } finally {
      context.opened.close();
    }
  });

  it("uses the bundle's one connection health for setup", async () => {
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
