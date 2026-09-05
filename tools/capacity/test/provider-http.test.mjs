import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createProviderHttpFixtureServer,
  postSignedSlackInteraction,
  verifySyntheticSlackSignature,
} from "../provider-http.mjs";

const note = {
  id: "note-1",
  object: "note",
  title: "Capacity fixture",
  owner: { email: "owner@example.test" },
  transcript: [{ text: "A frozen synthetic meeting." }],
};

async function withFixture(callback) {
  const fixture = createProviderHttpFixtureServer({
    granola: {
      pages: [{
        query: { page_size: "2" },
        response: { notes: [{ id: note.id, owner: note.owner }], hasMore: false, cursor: null },
      }],
      notes: [{ id: note.id, owner_email: "owner@example.test", response: note }],
    },
    slack: {
      calls: [
        {
          method: "conversations.open",
          request: { users: "U123", return_im: true },
          response: { ok: true, channel: { id: "D123", is_im: true, user: "U123" } },
        },
        {
          method: "chat.postMessage",
          request: {
            channel: "D123",
            text: "Frozen card",
            blocks: [],
            unfurl_links: false,
            unfurl_media: false,
            mrkdwn: false,
          },
          frozen_card: { approval_id: "approval-1" },
          response: { ok: true, channel: "D123", ts: "1700000000.000001" },
        },
      ],
    },
  });
  const origin = await fixture.listen();
  try {
    await callback({ fixture, origin });
  } finally {
    await fixture.close();
  }
}

test("serves only the scheduled raw Granola list and detail envelopes", async () => {
  await withFixture(async ({ fixture, origin }) => {
    const key = fixture.credentials.granola_api_key;
    const list = await fetch(`${origin}/v1/notes?page_size=2`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { notes: [{ id: note.id, owner: note.owner }], hasMore: false, cursor: null });

    const detail = await fetch(`${origin}/v1/notes/note-1?include=transcript`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), note);

    const effects = fixture.ledger();
    assert.equal(effects[0].operation, "list_notes");
    assert.equal(effects[1].operation, "get_note");
    assert.match(effects[1].owner_email_sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(effects).includes("owner@example.test"), false);
  });
});

test("rejects a Granola cursor outside the sealed source schedule", async () => {
  await withFixture(async ({ fixture, origin }) => {
    const response = await fetch(`${origin}/v1/notes?page_size=2&cursor=not-sealed`, {
      headers: { authorization: `Bearer ${fixture.credentials.granola_api_key}` },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "list-schedule-mismatch");
  });
});

test("validates the Slack Web API body and records frozen card content", async () => {
  await withFixture(async ({ fixture, origin }) => {
    const headers = {
      authorization: `Bearer ${fixture.credentials.slack_bot_token}`,
      "content-type": "application/json",
    };
    const opened = await fetch(`${origin}/api/conversations.open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ users: "U123", return_im: true }),
    });
    assert.equal(opened.status, 200);
    const posted = await fetch(`${origin}/api/chat.postMessage`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channel: "D123",
        text: "Frozen card",
        blocks: [],
        unfurl_links: false,
        unfurl_media: false,
        mrkdwn: false,
      }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), { ok: true, channel: "D123", ts: "1700000000.000001" });
    const effect = fixture.ledger().at(-1);
    assert.equal(effect.operation, "chat.postMessage");
    assert.match(effect.card_content_sha256, /^[a-f0-9]{64}$/);
  });
});

test("posts a signed Slack form to a real HTTP ingress", async () => {
  const signingSecret = "synthetic-signing-secret";
  let receivedResolve;
  const received = new Promise((resolve) => {
    receivedResolve = resolve;
  });
  const server = createServer(async (request, response) => {
    const raw = Buffer.concat(await Array.fromAsync(request));
    const signature = request.headers["x-slack-signature"];
    const timestamp = request.headers["x-slack-request-timestamp"];
    assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(verifySyntheticSlackSignature({
      raw_body: raw,
      timestamp,
      signature,
      signing_secret: signingSecret,
    }), true);
    response.writeHead(200).end();
    receivedResolve();
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("missing test address"));
      resolve(address);
    });
  });
  const response = await postSignedSlackInteraction({
    url: `http://127.0.0.1:${server.address().port}/v2/integrations/slack/interactions`,
    payload: { type: "block_actions", actions: [] },
    signing_secret: signingSecret,
    timestamp: 1700000000,
  });
  assert.equal(response.status, 200);
  await received;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
});
