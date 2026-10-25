import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Digest } from "@echo-brain/federation-protocol";
import {
  isApprovalOwnerTextV1,
  isApprovalSignalIdV1,
} from "@echo-brain/organization-protocol";
import {
  slackApprovalActionIdV4,
  slackApprovalOwnerActionIdV4,
} from "./slack-approval-card-v4.js";

/** The largest Slack interactivity request this pure boundary will retain. */
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES = 64 * 1024;
export const PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS = 5 * 60;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const USER = /^[UW][A-Z0-9]{2,255}$/;
const TEAM = /^T[A-Z0-9]{2,255}$/;
const APP = /^A[A-Z0-9]{2,255}$/;
const BOT = /^B[A-Z0-9]{2,255}$/;
const CHANNEL = /^[CDG][A-Z0-9]{2,255}$/;
const TS = /^[0-9]{1,16}\.[0-9]{1,9}$/;
const TRIGGER = /^[A-Za-z0-9._-]{16,512}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
type RecordValue = Record<string, unknown>;
interface VerifiedEvidence {
  readonly body: Uint8Array;
}
const evidence = new WeakMap<
  VerifiedPrivateSlackApprovalRequestV1,
  VerifiedEvidence
>();

export class VerifiedPrivateSlackApprovalRequestV1 {
  private constructor() {}
  static create() {
    return Object.freeze(new VerifiedPrivateSlackApprovalRequestV1());
  }
}
export class PrivateSlackApprovalInteractionError extends Error {
  constructor() {
    super("private approval Slack interaction is invalid");
    this.name = "PrivateSlackApprovalInteractionError";
  }
}
export interface VerifyPrivateSlackApprovalRequestInputV1 {
  readonly raw_body: Uint8Array;
  readonly signing_secret: string;
  readonly headers: {
    readonly "x-slack-request-timestamp": string | undefined;
    readonly "x-slack-signature": string | undefined;
  };
  readonly now_unix_seconds?: number;
}
export interface PrivateSlackApprovalLookupHintsV1 {
  readonly api_app_id: string;
  readonly workspace_id: string;
  readonly slack_user_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly message_user_id: string;
  readonly message_app_id: string;
  readonly message_bot_id: string;
}
/**
 * A verified Approve or Reject. Slack approves as suggested, so a click chooses no destination: it carries the digest of the
 * one its card showed (slackApprovalDestinationSha256V4) and the owners typed on the card.
 */
export interface VerifiedSlackApprovalClickV1 {
  readonly schema_version: 4;
  readonly disposition: "resolution";
  readonly action: "approve" | "reject";
  readonly approval_id: string;
  readonly snapshot_sha256: `sha256:${string}`;
  /** Where the card said Approve sends every item; an approval decides only while the suggestion is still that. */
  readonly destination_sha256: `sha256:${string}`;
  readonly owners: readonly {
    readonly signal_id: string;
    readonly owner: string;
  }[];
  readonly provider_action_key_sha256: `sha256:${string}`;
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
}
export interface PrivateSlackApprovalPresentationChangeV1 {
  readonly schema_version: 4;
  readonly disposition: "presentation_change";
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
}
export type PrivateSlackApprovalInteractionV1 =
  VerifiedSlackApprovalClickV1 | PrivateSlackApprovalPresentationChangeV1;
function invalid(): never {
  throw new PrivateSlackApprovalInteractionError();
}
function record(value: unknown): RecordValue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    invalid();
  return value as RecordValue;
}
function exact(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): RecordValue {
  const found = record(value),
    keys = Object.keys(found);
  if (
    required.some((key) => !Object.hasOwn(found, key)) ||
    keys.some((key) => !allowed.includes(key))
  )
    invalid();
  return found;
}
function string(
  value: unknown,
  pattern: RegExp,
  maximum = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !pattern.test(value)
  )
    invalid();
  return value;
}
function plainText(value: unknown): void {
  const text = exact(value, ["type", "text"], ["type", "text", "emoji"]);
  if (
    text.type !== "plain_text" ||
    typeof text.text !== "string" ||
    text.text.length === 0 ||
    text.text.length > 75 ||
    (text.emoji !== undefined && typeof text.emoji !== "boolean")
  )
    invalid();
}
function form(body: Uint8Array): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return invalid();
  }
  const fields = [...new URLSearchParams(source).entries()];
  if (fields.length !== 1 || fields[0]?.[0] !== "payload") invalid();
  try {
    return JSON.parse(fields[0]![1]) as unknown;
  } catch {
    return invalid();
  }
}

/** Verifies Slack's v0 HMAC over original bytes before a parser can see the payload. */
export function verifyPrivateSlackApprovalRequestV1(
  input: VerifyPrivateSlackApprovalRequestInputV1,
): VerifiedPrivateSlackApprovalRequestV1 {
  if (
    !(input.raw_body instanceof Uint8Array) ||
    input.raw_body.byteLength >
      PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_BODY_BYTES ||
    typeof input.signing_secret !== "string" ||
    input.signing_secret.length === 0
  )
    invalid();
  const timestamp = input.headers["x-slack-request-timestamp"];
  const signature = input.headers["x-slack-signature"];
  if (
    typeof timestamp !== "string" ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    typeof signature !== "string" ||
    !/^v0=[0-9a-f]{64}$/.test(signature)
  )
    invalid();
  const current = input.now_unix_seconds ?? Math.floor(Date.now() / 1000),
    seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(current) ||
    Math.abs(current - seconds) >
      PRIVATE_SLACK_APPROVAL_INTERACTION_MAX_AGE_SECONDS
  )
    invalid();
  const expected = createHmac("sha256", input.signing_secret)
    .update(`v0:${timestamp}:`)
    .update(input.raw_body)
    .digest("hex");
  if (
    !timingSafeEqual(
      new TextEncoder().encode(expected),
      new TextEncoder().encode(signature.slice(3)),
    )
  )
    invalid();
  const verified = VerifiedPrivateSlackApprovalRequestV1.create();
  evidence.set(
    verified,
    Object.freeze({ body: Uint8Array.from(input.raw_body) }),
  );
  return verified;
}
const USER_METADATA_FIELDS = [
  "id",
  "team_id",
  "username",
  "name",
  "profile",
] as const;
const TEAM_METADATA_FIELDS = [
  "id",
  "domain",
  "name",
  "enterprise_id",
  "enterprise_name",
  "image_34",
  "image_44",
  "image_68",
  "image_88",
  "image_102",
  "image_132",
  "image_230",
  "image_default",
] as const;
const MESSAGE_METADATA_FIELDS = [
  "type",
  "user",
  "username",
  "text",
  "ts",
  "app_id",
  "bot_id",
  "bot_profile",
  "blocks",
  "attachments",
  "team",
  "thread_ts",
  "subtype",
  "edited",
  "permalink",
  "icons",
  "files",
  "upload",
  "client_msg_id",
  "last_read",
  "event_ts",
] as const;

function lookup(payload: RecordValue): PrivateSlackApprovalLookupHintsV1 {
  const user = exact(payload.user, ["id"], USER_METADATA_FIELDS);
  const team = exact(payload.team, ["id"], TEAM_METADATA_FIELDS);
  const channel = exact(payload.channel, ["id"], ["id", "name"]);
  const container = exact(
    payload.container,
    ["type", "channel_id", "message_ts"],
    ["type", "channel_id", "message_ts", "is_ephemeral"],
  );
  const message = exact(
    payload.message,
    ["type", "user", "ts", "app_id", "bot_id"],
    MESSAGE_METADATA_FIELDS,
  );
  const workspace_id = string(team.id, TEAM);
  const slack_user_id = string(user.id, USER);
  const channel_id = string(channel.id, CHANNEL);
  const message_ts = string(message.ts, TS, 32);

  if (
    payload.type !== "block_actions" ||
    container.type !== "message" ||
    message.type !== "message" ||
    string(container.channel_id, CHANNEL) !== channel_id ||
    string(container.message_ts, TS, 32) !== message_ts ||
    (user.team_id !== undefined &&
      string(user.team_id, TEAM) !== workspace_id)
  )
    invalid();

  return Object.freeze({
    api_app_id: string(payload.api_app_id, APP),
    workspace_id,
    slack_user_id,
    channel_id,
    message_ts,
    message_user_id: string(message.user, USER),
    message_app_id: string(message.app_id, APP),
    message_bot_id: string(message.bot_id, BOT),
  });
}
const BUTTON_KEYS = ["schema_version", "approval_id", "snapshot_sha256", "destination_sha256"] as const;
function value(action: RecordValue): {
  readonly approval_id: string;
  readonly snapshot_sha256: `sha256:${string}`;
  readonly destination_sha256: `sha256:${string}`;
} {
  if (typeof action.value !== "string" || action.value.length > 1024)
    invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(action.value);
  } catch {
    return invalid();
  }
  const button = exact(parsed, BUTTON_KEYS, BUTTON_KEYS);
  if (button.schema_version !== 3) invalid();
  const snapshot = string(button.snapshot_sha256, DIGEST, 80);
  const destination = string(button.destination_sha256, DIGEST, 80);
  return Object.freeze({
    approval_id: string(button.approval_id, IDENTIFIER),
    snapshot_sha256: snapshot as `sha256:${string}`,
    destination_sha256: destination as `sha256:${string}`,
  });
}
/** The owner inputs of the card's state. A reject keeps none; an approval needs no other state, since it sends every item to the suggestion. */
function state(
  payload: RecordValue,
  approval_id: string,
  action: "approve" | "reject",
) {
  const values = record(
    exact(payload.state, ["values"], ["values"]).values,
  );
  const owners: { signal_id: string; owner: string }[] = [];
  for (const block of Object.values(values)) {
    const entry = record(block),
      keys = Object.keys(entry);
    if (keys.length !== 1) invalid();
    const key = keys[0]!;
    const control = record(entry[key]);
    const prefix = slackApprovalOwnerActionIdV4(approval_id, "");
    if (!key.startsWith(prefix)) invalid();
    const signal_id = key.slice(prefix.length);
    if (
      !isApprovalSignalIdV1(signal_id) ||
      control.type !== "plain_text_input" ||
      (control.value !== null && !isApprovalOwnerTextV1(control.value))
    )
      invalid();
    if (control.value !== null)
      owners.push({ signal_id, owner: control.value });
  }
  if (
    owners.length > 40 ||
    new Set(owners.map((owner) => owner.signal_id)).size !== owners.length
  )
    invalid();
  return Object.freeze({
    owners: Object.freeze(action === "reject" ? [] : owners),
  });
}
function presentationChangeAction(actionId: string, type: unknown): boolean {
  const control =
    /^echo-approval-v4-[0-9a-f]{32}-(owner-[A-Za-z0-9._:-]{1,255})$/.exec(
      actionId,
    )?.[1];
  return control !== undefined && type === "plain_text_input";
}
function providerKey(input: {
  readonly lookup: PrivateSlackApprovalLookupHintsV1;
  readonly trigger_id: string;
  readonly action_ts: string;
  readonly action_id: string;
}): `sha256:${string}` {
  const { lookup } = input;
  return sha256Digest(
    [
      "echo-private-slack-provider-action-key-v1",
      lookup.api_app_id,
      lookup.workspace_id,
      lookup.slack_user_id,
      lookup.channel_id,
      lookup.message_ts,
      input.trigger_id,
      input.action_ts,
      input.action_id,
    ].join("\0"),
  );
}

/** Parses only V4 controls after verification. Provider fields remain lookup hints for the durable click boundary. */
export function parseVerifiedPrivateSlackApprovalInteractionV1(
  verified: VerifiedPrivateSlackApprovalRequestV1,
): PrivateSlackApprovalInteractionV1 {
  try {
    const retained = evidence.get(verified);
    if (!retained) invalid();
    const payload = exact(
      form(retained.body),
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
        "channel",
        "message",
        "state",
        "actions",
        "enterprise",
        "is_enterprise_install",
        "hash",
        "response_url",
        "token",
      ],
    );
    if (payload.hash !== undefined)
      string(payload.hash, IDENTIFIER);
    if (payload.token !== undefined)
      string(payload.token, TOKEN, 4096);
    const hints = lookup(payload);
    const actions = payload.actions;
    if (!Array.isArray(actions) || actions.length !== 1) invalid();
    const selected = exact(
      actions[0],
      ["type", "action_id"],
      ["type", "action_id", "block_id", "text", "value", "action_ts", "style"],
    );
    const action_id = string(selected.action_id, IDENTIFIER);
    const trigger_id = string(payload.trigger_id, TRIGGER, 512);
    if (selected.type !== "button") {
      if (!presentationChangeAction(action_id, selected.type))
        invalid();
      return Object.freeze({
        schema_version: 4,
        disposition: "presentation_change",
        lookup: hints,
      });
    }
    plainText(selected.text);
    const button = value(selected);
    const expected =
      selected.action_id ===
      slackApprovalActionIdV4(button.approval_id, "approve")
        ? "approve"
        : selected.action_id ===
            slackApprovalActionIdV4(button.approval_id, "reject")
          ? "reject"
          : undefined;
    if (
      !expected ||
      typeof selected.action_ts !== "string" ||
      !TS.test(selected.action_ts)
    )
      invalid();
    const choices = state(payload, button.approval_id, expected);
    return Object.freeze({
      schema_version: 4,
      disposition: "resolution",
      action: expected,
      approval_id: button.approval_id,
      snapshot_sha256: button.snapshot_sha256,
      destination_sha256: button.destination_sha256,
      ...choices,
      provider_action_key_sha256: providerKey({
        lookup: hints,
        trigger_id,
        action_ts: selected.action_ts,
        action_id,
      }),
      lookup: hints,
    });
  } catch (error) {
    if (error instanceof PrivateSlackApprovalInteractionError) throw error;
    throw new PrivateSlackApprovalInteractionError();
  }
}

/** Extracted only on the verified, request-local handler path. It is never part of a parsed click or durable record. */
export function verifiedSlackResponseUrlV1(
  verified: VerifiedPrivateSlackApprovalRequestV1,
): string | undefined {
  const retained = evidence.get(verified);
  if (!retained) return undefined;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
        retained.body,
      ),
      fields = new URLSearchParams(source);
    if ([...fields.keys()].length !== 1 || !fields.has("payload"))
      return undefined;
    const payload = JSON.parse(fields.get("payload")!) as {
      readonly response_url?: unknown;
    };
    const value = payload.response_url;
    if (typeof value !== "string") return undefined;
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "hooks.slack.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname.startsWith("/actions/") &&
      url.search === "" &&
      url.hash === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
