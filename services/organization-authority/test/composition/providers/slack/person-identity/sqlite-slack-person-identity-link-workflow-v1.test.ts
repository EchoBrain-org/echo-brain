import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../../../src/shared/core-runtime-observation-v1.js";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import Database from "better-sqlite3";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/organization-api";
import type { SlackIdentityProviderV1 } from "@echo-brain/organization-control-plane/slack-external-identity-integration-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOrganizationControlBaselineV1 } from "../../../../../../../packages/organization-control-plane/src/persistence/baseline.js";
import { connectSlackConnectionV1 } from "../../../../../../../packages/organization-control-plane/src/persistence/sqlite-slack-connection-coordinator-v1.js";
import type { PersonAccessAuthorization } from "../../../../../src/application/person-identity-sessions.js";
import { ReadableSearchAuthorizationFence } from "../../../../../src/application/readable-search-authorization-fence.js";
import { createSqliteSlackPersonIdentityLinkWorkflowV1 } from "../../../../../src/composition/providers/slack/person-identity/sqlite-slack-person-identity-link-repository-v1.js";
import { createSlackExternalIdentityHttpApplicationV1 } from "../../../../../src/composition/providers/slack/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { createOrganizationAuthorityHttpServer } from "../../../../../src/presentation/organization-authority-http-server.js";

const NOW = "2026-08-22T00:00:00.000Z";
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "lineage-00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
const CODE = Buffer.alloc(32).toString("base64url");
const OTHER_CODE = Buffer.alloc(32, 1).toString("base64url");
const TOKEN = "test-slack-token";

const authorization: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: "employee",
  identity_binding_id: "oib_00000000-0000-4000-8000-000000000001",
  session_family_id: "psf_00000000-0000-4000-8000-000000000001",
  access_credential_sha256: canonicalSha256("access"),
  access_expires_at: "2026-08-23T00:00:00.000Z",
  hard_reauthentication_at: "2026-08-29T00:00:00.000Z",
  person_state_sha256: canonicalSha256("person"),
  session_state_sha256: canonicalSha256("session"),
  checked_at: NOW,
};

const databases: Database.Database[] = [];

function beginRequest(requestId = "psb_00000000-0000-4000-8000-000000000001") {
  return {
    request_id: requestId,
    challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(CODE),
    recipient_user_id: "U12345679",
  };
}

async function setup(
  currentAuthorization: () => PersonAccessAuthorization = () => authorization,
) {
  const database = new Database(":memory:");
  databases.push(database);
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
      ORGANIZATION_ID,
      AUTHORITY_ID,
      canonicalSha256("authority"),
      NOW,
    );

  const slack: SlackIdentityProviderV1 = {
    openIdentityLinkDirectMessage: vi.fn(async () => ({ team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "U12345679" })),
    verifyConnection: vi.fn(async () => ({
      team_id: "T12345678",
      enterprise_id: null,
      bot_user_id: "U12345678",
      bot_id: "B12345678",
      app_id: "A12345678",
      granted_scopes: [
        "channels:history",
        "channels:read",
        "chat:write",
        "im:history",
        "im:write",
        "reactions:read",
        "users:read",
      ],
      verification_evidence_sha256: canonicalSha256("connection"),
    })),
    verifyChannel: vi.fn(async (_token, channelId) => ({
      team_id: "T12345678",
      channel_id: channelId,
      is_public_organization_channel: true,
      is_active: true,
      bot_membership_verified: true,
      bot_access_verified: true,
      verification_evidence_sha256: canonicalSha256("channel"),
    })),
    verifyHuman: vi.fn(async () => ({
      team_id: "T12345678",
      user_id: "U12345679",
      verification_evidence_sha256: canonicalSha256("human"),
    })),
    postIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      channel_id: input.channel_id,
      challenge_message_ts: "100.000001",
    })),
    observeIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      user_id: "U12345679",
      channel_id: input.channel_id,
      challenge_message_ts: input.challenge_message_ts,
      reply_message_ts: "100.000002",
      verification_evidence_sha256: canonicalSha256("observed"),
    })),
  };
  await connectSlackConnectionV1({
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: LINEAGE_ID,
    connection_id: CONNECTION_ID,
    approval_channel_id: "C12345678",
    slack_bot_token: TOKEN,
    database,
    secrets: {
      create: vi.fn(() => ({
        secret_backend_id: "authority-file-v1" as const,
        secret_handle_id: "sch_00000000-0000-4000-8000-000000000001",
      })),
      remove: vi.fn(),
    },
    verifier: slack,
    now: () => NOW,
  });

  return {
    database,
    slack,
    application: createSqliteSlackPersonIdentityLinkWorkflowV1({
      database,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: LINEAGE_ID,
      approval_channel_id: "C12345678",
      authentication: {
        authenticateAccess: vi.fn(currentAuthorization),
      },
      membership_type: () => currentAuthorization().membership_type,
      slack,
      slack_token_access: { readActiveSlackBotToken: vi.fn(() => TOKEN) },
      authorization_fence: new ReadableSearchAuthorizationFence(),
      now: () => NOW,
    }),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Person Slack identity-link workflow", () => {
  it("reads the organization's enabled tools and this authenticated employee's status", async () => {
    const context = await setup();
    expect(typeof context.application.tools).toBe("function");
    expect(await context.application.tools("bearer")).toMatchObject({
      tools: [{ provider: "slack", availability: "enabled", personal_status: "unlinked" }],
    });
  });

  it("delivers identity proof only to a private DM", async () => {
    const context = await setup();
    await context.application.begin(beginRequest(), "bearer");
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledWith(
      TOKEN, expect.objectContaining({ channel_id: "D12345678", recipient_user_id: "U12345679" }), undefined,
    );
  });

  it("admits only one delivery per membership during the cooldown before contacting Slack", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");

    await expect(context.application.begin(beginRequest(), "bearer")).resolves.toEqual(begun);

    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000002"),
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE),
      recipient_user_id: "UOTHER",
    }, "bearer")).rejects.toMatchObject({ code: "conflict" });

    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce();
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    current = { ...authorization, checked_at: "2026-08-22T00:00:59.000Z" };
    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000003"),
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE),
      recipient_user_id: "UOTHER",
    }, "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce();
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    current = { ...authorization, checked_at: "2026-08-22T00:01:00.000Z" };
    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000004"),
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE),
    }, "bearer")).resolves.toMatchObject({ provider: "slack" });
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2);
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledTimes(2);
  });

  it("applies the delivery cooldown after completion across a restarted Person session", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete({
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
      challenge_code: CODE,
    }, "bearer");
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2);

    current = {
      ...authorization,
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
      session_state_sha256: canonicalSha256("restarted-session"),
    };
    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000003"),
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE),
      recipient_user_id: "UOTHER",
    }, "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2);
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();
  });

  it("allows only one racing fresh request to reach Slack posting", async () => {
    const context = await setup();
    let releaseFirstOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>(resolve => { releaseFirstOpen = resolve; });
    let opens = 0;
    vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockImplementation(async () => {
      opens += 1;
      if (opens === 1) await firstOpen;
      return { team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "U12345679" };
    });

    const first = context.application.begin(beginRequest(), "bearer");
    await vi.waitFor(() => expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce());
    const second = context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000002"),
      challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE),
    }, "bearer");
    await vi.waitFor(() => expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2));
    releaseFirstOpen!();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();
  });

  it.each([
    ["workspace mismatch", { team_id: "TOTHER", channel_id: "D12345678", recipient_user_id: "U12345679" }],
    ["recipient mismatch", { team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "UOTHER" }],
    ["shared channel", { team_id: "T12345678", channel_id: "C12345678", recipient_user_id: "U12345679" }],
  ])("refuses private delivery with %s", async (_label, destination) => {
    const context = await setup();
    vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockResolvedValue(destination);
    await expect(context.application.begin(beginRequest(), "bearer")).rejects.toMatchObject({ code: "unavailable" });
    expect(context.slack.postIdentityLinkChallenge).not.toHaveBeenCalled();
  });

  it("refuses absent recipients and failed DM delivery without a shared fallback", async () => {
    const context = await setup();
    await expect(context.application.begin({ ...beginRequest(), recipient_user_id: undefined }, "bearer")).rejects.toMatchObject({ code: "invalid_request" });
    vi.mocked(context.slack.postIdentityLinkChallenge).mockRejectedValue(new Error("synthetic provider body must stay private"));
    await expect(context.application.begin(beginRequest(), "bearer")).rejects.toMatchObject({ code: "unavailable", message: "Slack identity verification is temporarily unavailable" });
    expect(context.database.prepare("SELECT status FROM organization_person_slack_link_challenges").get()).toEqual({ status: "expired" });
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("distinguishes no configured tool, revoked connection, and a failed status read", async () => {
    const context = await setup();
    context.database.prepare("UPDATE organization_tool_connection_current_state SET current_status = 'revoked'").run();
    expect((await context.application.tools("bearer")).tools).toEqual([{ provider: "slack", availability: "unavailable", personal_status: "unavailable", workspace_id: null, account_id: null }]);
    context.database.prepare("DELETE FROM organization_tool_connection_current_state").run();
    expect((await context.application.tools("bearer")).tools).toEqual([]);
    context.database.exec("DROP TABLE organization_tool_connection_current_state");
    await expect(context.application.tools("bearer")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("observes status, delivery and completion without identity, code or provider content", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const events: CoreRuntimeObservationV1[] = [];
    const content: unknown[] = [];
    await observeCoreRuntimeV1("http_request", async () => {
      await context.application.tools("bearer");
      const begun = await context.application.begin(beginRequest(), "bearer");
      await context.application.complete({ request_id: "psc_00000000-0000-4000-8000-000000000001", challenge_attempt_id: begun.challenge_attempt_id, challenge_message_ts: begun.challenge_message_ts, challenge_code: CODE }, "bearer");
      current = { ...authorization, checked_at: "2026-08-22T00:01:00.000Z" };
      vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockRejectedValue(new Error("provider-private-body"));
      await expect(context.application.begin({ ...beginRequest("psb_00000000-0000-4000-8000-000000000002"), challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE) }, "bearer")).rejects.toMatchObject({ code: "unavailable" });
    }, { observer: event => { events.push(event); }, content_observer: event => { content.push(event); } });
    for (const phase of ["person_tools_status", "person_tool_delivery", "person_tool_completion"]) {
      expect(events.some(event => event.phase === phase && event.event === "succeeded")).toBe(true);
    }
    expect(events.some(event => event.phase === "person_tool_delivery" && event.event === "failed")).toBe(true);
    const output = JSON.stringify([events, content]);
    for (const secret of ["provider-private-body", PRINCIPAL_ID, MEMBERSHIP_ID, "U12345679", CODE, TOKEN]) expect(output).not.toContain(secret);
  });

  it("reports an old challenge schema as unavailable when constructed directly", async () => {
    const context = await setup();
    context.database.exec("DROP TRIGGER organization_person_slack_link_challenges_terminal_update; ALTER TABLE organization_person_slack_link_challenges DROP COLUMN dm_channel_id; ALTER TABLE organization_person_slack_link_challenges DROP COLUMN recipient_user_id");
    expect((await context.application.tools("bearer")).tools[0]).toMatchObject({ availability: "unavailable", personal_status: "unavailable" });
    await expect(context.application.begin(beginRequest(), "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.postIdentityLinkChallenge).not.toHaveBeenCalled();
  });

  it("requires current authentication for tools status", async () => {
    const context = await setup(() => { throw new Error("synthetic denied"); });
    await expect(context.application.tools("bearer")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("expires proofs and refuses changed recipients at final verification", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    const completion = { request_id: "psc_00000000-0000-4000-8000-000000000001", challenge_attempt_id: begun.challenge_attempt_id, challenge_message_ts: begun.challenge_message_ts, challenge_code: CODE };
    vi.mocked(context.slack.observeIdentityLinkChallenge).mockResolvedValue({ team_id: "T12345678", user_id: "UOTHER", channel_id: begun.channel_id, challenge_message_ts: begun.challenge_message_ts, reply_message_ts: "100.000002", verification_evidence_sha256: canonicalSha256("other") });
    await expect(context.application.complete(completion, "bearer")).rejects.toMatchObject({ code: "conflict" });
    current = { ...authorization, checked_at: "2026-08-22T00:16:00.000Z" };
    await expect(context.application.complete(completion, "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect((await context.application.tools("bearer")).tools[0]?.personal_status).toBe("unlinked");
  });

  it("rejects a subject already linked to a different member", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete({ request_id: "psc_00000000-0000-4000-8000-000000000001", challenge_attempt_id: begun.challenge_attempt_id, challenge_message_ts: begun.challenge_message_ts, challenge_code: CODE }, "bearer");
    current = { ...authorization, principal_id: "prn_00000000-0000-4000-8000-000000000002", membership_id: "mem_00000000-0000-4000-8000-000000000002" };
    const second = await context.application.begin({ ...beginRequest("psb_00000000-0000-4000-8000-000000000002"), challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(OTHER_CODE) }, "bearer");
    await expect(context.application.complete({ request_id: "psc_00000000-0000-4000-8000-000000000002", challenge_attempt_id: second.challenge_attempt_id, challenge_message_ts: second.challenge_message_ts, challenge_code: OTHER_CODE }, "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect((await context.application.tools("bearer")).tools[0]?.personal_status).toBe("unlinked");
  });

  it("serializes racing completions and persists the exact private destination", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    expect(context.database.prepare("SELECT dm_channel_id, recipient_user_id FROM organization_person_slack_link_challenges").get()).toEqual({ dm_channel_id: "D12345678", recipient_user_id: "U12345679" });
    expect(() => context.database.prepare("UPDATE organization_person_slack_link_challenges SET dm_channel_id = 'DOTHER'").run()).toThrow();
    const completion = { request_id: "psc_00000000-0000-4000-8000-000000000001", challenge_attempt_id: begun.challenge_attempt_id, challenge_message_ts: begun.challenge_message_ts, challenge_code: CODE };
    const [a, b] = await Promise.all([context.application.complete(completion, "bearer"), context.application.complete(completion, "bearer")]);
    expect(a).toEqual(b);
    expect(context.database.prepare("SELECT COUNT(*) AS n FROM organization_external_human_link_current").get()).toEqual({ n: 1 });
  });

  it("posts a challenge, completes the exact proof, and replays completion without re-observing Slack", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    const completion = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
      challenge_code: CODE,
    };
    const completed = await context.application.complete(completion, "bearer");
    expect(completed).toMatchObject({
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      provider_subject_id: "U12345679",
      identity_link_created: true,
    });
    await expect(context.application.complete(completion, "bearer")).resolves.toEqual(
      completed,
    );
    expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledTimes(1);
    expect((await context.application.tools("bearer")).tools).toEqual([{ provider: "slack", availability: "enabled", personal_status: "linked", workspace_id: "T12345678", account_id: "U12345679" }]);
    for (const table of ["organization_approval_action_capability_current", "organization_approval_binding_current"]) {
      expect(context.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    const contract = context.database.prepare("SELECT contract_json FROM organization_external_human_link_contracts").get() as { contract_json: string };
    expect(JSON.parse(contract.contract_json).membership_type).toBe("employee");
    context.database.prepare("UPDATE organization_external_human_link_current SET current_status = 'revoked'").run();
    expect((await context.application.tools("bearer")).tools[0]).toMatchObject({ personal_status: "revoked", account_id: null });
  });

  it("denies a wrong code and a different authenticated Person session", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    const input = {
      request_id: "psc_00000000-0000-4000-8000-000000000001",
      challenge_attempt_id: begun.challenge_attempt_id,
      challenge_message_ts: begun.challenge_message_ts,
    };
    await expect(
      context.application.complete({ ...input, challenge_code: OTHER_CODE }, "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });

    current = {
      ...authorization,
      membership_id: "mem_00000000-0000-4000-8000-000000000002",
      identity_binding_id: "oib_00000000-0000-4000-8000-000000000002",
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
    };
    await expect(
      context.application.complete({ ...input, challenge_code: CODE }, "bearer"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("dispatches an authenticated begin through the configured Person HTTP server", async () => {
    const context = await setup();
    const server = createOrganizationAuthorityHttpServer({
      descriptor: {} as never,
      sessions: {} as never,
      oidc_provider: {} as never,
      expected_issuer: "https://issuer.example",
      person_external_identity_link:
        createSlackExternalIdentityHttpApplicationV1({
          service: context.application,
        }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("test HTTP server did not bind TCP");
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/v2/integration-links/slack/challenges`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer bearer",
            "content-type": "application/json",
          },
          body: JSON.stringify(beginRequest()),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        provider: "slack",
        channel_id: "D12345678",
      });
      expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();
      const toolsResponse = await fetch(`http://127.0.0.1:${String(address.port)}/v2/person/tools`, { headers: { authorization: "Bearer bearer" } });
      expect(toolsResponse.status).toBe(200);
      expect(await toolsResponse.json()).toMatchObject({ membership_id: MEMBERSHIP_ID, tools: [{ personal_status: "unlinked" }] });
      const malformed = await fetch(`http://127.0.0.1:${String(address.port)}/v2/integration-links/slack/challenges`, {
        method: "POST", headers: { authorization: "Bearer bearer", "content-type": "application/json" }, body: JSON.stringify({ ...beginRequest(), recipient_user_id: "" }),
      });
      expect(malformed.status).toBe(400);
      const denied = await fetch(`http://127.0.0.1:${String(address.port)}/v2/person/tools`);
      expect(denied.status).toBe(401);
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
