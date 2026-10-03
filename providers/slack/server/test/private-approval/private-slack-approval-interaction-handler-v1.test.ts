import { createHmac } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../../src/organization-control-plane/slack-approval-integration-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1, privateSlackApprovalBlockKitActionIdV1 } from "../../src/private-approval/private-slack-approval-block-kit-card-v1.js";
import { privateSlackApprovalBlockKitActionIdV2, privateSlackApprovalBlockKitOwnerActionIdV3 } from "../../src/private-approval/private-slack-approval-block-kit-card-v2.js";
import { createPrivateSlackApprovalInteractionHandlerV1 } from "../../src/private-approval/private-slack-approval-interaction-handler-v1.js";
import { createPrivateSlackApprovalHttpAdapterV1 } from "../../src/private-approval/private-slack-approval-http-adapter-v1.js";
import { startOrganizationAuthorityServiceLifecycle } from "../../../../../services/organization-authority/src/composition/organization-authority-service-lifecycle.js";
import { createOrganizationAuthorityHttpServer } from "../../../../../services/organization-authority/src/presentation/organization-authority-http-server.js";

function journeyTelemetry(input: {
  readonly queue_age_ms?: number | null;
  readonly throw_on?: "capture" | "begin" | "succeed" | "fail";
}) {
  const events: string[] = [];
  return {
    events,
    telemetry: {
      captureClock: () => {
        events.push("capture");
        if (input.throw_on === "capture") throw new Error("telemetry capture failed");
        return { observed_at: "2026-08-28T21:59:59.000Z", monotonic_ms: 10 };
      },
      beginStageForApproval: (
        _approvalId: string,
        stage: "meeting_approval_action_verify" | "meeting_approval_action_queue",
      ) => {
        events.push(`begin:${stage}`);
        if (input.throw_on === "begin") throw new Error("telemetry begin failed");
        return { stage };
      },
      queueAgeMs: () => {
        events.push("queue-age");
        return input.queue_age_ms ?? null;
      },
      markCardStaged: (_approvalId: string, observedAt?: string) => {
        events.push(`card-staged:${observedAt ?? "now"}`);
      },
      succeedStage: (attempt: { readonly stage: string } | null, details?: unknown) => {
        events.push(`succeed:${attempt?.stage}:${JSON.stringify(details ?? {})}`);
        if (input.throw_on === "succeed") throw new Error("telemetry succeed failed");
      },
      failStage: (attempt: { readonly stage: string } | null) => {
        events.push(`fail:${attempt?.stage}`);
        if (input.throw_on === "fail") throw new Error("telemetry fail failed");
      },
    },
  };
}

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const CARD = {
  approval_id: "apr_00000000-0000-4000-8000-000000000001",
};
const POLICY_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
);
const COMMENT_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
);
const APPROVE_ID = privateSlackApprovalBlockKitActionIdV1(
  CARD,
  PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
);

function raw(input?: {
  readonly action_id?: string;
  readonly selected_option?: unknown;
  readonly comment?: string;
  readonly hash?: string;
  readonly state?: unknown;
}): Uint8Array {
  const actionId = input?.action_id ?? APPROVE_ID;
  const payload = {
    type: "block_actions",
    user: { id: "U012ABCDEF", team_id: "T012ABCDEF" },
    api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: {
      type: "message",
      channel_id: "D012ABCDEF",
      message_ts: "1712345678.123456",
      is_ephemeral: false,
    },
    team: { id: "T012ABCDEF", domain: "echo" },
    enterprise: null,
    is_enterprise_install: false,
    ...(input?.hash === undefined ? {} : { hash: input.hash }),
    channel: { id: "D012ABCDEF", name: "directmessage" },
    message: {
      type: "message",
      user: "U098BOTAPP",
      ts: "1712345678.123456",
      app_id: "A012ABCDEF",
      bot_id: "B012ABCDEF",
      blocks: [],
    },
    state: {
      values:
        input?.state ??
        {
          policy: {
            [POLICY_ID]: {
              type: "radio_buttons",
              selected_option:
                input !== undefined && Object.hasOwn(input, "selected_option")
                  ? input.selected_option
                  : {
                      text: { type: "plain_text", text: "Team", emoji: false },
                      value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
                    },
            },
          },
          comment: {
            [COMMENT_ID]: {
              type: "plain_text_input",
              value: input?.comment ?? "Ship it.",
            },
          },
        },
    },
    actions: [
      {
        type: actionId === POLICY_ID ? "radio_buttons" : "button",
        action_id: actionId,
        block_id: "actions",
        value: JSON.stringify({ schema_version: 1, ...CARD }),
        action_ts: "1712345680.123456",
      },
    ],
  };
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  );
}

function request(body: Uint8Array, secret = SECRET) {
  const signature = createHmac("sha256", secret)
    .update(`v0:${NOW}:`)
    .update(body)
    .digest("hex");
  return {
    raw_body: body,
    content_type: "application/x-www-form-urlencoded",
    slack_request_timestamp: String(NOW),
    slack_signature: `v0=${signature}`,
  };
}

function rawV2(input?: {
  readonly reject?: boolean;
  readonly projects?: readonly unknown[];
  readonly policy_id?: "project-members-readable-person-v1" | "organization-member-readable-person-v2" | "restricted-reviewer-person-v2";
  /** A V3 card: its owner fields by action place, as the approver left them. */
  readonly owners?: Readonly<Record<string, string | null>>;
  readonly owner_approval_id?: string;
  readonly button_version?: 2 | 3;
}): Uint8Array {
  const policy = privateSlackApprovalBlockKitActionIdV2(CARD, "policy");
  const projects = privateSlackApprovalBlockKitActionIdV2(CARD, "projects");
  const transcript = privateSlackApprovalBlockKitActionIdV2(CARD, "share-transcript");
  const comment = privateSlackApprovalBlockKitActionIdV2(CARD, "comment");
  const terminal = privateSlackApprovalBlockKitActionIdV2(CARD, input?.reject === true ? "reject" : "approve");
  const policyId = input?.policy_id ?? "project-members-readable-person-v1";
  const policyText = policyId === "project-members-readable-person-v1"
    ? "Projects"
    : policyId === "organization-member-readable-person-v2"
      ? "Team"
      : "Only me";
  const payload = {
    type: "block_actions", user: { id: "U012ABCDEF", team_id: "T012ABCDEF" }, api_app_id: "A012ABCDEF",
    trigger_id: "1234567890.1234567890.abcdefghijklmnopqrstuvwxyzABCD",
    container: { type: "message", channel_id: "D012ABCDEF", message_ts: "1712345678.123456", is_ephemeral: false },
    team: { id: "T012ABCDEF", domain: "echo" }, enterprise: null, is_enterprise_install: false,
    channel: { id: "D012ABCDEF", name: "directmessage" },
    message: { type: "message", user: "U098BOTAPP", ts: "1712345678.123456", app_id: "A012ABCDEF", bot_id: "B012ABCDEF", blocks: [] },
    state: { values: {
      policy: { [policy]: { type: "static_select", selected_option: { text: { type: "plain_text", text: policyText, emoji: false }, value: policyId } } },
      projects: { [projects]: { type: "multi_static_select", selected_options: input?.projects ?? [{ text: { type: "plain_text", text: "Launch", emoji: false }, value: "prj_11111111-1111-4111-8111-111111111111" }] } },
      transcript: { [transcript]: { type: "checkboxes", selected_options: [{ text: { type: "plain_text", text: "Share", emoji: false }, value: "share-transcript-v1" }] } },
      comment: { [comment]: { type: "plain_text_input", value: "Project release." } },
      ...Object.fromEntries(Object.entries(input?.owners ?? {}).map(([index, value]) => [`owner-${index}`, { [privateSlackApprovalBlockKitOwnerActionIdV3({ approval_id: input?.owner_approval_id ?? CARD.approval_id }, Number(index))]: { type: "plain_text_input", value } }])),
    } },
    actions: [{ type: "button", action_id: terminal, block_id: "actions", value: JSON.stringify({ schema_version: input?.button_version ?? (input?.owners === undefined ? 2 : 3), ...CARD }), action_ts: "1712345680.123456" }],
  };
  return new TextEncoder().encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
}

describe("private Slack interactions application V1", () => {
  it("durably dispatches V2 project and transcript choices through the V2 receipt API", async () => {
    const enqueueV2 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue: vi.fn(), enqueueV2 },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
    });
    await expect(application.accept(request(rawV2()))).resolves.toBe("accepted");
    expect(enqueueV2).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 2,
      action: "approve",
      selected_policy_id: "project-members-readable-person-v1",
      selected_project_ids: ["prj_11111111-1111-4111-8111-111111111111"],
      share_transcript: true,
      comment: "Project release.",
    }));
  });

  it("durably dispatches a V3 card's owner fields, kept, edited or cleared, through the V3 receipt API", async () => {
    const enqueueV3 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const enqueueV2 = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2, enqueueV3 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2({ owners: { 3: "  Priya   Shah ", 0: "Jules", 7: null } })))).resolves.toBe("accepted");
    expect(enqueueV2).not.toHaveBeenCalled();
    expect(enqueueV3).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 3, kind: "echo-private-approval-signed-block-action-receipt-v3", action: "approve",
      selected_policy_id: "project-members-readable-person-v1",
      action_owners: [{ action_index: 0, owner: "Jules" }, { action_index: 3, owner: "Priya Shah" }, { action_index: 7, owner: null }],
    }));
  });

  it("records no owners for a V3 rejection", async () => {
    const enqueueV3 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV3 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2({ reject: true, owners: { 0: "Jules" } })))).resolves.toBe("accepted");
    expect(enqueueV3).toHaveBeenCalledWith(expect.objectContaining({ action: "reject", action_owners: [] }));
  });

  it.each([
    ["an owner field of another approval", { owners: { 0: "Jules" }, owner_approval_id: "apr_00000000-0000-4000-8000-000000000009" }],
    ["an owner with a control character", { owners: { 0: "Jules\u0007" } }],
    ["an owner longer than 120 characters", { owners: { 0: "J".repeat(121) } }],
  ] as const)("refuses a V3 approval carrying %s", async (_label, variant) => {
    const enqueueV3 = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV3 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2(variant)))).rejects.toMatchObject({ code: "invalid_request" });
    expect(enqueueV3).not.toHaveBeenCalled();
  });

  it("refuses owner fields on a V2 card, and a V3 card without any", async () => {
    const enqueueV2 = vi.fn(); const enqueueV3 = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2, enqueueV3 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2({ owners: { 0: "Jules" }, button_version: 2 })))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(application.accept(request(rawV2({ button_version: 3 })))).rejects.toMatchObject({ code: "invalid_request" });
    expect(enqueueV2).not.toHaveBeenCalled(); expect(enqueueV3).not.toHaveBeenCalled();
  });

  it("allows rejection after selecting Projects without a project selection", async () => {
    const enqueueV2 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2({ reject: true, projects: [] })))).resolves.toBe("accepted");
    expect(enqueueV2).toHaveBeenCalledWith(expect.objectContaining({ action: "reject", selected_policy_id: null, selected_project_ids: [], share_transcript: false }));
  });

  it.each([
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
  ] as const)("refuses to approve %s with projects chosen, never dropping them silently", async (policy_id) => {
    const enqueueV2 = vi.fn();
    const rejections: string[] = [];
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z",
      on_rejection: ({ stage }) => { rejections.push(stage); } });

    await expect(application.accept(request(rawV2({ policy_id })))).rejects.toMatchObject({ code: "invalid_request" });
    expect(enqueueV2).not.toHaveBeenCalled();
    expect(rejections).toEqual(["state"]);
  });

  it.each([
    "organization-member-readable-person-v2",
    "restricted-reviewer-person-v2",
  ] as const)("approves %s with no projects chosen", async (policy_id) => {
    const enqueueV2 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });

    await expect(application.accept(request(rawV2({ policy_id, projects: [] })))).resolves.toBe("accepted");
    expect(enqueueV2).toHaveBeenCalledWith(expect.objectContaining({
      action: "approve",
      selected_policy_id: policy_id,
      selected_project_ids: [],
    }));
  });

  it("allows rejection with projects chosen under another audience, dropping them", async () => {
    const enqueueV2 = vi.fn(() => ({ disposition: "resolution" as const, receipt: {} as never, receipt_sha256: `sha256:${"d".repeat(64)}` as const, idempotent: false }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });
    await expect(application.accept(request(rawV2({ reject: true, policy_id: "restricted-reviewer-person-v2" })))).resolves.toBe("accepted");
    expect(enqueueV2).toHaveBeenCalledWith(expect.objectContaining({ action: "reject", selected_policy_id: null, selected_project_ids: [] }));
  });

  it("still rejects Projects approval without a selected project", async () => {
    const enqueueV2 = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({ signing_secret: () => SECRET, persistence: { enqueue: vi.fn(), enqueueV2 }, now_unix_seconds: () => NOW, now: () => "2026-08-28T22:00:00.000Z" });

    await expect(application.accept(request(rawV2({ projects: [] })))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(enqueueV2).not.toHaveBeenCalled();
  });
  it("durably writes a digest-only verified terminal receipt before accepting it", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "resolution",
        receipt: expect.objectContaining({
          action: "approve",
          action_id: APPROVE_ID,
          approval_id: CARD.approval_id,
          selected_policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          comment: "Ship it.",
          received_at: "2026-08-28T22:00:00.000Z",
          verified_at: "2026-08-28T22:00:00.000Z",
        }),
      }),
    );
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("response_url");
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("trigger_id");
  });

  it("records verified human action before durable queueing, including sidecar queue age", async () => {
    const telemetry = journeyTelemetry({ queue_age_ms: 42_000 });
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      journey_telemetry: telemetry.telemetry as never,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(telemetry.events).toEqual([
      "capture",
      "begin:meeting_approval_action_verify",
      "queue-age",
      'succeed:meeting_approval_action_verify:{"queue_age_ms":42000}',
      "capture",
      "begin:meeting_approval_action_queue",
      "succeed:meeting_approval_action_queue:{}",
    ]);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("restores a durable staged wait anchor before a click measures queue age", async () => {
    const telemetry = journeyTelemetry({ queue_age_ms: 42_000 });
    const readStagedAt = vi.fn(() => "2026-08-28T21:18:00.000Z");
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: {
        enqueue: () => ({
          disposition: "resolution" as const,
          receipt: {} as never,
          receipt_sha256: `sha256:${"d".repeat(64)}` as const,
          idempotent: false,
        }),
      },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      journey_telemetry: telemetry.telemetry as never,
      read_durable_card_staged_at: readStagedAt,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(readStagedAt).toHaveBeenCalledWith(CARD.approval_id);
    expect(telemetry.events).toContain("card-staged:2026-08-28T21:18:00.000Z");
    expect(telemetry.events.indexOf("card-staged:2026-08-28T21:18:00.000Z"))
      .toBeLessThan(telemetry.events.indexOf("queue-age"));
  });

  it("does not read the durable wait anchor before HMAC and parser success", async () => {
    const readStagedAt = vi.fn(() => "2026-08-28T21:18:00.000Z");
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue: vi.fn() },
      now_unix_seconds: () => NOW,
      journey_telemetry: journeyTelemetry({}).telemetry as never,
      read_durable_card_staged_at: readStagedAt,
    });

    await expect(application.accept(request(raw(), "wrong-secret"))).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(application.accept(request(raw({ state: {} })))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(readStagedAt).not.toHaveBeenCalled();
  });

  it("does not read the durable wait anchor when staging telemetry is absent", async () => {
    const readStagedAt = vi.fn(() => "2026-08-28T21:18:00.000Z");
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      read_durable_card_staged_at: readStagedAt,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(readStagedAt).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps durable enqueue and acknowledgement fail-open when wait recovery throws", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const readStagedAt = vi.fn(() => {
      throw new Error("telemetry sidecar unavailable");
    });
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      journey_telemetry: journeyTelemetry({}).telemetry as never,
      read_durable_card_staged_at: readStagedAt,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(readStagedAt).toHaveBeenCalledWith(CARD.approval_id);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("signals the wake hook only after the terminal receipt is durably queued", async () => {
    const order: string[] = [];
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: {
        enqueue: () => {
          order.push("enqueue");
          return {
            disposition: "resolution" as const,
            receipt: {} as never,
            receipt_sha256: `sha256:${"d".repeat(64)}` as const,
            idempotent: false,
          };
        },
      },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      on_action_queued: () => order.push("wake"),
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(order).toEqual(["enqueue", "wake"]);
  });

  it("does not signal the wake hook when durable enqueue fails", async () => {
    const wake = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue: () => { throw new Error("database busy"); } },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      on_action_queued: wake,
    });

    await expect(application.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("writes the HTTP acknowledgement before an idle worker starts publication", async () => {
    const order: string[] = [];
    let closing = false;
    let queued = false;
    let publicationStarted!: () => void;
    const published = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: {} as never, worker_interval_ms: 60_000 },
      {
        processing: {
          recoverV4Appends: async () => undefined,
          pollAndStageAdmittedMeetings: async () => undefined,
          observeAndFinalizePendingApprovals: async () => {
            if (!queued) return;
            // This synchronous prefix stands in for SQLite finalization. It
            // must not run until the HTTP acknowledgement has been written.
            order.push("publication");
            publicationStarted();
          },
          appendFinalizedApprovalsToV4: async () => undefined,
          reconcileReadableSearchGeneration: async () => undefined,
        },
        start_api_runtime: async () => ({
          address: { address: "127.0.0.1", family: "IPv4", port: 0 },
          close: async () => undefined,
        }),
      },
    );
    // Wait for the initial periodic cycle; the click must exercise an idle
    // gate, where runExclusive starts its operation synchronously.
    await runtime.runExclusive(async () => undefined);
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: {
        enqueue: () => {
          queued = true;
          order.push("enqueue");
          return {
            disposition: "resolution" as const,
            receipt: {} as never,
            receipt_sha256: `sha256:${"d".repeat(64)}` as const,
            idempotent: false,
          };
        },
      },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      on_action_queued: () => runtime.requestApprovalPublication(),
    });
    const ingress = createPrivateSlackApprovalHttpAdapterV1(application);
    const server = createOrganizationAuthorityHttpServer({
      is_closing: () => closing,
      descriptor: {} as never,
      sessions: {} as never,
      oidc_provider: {} as never,
      expected_issuer: "https://issuer.example",
      private_approval_interaction_ingress: ingress,
    });
    server.prependListener("request", (_request, response) => {
      response.once("finish", () => order.push("acknowledgement"));
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test HTTP server did not bind TCP");
      }
      const signed = request(raw());
      const response = await fetch(`http://127.0.0.1:${address.port}${ingress.routes[0]!.path}`, {
        method: "POST",
        headers: {
          "content-type": signed.content_type,
          "x-slack-request-timestamp": signed.slack_request_timestamp,
          "x-slack-signature": signed.slack_signature,
        },
        body: Buffer.from(signed.raw_body),
      });
      await response.text();
      expect(response.status).toBe(200);
      await published;
      expect(order).toEqual(["enqueue", "acknowledgement", "publication"]);
      closing = true;
      const rejected = await fetch(`http://127.0.0.1:${address.port}${ingress.routes[0]!.path}`, {
        method: "POST",
        headers: {
          "content-type": signed.content_type,
          "x-slack-request-timestamp": signed.slack_request_timestamp,
          "x-slack-signature": signed.slack_signature,
        },
        body: Buffer.from(signed.raw_body),
      });
      expect(rejected.status).toBe(503);
      await rejected.text();
      expect(order.filter((item) => item === "enqueue")).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.close();
    }
  }, 10_000);

  it("keeps the acknowledgement when the wake hook throws", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      on_action_queued: () => {
        throw new Error("worker unavailable");
      },
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("closes queue telemetry as failed when durable enqueue fails", async () => {
    const telemetry = journeyTelemetry({});
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue: () => { throw new Error("database busy"); } },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      journey_telemetry: telemetry.telemetry as never,
    });

    await expect(application.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(telemetry.events).toContain("fail:meeting_approval_action_queue");
    expect(telemetry.events).not.toContain("fail:meeting_approval_action_verify");
  });

  it("keeps replay acknowledgements and telemetry failures fail-open", async () => {
    const telemetry = journeyTelemetry({ throw_on: "succeed" });
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: true,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
      journey_telemetry: telemetry.telemetry as never,
    });

    await expect(application.accept(request(raw()))).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(telemetry.events).toContain("succeed:meeting_approval_action_queue:{}");
  });

  it("acknowledges a verified selector event without persisting it", async () => {
    const enqueue = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
    });

    await expect(
      application.accept(request(raw({ action_id: POLICY_ID }))),
    ).resolves.toBe(
      "accepted",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reads a signing secret getter on every request and fails closed without one", async () => {
    let secret = SECRET;
    const signingSecret = vi.fn(() => secret);
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: signingSecret,
      persistence: { enqueue: vi.fn() },
      now_unix_seconds: () => NOW,
    });
    const selector = raw({ action_id: POLICY_ID });
    await expect(application.accept(request(selector))).resolves.toBe("accepted");
    secret = "rotated-signing-secret";
    await expect(application.accept(request(selector))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(application.accept(request(selector, "rotated-signing-secret"))).resolves.toBe("accepted");
    signingSecret.mockImplementationOnce(() => { throw new Error(`bundle unreadable ${SECRET}`); });
    const failure = await application.accept(request(selector)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(String(failure)).not.toContain(SECRET);
    expect(signingSecret).toHaveBeenCalledTimes(4);
  });

  it("uses the narrow card default for untouched radio state and accepts media-type parameters", async () => {
    const enqueue = vi.fn(() => ({
      disposition: "resolution" as const,
      receipt: {} as never,
      receipt_sha256: `sha256:${"d".repeat(64)}` as const,
      idempotent: false,
    }));
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "2026-08-28T22:00:00.000Z",
    });
    const body = raw({
      selected_option: null,
      comment: "testing",
      hash: "1787980217.abcdef0123456789",
    });

    await expect(
      application.accept({
        ...request(body),
        content_type: "Application/X-Www-Form-Urlencoded; charset=utf-8",
      }),
    ).resolves.toBe("accepted");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({
          selected_policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          comment: "testing",
        }),
      }),
    );
  });

  it("separates authentication failures, malformed media, and durable queue failure", async () => {
    const queueFailure = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: {
        enqueue: async () => {
          throw new Error("database busy");
        },
      },
      now_unix_seconds: () => NOW,
    });
    await expect(queueFailure.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });

    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: {
        enqueue: () => ({
          disposition: "resolution" as const,
          receipt: {} as never,
          receipt_sha256: `sha256:${"d".repeat(64)}` as const,
          idempotent: false,
        }),
      },
      now_unix_seconds: () => NOW,
    });
    await expect(
      application.accept({ ...request(raw()), content_type: "application/json" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(application.accept(request(raw(), "wrong-secret"))).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("reports only verified parser rejection stages without changing failures", async () => {
    const onRejection = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue: vi.fn() },
      now_unix_seconds: () => NOW,
      on_rejection: onRejection,
    });

    await expect(
      application.accept(request(raw({ state: {} }))),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(onRejection).toHaveBeenCalledExactlyOnceWith({ stage: "state" });
    expect(JSON.stringify(onRejection.mock.calls)).toBe('[[{"stage":"state"}]]');

    await expect(
      application.accept(request(raw(), "wrong-secret")),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(onRejection).toHaveBeenCalledTimes(1);
  });

  it("does not persist when its durable receipt clock is non-canonical", async () => {
    const enqueue = vi.fn();
    const application = createPrivateSlackApprovalInteractionHandlerV1({
      signing_secret: () => SECRET,
      persistence: { enqueue },
      now_unix_seconds: () => NOW,
      now: () => "not-a-time",
    });

    await expect(application.accept(request(raw()))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
