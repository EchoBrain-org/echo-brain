import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthorityBaselineV10 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import type { ProviderHttpRequestV1 } from "@echo-brain/organization-authority-kernel/application/ports/provider-http-application-v1";
import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { applyOrganizationControlBaselineV3, openOrganizationControlDatabase } from "@echo-brain/organization-control-plane/organization-control-database-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import type { ApprovalWorkflowStateV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/approval-workflow-state-v1";
import type { ApprovalWorkflowContextV1 } from "@echo-brain/organization-processing/ports/approval-workflow-bundle-v1";
import { resolvePinnedOrganizationAuthority } from "../../../../../packages/organization-protocol/src/authority-descriptor.js";
import { COORDINATES, protocolAuthority } from "../../../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import type { NangoConnectionClientV1, NangoSlackConnectionV1 } from "../../src/organization-control-plane/adapters/nango/nango-connection-client-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1 } from "../../src/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1.js";
import { findSlackAppCredentialsByReferenceSha256V1, serializeSlackAppCredentialsV1, type SlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { createSlackBotTokenSourceV1 } from "../../src/organization-control-plane/application/slack-bot-token-source-v1.js";
import { SlackConnectionHealthV1 } from "../../src/organization-control-plane/application/slack-connection-health-v1.js";
import { readActiveSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { activateNangoSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID } from "../../src/organization-control-plane/slack-approval-integration-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1, privateSlackApprovalBlockKitActionIdV1 } from "../../src/private-approval/private-slack-approval-block-kit-card-v1.js";
import { createActivePrivateSlackApprovalPosterV1, createPrivateSlackApprovalWorkflowBundleV1, type PrivateSlackApprovalWorkflowBundleConfigV1 } from "../../src/private-approval/private-slack-approval-workflow-bundle-v1.js";
import { resolveActivePrivateSlackConnectionV1 } from "../../src/private-approval/resolve-current-private-slack-connection-v1.js";

const NOW = "2026-09-30T00:00:00.000Z";
const LATER = "2026-09-30T00:10:00.000Z";
const NANGO_ID = "con_00000000-0000-4000-8000-000000000002";
const NANGO_TOKEN = "xoxb-nango-fetched-token-never-echoed";
const APP_SIGNING_SECRET = "app-signing-secret-never-echoed";
const OTHER_SIGNING_SECRET = "a-signing-secret-of-no-installed-app";
const CARD = { approval_id: "apr_00000000-0000-4000-8000-000000000001" };
const MARKER = { approval_id: CARD.approval_id, dm_channel_id: "D0OWNER" };

const directories: string[] = [];
const opened: { close?(): void }[] = [];
afterEach(() => {
  for (const components of opened.splice(0)) components.close?.();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const NANGO: NangoSlackConnectionV1 = {
  connection_id: "nango-conn-1", tags: {}, team_id: "T01", enterprise_id: null, is_enterprise_install: false,
  app_id: "A0APP1", bot_user_id: "U0APPBOT", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: NANGO_TOKEN, updated_at: NOW,
};

/** A stopped Authority state directory whose organization has not installed Slack yet. */
function stateDirectory() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "echo-slack-approval-bundle-")));
  directories.push(directory);
  const authority = openAuthorityDatabase(join(directory, "authority.sqlite"));
  applyAuthorityBaselineV10(authority);
  authority.close();
  const database = openOrganizationControlDatabase(join(directory, "integrations.sqlite"));
  opened.push({ close: () => database.close() });
  applyOrganizationControlBaselineV3(database);
  database.prepare(`INSERT INTO organization_control_plane_metadata (singleton, control_plane_id, organization_id, authority_id,
    authority_descriptor_sha256, created_at) VALUES (1, 'ocp_1', ?, ?, ?, ?)`)
    .run(COORDINATES.organization_id, COORDINATES.authority_id, canonicalSha256({ descriptor: "test" }), NOW);
  const secrets = new FileOrganizationSecretStore(join(directory, "secrets"));
  const verifier = {
    verifyConnection: vi.fn(async () => ({ team_id: "T01", enterprise_id: null, bot_user_id: "U0APPBOT", bot_id: "B0APP", app_id: "A0APP1",
      granted_scopes: [...SLACK_PRIVATE_APP_BOT_SCOPES_V1], verification_evidence_sha256: canonicalSha256({ bot: "nango" }) })),
  };
  const activate = (credential: { readonly reference: ReturnType<FileOrganizationSecretStore["create"]>; readonly credentials: SlackAppCredentialsV1 },
    nango: NangoSlackConnectionV1) =>
    activateNangoSlackConnectionV1({ database, secrets, verifier, ...COORDINATES, credential, nango, now: () => NOW, new_connection_id: () => NANGO_ID });
  const credentials: SlackAppCredentialsV1 = { kind: "echo-slack-app-credentials-v1", app_id: "A0APP1", client_id: "1234.5678",
    client_secret: "client-secret-value", signing_secret: APP_SIGNING_SECRET, nango_connection_id: null };
  /** The owner's first install through Nango. */
  const installNango = () => activate({ reference: secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials }, NANGO);
  /** The owner's reinstall of the connected app: a Nango reconnect on the same connection id. */
  const reconnectNango = () => activate(
    findSlackAppCredentialsByReferenceSha256V1(secrets, readActiveSlackConnectionV1(database)!.state.credential_reference_sha256),
    { ...NANGO, updated_at: LATER },
  );
  const client = { getSlackConnection: vi.fn(async () => NANGO) } as unknown as NangoConnectionClientV1 & { getSlackConnection: ReturnType<typeof vi.fn> };
  const health = new SlackConnectionHealthV1();
  const bot_token_source = createSlackBotTokenSourceV1({ secrets, nango: client });
  const config: PrivateSlackApprovalWorkflowBundleConfigV1 = { state_directory: directory, bot_token_source, connection_health: health };
  return { database, secrets, installNango, reconnectNango, client, health, bot_token_source, config };
}

function context(): ApprovalWorkflowContextV1 {
  const authority = protocolAuthority();
  const state = Object.fromEntries(["listOutstandingApprovalPresentations", "listPendingApprovalDeliveries", "listPendingSupersededApprovalCards",
    "recordSupersededApprovalCardTombstoned", "readCandidateByApprovalId", "readDurableCardStagedAt", "readApprovalDeliveryQuarantine",
    "quarantineApprovalDelivery", "readFrozenCandidateForApproval", "prepareApprovalPost", "releaseApprovalPostAttempt",
    "recordPostedApprovalCard", "markControlPlaneStaged"].map((name) => [name, vi.fn(() => [])])) as unknown as ApprovalWorkflowStateV1;
  return { state, record_append: { append: vi.fn() }, next_envelope_id: () => "env_1", coordinates: COORDINATES,
    signer: { inspect: async () => resolvePinnedOrganizationAuthority(authority.pinned), sign: authority.sign } };
}

/** A signed, presentation-only selector click: accepted once its signature verifies, with no durable write. */
function click(secret: string): ProviderHttpRequestV1 {
  const policy = privateSlackApprovalBlockKitActionIdV1(CARD, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy);
  const comment = privateSlackApprovalBlockKitActionIdV1(CARD, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment);
  const payload = {
    type: "block_actions", user: { id: "U012ABCDEF", team_id: "T012ABCDEF" }, api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: { type: "message", channel_id: "D012ABCDEF", message_ts: "1712345678.123456", is_ephemeral: false },
    team: { id: "T012ABCDEF", domain: "echo" }, enterprise: null, is_enterprise_install: false, channel: { id: "D012ABCDEF", name: "directmessage" },
    message: { type: "message", user: "U098BOTAPP", ts: "1712345678.123456", app_id: "A012ABCDEF", bot_id: "B012ABCDEF", blocks: [] },
    state: { values: {
      policy: { [policy]: { type: "radio_buttons", selected_option: { text: { type: "plain_text", text: "Team", emoji: false }, value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID } } },
      comment: { [comment]: { type: "plain_text_input", value: "Ship it." } },
    } },
    actions: [{ type: "radio_buttons", action_id: policy, block_id: "actions", value: JSON.stringify({ schema_version: 1, ...CARD }), action_ts: "1712345680.123456" }],
  };
  const raw_body = new TextEncoder().encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw_body).digest("hex");
  return { route_id: "private-approval-interaction", method: "POST", path: "/v2/integrations/slack/interactions", raw_body,
    content_type: "application/x-www-form-urlencoded", headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` } };
}

async function load(config: PrivateSlackApprovalWorkflowBundleConfigV1) {
  const bundle = createPrivateSlackApprovalWorkflowBundleV1(config);
  const workflowContext = context();
  await bundle.assert_existing_presentations_owned(workflowContext);
  const components = await bundle.load(workflowContext);
  opened.push(components);
  const ingress = components.interaction_ingress!;
  return { components, accept: (secret: string) => ingress.accept(click(secret)) };
}

/** A poster on the active connection, recording each Slack call's bearer token. */
function recordingPoster(state: ReturnType<typeof stateDirectory>, response: unknown = { ok: true, channel: "D0OWNER", ts: "123.000001" }) {
  const authorizations: string[] = [];
  const poster = createActivePrivateSlackApprovalPosterV1({
    connection: () => resolveActivePrivateSlackConnectionV1(state.database, COORDINATES).stored,
    bot_token_source: state.bot_token_source, connection_health: state.health,
    client_options: { fetchImpl: async (_url: unknown, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization")!);
      return new Response(JSON.stringify(response));
    } },
  });
  return { poster, authorizations };
}

describe("private Slack approval workflow bundle", () => {
  it("first install: posts with the Nango-fetched token, verifies clicks with the bundle signing secret, and restarts on the same connection", async () => {
    const state = stateDirectory();
    await expect(state.installNango()).resolves.toMatchObject({ kind: "created" });
    const running = await load(state.config);
    const { poster, authorizations } = recordingPoster(state);

    await expect(running.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    await expect(running.accept(OTHER_SIGNING_SECRET)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(poster.postMarker(MARKER)).resolves.toEqual({ kind: "posted", provider_message_ts: "123.000001" });
    expect(authorizations).toEqual([`Bearer ${NANGO_TOKEN}`]);
    expect(state.client.getSlackConnection).toHaveBeenCalledWith({ connection_id: "nango-conn-1", force_refresh: false });

    const restarted = await load(state.config);
    await expect(restarted.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
  });

  it("reconnect keeps the connection, its state hash, and the running lane", async () => {
    const state = stateDirectory();
    await state.installNango();
    const before = readActiveSlackConnectionV1(state.database)!;
    const running = await load(state.config);

    await expect(state.reconnectNango()).resolves.toMatchObject({ kind: "reconnected" });

    expect(readActiveSlackConnectionV1(state.database)).toMatchObject({ contract_sha256: before.contract_sha256, state_sha256: before.state_sha256 });
    await expect(running.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    const restarted = await load(state.config);
    await expect(restarted.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    const { poster, authorizations } = recordingPoster(state);
    await expect(poster.postMarker(MARKER)).resolves.toMatchObject({ kind: "posted" });
    expect(authorizations).toEqual([`Bearer ${NANGO_TOKEN}`]);
  });

  it("refuses to start without an active connection or without its credential bundle", async () => {
    const state = stateDirectory();
    await expect(load(state.config)).rejects.toThrow("has no active Slack connection");

    await state.installNango();
    for (const reference of state.secrets.listReferences()) state.secrets.remove(reference);
    await expect(load(state.config)).rejects.toThrow("Slack credential is missing");
  });

  it("marks a Nango connection whose refreshed token Slack still rejects, then stops refreshing it", async () => {
    const state = stateDirectory();
    await state.installNango();
    state.client.getSlackConnection.mockImplementation(async (input: { force_refresh?: boolean }) =>
      ({ ...NANGO, bot_token: input.force_refresh === true ? `${NANGO_TOKEN}-refreshed` : NANGO_TOKEN }));
    const { poster, authorizations } = recordingPoster(state, { ok: false, error: "invalid_auth" });
    await expect(poster.postMarker(MARKER)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toEqual([`Bearer ${NANGO_TOKEN}`, `Bearer ${NANGO_TOKEN}-refreshed`]);
    expect(state.health.needsReinstall(readActiveSlackConnectionV1(state.database)!.state_sha256)).toBe(true);
    // Marked: the next rejection is not refreshed again until an install clears the mark.
    await expect(poster.postMarker(MARKER)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toHaveLength(3);
    expect(state.client.getSlackConnection).toHaveBeenCalledTimes(2);
  });
});
