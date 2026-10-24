import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS,
  PrivateSlackApprovalInteractionError,
  parseVerifiedPrivateSlackApprovalInteractionV1,
  verifyPrivateSlackApprovalRequestV1,
} from "../../src/private-approval/private-slack-approval-interaction-protocol-v1.js";
import {
  buildSlackApprovalCardV4,
  slackApprovalActionIdV4,
  slackApprovalDestinationSha256V4,
  slackApprovalOwnerActionIdV4,
} from "../../src/private-approval/slack-approval-card-v4.js";

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const APPROVAL_ID = "apr_00000000-0000-4000-8000-000000000001";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const PROJECT_A = "prj_11111111-1111-4111-8111-111111111111";
const DESTINATION = slackApprovalDestinationSha256V4([PROJECT_A]);
const plain = (text: string) => ({ type: "plain_text", text, emoji: false });

function form(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    new URLSearchParams({ payload: JSON.stringify(value) }).toString(),
  );
}
function verify(raw: Uint8Array, timestamp = NOW) {
  const signature = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:`)
    .update(raw)
    .digest("hex");
  return verifyPrivateSlackApprovalRequestV1({
    raw_body: raw,
    signing_secret: SECRET,
    headers: {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    now_unix_seconds: NOW,
  });
}
/** A V4 click. The card's only state is its owner inputs; "owner-input" is a no-op edit of one. */
function payload(
  input: {
    readonly action?: "approve" | "reject" | "owner-input";
    readonly owners?: Readonly<Record<string, string | null>>;
    readonly snapshot?: string | null;
    readonly destination?: string | null;
    readonly schema_version?: number;
    readonly response_url?: string;
    readonly provider_metadata?: boolean;
    readonly state?: Record<string, unknown>;
  } = {},
) {
  const action = input.action ?? "approve";
  const ownerState = Object.fromEntries(
    Object.entries(input.owners ?? {}).map(([signal_id, owner]) => [
      `owner-${signal_id}`,
      {
        [slackApprovalOwnerActionIdV4(APPROVAL_ID, signal_id)]: {
          type: "plain_text_input",
          value: owner,
        },
      },
    ]),
  );
  const state = input.state ?? ownerState;
  return {
    // These are ordinary Slack metadata fields, not ECHO authority inputs.
    type: "block_actions",
    user: {
      id: "U012ABCDEF",
      team_id: "T012ABCDEF",
      username: "ada",
      name: "Ada Lovelace",
    },
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
    channel: { id: "D012ABCDEF", name: "directmessage" },
    message: {
      type: "message",
      user: "U098BOTAPP",
      username: "echo",
      text: "Your ECHO approval is ready",
      ts: "1712345678.123456",
      app_id: "A012ABCDEF",
      bot_id: "B012ABCDEF",
      bot_profile: { id: "B012ABCDEF", app_id: "A012ABCDEF", name: "echo" },
      blocks: [],
    },
    state: { values: state },
    ...(input.provider_metadata
      ? {
          hash: "156dd7a1b8c6a7bdf070d9c5d5b02a86",
          token: "deprecated-provider-token",
        }
      : {}),
    ...(input.response_url === undefined
      ? {}
      : { response_url: input.response_url }),
    actions: [
      {
        type: action === "owner-input" ? "plain_text_input" : "button",
        action_id: action === "owner-input" ? slackApprovalOwnerActionIdV4(APPROVAL_ID, "act_alpha") : slackApprovalActionIdV4(APPROVAL_ID, action),
        block_id: "actions",
        text: plain(action === "reject" ? "Reject" : "Approve"),
        value: JSON.stringify({
          schema_version: input.schema_version ?? 3,
          approval_id: APPROVAL_ID,
          ...(input.snapshot === null
            ? {}
            : { snapshot_sha256: input.snapshot ?? SNAPSHOT }),
          ...(input.destination === null
            ? {}
            : { destination_sha256: input.destination ?? DESTINATION }),
        }),
        action_ts: "1712345680.123456",
      },
    ],
  };
}
function unsigned(raw: Uint8Array) {
  return verifyPrivateSlackApprovalRequestV1({
    raw_body: raw,
    signing_secret: SECRET,
    headers: {
      "x-slack-request-timestamp": String(NOW),
      "x-slack-signature": "v0=00".padEnd(67, "0"),
    },
    now_unix_seconds: NOW,
  });
}
function parse(value: unknown) {
  return parseVerifiedPrivateSlackApprovalInteractionV1(verify(form(value)));
}
function rejected(value: unknown) {
  expect(() => parse(value)).toThrow(PrivateSlackApprovalInteractionError);
}

describe("private Slack approval interaction V4", () => {
  it("parses a signed V4 approval with signal-keyed owners, the card's destination digest and no response URL retention", () => {
    const result = parse(
      payload({
        owners: { act_alpha: "Ada Lovelace", act_beta: null },
        response_url: "https://hooks.slack.com/actions/T000/B000/fake",
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      schema_version: 4,
      disposition: "resolution",
      action: "approve",
      approval_id: APPROVAL_ID,
      snapshot_sha256: SNAPSHOT,
      destination_sha256: DESTINATION,
      owners: [{ signal_id: "act_alpha", owner: "Ada Lovelace" }],
    }));
    expect(Object.keys(result).sort()).toEqual(["action", "approval_id", "destination_sha256", "disposition", "lookup", "owners", "provider_action_key_sha256", "schema_version", "snapshot_sha256"]);
    expect(JSON.stringify(result)).not.toContain("response_url");
  });
  it("accepts signed Slack hash and token envelope metadata without retaining it", () => {
    const result = parse(payload({ provider_metadata: true }));
    expect(result).toMatchObject({ disposition: "resolution" });
    expect(JSON.stringify(result)).not.toContain("deprecated-provider-token");
  });
  it("needs no state but the owner inputs, and maps a reject to no owners", () => {
    expect(parse(payload())).toMatchObject({ disposition: "resolution", action: "approve", owners: [] });
    expect(parse(payload({ action: "reject", owners: { act_alpha: "Ada" } }))).toMatchObject({ disposition: "resolution", action: "reject", owners: [] });
  });
  it("round-trips the owner inputs and the button value the card emits", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: APPROVAL_ID,
      snapshot_sha256: SNAPSHOT,
      review: { schema_version: 1, approval_id: APPROVAL_ID, meeting_title: "Roadmap", decision_groups: [],
        ungrouped_actions: [{ text: "Send draft", evidence_reference: "Meeting transcript" }] },
      destination: ["Alpha"],
      destination_sha256: DESTINATION,
      owners: [{ signal_id: "act_alpha", action: "Send draft", proposed: "Ada" }],
    });
    const inputs = card.blocks.flatMap((block) => {
      const element = (block as { element?: { type: string; action_id: string } }).element;
      return element?.type === "plain_text_input" ? [element.action_id] : [];
    });
    expect(inputs).toEqual([slackApprovalOwnerActionIdV4(APPROVAL_ID, "act_alpha")]);
    expect(parse(payload({ owners: { act_alpha: "Ada L." } }))).toMatchObject({ owners: [{ signal_id: "act_alpha", owner: "Ada L." }] });
    const buttons = card.blocks.flatMap((block) => (block as { elements?: readonly { type: string; value?: string }[] }).elements ?? []).filter((element) => element.type === "button");
    expect(buttons.map((button) => JSON.parse(button.value!))).toEqual([0, 1].map(() => ({ schema_version: 3, approval_id: APPROVAL_ID, snapshot_sha256: SNAPSHOT, destination_sha256: DESTINATION })));
    const emitted = payload(); emitted.actions[0]!.value = buttons[0]!.value!;
    expect(parse(emitted)).toMatchObject({ approval_id: APPROVAL_ID, snapshot_sha256: SNAPSHOT, destination_sha256: DESTINATION });
  });
  it("refuses a button value without the destination its card showed, a malformed one, or the earlier value shape", () => {
    rejected(payload({ destination: null }));
    rejected(payload({ destination: "sha256:not-a-digest" }));
    rejected(payload({ destination: null, schema_version: 2 }));
    rejected(payload({ schema_version: 2 }));
    const extra = payload(); extra.actions[0]!.value = JSON.stringify({ ...JSON.parse(extra.actions[0]!.value), project_ids: [PROJECT_A] });
    rejected(extra);
  });
  it("refuses missing snapshots, the retired audience, project and transcript controls, legacy controls and unknown owners", () => {
    rejected(payload({ snapshot: null }));
    for (const retired of ["audience-select", "projects-select", "transcript-checkbox"]) {
      rejected(payload({ state: { [retired]: { [`echo-approval-v4-${"0".repeat(32)}-${retired}`]: { type: "static_select", selected_option: null } } } }));
    }
    rejected(payload({ state: { projects: { [`echo-approval-v4-${"0".repeat(32)}-projects-select`]: { type: "multi_static_select", selected_options: [{ text: plain("Alpha"), value: PROJECT_A }] } } } }));
    rejected(
      payload({
        action: "approve",
        state: {
          legacy: {
            "echo-private-approval-v2-deadbeef-policy-v2": {
              type: "static_select",
              selected_option: null,
            },
          },
        },
      }),
    );
    rejected(payload({ owners: { "not an authority signal": "Ada" } }));
    rejected(payload({ owners: { act_alpha: " padded " } }));
  });
  it("keeps original-byte HMAC, freshness and body-size enforcement before parsing", () => {
    const raw = form(payload());
    expect(() => unsigned(raw)).toThrow(PrivateSlackApprovalInteractionError);
    expect(() =>
      verify(raw, NOW + PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS + 1),
    ).toThrow(PrivateSlackApprovalInteractionError);
    expect(() => unsigned(new Uint8Array(64 * 1024 + 1))).toThrow(
      PrivateSlackApprovalInteractionError,
    );
  });
  it("accepts an owner input edit as a no-op, and no retired control", () => {
    expect(parse(payload({ action: "owner-input" }))).toMatchObject({ disposition: "presentation_change" });
    const malformed = payload({ action: "owner-input" });
    malformed.actions[0]!.type = "static_select";
    rejected(malformed);
    for (const [name, type] of [["audience-select", "static_select"], ["projects-select", "multi_static_select"], ["transcript-checkbox", "checkboxes"]] as const) {
      const retired = payload({ action: "owner-input" });
      retired.actions[0]!.action_id = slackApprovalOwnerActionIdV4(APPROVAL_ID, "x").replace(/owner-x$/, name);
      retired.actions[0]!.type = type;
      rejected(retired);
    }
  });
});
