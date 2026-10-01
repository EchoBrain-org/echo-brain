import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { serializeSlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { createSlackBotTokenSourceV1 } from "../../src/organization-control-plane/application/slack-bot-token-source-v1.js";
import { SlackConnectionHealthV1 } from "../../src/organization-control-plane/application/slack-connection-health-v1.js";
import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import { readActiveSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { connectSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-connection-coordinator-v1.js";
import { activateNangoSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";
import { ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID } from "../../src/organization-control-plane/slack-approval-integration-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1, privateSlackApprovalBlockKitActionIdV1 } from "../../src/private-approval/private-slack-approval-block-kit-card-v1.js";
import { createActivePrivateSlackApprovalPosterV1, createPrivateSlackApprovalWorkflowBundleV1, type PrivateSlackApprovalWorkflowBundleConfigV1 } from "../../src/private-approval/private-slack-approval-workflow-bundle-v1.js";
import { activePrivateSlackConnectionIdV1, resolveActivePrivateSlackConnectionV1 } from "../../src/private-approval/resolve-current-private-slack-connection-v1.js";

const NOW = "2026-09-30T00:00:00.000Z";
const LEGACY_ID = "con_00000000-0000-4000-8000-000000000001";
const NANGO_ID = "con_00000000-0000-4000-8000-000000000002";
const LEGACY_TOKEN = "xoxb-legacy-local-token";
const NANGO_TOKEN = "xoxb-nango-fetched-token-never-echoed";
const FILE_SIGNING_SECRET = "legacy-signing-secret-from-the-file-0000";
const APP_SIGNING_SECRET = "app-signing-secret-never-echoed";
const CARD = { approval_id: "apr_00000000-0000-4000-8000-000000000001" };

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

/**
 * A stopped Authority state directory. With `legacy` (the default), its
 * pinned legacy connection is active, matching an organization not yet moved
 * to Nango. With `legacy: false`, nothing is active yet, matching an
 * organization installing Nango for the first time.
 */
async function stateDirectory({ legacy = true }: { legacy?: boolean } = {}) {
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
  const nango = token(NANGO_TOKEN);
  const legacyToken = token(LEGACY_TOKEN);
  const verifier = {
    verifyConnection: vi.fn(async (bot: string) => (bot === NANGO_TOKEN ? nango : legacyToken)),
    verifyChannel: vi.fn(async (_bot: string, channel_id: string) => ({ team_id: "T01", channel_id, is_public_organization_channel: true,
      is_active: true, bot_membership_verified: true, bot_access_verified: true, verification_evidence_sha256: canonicalSha256("channel") })),
  };
  if (legacy) {
    await connectSlackConnectionV1({ ...COORDINATES, connection_id: LEGACY_ID, approval_channel_id: "C0LEGACY", slack_bot_token: LEGACY_TOKEN,
      database, secrets, verifier, now: () => NOW });
  }
  const signing_secret_file = join(directory, "slack-signing-secret");
  writeFileSync(signing_secret_file, FILE_SIGNING_SECRET, { mode: 0o600 });
  const credentials = { kind: "echo-slack-app-credentials-v1" as const, app_id: "A0APP1", client_id: "1234.5678",
    client_secret: "client-secret-value", signing_secret: APP_SIGNING_SECRET, nango_connection_id: null };
  /** The owner's Nango install. Refused as already_connected whenever a connection (legacy or Nango) is already active. */
  const installNango = () => activateNangoSlackConnectionV1({ database, secrets, verifier, ...COORDINATES,
    credential: { reference: secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials },
    nango: NANGO, now: () => NOW, new_connection_id: () => NANGO_ID });
  const client = { getSlackConnection: vi.fn(async () => NANGO) } as unknown as NangoConnectionClientV1 & { getSlackConnection: ReturnType<typeof vi.fn> };
  return { directory, database, secrets, signing_secret_file, installNango, client };
}

function token(bot: string) {
  const nango = bot === NANGO_TOKEN;
  return { team_id: "T01", enterprise_id: null, bot_user_id: nango ? "U0APPBOT" : "U0LEGACYBOT", bot_id: nango ? "B0APP" : "B0LEGACY",
    app_id: nango ? "A0APP1" : "A0LEGACY", granted_scopes: nango ? [...SLACK_PRIVATE_APP_BOT_SCOPES_V1] : [...SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES],
    verification_evidence_sha256: canonicalSha256({ bot: nango ? "nango" : "legacy" }) };
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

function slackRecording(authorizations: string[], response: unknown = { ok: true, channel: "D0OWNER", ts: "123.000001" }) {
  return async (_url: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization")!);
    return new Response(JSON.stringify(response));
  };
}

describe("private Slack approval workflow bundle with Nango", () => {
  it("refuses a Nango install while a legacy runtime is active, and keeps serving on its pinned connection", async () => {
    const state = await stateDirectory();
    const config = { state_directory: state.directory, signing_secret_file: state.signing_secret_file, connection_id: LEGACY_ID };
    const legacy = await load(config);
    await expect(legacy.accept(FILE_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    await expect(legacy.accept(APP_SIGNING_SECRET)).rejects.toMatchObject({ code: "unauthorized" });

    await expect(state.installNango()).rejects.toMatchObject({ reason: "already_connected" });

    // Nothing was written: the pinned legacy connection keeps serving, and a restart still resolves it.
    await expect(legacy.accept(FILE_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    const restarted = await load(config);
    await expect(restarted.accept(FILE_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
  });

  it("nango connection: card posts with the Nango-fetched token and its click verifies with the bundle signing secret", async () => {
    const state = await stateDirectory({ legacy: false });
    await expect(state.installNango()).resolves.toMatchObject({ kind: "created" });
    const health = new SlackConnectionHealthV1();
    const source = createSlackBotTokenSourceV1({ secrets: state.secrets, nango: state.client });
    const config = { state_directory: state.directory, signing_secret_file: state.signing_secret_file, connection_id: NANGO_ID,
      bot_token_source: source, connection_health: health };
    const running = await load(config);
    const authorizations: string[] = [];
    const poster = createActivePrivateSlackApprovalPosterV1({
      connection: () => resolveActivePrivateSlackConnectionV1(state.database, NANGO_ID, COORDINATES).stored,
      bot_token_source: source, connection_health: health, client_options: { fetchImpl: slackRecording(authorizations) },
    });
    const marker = { approval_id: CARD.approval_id, dm_channel_id: "D0OWNER" };

    // The active Nango connection: its fetched token and its app's own signing secret.
    await expect(running.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
    await expect(running.accept(FILE_SIGNING_SECRET)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(poster.postMarker(marker)).resolves.toEqual({ kind: "posted", provider_message_ts: "123.000001" });
    expect(authorizations).toEqual([`Bearer ${NANGO_TOKEN}`]);
    expect(state.client.getSlackConnection).toHaveBeenCalledWith({ connection_id: "nango-conn-1", force_refresh: false });
    expect(activePrivateSlackConnectionIdV1(state.database, NANGO_ID)).toBe(NANGO_ID);

    // A restart resolves the same Nango connection.
    const restarted = await load(config);
    await expect(restarted.accept(APP_SIGNING_SECRET)).resolves.toMatchObject({ status: 200 });
  });

  it("marks a Nango connection whose refreshed token Slack still rejects, then stops refreshing it", async () => {
    const state = await stateDirectory({ legacy: false });
    await state.installNango();
    state.client.getSlackConnection.mockImplementation(async (input: { force_refresh?: boolean }) =>
      ({ ...NANGO, bot_token: input.force_refresh === true ? `${NANGO_TOKEN}-refreshed` : NANGO_TOKEN }));
    const health = new SlackConnectionHealthV1();
    const source = createSlackBotTokenSourceV1({ secrets: state.secrets, nango: state.client });
    const authorizations: string[] = [];
    const poster = createActivePrivateSlackApprovalPosterV1({
      connection: () => resolveActivePrivateSlackConnectionV1(state.database, NANGO_ID, COORDINATES).stored,
      bot_token_source: source, connection_health: health,
      client_options: { fetchImpl: slackRecording(authorizations, { ok: false, error: "invalid_auth" }) },
    });
    const marker = { approval_id: CARD.approval_id, dm_channel_id: "D0OWNER" };
    await expect(poster.postMarker(marker)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toEqual([`Bearer ${NANGO_TOKEN}`, `Bearer ${NANGO_TOKEN}-refreshed`]);
    expect(health.needsReinstall(readActiveSlackConnectionV1(state.database)!.state_sha256)).toBe(true);
    // Marked: the next rejection is not refreshed again until an install clears the mark.
    await expect(poster.postMarker(marker)).resolves.toEqual({ kind: "retry_allowed" });
    expect(authorizations).toHaveLength(3);
    expect(state.client.getSlackConnection).toHaveBeenCalledTimes(2);
  });
});
