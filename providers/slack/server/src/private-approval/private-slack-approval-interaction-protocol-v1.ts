import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonApprovalPolicyId,
  type PersonApprovalPolicyIdV2,
} from "../organization-control-plane/slack-approval-integration-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1, privateSlackApprovalBlockKitActionIdV1 } from "./private-slack-approval-block-kit-card-v1.js";
import { PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2, PRIVATE_SLACK_APPROVAL_OWNER_PROPOSALS_MAX_V3, canonicalPrivateSlackApprovalOwnerV3, privateSlackApprovalBlockKitActionIdV2, privateSlackApprovalBlockKitOwnerActionIdV3 } from "./private-slack-approval-block-kit-card-v2.js";

/** The largest Slack interactivity request this pure boundary will retain. */
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES = 64 * 1024;
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS = 5 * 60;

/**
 * Closed, content-free parser stages for operational diagnosis. They are only
 * emitted after HMAC verification has succeeded.
 */
export type PrivateSlackApprovalInteractionRejectionStageV1 =
  | "unclassified"
  | "form"
  | "envelope"
  | "lookup"
  | "action"
  | "card"
  | "state";

const PRIVATE_SLACK_APPROVAL_INTERACTION_KIND =
  // Versioned wire value; component renames never rewrite signed receipts.
  "echo-private-approval-slack-interaction-v1" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,255}$/;
const SLACK_TEAM_ID = /^T[A-Z0-9]{2,255}$/;
const SLACK_ENTERPRISE_ID = /^E[A-Z0-9]{2,255}$/;
const SLACK_APP_ID = /^A[A-Z0-9]{2,255}$/;
const SLACK_BOT_ID = /^B[A-Z0-9]{2,255}$/;
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{2,255}$/;
const SLACK_MESSAGE_TIMESTAMP = /^[0-9]{1,16}\.[0-9]{1,9}$/;
const SLACK_TRIGGER_ID = /^[A-Za-z0-9._-]{16,512}$/;
const SLACK_CARD_INPUT_ACTION =
  /^echo-private-approval-v1-[0-9a-f]{32}-(policy|comment)-v1$/;
const SLACK_CARD_V2_INPUT_ACTION =
  /^echo-private-approval-v2-[0-9a-f]{32}-(policy|projects|share-transcript|comment)-v2$/;
/** A V3 card's owner field; the index is the action's canonical place in the brief. */
const SLACK_CARD_V3_OWNER_ACTION =
  /^echo-private-approval-v2-[0-9a-f]{32}-owner-(0|[1-9][0-9]{0,2})-v3$/;
const DISALLOWED_COMMENT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
interface VerifiedSlackRequestEvidenceV1 {
  readonly body: Uint8Array;
  readonly request_timestamp: string;
  readonly signature_version: "v0";
  readonly signature_sha256: `sha256:${string}`;
  readonly raw_body_sha256: `sha256:${string}`;
}

const verifiedRequests = new WeakMap<
  VerifiedPrivateSlackApprovalRequestV1,
  VerifiedSlackRequestEvidenceV1
>();

type UnknownRecord = Record<string, unknown>;
type PrivateApprovalPolicyIdV1 =
  | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
  | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;

/**
 * A verification capability, intentionally opaque: it exposes neither the
 * raw provider body nor the signing secret. Parsing requires this capability,
 * which prevents accidental parse-before-verification wiring.
 */
export class VerifiedPrivateSlackApprovalRequestV1 {
  private constructor() {}

  static create(): VerifiedPrivateSlackApprovalRequestV1 {
    return Object.freeze(new VerifiedPrivateSlackApprovalRequestV1());
  }
}

export interface VerifyPrivateSlackApprovalRequestInputV1 {
  readonly raw_body: Uint8Array;
  readonly signing_secret: string;
  readonly headers: {
    readonly "x-slack-request-timestamp": string | undefined;
    readonly "x-slack-signature": string | undefined;
  };
  /** Injectable only for deterministic tests and a clock-owned HTTP adapter. */
  readonly now_unix_seconds?: number;
}

export interface PrivateSlackApprovalLookupHintsV1 {
  /** All provider-derived fields are lookup hints, never ECHO authority. */
  readonly api_app_id: string;
  readonly workspace_id: string;
  readonly enterprise_id: string | null;
  readonly slack_user_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly message_user_id: string;
  readonly message_app_id: string;
  readonly message_bot_id: string;
}

export interface PrivateSlackApprovalVerifiedRequestEvidenceV1 {
  readonly request_timestamp: string;
  readonly signature_version: "v0";
  /** Digest of the received signature header, never the signature itself. */
  readonly signature_sha256: `sha256:${string}`;
  readonly raw_body_sha256: `sha256:${string}`;
}

export interface PrivateSlackApprovalPresentationChangeV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_SLACK_APPROVAL_INTERACTION_KIND;
  /** A signed input change is intentionally a no-op in V1. */
  readonly disposition: "presentation_change";
  readonly action: "policy" | "comment";
  readonly request: PrivateSlackApprovalVerifiedRequestEvidenceV1;
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
}

export interface PrivateSlackApprovalResolutionIntentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_SLACK_APPROVAL_INTERACTION_KIND;
  readonly disposition: "resolution";
  readonly action: "approve" | "reject";
  /** Exact verified terminal button identifier for the durable receipt. */
  readonly action_id: string;
  readonly approval_id: string;
  /** Null for reject even though its complete UI state includes a radio value. */
  readonly selected_policy_id: PersonApprovalPolicyId | null;
  /** A canonical bounded string, or null for an empty optional input. */
  readonly comment: string | null;
  /** Stable digest of Slack's trigger/action tuple; no trigger token is retained. */
  readonly provider_action_key_sha256: `sha256:${string}`;
  readonly request: PrivateSlackApprovalVerifiedRequestEvidenceV1;
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
}

/** V2 adds only frozen project choices and an explicit transcript release flag. */
export interface PrivateSlackApprovalResolutionIntentV2 {
  readonly schema_version: 2;
  readonly kind: "echo-private-approval-slack-interaction-v2";
  readonly disposition: "resolution";
  readonly action: "approve" | "reject";
  readonly action_id: string;
  readonly approval_id: string;
  readonly selected_policy_id: PersonApprovalPolicyIdV2 | null;
  readonly selected_project_ids: readonly string[];
  readonly share_transcript: boolean;
  readonly comment: string | null;
  readonly provider_action_key_sha256: `sha256:${string}`;
  readonly request: PrivateSlackApprovalVerifiedRequestEvidenceV1;
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
}

/** One owner field as the approver left it: the proposal, an edit, or null when cleared. */
export interface PrivateSlackApprovalActionOwnerV3 {
  readonly action_index: number;
  readonly owner: string | null;
}

/** V3 is V2 plus the owner fields of a card that proposed owners (ADR-0021). */
export interface PrivateSlackApprovalResolutionIntentV3 extends Omit<PrivateSlackApprovalResolutionIntentV2, "schema_version" | "kind"> {
  readonly schema_version: 3;
  readonly kind: "echo-private-approval-slack-interaction-v3";
  /** Every owner field on the card, in action order; empty for reject. */
  readonly action_owners: readonly PrivateSlackApprovalActionOwnerV3[];
}

export type PrivateSlackApprovalInteractionV1 =
  | PrivateSlackApprovalPresentationChangeV1
  | PrivateSlackApprovalResolutionIntentV1
  | PrivateSlackApprovalResolutionIntentV2
  | PrivateSlackApprovalResolutionIntentV3;

/** Deliberately generic so errors never reflect a secret or raw Slack body. */
export class PrivateSlackApprovalInteractionError extends Error {
  constructor(
    readonly rejection_stage: PrivateSlackApprovalInteractionRejectionStageV1 =
      "unclassified",
  ) {
    super("private approval Slack interaction is invalid");
    this.name = "PrivateSlackApprovalInteractionError";
  }
}

function invalid(): never {
  throw new PrivateSlackApprovalInteractionError();
}

function plainRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalid();
    }
  }
  return value as UnknownRecord;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  allowed = required,
): UnknownRecord {
  const record = plainRecord(value);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    return invalid();
  }
  return record;
}

function text(
  value: unknown,
  expression: RegExp,
  maximum = 256,
): string {
  if (typeof value !== "string" || value.length > maximum || !expression.test(value)) {
    return invalid();
  }
  return value;
}

function parseUnixSeconds(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]{1,12}$/.test(value)) {
    return invalid();
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return invalid();
  return seconds;
}

function nowUnixSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function signingSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    return invalid();
  }
  return value;
}

function rawBody(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES) {
    return invalid();
  }
  return Uint8Array.from(value);
}

function signature(value: unknown): string {
  if (typeof value !== "string" || !/^v0=[0-9a-f]{64}$/.test(value)) {
    return invalid();
  }
  return value;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Verifies Slack's v0 HMAC over the original bytes. This function returns an
 * opaque capability rather than the bytes, so callers cannot accidentally
 * parse a request that has not first crossed this verification boundary.
 */
export function verifyPrivateSlackApprovalRequestV1(
  input: VerifyPrivateSlackApprovalRequestInputV1,
): VerifiedPrivateSlackApprovalRequestV1 {
  const record = exactRecord(
    input,
    ["raw_body", "signing_secret", "headers"],
    ["raw_body", "signing_secret", "headers", "now_unix_seconds"],
  );
  const body = rawBody(record.raw_body);
  const secret = signingSecret(record.signing_secret);
  const headers = exactRecord(record.headers, [
    "x-slack-request-timestamp",
    "x-slack-signature",
  ]);
  const timestamp = parseUnixSeconds(headers["x-slack-request-timestamp"]);
  const current = nowUnixSeconds(
    record.now_unix_seconds ?? Math.floor(Date.now() / 1000),
  );
  if (Math.abs(current - timestamp) > PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS) {
    return invalid();
  }
  const provided = signature(headers["x-slack-signature"]);
  const expected = createHmac("sha256", secret)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest("hex");
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(expected), encoder.encode(provided.slice(3)))) {
    return invalid();
  }
  const verified = VerifiedPrivateSlackApprovalRequestV1.create();
  verifiedRequests.set(
    verified,
    Object.freeze({
      body,
      request_timestamp: String(timestamp),
      signature_version: "v0",
      signature_sha256: sha256(provided),
      raw_body_sha256: sha256(body),
    }),
  );
  return verified;
}

function decodePayloadForm(body: Uint8Array): unknown {
  let form: URLSearchParams;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    form = new URLSearchParams(source);
  } catch {
    return invalid();
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "payload") return invalid();
  try {
    return JSON.parse(entries[0][1]) as unknown;
  } catch {
    return invalid();
  }
}

function canonicalComment(value: unknown): string | null {
  // Slack represents an untouched optional plain-text input as null.
  if (value === null) return null;
  if (typeof value !== "string") return invalid();
  if (
    value.length > PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS ||
    DISALLOWED_COMMENT_CONTROL.test(value)
  ) {
    return invalid();
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function actionValue(value: unknown): {
  readonly approval_id: string;
  readonly schema_version: 1 | 2 | 3;
} {
  if (typeof value !== "string" || value.length > 1_024) return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  const record = exactRecord(parsed, [
    "schema_version",
    "approval_id",
  ]);
  if (record.schema_version !== 1 && record.schema_version !== 2 && record.schema_version !== 3) return invalid();
  return Object.freeze({
    approval_id: text(record.approval_id, IDENTIFIER),
    schema_version: record.schema_version,
  });
}

function slackPlainText(value: unknown): void {
  const record = exactRecord(
    value,
    ["type", "text"],
    ["type", "text", "emoji"],
  );
  if (
    record.type !== "plain_text" ||
    (record.emoji !== undefined && typeof record.emoji !== "boolean") ||
    typeof record.text !== "string" ||
    record.text.length === 0 ||
    record.text.length > 75 ||
    record.text !== record.text.trim() ||
    /[\u0000-\u001F\u007F]/.test(record.text)
  ) {
    return invalid();
  }
}

function selectedPolicy(
  value: unknown,
  control: "radio_buttons" | "static_select",
  projectsAllowed = false,
): PersonApprovalPolicyIdV2 {
  // Both shipped card variants use the same immutable narrow default. Slack
  // may report an untouched initial option as null, so preserve that default.
  if (value === null) {
    return RESTRICTED_REVIEWER_PERSON_POLICY_ID;
  }
  const option = exactRecord(
    value,
    ["text", "value"],
    control === "static_select"
      ? ["text", "value", "description"]
      : ["text", "value"],
  );
  slackPlainText(option.text);
  if (option.description !== undefined) {
    slackPlainText(option.description);
  }
  if (
    option.value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
    option.value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID &&
    (!projectsAllowed || option.value !== PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID)
  ) {
    return invalid();
  }
  return option.value as PersonApprovalPolicyIdV2;
}

function selectedProjectIds(value: unknown): readonly string[] {
  if (value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 20) return invalid();
  const ids = value.map((option) => {
    const record = exactRecord(option, ["text", "value"], ["text", "value", "description"]);
    slackPlainText(record.text);
    if (record.description !== undefined) slackPlainText(record.description);
    return text(record.value, /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) return invalid();
  return Object.freeze(ids);
}

function selectedTranscript(value: unknown): boolean {
  if (value === null) return false;
  if (!Array.isArray(value) || value.length > 1) return invalid();
  if (value.length === 0) return false;
  const option = exactRecord(value[0], ["text", "value"], ["text", "value", "description"]);
  slackPlainText(option.text);
  if (option.description !== undefined) slackPlainText(option.description);
  if (option.value !== "share-transcript-v1") return invalid();
  return true;
}

function completeStateV2(input: {
  readonly state: unknown;
  readonly approval_id: string;
  readonly action: "approve" | "reject";
  /** 3 accepts the owner fields of a card that proposed owners. */
  readonly schema_version?: 2 | 3;
}): { readonly selected_policy_id: PersonApprovalPolicyIdV2; readonly selected_project_ids: readonly string[]; readonly share_transcript: boolean; readonly comment: string | null; readonly action_owners: readonly PrivateSlackApprovalActionOwnerV3[] } {
  const version = input.schema_version ?? 2;
  const state = exactRecord(input.state, ["values"]);
  const values = plainRecord(state.values);
  const ids = Object.values(PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2).map((action) => privateSlackApprovalBlockKitActionIdV2(input, action));
  const blocks = Object.values(values);
  const ownerPrefix = privateSlackApprovalBlockKitOwnerActionIdV3(input, 0).slice(0, -"0-v3".length);
  const ownerIndex = (key: string): number | undefined => {
    if (version !== 3 || !key.startsWith(ownerPrefix)) return undefined;
    const index = SLACK_CARD_V3_OWNER_ACTION.exec(key)?.[1];
    return index === undefined ? undefined : Number(index);
  };
  // A card with no eligible projects intentionally has no static selector:
  // Slack rejects an empty option list. Its state therefore has three fields.
  // A V3 card adds one field per proposed owner.
  const ownerFields = blocks.filter((block) => {
    const keys = Object.keys(plainRecord(block));
    return keys.length === 1 && ownerIndex(keys[0]!) !== undefined;
  }).length;
  if (version === 3 && (ownerFields === 0 || ownerFields > PRIVATE_SLACK_APPROVAL_OWNER_PROPOSALS_MAX_V3)) return invalid();
  if (blocks.length - ownerFields < 3 || blocks.length - ownerFields > 4) return invalid();
  let policy: PersonApprovalPolicyIdV2 | undefined;
  let projects: readonly string[] = Object.freeze([]);
  let transcript: boolean | undefined;
  let comment: string | null | undefined;
  const owners: PrivateSlackApprovalActionOwnerV3[] = [];
  for (const block of blocks) {
    const element = plainRecord(block);
    const keys = Object.keys(element);
    if (keys.length !== 1) return invalid();
    const key = keys[0]!;
    const index = ownerIndex(key);
    if (index !== undefined) {
      const field = exactRecord(element[key], ["type", "value"]);
      if (field.type !== "plain_text_input") return invalid();
      if (field.value !== null && (typeof field.value !== "string" || field.value.length > 3_000)) return invalid();
      let owner: string | null;
      try { owner = field.value === null ? null : canonicalPrivateSlackApprovalOwnerV3(field.value); } catch { return invalid(); }
      if (owners.some((value) => value.action_index === index)) return invalid();
      owners.push(Object.freeze({ action_index: index, owner }));
      continue;
    }
    if (!ids.includes(key)) return invalid();
    if (key === privateSlackApprovalBlockKitActionIdV2(input, "policy")) {
      const selector = exactRecord(element[key], ["type", "selected_option"]);
      if (selector.type !== "static_select") return invalid();
      policy = selectedPolicy(selector.selected_option, selector.type, true);
    } else if (key === privateSlackApprovalBlockKitActionIdV2(input, "projects")) {
      const selector = exactRecord(element[key], ["type", "selected_options"]);
      if (selector.type !== "multi_static_select") return invalid();
      projects = selectedProjectIds(selector.selected_options);
    } else if (key === privateSlackApprovalBlockKitActionIdV2(input, "share-transcript")) {
      const selector = exactRecord(element[key], ["type", "selected_options"]);
      if (selector.type !== "checkboxes") return invalid();
      transcript = selectedTranscript(selector.selected_options);
    } else if (key === privateSlackApprovalBlockKitActionIdV2(input, "comment")) {
      const field = exactRecord(element[key], ["type", "value"]);
      if (field.type !== "plain_text_input") return invalid();
      comment = canonicalComment(field.value);
    } else return invalid();
  }
  if (policy === undefined || transcript === undefined || comment === undefined) return invalid();
  // Approve needs the audience and the projects to agree. Projects without
  // the Projects audience are refused, never dropped: a silently dropped
  // choice leaves the record out of every project's Ask while the approver
  // believes its members can read it. Only me stays the narrow default; the
  // approver fixes the card and approves again. A reject ignores both.
  if (
    input.action === "approve" &&
    (policy === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) !== (projects.length > 0)
  ) return invalid();
  return Object.freeze({
    selected_policy_id: policy,
    selected_project_ids:
      policy === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID
        ? projects
        : Object.freeze([]),
    share_transcript: transcript,
    comment,
    action_owners: Object.freeze(owners.sort((left, right) => left.action_index - right.action_index)),
  });
}

function completeState(input: {
  readonly state: unknown;
  readonly approval_id: string;
}): { readonly selected_policy_id: PersonApprovalPolicyId; readonly comment: string | null } {
  const state = exactRecord(input.state, ["values"]);
  const values = plainRecord(state.values);
  const policyActionId = privateSlackApprovalBlockKitActionIdV1(
    input,
    PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
  );
  const commentActionId = privateSlackApprovalBlockKitActionIdV1(
    input,
    PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
  );
  const blocks = Object.values(values);
  if (blocks.length !== 2) return invalid();

  let policy: PrivateApprovalPolicyIdV1 | undefined;
  let comment: string | null | undefined;
  for (const block of blocks) {
    const element = plainRecord(block);
    const keys = Object.keys(element);
    if (keys.length !== 1) return invalid();
    if (keys[0] === policyActionId) {
      const selector = exactRecord(element[policyActionId], [
        "type",
        "selected_option",
      ]);
      if (selector.type !== "radio_buttons" && selector.type !== "static_select") {
        return invalid();
      }
      const selected = selectedPolicy(selector.selected_option, selector.type);
      if (selected === PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID) return invalid();
      policy = selected;
      continue;
    }
    if (keys[0] === commentActionId) {
      const field = exactRecord(element[commentActionId], ["type", "value"]);
      if (field.type !== "plain_text_input") return invalid();
      comment = canonicalComment(field.value);
      continue;
    }
    return invalid();
  }
  if (policy === undefined || comment === undefined) return invalid();
  return Object.freeze({ selected_policy_id: policy, comment });
}

function lookupHints(payload: UnknownRecord): PrivateSlackApprovalLookupHintsV1 {
  const user = exactRecord(payload.user, ["id"], ["id", "username", "name", "team_id"]);
  const team = exactRecord(payload.team, ["id"], ["id", "domain"]);
  const enterprise = payload.enterprise;
  const enterpriseId =
    enterprise === undefined || enterprise === null
      ? null
      : text(exactRecord(enterprise, ["id"], ["id", "name"]).id, SLACK_ENTERPRISE_ID);
  const channel = exactRecord(payload.channel, ["id"], ["id", "name"]);
  const container = exactRecord(
    payload.container,
    ["type", "channel_id", "message_ts"],
    ["type", "channel_id", "message_ts", "is_ephemeral"],
  );
  const message = exactRecord(
    payload.message,
    ["type", "user", "ts", "app_id", "bot_id"],
    [
      "type",
      "user",
      "ts",
      "app_id",
      "bot_id",
      "bot_profile",
      "text",
      "team",
      "blocks",
      "thread_ts",
      "subtype",
      "attachments",
      "files",
      "metadata",
      "edited",
      "icons",
      "client_msg_id",
      "display_as_bot",
      "username",
    ],
  );
  if (container.type !== "message" || message.type !== "message") return invalid();
  const workspaceId = text(team.id, SLACK_TEAM_ID);
  const userId = text(user.id, SLACK_USER_ID);
  const channelId = text(channel.id, SLACK_CHANNEL_ID);
  const containerChannelId = text(container.channel_id, SLACK_CHANNEL_ID);
  const messageTs = text(message.ts, SLACK_MESSAGE_TIMESTAMP, 32);
  if (
    containerChannelId !== channelId ||
    text(container.message_ts, SLACK_MESSAGE_TIMESTAMP, 32) !== messageTs ||
    (user.team_id !== undefined && text(user.team_id, SLACK_TEAM_ID) !== workspaceId)
  ) {
    return invalid();
  }
  return Object.freeze({
    api_app_id: text(payload.api_app_id, SLACK_APP_ID),
    workspace_id: workspaceId,
    enterprise_id: enterpriseId,
    slack_user_id: userId,
    channel_id: channelId,
    message_ts: messageTs,
    message_user_id: text(message.user, SLACK_USER_ID),
    message_app_id: text(message.app_id, SLACK_APP_ID),
    message_bot_id: text(message.bot_id, SLACK_BOT_ID),
  });
}

function action(payload: UnknownRecord): UnknownRecord {
  const actions = payload.actions;
  if (!Array.isArray(actions) || actions.length !== 1) return invalid();
  const selected = exactRecord(
    actions[0],
    ["type", "action_id"],
    [
      "type",
      "action_id",
      "block_id",
      "value",
      "action_ts",
      "text",
      "style",
      "selected_option",
      "selected_options",
    ],
  );
  if (
    selected.style !== undefined &&
    (selected.type !== "button" ||
      (selected.style !== "primary" && selected.style !== "danger"))
  ) {
    return invalid();
  }
  return selected;
}

function requestEvidence(
  verified: VerifiedSlackRequestEvidenceV1,
): PrivateSlackApprovalVerifiedRequestEvidenceV1 {
  return Object.freeze({
    request_timestamp: verified.request_timestamp,
    signature_version: verified.signature_version,
    signature_sha256: verified.signature_sha256,
    raw_body_sha256: verified.raw_body_sha256,
  });
}

function providerActionKey(input: {
  readonly api_app_id: string;
  readonly workspace_id: string;
  readonly slack_user_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly trigger_id: string;
  readonly action_ts: string;
  readonly action_id: string;
}): `sha256:${string}` {
  return sha256(
    [
      "echo-private-slack-provider-action-key-v1",
      input.api_app_id,
      input.workspace_id,
      input.slack_user_id,
      input.channel_id,
      input.message_ts,
      input.trigger_id,
      input.action_ts,
      input.action_id,
    ].join("\u0000"),
  );
}

/**
 * Parses a Slack `block_actions` form only after signature verification.
 * Provider identity, message and container values stay lookup hints. The
 * later durable boundary must revalidate the app installation, DM, message,
 * active assignment, and external-person link before it can resolve anything.
 */
export function parseVerifiedPrivateSlackApprovalInteractionV1(
  verified: VerifiedPrivateSlackApprovalRequestV1,
): PrivateSlackApprovalInteractionV1 {
  let rejectionStage: PrivateSlackApprovalInteractionRejectionStageV1 =
    "unclassified";
  try {
    const verifiedRequest = verifiedRequests.get(verified);
    if (verifiedRequest === undefined) return invalid();
    rejectionStage = "form";
    const decoded = decodePayloadForm(verifiedRequest.body);
    rejectionStage = "envelope";
    const payload = exactRecord(
      decoded,
      [
        "type",
        "user",
        "api_app_id",
        "container",
        "trigger_id",
        "team",
        "channel",
        "message",
        "state",
        "actions",
      ],
      [
        "type",
        "user",
        "api_app_id",
        "container",
        "trigger_id",
        "team",
        "enterprise",
        "is_enterprise_install",
        "channel",
        "message",
        "state",
        "hash",
        "response_url",
        "token",
        "actions",
      ],
    );
    if (payload.hash !== undefined) text(payload.hash, IDENTIFIER);
    if (
      payload.type !== "block_actions" ||
      (payload.is_enterprise_install !== undefined &&
        typeof payload.is_enterprise_install !== "boolean") ||
      payload.is_enterprise_install === true
    ) {
      return invalid();
    }
    const triggerId = text(payload.trigger_id, SLACK_TRIGGER_ID, 512);
    rejectionStage = "lookup";
    const lookup = lookupHints(payload);
    const request = requestEvidence(verifiedRequest);
    rejectionStage = "action";
    const selected = action(payload);
    const actionId = text(selected.action_id, IDENTIFIER);

    const inputAction = SLACK_CARD_INPUT_ACTION.exec(actionId)?.[1];
    const v2InputAction = SLACK_CARD_V2_INPUT_ACTION.exec(actionId)?.[1];
    if (inputAction === "policy" || inputAction === "comment") {
      if (
        (inputAction === "policy" &&
          selected.type !== "radio_buttons" &&
          selected.type !== "static_select") ||
        (inputAction === "comment" && selected.type !== "plain_text_input")
      ) {
        return invalid();
      }
      return Object.freeze({
        schema_version: 1,
        kind: PRIVATE_SLACK_APPROVAL_INTERACTION_KIND,
        disposition: "presentation_change",
        action: inputAction,
        request,
        lookup,
      });
    }
    if (SLACK_CARD_V3_OWNER_ACTION.test(actionId)) {
      // Editing an owner field is a signed, content-free no-op like a comment edit.
      if (selected.type !== "plain_text_input") return invalid();
      return Object.freeze({
        schema_version: 1,
        kind: PRIVATE_SLACK_APPROVAL_INTERACTION_KIND,
        disposition: "presentation_change",
        action: "comment",
        request,
        lookup,
      });
    }
    if (v2InputAction === "policy" || v2InputAction === "projects" || v2InputAction === "share-transcript" || v2InputAction === "comment") {
      if (
        (v2InputAction === "policy" && selected.type !== "static_select") ||
        (v2InputAction === "projects" && selected.type !== "multi_static_select") ||
        (v2InputAction === "share-transcript" && selected.type !== "checkboxes") ||
        (v2InputAction === "comment" && selected.type !== "plain_text_input")
      ) return invalid();
      return Object.freeze({
        schema_version: 1,
        kind: PRIVATE_SLACK_APPROVAL_INTERACTION_KIND,
        disposition: "presentation_change",
        action: v2InputAction === "projects" || v2InputAction === "share-transcript" ? "policy" : v2InputAction,
        request,
        lookup,
      });
    }

    if (selected.type !== "button" || typeof selected.value !== "string") {
      return invalid();
    }
    const actionTs = text(selected.action_ts, SLACK_MESSAGE_TIMESTAMP, 32);
    rejectionStage = "card";
    const card = actionValue(selected.value);
    const approveId = card.schema_version === 1
      ? privateSlackApprovalBlockKitActionIdV1(card, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve)
      : privateSlackApprovalBlockKitActionIdV2(card, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2.approve);
    const rejectId = card.schema_version === 1
      ? privateSlackApprovalBlockKitActionIdV1(card, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V1.reject)
      : privateSlackApprovalBlockKitActionIdV2(card, PRIVATE_SLACK_APPROVAL_BLOCK_KIT_ACTIONS_V2.reject);
    const resolutionAction =
      actionId === approveId
        ? "approve"
        : actionId === rejectId
          ? "reject"
          : undefined;
    if (resolutionAction === undefined) {
      rejectionStage = "action";
      return invalid();
    }
    rejectionStage = "state";
    if (card.schema_version === 3) {
      const state = completeStateV2({ ...card, schema_version: 3, state: payload.state, action: resolutionAction });
      return Object.freeze({
        schema_version: 3,
        kind: "echo-private-approval-slack-interaction-v3" as const,
        disposition: "resolution" as const,
        action: resolutionAction,
        action_id: actionId,
        approval_id: card.approval_id,
        selected_policy_id: resolutionAction === "approve" ? state.selected_policy_id : null,
        selected_project_ids: resolutionAction === "approve" ? state.selected_project_ids : Object.freeze([]),
        share_transcript: resolutionAction === "approve" ? state.share_transcript : false,
        comment: state.comment,
        action_owners: resolutionAction === "approve" ? state.action_owners : Object.freeze([]),
        provider_action_key_sha256: providerActionKey({ api_app_id: lookup.api_app_id, workspace_id: lookup.workspace_id, slack_user_id: lookup.slack_user_id, channel_id: lookup.channel_id, message_ts: lookup.message_ts, trigger_id: triggerId, action_ts: actionTs, action_id: actionId }),
        request,
        lookup,
      });
    }
    if (card.schema_version === 2) {
      const state = completeStateV2({ ...card, schema_version: 2, state: payload.state, action: resolutionAction });
      return Object.freeze({
        schema_version: 2,
        kind: "echo-private-approval-slack-interaction-v2" as const,
        disposition: "resolution" as const,
        action: resolutionAction,
        action_id: actionId,
        approval_id: card.approval_id,
        selected_policy_id: resolutionAction === "approve" ? state.selected_policy_id : null,
        selected_project_ids: resolutionAction === "approve" ? state.selected_project_ids : Object.freeze([]),
        share_transcript: resolutionAction === "approve" ? state.share_transcript : false,
        comment: state.comment,
        provider_action_key_sha256: providerActionKey({ api_app_id: lookup.api_app_id, workspace_id: lookup.workspace_id, slack_user_id: lookup.slack_user_id, channel_id: lookup.channel_id, message_ts: lookup.message_ts, trigger_id: triggerId, action_ts: actionTs, action_id: actionId }),
        request,
        lookup,
      });
    }
    const state = completeState({ ...card, state: payload.state });
    return Object.freeze({
      schema_version: 1,
      kind: PRIVATE_SLACK_APPROVAL_INTERACTION_KIND,
      disposition: "resolution",
      action: resolutionAction,
      action_id: actionId,
      approval_id: card.approval_id,
      selected_policy_id:
        resolutionAction === "approve" ? state.selected_policy_id : null,
      comment: state.comment,
      provider_action_key_sha256: providerActionKey({
        api_app_id: lookup.api_app_id,
        workspace_id: lookup.workspace_id,
        slack_user_id: lookup.slack_user_id,
        channel_id: lookup.channel_id,
        message_ts: lookup.message_ts,
        trigger_id: triggerId,
        action_ts: actionTs,
        action_id: actionId,
      }),
      request,
      lookup,
    });
  } catch (error) {
    if (
      error instanceof PrivateSlackApprovalInteractionError &&
      error.rejection_stage === "unclassified"
    ) {
      throw new PrivateSlackApprovalInteractionError(rejectionStage);
    }
    throw error;
  }
}
