import { createHash } from "node:crypto";

export interface PrivateSlackApprovalReviewItemV1 {
  readonly text: string;
  readonly evidence_reference: string;
}

export interface PrivateSlackApprovalDecisionItemV1
  extends PrivateSlackApprovalReviewItemV1 {
  readonly status: "proposed" | "decided" | "unresolved";
}

/** V1 actions deliberately have no assignee, relation, or deadline presentation. */
export type PrivateSlackApprovalActionItemV1 =
  PrivateSlackApprovalReviewItemV1;

export interface PrivateSlackApprovalDecisionGroupV1 {
  readonly id: string;
  readonly decision: PrivateSlackApprovalDecisionItemV1;
  readonly rationales: readonly PrivateSlackApprovalReviewItemV1[];
}

export interface PrivateSlackApprovalBlockKitCardInputV1 {
  readonly schema_version: 1;
  readonly approval_id: string;
  readonly meeting_title: string;
  readonly decision_groups: readonly PrivateSlackApprovalDecisionGroupV1[];
  readonly ungrouped_actions?: readonly PrivateSlackApprovalActionItemV1[];
  readonly ungrouped_rationales?: readonly PrivateSlackApprovalReviewItemV1[];
}

interface PlainTextV1 {
  readonly type: "plain_text";
  readonly text: string;
  readonly emoji: false;
}

interface MrkdwnTextV1 {
  readonly type: "mrkdwn";
  readonly text: string;
  readonly verbatim: true;
}

export interface PrivateSlackApprovalReviewV1 {
  /**
   * Plain-text review for the card's notification and assistive-tool
   * alternative; the card appends its own control instructions.
   */
  readonly text: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
}

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

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    invalid(`${label} has an unexpected shape`);
  }
}

function exactArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
}

function boundedText(
  value: unknown,
  maximum: number,
  label: string,
  controls = DISPLAY_CONTROLS,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximum ||
    controls.test(value)
  ) {
    invalid(`${label} must be canonically trimmed, bounded display text`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_APPROVAL_ID ||
    !IDENTIFIER.test(value)
  ) {
    invalid(`${label} must be a bounded canonical identifier`);
  }
}

function validateReviewItem(
  item: PrivateSlackApprovalReviewItemV1,
  label: string,
  extraKeys: readonly string[] = [],
): void {
  exactObject(item, ["text", "evidence_reference", ...extraKeys], [], label);
  boundedText(item.text, MAX_SECTION, `${label}.text`);
  boundedText(
    item.evidence_reference,
    MAX_SECTION,
    `${label}.evidence_reference`,
  );
}

function validateDecisionItem(
  item: PrivateSlackApprovalDecisionItemV1,
  label: string,
): void {
  validateReviewItem(item, label, ["status"]);
  if (!(["proposed", "decided", "unresolved"] as const).includes(item.status)) {
    invalid(`${label}.status must be a decision status`);
  }
}

function validateInput(input: PrivateSlackApprovalBlockKitCardInputV1): void {
  exactObject(
    input,
    ["schema_version", "approval_id", "meeting_title", "decision_groups"],
    ["ungrouped_actions", "ungrouped_rationales"],
    "input",
  );
  if (input.schema_version !== 1) invalid("schema_version must equal 1");
  identifier(input.approval_id, "approval_id");
  boundedText(input.meeting_title, MAX_TITLE, "meeting_title", PLAIN_CONTROLS);
  exactArray(input.decision_groups, "decision_groups");

  const ids = new Set<string>();
  input.decision_groups.forEach((group, index) => {
    const label = `decision_groups[${index}]`;
    exactObject(group, ["id", "decision", "rationales"], [], label);
    identifier(group.id, `${label}.id`);
    if (ids.has(group.id)) invalid("decision_groups contain duplicate ids");
    ids.add(group.id);
    validateDecisionItem(group.decision, `${label}.decision`);
    exactArray(group.rationales, `${label}.rationales`);
    group.rationales.forEach((item, itemIndex) =>
      validateReviewItem(item, `${label}.rationales[${itemIndex}]`),
    );
  });

  if (input.ungrouped_actions !== undefined) {
    exactArray(input.ungrouped_actions, "ungrouped_actions");
    if (input.ungrouped_actions.length === 0) {
      invalid("ungrouped_actions must be omitted when empty");
    }
    input.ungrouped_actions.forEach((item, index) =>
      validateReviewItem(item, `ungrouped_actions[${index}]`),
    );
  }
  if (input.ungrouped_rationales !== undefined) {
    exactArray(input.ungrouped_rationales, "ungrouped_rationales");
    if (input.ungrouped_rationales.length === 0) {
      invalid("ungrouped_rationales must be omitted when empty");
    }
    input.ungrouped_rationales.forEach((item, index) =>
      validateReviewItem(item, `ungrouped_rationales[${index}]`),
    );
  }

  // Header and context, plus the card's five control blocks.
  const blockCount =
    7 +
    input.decision_groups.length +
    Number(
      input.ungrouped_actions !== undefined ||
        input.ungrouped_rationales !== undefined,
    );
  if (blockCount > MAX_BLOCKS) invalid("card exceeds Slack's 50-block limit");
}

function escapeMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainText(text: string): PlainTextV1 {
  return Object.freeze({ type: "plain_text", text, emoji: false });
}

function mrkdwnText(text: string): MrkdwnTextV1 {
  return Object.freeze({ type: "mrkdwn", text, verbatim: true });
}

function cardKey(approvalId: string): string {
  return createHash("sha256")
    .update(`echo-private-approval-v1\u0000${approvalId}`)
    .digest("hex")
    .slice(0, 32);
}

function blockId(
  input: Pick<PrivateSlackApprovalBlockKitCardInputV1, "approval_id">,
  name: string,
): string {
  return `echo-private-approval-v1-${cardKey(input.approval_id)}-${name}-v1`;
}

function decisionBlockId(
  input: Pick<PrivateSlackApprovalBlockKitCardInputV1, "approval_id">,
  decisionId: string,
): string {
  const key = createHash("sha256")
    .update(`echo-private-approval-v1\u0000${input.approval_id}\u0000${decisionId}`)
    .digest("hex")
    .slice(0, 32);
  return `echo-private-approval-v1-${key}-decision-v1`;
}

/**
 * The group title is legacy presentation metadata.  What the reviewer sees
 * must always be a (bounded) excerpt of the exact decision they authorize.
 */
function displayDecisionTitle(
  decision: PrivateSlackApprovalDecisionItemV1,
  position: number,
): string {
  const prefix = `${position} · `;
  const available = MAX_TITLE - prefix.length;
  const text = decision.text;
  const presentationText =
    text.length <= available ? text : `${text.slice(0, available - 1)}…`;
  return `${prefix}${presentationText}`;
}

function decisionSubtitle(group: PrivateSlackApprovalDecisionGroupV1): string | undefined {
  if (group.rationales.length === 0) return undefined;
  return `${group.rationales.length} ${group.rationales.length === 1 ? "why" : "whys"}`;
}

function section(label: string, lines: readonly string[]): string {
  const text = `*${label}*\n${lines.join("\n")}`;
  if (text.length > MAX_SECTION) {
    invalid(`${label} section exceeds Slack's text limit`);
  }
  return text;
}

function reviewLines(item: PrivateSlackApprovalReviewItemV1): string[] {
  return [`• ${escapeMrkdwn(item.text)}`];
}

function decisionContainer(
  input: PrivateSlackApprovalBlockKitCardInputV1,
  group: PrivateSlackApprovalDecisionGroupV1,
  position: number,
): Readonly<Record<string, unknown>> {
  const childBlocks: Readonly<Record<string, unknown>>[] = [
    {
      type: "section",
      text: mrkdwnText(
        section("Decision", [
          escapeMrkdwn(group.decision.text),
        ]),
      ),
    },
  ];
  if (group.rationales.length > 0) {
    childBlocks.push({
      type: "section",
      text: mrkdwnText(section("Why", group.rationales.flatMap(reviewLines))),
    });
  }
  return {
    type: "container",
    block_id: decisionBlockId(input, group.id),
    title: plainText(displayDecisionTitle(group.decision, position)),
    ...(decisionSubtitle(group) === undefined
      ? {}
      : { subtitle: mrkdwnText(decisionSubtitle(group)!) }),
    is_collapsible: true,
    default_collapsed: true,
    width: "full",
    child_blocks: childBlocks,
  };
}

function meetingFollowUp(
  input: PrivateSlackApprovalBlockKitCardInputV1,
): Readonly<Record<string, unknown>> | undefined {
  const actions = input.ungrouped_actions;
  const context = input.ungrouped_rationales;
  const hasActions = actions !== undefined;
  const hasContext = context !== undefined;
  if (!hasActions && !hasContext) {
    return undefined;
  }
  const childBlocks: Readonly<Record<string, unknown>>[] = [];
  if (hasActions) {
    childBlocks.push({
      type: "section",
      text: mrkdwnText(section("Next steps", actions.flatMap(reviewLines))),
    });
  }
  if (hasContext) {
    childBlocks.push({
      type: "section",
      text: mrkdwnText(
        section(
          "Additional context",
          context.flatMap(reviewLines),
        ),
      ),
    });
  }
  const title = hasActions
    ? hasContext
      ? "Next steps and context"
      : "Next steps from this meeting"
    : "Additional meeting context";
  return {
    type: "container",
    block_id: blockId(input, "other-meeting-items"),
    title: plainText(title),
    is_collapsible: true,
    default_collapsed: true,
    width: "full",
    child_blocks: childBlocks,
  };
}

function fallback(input: PrivateSlackApprovalBlockKitCardInputV1): string {
  const lines = [
    "Private meeting-owner approval requested.",
    `Meeting: ${input.meeting_title}`,
    "Frozen review:",
  ];
  for (const [index, group] of input.decision_groups.entries()) {
    lines.push(
      `Decision ${index + 1}: ${group.decision.text}`,
      `Status: ${group.decision.status}`,
      `Evidence: ${group.decision.evidence_reference}`,
    );
    for (const rationale of group.rationales) {
      lines.push(
        `Why: ${rationale.text}`,
        `Evidence: ${rationale.evidence_reference}`,
      );
    }
  }
  if (input.ungrouped_actions !== undefined) {
    lines.push("Next steps from this meeting:");
  }
  for (const action of input.ungrouped_actions ?? []) {
    lines.push(`Next step: ${action.text}`);
    lines.push(`Evidence: ${action.evidence_reference}`);
  }
  if (input.ungrouped_rationales !== undefined) {
    lines.push("Additional meeting context:");
  }
  for (const rationale of input.ungrouped_rationales ?? []) {
    lines.push(
      `Context: ${rationale.text}`,
      `Evidence: ${rationale.evidence_reference}`,
    );
  }
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
  const blocks: Readonly<Record<string, unknown>>[] = [
    {
      type: "header",
      block_id: blockId(input, "title"),
      text: plainText(input.meeting_title),
    },
    {
      type: "context",
      block_id: blockId(input, "context"),
      elements: [
        mrkdwnText(
          `${input.decision_groups.length} ${input.decision_groups.length === 1 ? "decision" : "decisions"}  •  Private until approved`,
        ),
      ],
    },
    ...input.decision_groups.map((group, index) =>
      decisionContainer(input, group, index + 1),
    ),
  ];
  const followUp = meetingFollowUp(input);
  if (followUp !== undefined) blocks.push(followUp);
  return deepFreeze({ text: fallback(input), blocks });
}
