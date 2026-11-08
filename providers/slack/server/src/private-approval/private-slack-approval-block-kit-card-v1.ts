import { createHash } from "node:crypto";

interface PrivateSlackApprovalReviewItemV1 {
  readonly text: string;
  readonly evidence_reference: string;
}

interface PrivateSlackApprovalDecisionGroupV1 {
  readonly id: string;
  readonly decision: PrivateSlackApprovalReviewItemV1 & { readonly status: "proposed" | "decided" | "unresolved" };
  readonly rationales: readonly PrivateSlackApprovalReviewItemV1[];
}

export interface PrivateSlackApprovalBlockKitCardInputV1 {
  readonly schema_version: 1;
  readonly approval_id: string;
  readonly meeting_title: string;
  readonly decision_groups: readonly PrivateSlackApprovalDecisionGroupV1[];
  /** V1 actions deliberately have no assignee, relation, or deadline presentation. */
  readonly ungrouped_actions?: readonly PrivateSlackApprovalReviewItemV1[];
  readonly ungrouped_rationales?: readonly PrivateSlackApprovalReviewItemV1[];
}

interface PrivateSlackApprovalReviewV1 {
  /** Plain-text review for the card's notification and assistive-tool alternative; the card appends its own control instructions. */
  readonly text: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
}

type Block = Readonly<Record<string, unknown>>;

const MAX_TITLE = 150;
const MAX_SECTION = 3_000;
/**
 * Slack's 40,000-character message limit once covered this review plus the
 * 96 characters of the original card's closing instructions. The review keeps
 * that bound, so exactly the same reviews fail closed.
 */
const MAX_REVIEW_TEXT = 40_000 - 96;
const MAX_APPROVAL_ID = 256;
const MAX_BLOCKS = 50;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DISPLAY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const PLAIN_CONTROLS = /[\u0000-\u001F\u007F]/;
const NON_RELEASE_TEXT =
  "Raw transcript and rejected suggestions are not released.";

function invalid(detail: string): never {
  throw new Error(`private approval Block Kit card ${detail}`);
}

/** Text Slack shows as given: canonically trimmed, non-empty, bounded, and free of control characters. */
function checkText(value: string, maximum: number, label: string, controls = DISPLAY_CONTROLS): void {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maximum || controls.test(value)) {
    invalid(`${label} must be canonically trimmed, bounded display text`);
  }
}

function checkItem(item: PrivateSlackApprovalReviewItemV1, label: string): void {
  checkText(item.text, MAX_SECTION, `${label}.text`);
  checkText(item.evidence_reference, MAX_SECTION, `${label}.evidence_reference`);
}

/**
 * Refuses a review Slack cannot show as given. The presenter builds the input's shape itself from the frozen snapshot,
 * so what is checked here are that snapshot's values: the approval id, every text, and the card's block count.
 */
function validateInput(input: PrivateSlackApprovalBlockKitCardInputV1): void {
  if (typeof input.approval_id !== "string" || input.approval_id.length > MAX_APPROVAL_ID || !IDENTIFIER.test(input.approval_id)) {
    invalid("approval_id must be a bounded canonical identifier");
  }
  checkText(input.meeting_title, MAX_TITLE, "meeting_title", PLAIN_CONTROLS);
  input.decision_groups.forEach((group, index) => {
    checkItem(group.decision, `decision_groups[${index}].decision`);
    group.rationales.forEach((item, itemIndex) => checkItem(item, `decision_groups[${index}].rationales[${itemIndex}]`));
  });
  input.ungrouped_actions?.forEach((item, index) => checkItem(item, `ungrouped_actions[${index}]`));
  input.ungrouped_rationales?.forEach((item, index) => checkItem(item, `ungrouped_rationales[${index}]`));
  // Header and context, plus the card's five control blocks.
  const followUp = input.ungrouped_actions !== undefined || input.ungrouped_rationales !== undefined;
  if (7 + input.decision_groups.length + Number(followUp) > MAX_BLOCKS) invalid("card exceeds Slack's 50-block limit");
}

function escapeMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const plainText = (text: string) => ({ type: "plain_text", text, emoji: false });
const mrkdwnText = (text: string) => ({ type: "mrkdwn", text, verbatim: true });
const bullets = (items: readonly PrivateSlackApprovalReviewItemV1[]) => items.map((item) => `• ${escapeMrkdwn(item.text)}`);

function key(...parts: readonly string[]): string {
  return createHash("sha256").update(["echo-private-approval-v1", ...parts].join("\u0000")).digest("hex").slice(0, 32);
}

function blockId(approvalId: string, name: string): string {
  return `echo-private-approval-v1-${key(approvalId)}-${name}-v1`;
}

function sectionBlock(label: string, lines: readonly string[]): Block {
  const text = `*${label}*\n${lines.join("\n")}`;
  if (text.length > MAX_SECTION) invalid(`${label} section exceeds Slack's text limit`);
  return { type: "section", text: mrkdwnText(text) };
}

function collapsed(blockIdValue: string, title: string, subtitle: string | undefined, childBlocks: readonly Block[]): Block {
  return {
    type: "container",
    block_id: blockIdValue,
    title: plainText(title),
    ...(subtitle === undefined ? {} : { subtitle: mrkdwnText(subtitle) }),
    is_collapsible: true,
    default_collapsed: true,
    width: "full",
    child_blocks: childBlocks,
  };
}

/**
 * The group title is legacy presentation metadata. What the reviewer sees is always a (bounded) excerpt of the exact
 * decision they authorize, numbered by position.
 */
function decisionContainer(approvalId: string, group: PrivateSlackApprovalDecisionGroupV1, position: number): Block {
  const prefix = `${position} · `;
  const available = MAX_TITLE - prefix.length;
  const text = group.decision.text;
  const title = `${prefix}${text.length <= available ? text : `${text.slice(0, available - 1)}…`}`;
  const whys = group.rationales.length;
  const childBlocks = [sectionBlock("Decision", [escapeMrkdwn(text)])];
  if (whys > 0) childBlocks.push(sectionBlock("Why", bullets(group.rationales)));
  return collapsed(
    `echo-private-approval-v1-${key(approvalId, group.id)}-decision-v1`,
    title,
    whys === 0 ? undefined : `${whys} ${whys === 1 ? "why" : "whys"}`,
    childBlocks,
  );
}

function meetingFollowUp(input: PrivateSlackApprovalBlockKitCardInputV1): Block[] {
  const { ungrouped_actions: actions, ungrouped_rationales: context } = input;
  if (actions === undefined && context === undefined) return [];
  const childBlocks: Block[] = [];
  if (actions !== undefined) childBlocks.push(sectionBlock("Next steps", bullets(actions)));
  if (context !== undefined) childBlocks.push(sectionBlock("Additional context", bullets(context)));
  const title = actions === undefined ? "Additional meeting context" : context === undefined ? "Next steps from this meeting" : "Next steps and context";
  return [collapsed(blockId(input.approval_id, "other-meeting-items"), title, undefined, childBlocks)];
}

function fallback(input: PrivateSlackApprovalBlockKitCardInputV1): string {
  const lines = ["Private meeting-owner approval requested.", `Meeting: ${input.meeting_title}`, "Frozen review:"];
  for (const [index, group] of input.decision_groups.entries()) {
    const decision = group.decision;
    lines.push(`Decision ${index + 1}: ${decision.text}`, `Status: ${decision.status}`, `Evidence: ${decision.evidence_reference}`);
    for (const rationale of group.rationales) lines.push(`Why: ${rationale.text}`, `Evidence: ${rationale.evidence_reference}`);
  }
  if (input.ungrouped_actions !== undefined) lines.push("Next steps from this meeting:");
  for (const action of input.ungrouped_actions ?? []) lines.push(`Next step: ${action.text}`, `Evidence: ${action.evidence_reference}`);
  if (input.ungrouped_rationales !== undefined) lines.push("Additional meeting context:");
  for (const rationale of input.ungrouped_rationales ?? []) lines.push(`Context: ${rationale.text}`, `Evidence: ${rationale.evidence_reference}`);
  lines.push(NON_RELEASE_TEXT);
  const text = lines.join("\n");
  if (text.length > MAX_REVIEW_TEXT) invalid("fallback exceeds Slack's text limit");
  return text;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/** Builds the complete review a card shows above its approval controls. */
export function buildPrivateSlackApprovalReviewV1(
  input: PrivateSlackApprovalBlockKitCardInputV1,
): PrivateSlackApprovalReviewV1 {
  validateInput(input);
  const decisions = input.decision_groups.length;
  const blocks: Block[] = [
    { type: "header", block_id: blockId(input.approval_id, "title"), text: plainText(input.meeting_title) },
    {
      type: "context",
      block_id: blockId(input.approval_id, "context"),
      elements: [mrkdwnText(`${decisions} ${decisions === 1 ? "decision" : "decisions"}  •  Private until approved`)],
    },
    ...input.decision_groups.map((group, index) => decisionContainer(input.approval_id, group, index + 1)),
    ...meetingFollowUp(input),
  ];
  return deepFreeze({ text: fallback(input), blocks });
}
