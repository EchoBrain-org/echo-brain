import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it, vi } from "vitest";
import type { SlackBrowserIdentityProvider } from "../../../../../src/adapters/oidc/slack-browser-identity-provider.js";
import type { PersonAccessAuthorization } from "../../../../../src/application/person-identity-sessions.js";
import type { ActiveSlackOrganizationTool } from "@echo-brain/organization-control-plane/slack-external-identity-integration-v1";
import { SlackPersonBrowserIdentityLinkWorkflowV1 } from "../../../../../src/composition/providers/slack/person-identity/slack-person-browser-identity-link-workflow-v1.js";
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from "../../../../../src/shared/core-runtime-observation-v1.js";

const NOW = "2026-09-10T22:00:00.000Z";
const authorization: PersonAccessAuthorization = {
  organization_id: "org_00000000-0000-4000-8000-000000000001",
  principal_id: "prn_00000000-0000-4000-8000-000000000001",
  membership_id: "mem_00000000-0000-4000-8000-000000000001",
  membership_type: "employee",
  identity_binding_id: "oib_00000000-0000-4000-8000-000000000001",
  session_family_id: "psf_00000000-0000-4000-8000-000000000001",
  access_credential_sha256: canonicalSha256("access"), access_expires_at: "2026-09-11T00:00:00.000Z",
  hard_reauthentication_at: "2026-09-11T00:00:00.000Z", person_state_sha256: canonicalSha256("person"),
  session_state_sha256: canonicalSha256("session"), checked_at: NOW,
};
const tool = Object.freeze({ connection_attempt_id: "verify_1", connection_id: "con_00000000-0000-4000-8000-000000000001",
  team_id: "T123", enterprise_id: null, bot_user_id: "Ubot", bot_id: "B123", app_id: "A123", channel_id: "C123",
  approve_reaction: "white_check_mark", reject_reaction: "x", granted_scopes: [], secret: { secret_backend_id: "authority-file-v1" as const, secret_handle_id: "con_00000000-0000-4000-8000-000000000001" } });

function setup(input: { now?: () => string; authorization?: () => PersonAccessAuthorization; proof?: { user_id: string; team_id: string } } = {}) {
  const commit = vi.fn();
  const activeSlackOrganizationTool = vi.fn<() => ActiveSlackOrganizationTool | null>(() => tool);
  const repository = { activeSlackOrganizationTool, completeBrowserSlackIdentityLink: commit };
  const authorizationUrl = vi.fn<SlackBrowserIdentityProvider["authorizationUrl"]>(async () => "https://slack.com/openid/connect/authorize?opaque=yes");
  const verifyCallback = vi.fn<SlackBrowserIdentityProvider["verifyCallback"]>(async () => ({ user_id: input.proof?.user_id ?? "U123", team_id: input.proof?.team_id ?? "T123", verification_evidence_sha256: canonicalSha256("proof") }));
  const provider: SlackBrowserIdentityProvider = {
    authorizationUrl,
    verifyCallback,
  };
  const workflow = new SlackPersonBrowserIdentityLinkWorkflowV1({
    authority_id: "oau_00000000-0000-4000-8000-000000000001", organization_id: authorization.organization_id,
    authentication: { authenticateAccess: vi.fn(input.authorization ?? (() => authorization)) },
    repository,
    browser_provider: provider, now: input.now ?? (() => NOW),
  });
  return { workflow, provider, authorizationUrl, verifyCallback, commit, repository };
}

describe("Slack browser identity link workflow", () => {
  it("does not persist a callback proof until the authenticated status poll", async () => {
    const { workflow, authorizationUrl, commit } = setup();
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    expect(commit).not.toHaveBeenCalled();
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "complete", failure_reason: null });
    expect(commit).toHaveBeenCalledOnce();
    expect(JSON.stringify(commit.mock.calls)).not.toContain("code");
  });

  it("refuses a status poll from a different current Person session", async () => {
    let current = authorization;
    const { workflow, authorizationUrl, commit } = setup({ authorization: () => current });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    current = { ...authorization, session_family_id: "psf_00000000-0000-4000-8000-000000000002" };
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).rejects.toMatchObject({ code: "unauthorized" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("exposes only a safe failure when Slack proves a different workspace", async () => {
    const { workflow, authorizationUrl, commit } = setup({ proof: { user_id: "U123", team_id: "TOTHER" } });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "secret-code" }));
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toEqual(expect.objectContaining({ status: "failed", failure_reason: "provider_rejected" }));
    expect(commit).not.toHaveBeenCalled();
  });

  it("accepts Slack's W-prefixed subject format", async () => {
    const { workflow, authorizationUrl, commit } = setup({ proof: { user_id: "W123", team_id: "T123" } });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "complete" });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("marks a rejected callback invalid-output without exporting OAuth material", async () => {
    const { workflow, authorizationUrl } = setup({ proof: { user_id: "U123", team_id: "TOTHER" } });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    const events: CoreRuntimeObservationV1[] = [];
    const content: unknown[] = [];
    await observeCoreRuntimeV1("http_request", async () => {
      await workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "sensitive-oauth-code" }));
    }, { observer: (event) => { events.push(event); }, content_observer: (event) => { content.push(event); } });
    expect(events.some((event) => event.phase === "person_tool_completion" && event.event === "succeeded" && event.result === "invalid_output")).toBe(true);
    expect(JSON.stringify([events, content])).not.toContain("sensitive-oauth-code");
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "failed", failure_reason: "provider_rejected" });
  });

  it("cancels, expires, and treats an absent process-memory attempt as safely expired", async () => {
    let now = NOW;
    const { workflow } = setup({ now: () => now });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await expect(workflow.cancel({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "cancelled" });
    const second = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000002" }, "bearer");
    now = "2026-09-10T22:06:00.000Z";
    await expect(workflow.status({ attempt_id: second.attempt_id }, "bearer")).resolves.toMatchObject({ status: "expired" });
    await expect(workflow.status({ attempt_id: "sbl_00000000-0000-4000-8000-000000000099" }, "bearer")).resolves.toMatchObject({ status: "expired" });
  });

  it("supersedes a slow lost begin response without returning its stale authorization URL", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { workflow, authorizationUrl } = setup();
    authorizationUrl.mockImplementationOnce(async () => { await held; return "https://slack.com/openid/connect/authorize?opaque=yes"; });
    const first = workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await vi.waitFor(() => expect(authorizationUrl).toHaveBeenCalledOnce());
    const second = workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000002" }, "bearer");
    release!();
    await expect(first).rejects.toMatchObject({ code: "conflict" });
    await expect(second).resolves.toMatchObject({ kind: "echo-person-slack-browser-link-v1" });
  });

  it("replays the exact request while its authorization URL is still being built", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { workflow, authorizationUrl } = setup();
    authorizationUrl.mockImplementationOnce(async () => { await held; return "https://slack.com/openid/connect/authorize?opaque=yes"; });
    const input = { request_id: "psb_00000000-0000-4000-8000-000000000003" };
    const first = workflow.begin(input, "bearer");
    await vi.waitFor(() => expect(authorizationUrl).toHaveBeenCalledOnce());
    const replay = workflow.begin(input, "bearer");
    release!();
    await expect(replay).resolves.toEqual(await first);
    expect(authorizationUrl).toHaveBeenCalledOnce();
  });

  it("lets the same Person retry after a session-family restart while old status remains fenced", async () => {
    let current = authorization;
    const { workflow } = setup({ authorization: () => current });
    const first = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    current = { ...authorization, session_family_id: "psf_00000000-0000-4000-8000-000000000002" };
    const second = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000002" }, "bearer");
    await expect(workflow.status({ attempt_id: first.attempt_id }, "bearer")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(workflow.status({ attempt_id: second.attempt_id }, "bearer")).resolves.toMatchObject({ status: "pending" });
  });

  it("expires a proof that returns after its five-minute browser window", async () => {
    let now = NOW;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { workflow, authorizationUrl, verifyCallback, commit } = setup({ now: () => now });
    verifyCallback.mockImplementationOnce(async () => { await held; return { user_id: "U123", team_id: "T123", verification_evidence_sha256: canonicalSha256("proof") }; });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    const callback = workflow.callback(new URLSearchParams({ state: authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    await vi.waitFor(() => expect(verifyCallback).toHaveBeenCalledOnce());
    now = "2026-09-10T22:06:00.000Z";
    release!();
    await callback;
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "expired" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports a changed organization tool and a real durable-link conflict safely", async () => {
    const unavailable = setup();
    const first = await unavailable.workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    await unavailable.workflow.callback(new URLSearchParams({ state: unavailable.authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    unavailable.repository.activeSlackOrganizationTool.mockReturnValue(null);
    await expect(unavailable.workflow.status({ attempt_id: first.attempt_id }, "bearer")).resolves.toMatchObject({ status: "failed", failure_reason: "tool_unavailable" });

    const conflict = setup();
    conflict.commit.mockImplementationOnce(() => { const error = new Error("already linked"); error.name = "PersonSlackIdentityLinkConflictError"; throw error; });
    const second = await conflict.workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000002" }, "bearer");
    await conflict.workflow.callback(new URLSearchParams({ state: conflict.authorizationUrl.mock.calls[0]![0].state, code: "code" }));
    await expect(conflict.workflow.status({ attempt_id: second.attempt_id }, "bearer")).resolves.toMatchObject({ status: "failed", failure_reason: "identity_conflict" });
  });

  it("consumes callback state once and cannot commit after cancellation during exchange", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { workflow, authorizationUrl, verifyCallback, commit } = setup();
    verifyCallback.mockImplementationOnce(async () => { await held; return { user_id: "U123", team_id: "T123", verification_evidence_sha256: canonicalSha256("proof") }; });
    const begun = await workflow.begin({ request_id: "psb_00000000-0000-4000-8000-000000000001" }, "bearer");
    const state = authorizationUrl.mock.calls[0]![0].state;
    const first = workflow.callback(new URLSearchParams({ state, code: "code" }));
    await vi.waitFor(() => expect(verifyCallback).toHaveBeenCalledOnce());
    await workflow.callback(new URLSearchParams({ state, code: "second-code" }));
    await workflow.cancel({ attempt_id: begun.attempt_id }, "bearer");
    release!();
    await first;
    await expect(workflow.status({ attempt_id: begun.attempt_id }, "bearer")).resolves.toMatchObject({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
  });
});
