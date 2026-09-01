#!/usr/bin/env node
/**
 * One-shot Slack-format preview for the frozen synthetic extraction replay.
 * This intentionally has no extraction, Authority-runtime, or approval write
 * path: it projects the preserved pairs and posts inert Slack controls only.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const requireFromRuntime = createRequire(resolve(process.cwd(), "package.json"));
const Database = requireFromRuntime("better-sqlite3");

const root = process.cwd();
const fromRuntime = (path) => pathToFileURL(resolve(root, path)).href;
const {
  FileOrganizationSecretStore,
  SqliteSlackBotTokenReaderV1,
} = await import(fromRuntime(
  "node_modules/@echo-brain/organization-control-plane/dist/slack-approval-integration-v1.js",
));
const { canonicalSha256 } = await import(fromRuntime(
  "node_modules/@echo-brain/federation-protocol/dist/index.js",
));
const { projectPrivateSlackApprovalCardV1 } = await import(fromRuntime(
  "services/organization-authority/dist/composition/providers/slack/private-approval/private-slack-dm-approval-stager-v1.js",
));
const { assertCanonicalDecisionSet, assertCanonicalMeetingDocument } = await import(fromRuntime(
  "services/organization-authority/dist/processing/core/index.js",
));
const { SlackWebApiClient } = await import(fromRuntime(
  "services/organization-authority/dist/processing/adapters/shared/slack/slack-web-api-client.js",
));

const SYNTHETIC_SOURCE = Object.freeze({
  kind: "meeting-source",
  adapter_id: "synthetic-demo-source",
  instance_id: "customer-demo",
  version: "1.0.0",
});
const MEETING_IDS = Object.freeze([
  "synthetic-demo-northstar-revenue-signal-calibration-2026-08-24",
  "synthetic-demo-northstar-data-handling-review-2026-08-26",
  "synthetic-demo-northstar-implementation-capacity-2026-08-28",
  "synthetic-demo-northstar-commercial-exception-2026-08-29",
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PREVIEW_PREFIX = "synthetic-preview-v1";

function fail() {
  throw new Error("Slack card preview validation failed");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedSha256(value) {
  const normalized = typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? `sha256:${value}`
    : value;
  if (!SHA256.test(normalized)) fail();
  return normalized;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function processorIdentity(value) {
  if (!exactKeys(value, ["kind", "adapter_id", "instance_id", "version"]) ||
      value.kind !== "decision-processor" ||
      [value.adapter_id, value.instance_id, value.version].some((part) =>
        typeof part !== "string" || part.length === 0,
      )) fail();
  return Object.freeze({ ...value });
}

/** Validates the fixed, content-addressed replay before any provider call. */
export function validateReplay(raw, expectedReplaySha) {
  if (digest(raw) !== normalizedSha256(expectedReplaySha)) fail();
  let replay;
  try {
    replay = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!exactKeys(replay, ["schema_version", "kind", "source_commit", "items"]) ||
      replay.schema_version !== 1 ||
      replay.kind !== "echo-synthetic-demo-staged-extraction-replay-v1" ||
      typeof replay.source_commit !== "string" || !/^[0-9a-f]{40}$/.test(replay.source_commit) ||
      !Array.isArray(replay.items) || replay.items.length !== MEETING_IDS.length) fail();
  let processor;
  const cursors = new Set();
  const pairs = replay.items.map((item, index) => {
    if (!exactKeys(item, ["source_cursor", "meeting", "decisions"]) ||
        typeof item.source_cursor !== "string" || item.source_cursor.trim() !== item.source_cursor ||
        item.source_cursor.length === 0 || cursors.has(item.source_cursor)) fail();
    cursors.add(item.source_cursor);
    const itemProcessor = processorIdentity(item.decisions?.processor);
    if (processor === undefined) processor = itemProcessor;
    if (itemProcessor.kind !== processor.kind || itemProcessor.adapter_id !== processor.adapter_id ||
        itemProcessor.instance_id !== processor.instance_id || itemProcessor.version !== processor.version) fail();
    try {
      assertCanonicalMeetingDocument(item.meeting, SYNTHETIC_SOURCE);
      assertCanonicalDecisionSet(item.decisions, item.meeting, processor);
    } catch {
      fail();
    }
    if (item.meeting.id !== MEETING_IDS[index]) fail();
    return Object.freeze({ meeting: item.meeting, decisions: item.decisions });
  });
  return Object.freeze({ replay_sha256: digest(raw), pairs: Object.freeze(pairs) });
}

function previewApprovalId(replaySha, meetingId) {
  return `${PREVIEW_PREFIX}-${createHash("sha256")
    .update(`${replaySha}\u0000${meetingId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/** Keeps the review labels while making every Slack interaction unrouteable. */
export function inertPreviewCard(card, replaySha, meetingId) {
  const previewKey = createHash("sha256")
    .update(`${replaySha}\u0000${meetingId}`)
    .digest("hex")
    .slice(0, 20);
  let control = 0;
  const inertControl = (action) => `${PREVIEW_PREFIX}-${previewKey}-${action}-${++control}`;
  const blocks = structuredClone(card.blocks).map((block) => {
    if (block.type === "input" && block.element !== undefined) {
      const element = block.element;
      element.action_id = inertControl("input");
      if (element.type === "static_select") {
        if (!Array.isArray(element.options) || element.initial_option === undefined) fail();
        const originalInitialValue = element.initial_option.value;
        const rewrittenOptions = new Map();
        element.options.forEach((option) => {
          const value = inertControl("option");
          rewrittenOptions.set(option.value, value);
          option.value = value;
        });
        const value = rewrittenOptions.get(originalInitialValue);
        if (value === undefined) fail();
        element.initial_option.value = value;
      }
    }
    if (block.type === "actions" && Array.isArray(block.elements)) {
      block.elements.forEach((element) => {
        element.action_id = inertControl("button");
        element.value = inertControl("value");
      });
    }
    if (block.type === "context" && String(block.block_id ?? "").includes("footer")) {
      block.elements = [{
        type: "plain_text",
        text: "Preview only. Controls are inactive and cannot approve or reject.",
        emoji: false,
      }];
    }
    return block;
  });
  return Object.freeze({
    ...card,
    text: `${card.text}\nPreview only. Controls are inactive.`,
    blocks: Object.freeze(blocks),
  });
}

export function previewPayloads(replay, selection, project = projectPrivateSlackApprovalCardV1) {
  const selected = selection.all
    ? replay.pairs
    : replay.pairs.filter((pair) => pair.meeting.id === selection.meeting_id);
  if (selected.length === 0 || (!selection.all && selected.length !== 1)) fail();
  return Object.freeze(selected.map((pair) => {
    const card = project({
      approval_id: previewApprovalId(replay.replay_sha256, pair.meeting.id),
      meeting: pair.meeting,
      decisions: pair.decisions,
    });
    if (card === undefined) fail();
    return inertPreviewCard(card, replay.replay_sha256, pair.meeting.id);
  }));
}

function readonlyDatabase(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  return database;
}

/** Reads exactly one durable founder-DM assignment; no caller-supplied target is accepted. */
export function readPreviewDeliveryTarget(stateDir) {
  const authority = readonlyDatabase(resolve(stateDir, "authority.sqlite"));
  const control = readonlyDatabase(resolve(stateDir, "integrations.sqlite"));
  try {
    const assignments = authority.prepare(
      `SELECT DISTINCT connection_id, connection_state_sha256, slack_subject_id, slack_dm_channel_id
         FROM authority_private_approval_assignments_v3
        ORDER BY approval_id`,
    ).all();
    if (assignments.length !== 1) fail();
    const assignment = assignments[0];
    const secrets = new FileOrganizationSecretStore(resolve(stateDir, "secrets"));
    const token = new SqliteSlackBotTokenReaderV1(control, secrets).readBotToken({
      connection_id: assignment.connection_id,
      connection_state_sha256: assignment.connection_state_sha256,
    });
    if (typeof assignment.slack_subject_id !== "string" ||
        typeof assignment.slack_dm_channel_id !== "string") fail();
    return Object.freeze({ token, subject: assignment.slack_subject_id, channel: assignment.slack_dm_channel_id });
  } finally {
    control.close();
    authority.close();
  }
}

export async function postPreviewCards(cards, target, Client = SlackWebApiClient) {
  const slack = new Client(target.token);
  const dm = await slack.openDirectMessage(target.subject);
  if (dm.user_id !== target.subject || dm.channel_id !== target.channel) fail();
  for (const card of cards) {
    await slack.postMessage({
      channel: dm.channel_id,
      text: card.text,
      blocks: card.blocks,
      mrkdwn: card.transport.mrkdwn,
      unfurlLinks: card.transport.unfurl_links,
      unfurlMedia: card.transport.unfurl_media,
    });
  }
}

export function parseArguments(argumentsList) {
  const values = new Map();
  let all = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--all") {
      if (all) fail();
      all = true;
      continue;
    }
    if (!["--state-dir", "--replay", "--replay-sha", "--meeting-id"].includes(argument) ||
        values.has(argument) || index + 1 >= argumentsList.length) fail();
    values.set(argument, argumentsList[++index]);
  }
  const stateDir = values.get("--state-dir");
  const replayPath = values.get("--replay");
  const replaySha = values.get("--replay-sha");
  const meetingId = values.get("--meeting-id");
  if (typeof stateDir !== "string" || typeof replayPath !== "string" ||
      typeof replaySha !== "string" || !isAbsolute(stateDir) || !isAbsolute(replayPath) ||
      (all === (typeof meetingId === "string"))) fail();
  return Object.freeze({ state_dir: stateDir, replay_path: replayPath, replay_sha: normalizedSha256(replaySha), all, meeting_id: meetingId });
}

export async function runPreview(argumentsList) {
  const input = parseArguments(argumentsList);
  const replayState = lstatSync(input.replay_path);
  if (!replayState.isFile() || replayState.isSymbolicLink()) fail();
  const replay = validateReplay(readFileSync(input.replay_path, "utf8"), input.replay_sha);
  const cards = previewPayloads(replay, input);
  await postPreviewCards(cards, readPreviewDeliveryTarget(input.state_dir));
  process.stdout.write(`${JSON.stringify(Object.freeze({
    kind: "echo-synthetic-demo-slack-card-preview-v1",
    posted_card_count: cards.length,
    replay_sha256: replay.replay_sha256,
    card_batch_sha256: canonicalSha256(cards),
  }))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreview(process.argv.slice(2)).catch(() => {
    process.stderr.write("Slack card preview failed\n");
    process.exitCode = 1;
  });
}
