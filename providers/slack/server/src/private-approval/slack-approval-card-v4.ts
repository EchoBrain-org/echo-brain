import { createHash } from "node:crypto";
import {
  buildPrivateSlackApprovalReviewV1,
  type PrivateSlackApprovalBlockKitCardInputV1,
} from "./private-slack-approval-block-kit-card-v1.js";

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
  /** Where Approve sends every decision and action: the suggested projects the reviewer can read, by name; [] = only the reviewer. */
  readonly destination: readonly string[];
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
  action: "approve" | "reject",
): string {
  return id(approvalId, action);
}
/** Where items go, in one line: project names, or "Only you". */
export function slackApprovalDestinationV4(names: readonly string[]): string {
  return names.length === 0 ? "Only you" : names.join(", ");
}
/** A signal id remains explicit so a submitted owner can never be re-associated by its rendered position. */
export function slackApprovalOwnerActionIdV4(
  approvalId: string,
  signalId: string,
): string {
  return id(approvalId, `owner-${signalId}`);
}

/**
 * Builds the V4 controls below the complete review: owner inputs, one line saying where every item goes, and Approve or
 * Reject. Slack approves as suggested; choosing per item happens in the ECHO desktop app.
 */
export function buildSlackApprovalCardV4(
  input: SlackApprovalCardInputV4,
): SlackApprovalCardV4 {
  if (input.destination.length > 20 || input.owners.length > 40)
    throw new Error("Slack approval card exceeds Slack limits");
  const review = buildPrivateSlackApprovalReviewV1(input.review);
  const destination = slackApprovalDestinationV4(input.destination);
  const goesTo = `Goes to: ${destination.length <= 2_900 ? destination : `${destination.slice(0, 2_899).trimEnd()}…`}`;
  const blocks: Readonly<Record<string, unknown>>[] = [
    ...review.blocks,
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
      type: "section",
      block_id: id(input.approval_id, "destination"),
      text: plain(goesTo),
    },
    {
      type: "context",
      block_id: id(input.approval_id, "per-item"),
      elements: [plain("To choose per item, open the ECHO desktop app.")],
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
  const text = [
    review.text,
    goesTo,
    "Approve sends every decision and action there; choose per item in the ECHO desktop app.",
    "Choose Approve or Reject.",
  ].join("\n");
  return Object.freeze({
    text,
    blocks: Object.freeze(blocks),
    transport: Object.freeze({
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
}

/**
 * The card once decided or replaced. An approval names its destinations, one per destination group in group order (a
 * group's projects joined with " + ", "Only you" for the reviewer alone), so mixed destinations read as they were chosen.
 */
export function buildClosedApprovalCardV4(input: {
  readonly title: string;
  readonly outcome: "approved" | "rejected" | "superseded";
  readonly surface?: "desktop" | "slack";
  readonly destinations?: readonly string[];
}): SlackApprovalCardV4 {
  const message =
    input.outcome === "superseded"
      ? "Replaced by a newer version of this meeting"
      : `${input.outcome === "approved" ? "Approved" : "Rejected"} in ${input.surface === "slack" ? "Slack" : "the ECHO desktop"}`;
  const sent = input.destinations === undefined || input.destinations.length === 0 ? null : input.destinations.join(" · ");
  const text =
    sent === null
      ? message
      : `${message}\nSent to: ${sent.length <= 2_900 ? sent : `${sent.slice(0, 2_899).trimEnd()}…`}`;
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
