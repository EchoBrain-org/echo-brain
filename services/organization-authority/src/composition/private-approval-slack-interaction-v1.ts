import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type PersonApprovalPolicyId,
} from "@echo-brain/organization-control-plane/clean-runtime-v1";
import {
  PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1,
  privateApprovalBlockKitActionIdV1,
} from "./private-approval-block-kit-card-v1.js";

/** The largest Slack interactivity request this pure boundary will retain. */
export const PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_BODY_BYTES = 64 * 1024;
export const PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_AGE_SECONDS = 5 * 60;

const PRIVATE_APPROVAL_SLACK_INTERACTION_KIND =
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
const DISALLOWED_COMMENT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
interface VerifiedSlackRequestEvidenceV1 {
  readonly body: Uint8Array;
  readonly request_timestamp: string;
  readonly signature_version: "v0";
  readonly signature_sha256: `sha256:${string}`;
  readonly raw_body_sha256: `sha256:${string}`;
}

const verifiedRequests = new WeakMap<
  VerifiedPrivateApprovalSlackRequestV1,
  VerifiedSlackRequestEvidenceV1
>();

type UnknownRecord = Record<string, unknown>;

/**
 * A verification capability, intentionally opaque: it exposes neither the
 * raw provider body nor the signing secret. Parsing requires this capability,
 * which prevents accidental parse-before-verification wiring.
 */
export class VerifiedPrivateApprovalSlackRequestV1 {
  private constructor() {}

  static create(): VerifiedPrivateApprovalSlackRequestV1 {
    return Object.freeze(new VerifiedPrivateApprovalSlackRequestV1());
  }
}

export interface VerifyPrivateApprovalSlackRequestInputV1 {
  readonly raw_body: Uint8Array;
  readonly signing_secret: string;
  readonly headers: {
    readonly "x-slack-request-timestamp": string | undefined;
    readonly "x-slack-signature": string | undefined;
  };
  /** Injectable only for deterministic tests and a clock-owned HTTP adapter. */
  readonly now_unix_seconds?: number;
}

export interface PrivateApprovalSlackLookupHintsV1 {
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

export interface PrivateApprovalSlackVerifiedRequestEvidenceV1 {
  readonly request_timestamp: string;
  readonly signature_version: "v0";
  /** Digest of the received signature header, never the signature itself. */
  readonly signature_sha256: `sha256:${string}`;
  readonly raw_body_sha256: `sha256:${string}`;
}

export interface PrivateApprovalSlackPresentationChangeV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_SLACK_INTERACTION_KIND;
  /** A signed input change is intentionally a no-op in V1. */
  readonly disposition: "presentation_change";
  readonly action: "policy" | "comment";
  readonly request: PrivateApprovalSlackVerifiedRequestEvidenceV1;
  readonly lookup: PrivateApprovalSlackLookupHintsV1;
}

export interface PrivateApprovalSlackResolutionIntentV1 {
  readonly schema_version: 1;
  readonly kind: typeof PRIVATE_APPROVAL_SLACK_INTERACTION_KIND;
  readonly disposition: "resolution";
  readonly action: "approve" | "reject";
  /** Exact verified terminal button identifier for the durable receipt. */
  readonly action_id: string;
  readonly approval_id: string;
  readonly assignment_version: number;
  /** Null for reject even though its complete UI state includes a radio value. */
  readonly selected_policy_id: PersonApprovalPolicyId | null;
  /** A canonical bounded string, or null for an empty optional input. */
  readonly comment: string | null;
  /** Stable digest of Slack's trigger/action tuple; no trigger token is retained. */
  readonly provider_action_key_sha256: `sha256:${string}`;
  readonly request: PrivateApprovalSlackVerifiedRequestEvidenceV1;
  readonly lookup: PrivateApprovalSlackLookupHintsV1;
}

export type PrivateApprovalSlackInteractionV1 =
  | PrivateApprovalSlackPresentationChangeV1
  | PrivateApprovalSlackResolutionIntentV1;

/** Deliberately generic so errors never reflect a secret or raw Slack body. */
export class PrivateApprovalSlackInteractionError extends Error {
  constructor() {
    super("private approval Slack interaction is invalid");
    this.name = "PrivateApprovalSlackInteractionError";
  }
}

function invalid(): never {
  throw new PrivateApprovalSlackInteractionError();
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

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
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
  if (!(value instanceof Uint8Array) || value.byteLength > PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_BODY_BYTES) {
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
export function verifyPrivateApprovalSlackRequestV1(
  input: VerifyPrivateApprovalSlackRequestInputV1,
): VerifiedPrivateApprovalSlackRequestV1 {
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
  if (Math.abs(current - timestamp) > PRIVATE_APPROVAL_SLACK_INTERACTION_MAX_AGE_SECONDS) {
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
  const verified = VerifiedPrivateApprovalSlackRequestV1.create();
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
  readonly assignment_version: number;
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
    "assignment_version",
  ]);
  if (record.schema_version !== 1) return invalid();
  return Object.freeze({
    approval_id: text(record.approval_id, IDENTIFIER),
    assignment_version: positive(record.assignment_version),
  });
}

function selectedPolicy(value: unknown): PersonApprovalPolicyId {
  const option = exactRecord(value, ["text", "value"]);
  if (typeof option.text !== "object" || option.text === null) return invalid();
  if (
    option.value !== RESTRICTED_REVIEWER_PERSON_POLICY_ID &&
    option.value !== ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID
  ) {
    return invalid();
  }
  return option.value;
}

function completeState(input: {
  readonly state: unknown;
  readonly approval_id: string;
  readonly assignment_version: number;
}): { readonly selected_policy_id: PersonApprovalPolicyId; readonly comment: string | null } {
  const state = exactRecord(input.state, ["values"]);
  const values = plainRecord(state.values);
  const policyActionId = privateApprovalBlockKitActionIdV1(
    input,
    PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.policy,
  );
  const commentActionId = privateApprovalBlockKitActionIdV1(
    input,
    PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.comment,
  );
  const blocks = Object.values(values);
  if (blocks.length !== 2) return invalid();

  let policy: PersonApprovalPolicyId | undefined;
  let comment: string | null | undefined;
  for (const block of blocks) {
    const element = plainRecord(block);
    const keys = Object.keys(element);
    if (keys.length !== 1) return invalid();
    if (keys[0] === policyActionId) {
      const radio = exactRecord(element[policyActionId], [
        "type",
        "selected_option",
      ]);
      if (radio.type !== "radio_buttons") return invalid();
      policy = selectedPolicy(radio.selected_option);
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

function lookupHints(payload: UnknownRecord): PrivateApprovalSlackLookupHintsV1 {
  const user = exactRecord(payload.user, ["id"], ["id", "username", "name", "team_id"]);
  const team = exactRecord(payload.team, ["id"], ["id", "domain"]);
  const enterprise = payload.enterprise;
  const enterpriseId =
    enterprise === null
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
  return exactRecord(
    actions[0],
    ["type", "action_id"],
    [
      "type",
      "action_id",
      "block_id",
      "value",
      "action_ts",
      "text",
      "selected_option",
      "selected_options",
    ],
  );
}

function requestEvidence(
  verified: VerifiedSlackRequestEvidenceV1,
): PrivateApprovalSlackVerifiedRequestEvidenceV1 {
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
 * later durable boundary must reprove the app installation, DM, message,
 * active assignment, and external-person link before it can resolve anything.
 */
export function parseVerifiedPrivateApprovalSlackInteractionV1(
  verified: VerifiedPrivateApprovalSlackRequestV1,
): PrivateApprovalSlackInteractionV1 {
  const verifiedRequest = verifiedRequests.get(verified);
  if (verifiedRequest === undefined) return invalid();
  const payload = exactRecord(
    decodePayloadForm(verifiedRequest.body),
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
      "response_url",
      "token",
      "actions",
    ],
  );
  if (payload.type !== "block_actions" || typeof payload.is_enterprise_install !== "boolean") {
    return invalid();
  }
  const lookup = lookupHints(payload);
  const request = requestEvidence(verifiedRequest);
  const triggerId = text(payload.trigger_id, SLACK_TRIGGER_ID, 512);
  const selected = action(payload);
  const actionId = text(selected.action_id, IDENTIFIER);

  const inputAction = SLACK_CARD_INPUT_ACTION.exec(actionId)?.[1];
  if (inputAction === "policy" || inputAction === "comment") {
    const expectedType = inputAction === "policy" ? "radio_buttons" : "plain_text_input";
    if (selected.type !== expectedType) return invalid();
    return Object.freeze({
      schema_version: 1,
      kind: PRIVATE_APPROVAL_SLACK_INTERACTION_KIND,
      disposition: "presentation_change",
      action: inputAction,
      request,
      lookup,
    });
  }

  if (selected.type !== "button" || typeof selected.value !== "string") return invalid();
  const actionTs = text(selected.action_ts, SLACK_MESSAGE_TIMESTAMP, 32);
  const card = actionValue(selected.value);
  const approveId = privateApprovalBlockKitActionIdV1(
    card,
    PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.approve,
  );
  const rejectId = privateApprovalBlockKitActionIdV1(
    card,
    PRIVATE_APPROVAL_BLOCK_KIT_ACTIONS_V1.reject,
  );
  const resolutionAction = actionId === approveId ? "approve" : actionId === rejectId ? "reject" : undefined;
  if (resolutionAction === undefined) return invalid();
  const state = completeState({ ...card, state: payload.state });
  return Object.freeze({
    schema_version: 1,
    kind: PRIVATE_APPROVAL_SLACK_INTERACTION_KIND,
    disposition: "resolution",
    action: resolutionAction,
    action_id: actionId,
    approval_id: card.approval_id,
    assignment_version: card.assignment_version,
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
}
