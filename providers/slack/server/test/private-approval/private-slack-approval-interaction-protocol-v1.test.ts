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
  slackApprovalOwnerActionIdV4,
} from "../../src/private-approval/slack-approval-card-v4.js";

const SECRET = "not-a-real-signing-secret";
const NOW = 1_800_000_000;
const APPROVAL_ID = "apr_00000000-0000-4000-8000-000000000001";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const PROJECT_A = "prj_11111111-1111-4111-8111-111111111111";
const PROJECT_B = "prj_22222222-2222-4222-8222-222222222222";
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
function payload(
  input: {
    readonly action?: "approve" | "reject" | "audience-select";
    readonly audience?: "only-me" | "projects";
    readonly projects?: readonly string[];
    readonly project_options?: readonly unknown[];
    readonly owners?: Readonly<Record<string, string | null>>;
    readonly snapshot?: string | null;
    readonly response_url?: string;
    readonly provider_metadata?: boolean;
    readonly state?: Record<string, unknown>;
  } = {},
) {
  const action = input.action ?? "approve",
    audience = input.audience ?? "only-me";
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
  const state = input.state ?? {
    audience: {
      [slackApprovalActionIdV4(APPROVAL_ID, "audience-select")]: {
        type: "static_select",
        selected_option: {
          text: plain(audience === "projects" ? "Projects" : "Only me"),
          value: audience,
        },
      },
    },
    projects: {
      [slackApprovalActionIdV4(APPROVAL_ID, "projects-select")]: {
        type: "multi_static_select",
        selected_options: input.project_options ?? (input.projects ?? []).map((id) => ({
          text: plain(id === PROJECT_A ? "Alpha" : "Beta"),
          value: id,
          description: plain("Current project members can read this record"),
        })),
      },
    },
    transcript: {
      [slackApprovalActionIdV4(APPROVAL_ID, "transcript-checkbox")]: {
        type: "checkboxes",
        selected_options: [],
      },
    },
    ...ownerState,
  };
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
        type: action === "audience-select" ? "static_select" : "button",
        action_id: slackApprovalActionIdV4(APPROVAL_ID, action),
        block_id: "actions",
        text: plain(action === "reject" ? "Reject" : "Approve"),
        value: JSON.stringify({
          schema_version: 2,
          approval_id: APPROVAL_ID,
          ...(input.snapshot === null
            ? {}
            : { snapshot_sha256: input.snapshot ?? SNAPSHOT }),
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
  it("parses a signed V4 project approval with signal-keyed owners and no response URL retention", () => {
    const result = parse(
      payload({
        audience: "projects",
        projects: [PROJECT_A, PROJECT_B],
        owners: { act_alpha: "Ada Lovelace" },
        response_url: "https://hooks.slack.com/actions/T000/B000/fake",
      }),
    );
    expect(result).toMatchObject({
      disposition: "resolution",
      action: "approve",
      approval_id: APPROVAL_ID,
      snapshot_sha256: SNAPSHOT,
      audience: "projects",
      project_ids: [PROJECT_A, PROJECT_B],
      share_transcript: false,
      owners: [{ signal_id: "act_alpha", owner: "Ada Lovelace" }],
    });
    expect(JSON.stringify(result)).not.toContain("response_url");
  });
  it("accepts signed Slack hash and token envelope metadata without retaining it", () => {
    const result = parse(payload({ provider_metadata: true }));
    expect(result).toMatchObject({ disposition: "resolution" });
    expect(JSON.stringify(result)).not.toContain("deprecated-provider-token");
  });
  it("round-trips the complete V4 project option emitted by the card", () => {
    const card = buildSlackApprovalCardV4({
      approval_id: APPROVAL_ID,
      snapshot_sha256: SNAPSHOT,
      review: {
        schema_version: 1,
        approval_id: APPROVAL_ID,
        meeting_title: "Roadmap",
        decision_groups: [],
        ungrouped_actions: [
          { text: "Send draft", evidence_reference: "Meeting transcript" },
        ],
      },
      projects: [{ project_id: PROJECT_A, name: "Alpha" }],
      suggested_project_ids: [PROJECT_A],
      owners: [],
    });
    const projects = (
      card.blocks.find((block) =>
        (block as { block_id?: string }).block_id?.endsWith("-projects"),
      ) as { element: { options: readonly unknown[] } }
    ).element.options;
    expect(parse(payload({ audience: "projects", project_options: projects }))).toMatchObject({
      disposition: "resolution",
      audience: "projects",
      project_ids: [PROJECT_A],
    });
  });
  it("accepts only-me with zero project options and maps a reject to empty choices", () => {
    expect(parse(payload())).toMatchObject({
      disposition: "resolution",
      audience: "only-me",
      project_ids: [],
      owners: [],
    });
    expect(
      parse(payload({ audience: "only-me", projects: [PROJECT_A] })),
    ).toMatchObject({
      disposition: "resolution",
      audience: "only-me",
      project_ids: [],
    });
    expect(
      parse(
        payload({
          action: "reject",
          audience: "projects",
          projects: [PROJECT_A],
          owners: { act_alpha: "Ada" },
        }),
      ),
    ).toMatchObject({
      disposition: "resolution",
      action: "reject",
      project_ids: [],
      share_transcript: false,
      owners: [],
    });
  });
  it("accepts an Only me card with the unavailable project picker omitted", () => {
    const { projects: _projects, ...state } = payload().state.values;
    expect(parse(payload({ state }))).toMatchObject({
      disposition: "resolution",
      action: "approve",
      audience: "only-me",
      project_ids: [],
      share_transcript: false,
    });
  });
  it("canonicalizes Slack selection order but refuses missing snapshots, legacy controls, unknown owners, duplicate or 21 project choices, and incomplete state", () => {
    rejected(payload({ snapshot: null }));
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
    expect(
      parse(
        payload({ audience: "projects", projects: [PROJECT_B, PROJECT_A] }),
      ),
    ).toMatchObject({ project_ids: [PROJECT_A, PROJECT_B] });
    rejected(
      payload({ audience: "projects", projects: [PROJECT_A, PROJECT_A] }),
    );
    rejected(
      payload({
        audience: "projects",
        projects: Array.from(
          { length: 21 },
          (_, index) =>
            `prj_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        ),
      }),
    );
    rejected(payload({ state: {} }));
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
  it("accepts only the expected Slack type for each V4 no-op control", () => {
    const cases: readonly [string, string][] = [
      ["audience-select", "static_select"],
      ["projects-select", "multi_static_select"],
      ["transcript-checkbox", "checkboxes"],
      ["owner-act_alpha", "plain_text_input"],
    ];
    for (const [name, type] of cases) {
      const interaction = payload({ action: "audience-select" });
      interaction.actions[0]!.action_id = slackApprovalActionIdV4(
        APPROVAL_ID,
        name as "audience-select",
      );
      interaction.actions[0]!.type = type;
      expect(parse(interaction)).toMatchObject({
        disposition: "presentation_change",
      });
    }
    const malformed = payload({ action: "audience-select" });
    malformed.actions[0]!.type = "plain_text_input";
    rejected(malformed);
  });
});
