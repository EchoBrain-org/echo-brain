import { createHash } from "node:crypto";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonApprovalPolicyId,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";

/**
 * The presentation-only, private-owner approval card.
 *
 * This module intentionally does not open a Slack DM, persist an assignment,
 * or interpret an interaction payload. Its button values identify the card
 * and assignment version only. The inbound boundary must reprove the current
 * Slack identity, assignee, and assignment capability before it creates a
 * policy-resolution command.
 */
export const PRIVATE_APPROVAL_BLOCK_KIT_CARD_KIND =
  "echo-private-approval-block-kit-card-v1" as const;

export const PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1 = Object.freeze({
  policy: "policy",
  comment: "comment",
  approve: "approve",
  reject: "reject",
  /** Reserved for a later assignment-changing delegation flow. */
  delegate: "delegate",
} as const);

export type PrivateApprovalBlockKitActionV1 =
  (typeof PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1)[keyof typeof PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1];

export interface PrivateApprovalBlockKitCardInputV1 {
  readonly schema_version: 1;
  readonly approval_id: string;
  readonly assignment_version: number;
  /** Bounded, human-readable meeting title. */
  readonly meeting_title: string;
  /** Bounded, human-readable summary of the approval being requested. */
  readonly approval_context: string;
}

export interface PrivateApprovalBlockKitPlainTextV1 {
  readonly type: "plain_text";
  readonly text: string;
  readonly emoji: false;
}

export interface PrivateApprovalBlockKitOptionV1 {
  readonly text: PrivateApprovalBlockKitPlainTextV1;
  readonly value: PersonApprovalPolicyId;
}

export interface PrivateApprovalBlockKitHeaderBlockV1 {
  readonly type: "header";
  readonly block_id: string;
  readonly text: PrivateApprovalBlockKitPlainTextV1;
}

export interface PrivateApprovalBlockKitSectionBlockV1 {
  readonly type: "section";
  readonly block_id: string;
  readonly text: PrivateApprovalBlockKitPlainTextV1;
}

export interface PrivateApprovalBlockKitDividerBlockV1 {
  readonly type: "divider";
  readonly block_id: string;
}

export interface PrivateApprovalBlockKitPolicyInputBlockV1 {
  readonly type: "input";
  readonly block_id: string;
  readonly optional: false;
  readonly label: PrivateApprovalBlockKitPlainTextV1;
  readonly element: {
    readonly type: "radio_buttons";
    readonly action_id: string;
    readonly options: readonly [
      PrivateApprovalBlockKitOptionV1,
      PrivateApprovalBlockKitOptionV1,
    ];
    readonly initial_option: PrivateApprovalBlockKitOptionV1;
  };
}

export interface PrivateApprovalBlockKitCommentInputBlockV1 {
  readonly type: "input";
  readonly block_id: string;
  readonly optional: true;
  readonly label: PrivateApprovalBlockKitPlainTextV1;
  readonly element: {
    readonly type: "plain_text_input";
    readonly action_id: string;
    readonly multiline: true;
    readonly max_length: typeof PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS;
  };
}

export interface PrivateApprovalBlockKitActionsBlockV1 {
  readonly type: "actions";
  readonly block_id: string;
  readonly elements: readonly [
    {
      readonly type: "button";
      readonly action_id: string;
      readonly style: "primary";
      readonly text: PrivateApprovalBlockKitPlainTextV1;
      readonly value: string;
    },
    {
      readonly type: "button";
      readonly action_id: string;
      readonly style: "danger";
      readonly text: PrivateApprovalBlockKitPlainTextV1;
      readonly value: string;
    },
  ];
}

export type PrivateApprovalBlockKitBlockV1 =
  | PrivateApprovalBlockKitHeaderBlockV1
  | PrivateApprovalBlockKitSectionBlockV1
  | PrivateApprovalBlockKitDividerBlockV1
  | PrivateApprovalBlockKitPolicyInputBlockV1
  | PrivateApprovalBlockKitCommentInputBlockV1
  | PrivateApprovalBlockKitActionsBlockV1;

export interface PrivateApprovalBlockKitCardV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_BLOCK_KIT_CARD_KIND;
  readonly approval_id: string;
  readonly assignment_version: number;
  /** Complete plain-text alternative for notifications and assistive tools. */
  readonly text: string;
  readonly blocks: readonly [
    PrivateApprovalBlockKitHeaderBlockV1,
    PrivateApprovalBlockKitSectionBlockV1,
    PrivateApprovalBlockKitDividerBlockV1,
    PrivateApprovalBlockKitPolicyInputBlockV1,
    PrivateApprovalBlockKitCommentInputBlockV1,
    PrivateApprovalBlockKitActionsBlockV1,
  ];
  readonly transport: {
    readonly mrkdwn: false;
    readonly unfurl_links: false;
    readonly unfurl_media: false;
  };
}

const MAX_SLACK_HEADER_TEXT_CHARACTERS = 150;
const MAX_SLACK_SECTION_TEXT_CHARACTERS = 3_000;
const MAX_SLACK_MESSAGE_TEXT_CHARACTERS = 40_000;
const MAX_SLACK_BLOCK_ID_CHARACTERS = 255;
const MAX_APPROVAL_ID_CHARACTERS = 256;
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type UnknownRecord = Record<string, unknown>;

function invalid(detail: string): never {
  throw new Error(`private approval Block Kit card ${detail}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(`${label} must not contain symbol keys`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid(`${label} field ${key} must be an enumerable data property`);
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an unexpected shape`);
  }
  return value as UnknownRecord;
}

function boundedText(
  value: unknown,
  maximum: number,
  label: string,
  controls: RegExp,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximum ||
    controls.test(value)
  ) {
    invalid(`${label} must be canonically trimmed, bounded text without disallowed controls`);
  }
}

function approvalId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_APPROVAL_ID_CHARACTERS ||
    !CANONICAL_IDENTIFIER.test(value)
  ) {
    invalid("approval_id must be a bounded canonical identifier");
  }
}

function assignmentVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid("assignment_version must be a positive safe integer");
  }
}

function validateInput(
  value: PrivateApprovalBlockKitCardInputV1,
): PrivateApprovalBlockKitCardInputV1 {
  const input = exactRecord(
    value,
    [
      "schema_version",
      "approval_id",
      "assignment_version",
      "meeting_title",
      "approval_context",
    ],
    "input",
  );
  if (input.schema_version !== 1) invalid("schema_version must equal 1");
  approvalId(input.approval_id);
  assignmentVersion(input.assignment_version);
  boundedText(
    input.meeting_title,
    MAX_SLACK_HEADER_TEXT_CHARACTERS,
    "meeting_title",
    /[\u0000-\u001F\u007F]/,
  );
  boundedText(
    input.approval_context,
    MAX_SLACK_SECTION_TEXT_CHARACTERS,
    "approval_context",
    /[\u0000-\u0008\u000B-\u001F\u007F]/,
  );
  return input as unknown as PrivateApprovalBlockKitCardInputV1;
}

function cardKey(input: {
  readonly approval_id: string;
  readonly assignment_version: number;
}): string {
  return createHash("sha256")
    .update(`echo-private-approval-v1\u0000${input.approval_id}\u0000${input.assignment_version}`)
    .digest("hex")
    .slice(0, 32);
}

/** Stable ID for an element; not an authorization claim. */
export function privateApprovalBlockKitActionIdV1(
  input: Pick<
    PrivateApprovalBlockKitCardInputV1,
    "approval_id" | "assignment_version"
  >,
  action: PrivateApprovalBlockKitActionV1,
): string {
  approvalId(input.approval_id);
  assignmentVersion(input.assignment_version);
  return `echo-private-approval-v1-${cardKey(input)}-${action}-v1`;
}

function blockId(
  input: Pick<
    PrivateApprovalBlockKitCardInputV1,
    "approval_id" | "assignment_version"
  >,
  name: "title" | "context" | "divider" | "policy" | "comment" | "actions",
): string {
  const value = `echo-private-approval-v1-${cardKey(input)}-${name}-v1`;
  if (value.length > MAX_SLACK_BLOCK_ID_CHARACTERS) {
    invalid("derived block id exceeds Slack's limit");
  }
  return value;
}

function actionValue(input: {
  readonly approval_id: string;
  readonly assignment_version: number;
}): string {
  // Deliberately contains no ECHO principal, membership, policy, or authority
  // claim. The selected radio option is read from Slack's interaction state.
  return JSON.stringify({
    schema_version: 1,
    approval_id: input.approval_id,
    assignment_version: input.assignment_version,
  });
}

function plainText(text: string): PrivateApprovalBlockKitPlainTextV1 {
  return Object.freeze({ type: "plain_text" as const, text, emoji: false as const });
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

/**
 * Builds the complete private-DM presentation. Future delegation is reserved
 * as an action-ID namespace only; V1 renders no inactive Delegate control.
 */
export function buildPrivateApprovalBlockKitCardV1(
  rawInput: PrivateApprovalBlockKitCardInputV1,
): PrivateApprovalBlockKitCardV1 {
  const input = validateInput(rawInput);
  const onlyMe: PrivateApprovalBlockKitOptionV1 = {
    text: plainText("Only me"),
    value: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  };
  const team: PrivateApprovalBlockKitOptionV1 = {
    text: plainText("Team"),
    value: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  };
  const fallback = [
    "Private meeting-owner approval requested.",
    `Meeting: ${input.meeting_title}`,
    `Review: ${input.approval_context}`,
    "Visibility: Only me (default) or Team.",
    "Optionally add a comment, then choose Approve or Reject.",
  ].join("\n");
  if (fallback.length > MAX_SLACK_MESSAGE_TEXT_CHARACTERS) {
    invalid("fallback text exceeds Slack's limit");
  }

  const card: PrivateApprovalBlockKitCardV1 = {
    schema_version: 1,
    kind: PRIVATE_APPROVAL_BLOCK_KIT_CARD_KIND,
    approval_id: input.approval_id,
    assignment_version: input.assignment_version,
    text: fallback,
    blocks: [
      {
        type: "header",
        block_id: blockId(input, "title"),
        text: plainText(input.meeting_title),
      },
      {
        type: "section",
        block_id: blockId(input, "context"),
        text: plainText(input.approval_context),
      },
      { type: "divider", block_id: blockId(input, "divider") },
      {
        type: "input",
        block_id: blockId(input, "policy"),
        optional: false,
        label: plainText("Who should be able to read this record?"),
        element: {
          type: "radio_buttons",
          action_id: privateApprovalBlockKitActionIdV1(
            input,
            PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
          ),
          options: [onlyMe, team],
          initial_option: onlyMe,
        },
      },
      {
        type: "input",
        block_id: blockId(input, "comment"),
        optional: true,
        label: plainText("Comment (optional)"),
        element: {
          type: "plain_text_input",
          action_id: privateApprovalBlockKitActionIdV1(
            input,
            PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
          ),
          multiline: true,
          max_length: PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
        },
      },
      {
        type: "actions",
        block_id: blockId(input, "actions"),
        elements: [
          {
            type: "button",
            action_id: privateApprovalBlockKitActionIdV1(
              input,
              PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
            ),
            style: "primary",
            text: plainText("Approve"),
            value: actionValue(input),
          },
          {
            type: "button",
            action_id: privateApprovalBlockKitActionIdV1(
              input,
              PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.reject,
            ),
            style: "danger",
            text: plainText("Reject"),
            value: actionValue(input),
          },
        ],
      },
    ],
    transport: {
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    },
  };
  return deepFreeze(card);
}
