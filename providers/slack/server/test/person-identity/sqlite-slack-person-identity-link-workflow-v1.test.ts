import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { SlackIdentityProviderErrorV1 } from "../../src/organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { readActiveSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-active-connection-v1.js";
import { describe, expect, it, vi } from "vitest";
import { createSqliteSlackPersonIdentityLinkWorkflowV1, createSqliteSlackPersonIdentityLinkRepositoryV1 } from "../../src/person-identity/sqlite-slack-person-identity-link-repository-v1.js";
import { SlackPersonBrowserIdentityLinkWorkflowV1 } from "../../src/person-identity/slack-person-browser-identity-link-workflow-v1.js";
import { AUTHORITY_ID, authorization, beginRequest, CODE, MEMBERSHIP_ID, NOW, ORGANIZATION_ID, OTHER_CODE, PRINCIPAL_ID, setup, TOKEN, tokenAccess, workflowOptions } from "./fixtures.js";

function completeRequest(
  begun: { readonly challenge_attempt_id: string; readonly challenge_message_ts: string },
  code = CODE,
  n = 1,
) {
  return {
    request_id: `psc_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    challenge_attempt_id: begun.challenge_attempt_id,
    challenge_message_ts: begun.challenge_message_ts,
    challenge_code: code,
  };
}

describe("Person Slack identity-link workflow", () => {
  it("reads the organization's enabled tools and this authenticated employee's status", async () => {
    const context = await setup();
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
      ...beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE),
      recipient_user_id: "UOTHER",
    }, "bearer")).rejects.toMatchObject({ code: "conflict" });

    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce();
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    current = { ...authorization, checked_at: "2026-08-22T00:00:59.000Z" };
    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000003", OTHER_CODE),
      recipient_user_id: "UOTHER",
    }, "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce();
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    current = { ...authorization, checked_at: "2026-08-22T00:01:00.000Z" };
    await expect(context.application.begin(beginRequest("psb_00000000-0000-4000-8000-000000000004", OTHER_CODE), "bearer")).resolves.toMatchObject({ provider: "slack" });
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2);
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledTimes(2);
  });

  it("applies the delivery cooldown after completion across a restarted Person session", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(completeRequest(begun), "bearer");
    expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2);

    current = {
      ...authorization,
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
      session_state_sha256: canonicalSha256("restarted-session"),
    };
    await expect(context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000003", OTHER_CODE),
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
    await vi.waitFor(() => expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce(), { interval: 1 });
    const second = context.application.begin(beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE), "bearer");
    await vi.waitFor(() => expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledTimes(2), { interval: 1 });
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
    await observeCoreRuntimeV1("http_request", async () => {
      await context.application.tools("bearer");
      const begun = await context.application.begin(beginRequest(), "bearer");
      await context.application.complete(completeRequest(begun), "bearer");
      current = { ...authorization, checked_at: "2026-08-22T00:01:00.000Z" };
      vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockRejectedValue(new Error("provider-private-body"));
      await expect(context.application.begin(beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE), "bearer")).rejects.toMatchObject({ code: "unavailable" });
    }, { observer: event => { events.push(event); } });
    for (const phase of ["person_tools_status", "person_tool_delivery", "person_tool_completion"]) {
      expect(events.some(event => event.phase === phase && event.event === "succeeded")).toBe(true);
    }
    expect(events.some(event => event.phase === "person_tool_delivery" && event.event === "failed")).toBe(true);
    const output = JSON.stringify(events);
    for (const secret of ["provider-private-body", PRINCIPAL_ID, MEMBERSHIP_ID, "U12345679", CODE, TOKEN]) expect(output).not.toContain(secret);
  });

  it("requires current authentication for tools status", async () => {
    const context = await setup(() => { throw new Error("synthetic denied"); });
    await expect(context.application.tools("bearer")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("expires proofs and refuses changed recipients at final verification", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const begun = await context.application.begin(beginRequest(), "bearer");
    const completion = completeRequest(begun);
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
    await context.application.complete(completeRequest(begun), "bearer");
    current = { ...authorization, principal_id: "prn_00000000-0000-4000-8000-000000000002", membership_id: "mem_00000000-0000-4000-8000-000000000002" };
    const second = await context.application.begin(beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE), "bearer");
    await expect(context.application.complete(completeRequest(second, OTHER_CODE, 2), "bearer")).rejects.toMatchObject({ code: "conflict" });
    expect((await context.application.tools("bearer")).tools[0]?.personal_status).toBe("unlinked");
  });

  it("serializes racing completions and persists the exact private destination", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    expect(context.database.prepare("SELECT dm_channel_id, recipient_user_id FROM organization_person_slack_link_challenges").get()).toEqual({ dm_channel_id: "D12345678", recipient_user_id: "U12345679" });
    expect(() => context.database.prepare("UPDATE organization_person_slack_link_challenges SET dm_channel_id = 'DOTHER'").run()).toThrow();
    const completion = completeRequest(begun);
    const [a, b] = await Promise.all([context.application.complete(completion, "bearer"), context.application.complete(completion, "bearer")]);
    expect(a).toEqual(b);
    expect(context.database.prepare("SELECT COUNT(*) AS n FROM organization_external_human_link_current").get()).toEqual({ n: 1 });
  });

  it("posts a challenge, completes the exact proof, and replays completion without re-observing Slack", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledOnce();

    const completion = completeRequest(begun);
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
    const contract = context.database.prepare("SELECT contract_json FROM organization_external_human_link_contracts").get() as { contract_json: string };
    expect(JSON.parse(contract.contract_json).membership_type).toBe("employee");
    context.database.prepare("UPDATE organization_external_human_link_current SET current_status = 'revoked'").run();
    expect((await context.application.tools("bearer")).tools[0]).toMatchObject({ personal_status: "revoked", account_id: null });
  });

  it.each(["employee", "owner"] as const)("disconnects only the current %s's Slack association, preserves history, and is idempotent", async (membership_type) => {
    const person = { ...authorization, membership_type };
    const context = await setup(() => person);
    const begun = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(completeRequest(begun), "bearer");

    await expect(context.application.disconnect({}, "bearer")).resolves.toMatchObject({
      organization_id: ORGANIZATION_ID,
      membership_id: MEMBERSHIP_ID,
      tools: [{ provider: "slack", availability: "enabled", personal_status: "revoked", account_id: null }],
    });
    await expect(context.application.disconnect({}, "bearer")).resolves.toMatchObject({
      tools: [{ personal_status: "revoked", account_id: null }],
    });
    expect(context.database.prepare("SELECT current_status FROM organization_external_human_link_current").get()).toEqual({ current_status: "revoked" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM organization_external_human_link_contracts").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT current_status FROM organization_tool_connection_current_state").get()).toEqual({ current_status: "active" });
  });

  it("uses the current Person session and leaves another member's Slack link active", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const first = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(completeRequest(first), "bearer");
    current = {
      ...authorization,
      principal_id: "prn_00000000-0000-4000-8000-000000000002",
      membership_id: "mem_00000000-0000-4000-8000-000000000002",
      identity_binding_id: "oib_00000000-0000-4000-8000-000000000002",
      session_family_id: "psf_00000000-0000-4000-8000-000000000002",
      checked_at: "2026-08-22T00:01:00.000Z",
    };
    vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockImplementation(async (_token, recipient) => ({
      team_id: "T12345678", channel_id: "D12345678", recipient_user_id: recipient,
    }));
    vi.mocked(context.slack.observeIdentityLinkChallenge).mockResolvedValueOnce({
      team_id: "T12345678", user_id: "U98765432", channel_id: "D12345678",
      challenge_message_ts: "100.000001", reply_message_ts: "100.000002",
      verification_evidence_sha256: canonicalSha256("other-member"),
    });
    const second = await context.application.begin({
      ...beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE),
      recipient_user_id: "U98765432",
    }, "bearer");
    await context.application.complete(completeRequest(second, OTHER_CODE, 2), "bearer");

    await context.application.disconnect({}, "bearer");
    expect(context.database.prepare("SELECT current_status FROM organization_external_human_link_current WHERE membership_id = ?").get(MEMBERSHIP_ID)).toEqual({ current_status: "active" });
    expect(context.database.prepare("SELECT current_status FROM organization_external_human_link_current WHERE membership_id = ?").get(current.membership_id)).toEqual({ current_status: "revoked" });
  });

  it("allows an explicit DM reconnect after the existing delivery cooldown", async () => {
    let current = authorization;
    const context = await setup(() => current);
    const first = await context.application.begin(beginRequest(), "bearer");
    await context.application.complete(completeRequest(first), "bearer");
    await context.application.disconnect({}, "bearer");
    current = { ...authorization, checked_at: "2026-08-22T00:01:00.000Z" };

    const second = await context.application.begin(beginRequest("psb_00000000-0000-4000-8000-000000000002", OTHER_CODE), "bearer");
    await context.application.complete(completeRequest(second, OTHER_CODE, 2), "bearer");
    expect((await context.application.tools("bearer")).tools).toMatchObject([{ personal_status: "linked", account_id: "U12345679" }]);
  });

  it("invalidates a DM begin that crosses a disconnect before it can persist", async () => {
    const context = await setup();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(context.slack.openIdentityLinkDirectMessage!).mockImplementationOnce(async () => {
      await held;
      return { team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "U12345679" };
    });

    const begin = context.application.begin(beginRequest(), "bearer");
    await vi.waitFor(() => expect(context.slack.openIdentityLinkDirectMessage).toHaveBeenCalledOnce(), { interval: 1 });
    await context.application.disconnect({}, "bearer");
    release!();

    await expect(begin).rejects.toMatchObject({ code: "conflict" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM organization_person_slack_link_challenges").get()).toEqual({ count: 0 });
  });

  it("invalidates a DM completion that crosses a disconnect", async () => {
    const context = await setup();
    const begun = await context.application.begin(beginRequest(), "bearer");
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(context.slack.observeIdentityLinkChallenge).mockImplementationOnce(async (_token, input) => {
      await held;
      return {
        team_id: "T12345678", user_id: "U12345679", channel_id: input.channel_id,
        challenge_message_ts: input.challenge_message_ts, reply_message_ts: "100.000002",
        verification_evidence_sha256: canonicalSha256("observed"),
      };
    });
    const completion = context.application.complete(completeRequest(begun), "bearer");
    await vi.waitFor(() => expect(context.slack.observeIdentityLinkChallenge).toHaveBeenCalledOnce(), { interval: 1 });
    await context.application.disconnect({}, "bearer");
    release!();

    await expect(completion).rejects.toMatchObject({ code: "conflict" });
    expect((await context.application.tools("bearer")).tools).toMatchObject([{ personal_status: "unlinked" }]);
  });

  it("retries a rejected bot token once with a refreshed one, then reports the active connection", async () => {
    const context = await setup();
    const rejected = new SlackIdentityProviderErrorV1("Slack rejected the integration verification request", "unauthorized", true);
    const onRejected = vi.fn();
    const readActiveSlackBotToken = vi.fn(async (_connection: unknown, options?: { force_refresh?: boolean }) =>
      options?.force_refresh === true ? "xoxb-refreshed" : TOKEN);
    const verifiedConnection = vi.mocked(context.slack.verifyConnection).getMockImplementation()!;
    const application = (rejections: number) => {
      let remaining = rejections;
      vi.mocked(context.slack.verifyConnection).mockImplementation(async (token) => {
        if (remaining > 0) { remaining -= 1; throw rejected; }
        return verifiedConnection(token);
      });
      return createSqliteSlackPersonIdentityLinkWorkflowV1(workflowOptions(context, {
        authentication: { authenticateAccess: () => authorization }, membership_type: () => "employee" as const,
        slack_token_access: tokenAccess(readActiveSlackBotToken, onRejected),
      }));
    };

    await expect(application(2).begin(beginRequest(), "bearer")).rejects.toMatchObject({ code: "invalid_request" });
    expect(readActiveSlackBotToken.mock.calls.map((call) => call[1])).toEqual([undefined, { force_refresh: true }]);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(onRejected.mock.calls[0]?.[0]).toMatchObject({
      state_sha256: readActiveSlackConnectionV1(context.database)!.state_sha256,
    });

    await application(1).begin(beginRequest(), "bearer");
    expect(context.slack.postIdentityLinkChallenge).toHaveBeenCalledWith("xoxb-refreshed", expect.anything(), undefined);
    expect(onRejected).toHaveBeenCalledOnce();
  });

  it("wires disconnect to cancel an in-flight browser callback before it can link", async () => {
    const context = await setup();
    let browser: SlackPersonBrowserIdentityLinkWorkflowV1;
    const configuration = workflowOptions(context, {
      authentication: { authenticateAccess: () => authorization },
      membership_type: () => "employee" as const,
      slack_token_access: tokenAccess(),
    });
    const application = createSqliteSlackPersonIdentityLinkWorkflowV1({
      ...configuration,
      invalidate_browser_attempts: (membershipId) => browser.invalidateMembership(membershipId),
    });
    let state = "";
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let markCallbackStarted: (() => void) | undefined;
    const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
    browser = new SlackPersonBrowserIdentityLinkWorkflowV1({
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      authentication: configuration.authentication,
      repository: createSqliteSlackPersonIdentityLinkRepositoryV1(configuration),
      browser_provider: () => ({
        authorizationUrl: (input) => { state = input.state; return "https://slack.com/openid/connect/authorize?opaque=yes"; },
        verifyCallback: async () => {
          markCallbackStarted!();
          await held;
          return { team_id: "T12345678", user_id: "U12345679", verification_evidence_sha256: canonicalSha256("browser-proof") };
        },
      }),
      now: () => NOW,
    });
    const begun = await browser.begin({ request_id: "psb_00000000-0000-4000-8000-000000000099" }, "bearer");
    const callback = browser.callback(new URLSearchParams({ state, code: "provider-code" }));
    await callbackStarted;
    await application.disconnect({}, "bearer");
    release!();
    await callback;

    await expect(browser.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "cancelled" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM organization_external_human_link_current").get()).toEqual({ count: 0 });
    const reconnect = await browser.begin({ request_id: "psb_00000000-0000-4000-8000-000000000100" }, "bearer");
    await browser.callback(new URLSearchParams({ state, code: "fresh-provider-code" }));
    await expect(browser.status({ attempt_id: reconnect.attempt_id }, "bearer")).resolves.toMatchObject({ status: "complete" });
    expect((await application.tools("bearer")).tools).toMatchObject([{ personal_status: "linked", account_id: "U12345679" }]);
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
});
