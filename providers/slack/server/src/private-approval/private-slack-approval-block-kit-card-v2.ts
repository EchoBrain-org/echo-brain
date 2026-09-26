/**
 * Project-scoped extension of the frozen private-approval presentation.
 *
 * V1 cards deliberately remain byte-for-byte V1.  This module builds a new
 * presentation and gives every new control a V2 action identifier so a signed
 * action cannot be replayed across the two contracts.
 */
import { createHash } from "node:crypto";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../organization-control-plane/slack-approval-integration-v1.js";
import {
  buildPrivateSlackApprovalBlockKitCardV1,
  type PrivateSlackApprovalActionItemV1,
  type PrivateSlackApprovalDecisionGroupV1,
  type PrivateSlackApprovalReviewItemV1,
} from "./private-slack-approval-block-kit-card-v1.js";

export const PRIVATE_SLACK_APPROVAL_BLOCK_KIT_CARD_V2_KIND =
  "echo-private-approval-block-kit-card-v2" as const;

export const PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2 = Object.freeze({
  policy: "policy",
  projects: "projects",
  share_transcript: "share-transcript",
  comment: "comment",
  approve: "approve",
  reject: "reject",
} as const);

export type PrivateSlackApprovalBlockKitActionV2 =
  (typeof PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2)[keyof typeof PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2];

export interface PrivateSlackApprovalEligibleProjectV2 {
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly name: string;
}

export interface PrivateSlackApprovalBlockKitCardInputV2 {
  readonly schema_version: 2;
  readonly approval_id: string;
  readonly meeting_title: string;
  readonly decision_groups: readonly PrivateSlackApprovalDecisionGroupV1[];
  readonly eligible_projects: readonly PrivateSlackApprovalEligibleProjectV2[];
  readonly ungrouped_actions?: readonly PrivateSlackApprovalActionItemV1[];
  readonly ungrouped_rationales?: readonly PrivateSlackApprovalReviewItemV1[];
}

export interface PrivateSlackApprovalBlockKitCardV2 {
  readonly schema_version: 2;
  readonly kind: typeof PRIVATE_SLACK_APPROVAL_BLOCK_KIT_CARD_V2_KIND;
  readonly approval_id: string;
  readonly text: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly transport: { readonly mrkdwn: false; readonly unfurl_links: false; readonly unfurl_media: false };
}

const PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_MEMBERSHIP_ID = /^pgm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DISPLAY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const PROJECT_POLICY_ID = "project-members-readable-person-v1";
const SLACK_OPTION_TEXT_MAX = 75;
const SLACK_BLOCK_MAX = 50;

function invalid(detail: string): never {
  throw new Error(`private approval Block Kit card v2 ${detail}`);
}

function plain(text: string) {
  return Object.freeze({ type: "plain_text" as const, text, emoji: false as const });
}

/** Slack option labels are capped at 75 characters; the frozen name is retained separately. */
function projectOptionLabel(project: PrivateSlackApprovalEligibleProjectV2): string {
  const suffix = ` · ${project.project_id.slice(-8)}`;
  const limit = SLACK_OPTION_TEXT_MAX - suffix.length;
  return project.name.length <= limit ? project.name : `${project.name.slice(0, limit - 1).trimEnd()}…${suffix}`;
}

function actionId(approvalId: string, action: PrivateSlackApprovalBlockKitActionV2): string {
  const key = createHash("sha256")
    .update(`echo-private-approval-v2\u0000${approvalId}`)
    .digest("hex")
    .slice(0, 32);
  return `echo-private-approval-v2-${key}-${action}-v2`;
}

export function privateSlackApprovalBlockKitActionIdV2(
  input: Pick<PrivateSlackApprovalBlockKitCardInputV2, "approval_id">,
  action: PrivateSlackApprovalBlockKitActionV2,
): string {
  return actionId(input.approval_id, action);
}

function blockId(approvalId: string, name: string): string {
  const key = createHash("sha256")
    .update(`echo-private-approval-v2\u0000${approvalId}`)
    .digest("hex")
    .slice(0, 32);
  return `echo-private-approval-v2-${key}-${name}-v2`;
}

function validate(input: PrivateSlackApprovalBlockKitCardInputV2): void {
  if (input.schema_version !== 2 || typeof input.approval_id !== "string" || input.approval_id.length === 0) invalid("has invalid identity");
  // Slack permits 100 static-select options. Selection itself is capped at 20
  // by the neutral V2 command, so do not silently hide an active project.
  if (!Array.isArray(input.eligible_projects) || input.eligible_projects.length > 100) invalid("eligible_projects must contain at most 100 projects");
  let prior = "";
  for (const [index, project] of input.eligible_projects.entries()) {
    if (project === null || typeof project !== "object" || Array.isArray(project) || Object.keys(project).sort().join(",") !== "name,project_id,project_membership_id") invalid(`eligible_projects[${index}] has unexpected fields`);
    if (!PROJECT_ID.test(project.project_id) || !PROJECT_MEMBERSHIP_ID.test(project.project_membership_id)) invalid(`eligible_projects[${index}] has invalid identifiers`);
    if (typeof project.name !== "string" || project.name.trim() !== project.name || project.name.length === 0 || project.name.length > 200 || DISPLAY_CONTROLS.test(project.name)) invalid(`eligible_projects[${index}].name is invalid`);
    if (project.project_id <= prior) invalid("eligible_projects must be canonically ordered and unique");
    prior = project.project_id;
  }
}

/** Build the project/toggle controls around the already-tested complete V1 review. */
export function buildPrivateSlackApprovalBlockKitCardV2(
  input: PrivateSlackApprovalBlockKitCardInputV2,
): PrivateSlackApprovalBlockKitCardV2 {
  validate(input);
  const base = buildPrivateSlackApprovalBlockKitCardV1({
    schema_version: 1,
    approval_id: input.approval_id,
    meeting_title: input.meeting_title,
    decision_groups: input.decision_groups,
    ...(input.ungrouped_actions === undefined ? {} : { ungrouped_actions: input.ungrouped_actions }),
    ...(input.ungrouped_rationales === undefined ? {} : { ungrouped_rationales: input.ungrouped_rationales }),
  });
  const retained = base.blocks.filter((block) => {
    const id = (block as { readonly block_id?: unknown }).block_id;
    return typeof id !== "string" || !/-(divider|policy|comment|actions|footer)-v1$/.test(id);
  });
  const projects = input.eligible_projects.map((project) => Object.freeze({
    text: plain(projectOptionLabel(project)),
    value: project.project_id,
    description: plain("Current project members can read this record"),
  }));
  const policyOptions = Object.freeze([
    Object.freeze({ text: plain("Only me"), value: RESTRICTED_REVIEWER_PERSON_POLICY_ID, description: plain("Only you can read this record") }),
    Object.freeze({ text: plain("Team"), value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, description: plain("Current organization members can read it") }),
    ...(projects.length === 0 ? [] : [Object.freeze({ text: plain("Projects"), value: PROJECT_POLICY_ID, description: plain("Current members of selected projects can read it") })]),
  ]);
  const blocks: Readonly<Record<string, unknown>>[] = [
    ...retained,
    { type: "divider", block_id: blockId(input.approval_id, "divider") },
    { type: "input", block_id: blockId(input.approval_id, "policy"), optional: false, label: plain("Who should be able to read this record?"), element: { type: "static_select", action_id: actionId(input.approval_id, "policy"), placeholder: plain("Choose who can read this record"), options: policyOptions, initial_option: policyOptions[0] } },
    ...(projects.length === 0
      ? [{ type: "context", block_id: blockId(input.approval_id, "projects-unavailable"), elements: [plain("You have no active projects available to share with.")] }]
      : [{ type: "input", block_id: blockId(input.approval_id, "projects"), optional: true, label: plain("Projects to share with"), hint: plain("Choose one or more only when Projects is selected."), element: { type: "multi_static_select", action_id: actionId(input.approval_id, "projects"), placeholder: plain("Choose projects"), options: projects, max_selected_items: 20 } }]),
    { type: "input", block_id: blockId(input.approval_id, "share-transcript"), optional: true, label: plain("Transcript"), element: { type: "checkboxes", action_id: actionId(input.approval_id, "share-transcript"), options: [Object.freeze({ text: plain("Share transcript with the selected audience"), value: "share-transcript-v1", description: plain("Off by default. Decisions and transcript are approved separately.") })] } },
    { type: "input", block_id: blockId(input.approval_id, "comment"), optional: true, label: plain("Note for the record (optional)"), element: { type: "plain_text_input", action_id: actionId(input.approval_id, "comment"), multiline: false, max_length: PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS, placeholder: plain("Add context for this approval") } },
    { type: "actions", block_id: blockId(input.approval_id, "actions"), elements: [
      { type: "button", action_id: actionId(input.approval_id, "approve"), style: "primary", text: plain("Approve meeting"), value: JSON.stringify({ schema_version: 2, approval_id: input.approval_id }) },
      { type: "button", action_id: actionId(input.approval_id, "reject"), style: "danger", text: plain("Reject"), value: JSON.stringify({ schema_version: 2, approval_id: input.approval_id }) },
    ] },
    { type: "context", block_id: blockId(input.approval_id, "footer"), elements: [plain("One visibility policy applies to the entire meeting record. Transcript sharing is separate and off by default.")] },
  ];
  if (blocks.length > SLACK_BLOCK_MAX) invalid("exceeds Slack's 50 block limit");
  const text = `${base.text.replace("Visibility: Only me (default) or Team.", "Visibility: Only me (default), Team, or selected Projects.")}\nTranscript sharing is off by default.`;
  return Object.freeze({ schema_version: 2, kind: PRIVATE_SLACK_APPROVAL_BLOCK_KIT_CARD_V2_KIND, approval_id: input.approval_id, text, blocks: Object.freeze(blocks), transport: base.transport });
}
