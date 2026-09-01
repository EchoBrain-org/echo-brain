import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseArguments,
  postPreviewCards,
  previewPayloads,
  validateReplay,
} from "../staging/replay-slack-card-preview.mjs";

const demo = resolve(import.meta.dirname, "..");
const meetingNames = [
  "01-revenue-signal-calibration.json",
  "02-data-handling-review.json",
  "03-implementation-capacity-triage.json",
  "04-commercial-exception-review.json",
];
const processor = Object.freeze({
  kind: "decision-processor",
  adapter_id: "replay-fixture",
  instance_id: "replay-fixture",
  version: "1.0.0",
});

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function replayRaw() {
  const items = meetingNames.map((name, index) => {
    const meeting = JSON.parse(readFileSync(resolve(demo, "meetings", name), "utf8"));
    const evidence = meeting.content[0];
    return {
      source_cursor: `synthetic-demo-source:customer-demo:1.0.0:v1:${index + 1}`,
      meeting,
      decisions: {
        schema_version: 1,
        meeting_id: meeting.id,
        meeting_revision: meeting.provenance.canonical_revision,
        processor,
        generated_at: "2026-08-31T00:00:00.000Z",
        signals: [{
          id: `decision-${index + 1}`,
          kind: "decision",
          text: `Replay decision ${index + 1}`,
          subject: null,
          confidence: null,
          status: "decided",
          evidence: [{ meeting_id: meeting.id, block_id: evidence.id }],
        }],
      },
    };
  });
  return JSON.stringify({
    schema_version: 1,
    kind: "echo-synthetic-demo-staged-extraction-replay-v1",
    source_commit: "a".repeat(40),
    items,
  });
}

test("replay projection is stable and rewrites the rendered controls inert", () => {
  const raw = replayRaw();
  const replay = validateReplay(raw, sha(raw));
  let projections = 0;
  const projectCard = (input) => {
    projections += 1;
    return {
      schema_version: 1,
      kind: "echo-private-approval-block-kit-card-v1",
      approval_id: input.approval_id,
      text: "Review",
      transport: { mrkdwn: false, unfurl_links: false, unfurl_media: false },
      blocks: [{
        type: "input",
        element: {
          type: "static_select",
          action_id: "echo-private-approval-v1-policy-v1",
          options: [{ text: { type: "plain_text", text: "Only me" }, value: "approval-policy" }],
          initial_option: { text: { type: "plain_text", text: "Only me" }, value: "approval-policy" },
        },
      }, {
        type: "actions",
        elements: [{
          action_id: "echo-private-approval-v1-approve-v1",
          value: '{"approval_id":"real"}',
          text: { type: "plain_text", text: "Approve meeting" },
        }],
      }, {
        type: "context",
        block_id: "echo-private-approval-v1-footer-v1",
        elements: [{ type: "plain_text", text: "old" }],
      }],
    };
  };
  const cards = previewPayloads(replay, {
    meeting_id: replay.pairs[2].meeting.id,
    all: false,
  }, projectCard);
  assert.equal(projections, 1);
  assert.equal(cards.length, 1);
  const serialized = JSON.stringify(cards[0]);
  assert.match(serialized, /Approve meeting/);
  assert.match(serialized, /Controls are inactive/);
  assert.doesNotMatch(serialized, /echo-private-approval-v1-policy-v1|approval-policy|"real"/);
  assert.match(serialized, /synthetic-preview-v1-/);
  const select = cards[0].blocks.find((block) => block.type === "input").element;
  assert.equal(select.initial_option.value, select.options[0].value);
  assert.deepEqual(cards, previewPayloads(replay, {
    meeting_id: replay.pairs[2].meeting.id,
    all: false,
  }, projectCard));
  const projected = previewPayloads(replay, {
    meeting_id: replay.pairs[2].meeting.id,
    all: false,
  });
  assert.deepEqual(projected, previewPayloads(replay, {
    meeting_id: replay.pairs[2].meeting.id,
    all: false,
  }));
  assert.match(
    JSON.stringify(projected),
    new RegExp(replay.pairs[2].meeting.title),
  );
  assert.doesNotMatch(JSON.stringify(projected), /Review meeting decisions/);
  assert.match(JSON.stringify(projected), /synthetic-preview-v1-/);
});

test("preview fails closed for a changed digest, noncanonical pair, or incomplete replay", () => {
  const raw = replayRaw();
  assert.throws(() => validateReplay(raw, sha(`${raw}changed`)), /validation failed/);
  const incomplete = JSON.parse(raw);
  incomplete.items.pop();
  assert.throws(() => validateReplay(JSON.stringify(incomplete), sha(JSON.stringify(incomplete))), /validation failed/);
  const mismatched = JSON.parse(raw);
  mismatched.items[0].decisions.meeting_id = "different";
  assert.throws(() => validateReplay(JSON.stringify(mismatched), sha(JSON.stringify(mismatched))), /validation failed/);
});

test("preview does not invoke an extraction or model boundary", async () => {
  const source = readFileSync(resolve(demo, "staging", "replay-slack-card-preview.mjs"), "utf8");
  assert.doesNotMatch(source, /createLlmDecisionProcessor|processor\.extract|synthetic-demo-main\.js|\bV4\b/);
  const calls = [];
  class PreviewClient {
    constructor(token) { calls.push(["token", token]); }
    async openDirectMessage(subject) { calls.push(["open", subject]); return { user_id: subject, channel_id: "D123" }; }
    async postMessage(message) { calls.push(["post", message.channel]); return { channel: "D123", ts: "1.000000" }; }
  }
  await postPreviewCards([{ text: "Preview", blocks: [], transport: { mrkdwn: false, unfurl_links: false, unfurl_media: false } }], {
    token: "opaque",
    subject: "U123",
    channel: "D123",
  }, PreviewClient);
  assert.deepEqual(calls.map(([kind]) => kind), ["token", "open", "post"]);
});

test("command parser requires one explicit selection and no mutable target flags", () => {
  assert.deepEqual(parseArguments([
    "--state-dir", "/state", "--replay", "/replay.json", "--replay-sha", `sha256:${"a".repeat(64)}`,
    "--meeting-id", "synthetic-demo-northstar-data-handling-review-2026-08-26",
  ]).all, false);
  assert.equal(parseArguments([
    "--state-dir", "/state", "--replay", "/replay.json", "--replay-sha", `sha256:${"a".repeat(64)}`, "--all",
  ]).all, true);
  assert.throws(() => parseArguments([
    "--state-dir", "/state", "--replay", "/replay.json", "--replay-sha", `sha256:${"a".repeat(64)}`,
  ]), /validation failed/);
  assert.throws(() => parseArguments([
    "--state-dir", "/state", "--replay", "/replay.json", "--replay-sha", `sha256:${"a".repeat(64)}`,
    "--all", "--meeting-id", "x",
  ]), /validation failed/);
  assert.throws(() => parseArguments([
    "--state-dir", "/state", "--replay", "/replay.json", "--replay-sha", `sha256:${"a".repeat(64)}`,
    "--channel", "D123", "--all",
  ]), /validation failed/);
});
