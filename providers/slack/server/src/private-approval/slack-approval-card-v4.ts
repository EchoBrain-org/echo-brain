import { createHash } from "node:crypto";
import {
  buildPrivateSlackApprovalBlockKitCardV1,
  type PrivateSlackApprovalBlockKitCardInputV1,
} from "./private-slack-approval-block-kit-card-v1.js";

export interface SlackApprovalProjectV4 {
  readonly project_id: string;
  readonly name: string;
}
export interface SlackApprovalOwnerProposalV4 {
  readonly signal_id: string;
  readonly action: string;
  readonly proposed: string;
}
export interface SlackApprovalCardV4 {
  readonly text: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly transport: {
    readonly mrkdwn: false;
    readonly unfurl_links: false;
    readonly unfurl_media: false;
  };
}
export interface SlackApprovalCardInputV4 {
  readonly approval_id: string;
  readonly snapshot_sha256: string;
  readonly review: PrivateSlackApprovalBlockKitCardInputV1;
  readonly projects: readonly SlackApprovalProjectV4[];
  readonly suggested_project_ids: readonly string[];
  readonly owners: readonly SlackApprovalOwnerProposalV4[];
}
const plain = (text: string) =>
  Object.freeze({ type: "plain_text" as const, text, emoji: false });
const key = (id: string) =>
  createHash("sha256")
    .update(`echo-approval-v4\0${id}`)
    .digest("hex")
    .slice(0, 32);
const id = (approval: string, name: string) =>
  `echo-approval-v4-${key(approval)}-${name}`;

/** Shared with the verified interaction parser. These identifiers bind controls to one approval without exposing card state. */
export function slackApprovalActionIdV4(
  approvalId: string,
  action:
    | "audience-select"
    | "projects-select"
    | "transcript-checkbox"
    | "approve"
    | "reject",
): string {
  return id(approvalId, action);
}
/** A signal id remains explicit so a submitted owner can never be re-associated by its rendered position. */
export function slackApprovalOwnerActionIdV4(
  approvalId: string,
  signalId: string,
): string {
  return id(approvalId, `owner-${signalId}`);
}

/** Builds the V4 controls around the existing complete review renderer. */
export function buildSlackApprovalCardV4(
  input: SlackApprovalCardInputV4,
): SlackApprovalCardV4 {
  if (input.projects.length > 100 || input.owners.length > 40)
    throw new Error("Slack approval card exceeds Slack limits");
  const base = buildPrivateSlackApprovalBlockKitCardV1(input.review);
  const retained = base.blocks.filter(
    (block) =>
      !["policy", "comment", "actions", "footer", "divider"].some(
        (name) =>
          (block as { block_id?: string }).block_id?.endsWith(`-${name}-v1`) ===
          true,
      ),
  );
  const projectLabel = (name: string) =>
    name.length <= 75 ? name : `${name.slice(0, 74).trimEnd()}…`;
  const projects = input.projects.map((project) =>
    Object.freeze({
      text: plain(projectLabel(project.name)),
      value: project.project_id,
      description: plain("Current project members can read this record"),
    }),
  );
  const suggested = projects.filter((project) =>
    input.suggested_project_ids.includes(project.value),
  );
  const blocks: Readonly<Record<string, unknown>>[] = [
    ...retained,
    ...input.owners.map((owner) => ({
      type: "input",
      block_id: id(input.approval_id, `owner-${owner.signal_id}`),
      optional: true,
      label: plain(`Owner · ${owner.action.slice(0, 140)}`),
      element: {
        type: "plain_text_input",
        action_id: slackApprovalOwnerActionIdV4(
          input.approval_id,
          owner.signal_id,
        ),
        initial_value: owner.proposed,
        max_length: 120,
        multiline: false,
      },
    })),
    { type: "divider", block_id: id(input.approval_id, "divider") },
    {
      type: "input",
      block_id: id(input.approval_id, "audience"),
      optional: false,
      label: plain("Who should be able to read this record?"),
      element: {
        type: "static_select",
        action_id: slackApprovalActionIdV4(
          input.approval_id,
          "audience-select",
        ),
        options: [
          { text: plain("Only me"), value: "only-me" },
          { text: plain("Projects"), value: "projects" },
        ],
        initial_option: {
          text: plain(suggested.length === 0 ? "Only me" : "Projects"),
          value: suggested.length === 0 ? "only-me" : "projects",
        },
      },
    },
    {
      type: "input",
      block_id: id(input.approval_id, "projects"),
      optional: true,
      label: plain("Projects to share with"),
      element: {
        type: "multi_static_select",
        action_id: slackApprovalActionIdV4(
          input.approval_id,
          "projects-select",
        ),
        options: projects,
        max_selected_items: 20,
        ...(suggested.length === 0 ? {} : { initial_options: suggested }),
      },
    },
    {
      type: "input",
      block_id: id(input.approval_id, "transcript"),
      optional: true,
      label: plain("Transcript"),
      element: {
        type: "checkboxes",
        action_id: slackApprovalActionIdV4(
          input.approval_id,
          "transcript-checkbox",
        ),
        options: [
          {
            text: plain("Share transcript with the selected audience"),
            value: "share-transcript-v1",
          },
        ],
      },
    },
    {
      type: "actions",
      block_id: id(input.approval_id, "actions"),
      elements: (["approve", "reject"] as const).map((action) => ({
        type: "button",
        action_id: slackApprovalActionIdV4(input.approval_id, action),
        ...(action === "approve" ? { style: "primary" } : { style: "danger" }),
        text: plain(action === "approve" ? "Approve meeting" : "Reject"),
        value: JSON.stringify({
          schema_version: 2,
          approval_id: input.approval_id,
          snapshot_sha256: input.snapshot_sha256,
        }),
      })),
    },
  ];
  if (blocks.length > 50)
    throw new Error("Slack approval card exceeds Slack limits");
  const text = base.text
    .replace(
      "Visibility: Only me (default) or Team.\nOptionally add a comment, then choose Approve or Reject.",
      "Visibility: Only me (default) or selected Projects.\nChoose Approve or Reject.",
    )
    .concat("\nTranscript sharing is off by default.");
  return Object.freeze({
    text,
    blocks: Object.freeze(blocks),
    transport: base.transport,
  });
}

export function buildClosedApprovalCardV4(input: {
  readonly title: string;
  readonly outcome: "approved" | "rejected" | "superseded";
  readonly surface?: "desktop" | "slack";
  readonly audience_label?: string | null;
}): SlackApprovalCardV4 {
  const message =
    input.outcome === "superseded"
      ? "Replaced by a newer version of this meeting"
      : `${input.outcome === "approved" ? "Approved" : "Rejected"} in ${input.surface === "slack" ? "Slack" : "the ECHO desktop"}`;
  const text =
    input.audience_label === undefined || input.audience_label === null
      ? message
      : `${message}\nAudience: ${input.audience_label}`;
  return Object.freeze({
    text,
    blocks: Object.freeze([{ type: "section", text: plain(text) }]),
    transport: Object.freeze({
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
}
