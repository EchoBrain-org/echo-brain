import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const JSON_TYPE = "application/json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function immutable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": JSON_TYPE,
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function queryObject(url) {
  const output = {};
  for (const [key, value] of url.searchParams) {
    if (key in output) throw new Error("duplicate-query-parameter");
    output[key] = value;
  }
  return output;
}

function expectedOwner(response, ownerEmail) {
  if (ownerEmail === undefined) return true;
  const owner = record(response)?.owner;
  return record(owner)?.email === ownerEmail;
}

function syntheticCredential(prefix) {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

/**
 * Separate source and approval-delivery provider fixture. Input responses are
 * raw Granola/Slack provider envelopes owned by the verifier. The fixture
 * neither maps them to internal meeting records nor creates approval receipts.
 */
export function createProviderHttpFixtureServer({ granola, slack, callbacks = {}, tls, now_ms = () => performance.now() }) {
  const granolaConfig = granola === undefined ? undefined : record(granola);
  const slackConfig = slack === undefined ? undefined : record(slack);
  if (granolaConfig === null || slackConfig === null) throw new TypeError("provider fixture configuration is invalid");
  const granolaApiKey = granolaConfig === undefined ? undefined : (granolaConfig.api_key ?? syntheticCredential("grn_"));
  const slackToken = slackConfig === undefined ? undefined : (slackConfig.token ?? syntheticCredential("xoxb-"));
  const slackSigningSecret = slackConfig === undefined ? undefined : (slackConfig.signing_secret ?? syntheticCredential("fixture-signing-"));
  if (
    (granolaConfig !== undefined && (!nonEmpty(granolaApiKey) || !Array.isArray(granolaConfig.pages) || !Array.isArray(granolaConfig.notes))) ||
    (slackConfig !== undefined && (!nonEmpty(slackToken) || !nonEmpty(slackSigningSecret) || !Array.isArray(slackConfig.calls)))
  ) {
    throw new TypeError("provider fixture configuration is invalid");
  }
  const pages = granolaConfig?.pages.map(immutable) ?? [];
  const notes = new Map((granolaConfig?.notes ?? []).map((note) => [note.id, immutable(note)]));
  const slackCalls = slackConfig?.calls.map(immutable) ?? [];
  const ledger = [];
  const frozenCards = new Map();
  let pageCursor = 0;
  let slackCursor = 0;
  let eventId = 0;

  function append(event) {
    const frozen = immutable({ event_id: ++eventId, at_ms: now_ms(), ...event });
    ledger.push(frozen);
    callbacks.on_effect?.(frozen);
  }

  function sourceFailure(response, detail, event) {
    append({ provider: "granola", accepted: false, reason: detail, ...event });
    json(response, 409, { error: detail });
  }

  function slackFailure(response, detail, event) {
    append({ provider: "slack", accepted: false, reason: detail, ...event });
    json(response, 409, { ok: false, error: detail });
  }

  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (granolaConfig !== undefined && request.method === "GET" && url.pathname === "/v1/notes") {
      const event = { operation: "list_notes", request_sha256: sha256(url.search), request_bytes: Buffer.byteLength(url.search) };
      if (request.headers.authorization !== `Bearer ${granolaApiKey}`) {
        append({ provider: "granola", accepted: false, reason: "unauthorized", ...event });
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const step = pages[pageCursor];
      if (step === undefined) return sourceFailure(response, "unexpected-list-request", event);
      let actual;
      try {
        actual = queryObject(url);
      } catch (error) {
        return sourceFailure(response, error instanceof Error ? error.message : "invalid-query", event);
      }
      if (canonical(actual) !== canonical(step.query ?? {}) || (step.not_before_ms !== undefined && now_ms() < step.not_before_ms)) {
        return sourceFailure(response, "list-schedule-mismatch", event);
      }
      pageCursor += 1;
      const body = JSON.stringify(step.response);
      append({ provider: "granola", accepted: true, ...event, response_sha256: sha256(body), response_bytes: Buffer.byteLength(body), cursor: actual.cursor ?? null });
      json(response, 200, step.response);
      return;
    }
    const noteMatch = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (granolaConfig !== undefined && request.method === "GET" && noteMatch !== null) {
      const noteId = decodeURIComponent(noteMatch[1]);
      const event = { operation: "get_note", note_id: noteId, request_sha256: sha256(url.search), request_bytes: Buffer.byteLength(url.search) };
      if (request.headers.authorization !== `Bearer ${granolaApiKey}`) {
        append({ provider: "granola", accepted: false, reason: "unauthorized", ...event });
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const note = notes.get(noteId);
      if (note === undefined || canonical(queryObject(url)) !== canonical({ include: "transcript" })) return sourceFailure(response, "note-schedule-mismatch", event);
      if (!expectedOwner(note.response, note.owner_email)) return sourceFailure(response, "note-owner-mismatch", event);
      const body = JSON.stringify(note.response);
      append({ provider: "granola", accepted: true, ...event, owner_email_sha256: note.owner_email === undefined ? null : sha256(note.owner_email), response_sha256: sha256(body), response_bytes: Buffer.byteLength(body) });
      json(response, 200, note.response);
      return;
    }
    const slackMethod = /^\/api\/([A-Za-z.]+)$/.exec(url.pathname)?.[1];
    if (slackConfig !== undefined && slackMethod !== undefined && (request.method === "GET" || request.method === "POST")) {
      const raw = request.method === "POST" ? await requestBody(request) : Buffer.alloc(0);
      const event = { operation: slackMethod, request_sha256: sha256(raw), request_bytes: raw.byteLength };
      if (request.headers.authorization !== `Bearer ${slackToken}`) {
        append({ provider: "slack", accepted: false, reason: "unauthorized", ...event });
        json(response, 200, { ok: false, error: "invalid_auth" });
        return;
      }
      let actual;
      try {
        actual = request.method === "GET" ? queryObject(url) : JSON.parse(raw.toString("utf8"));
      } catch {
        return slackFailure(response, "invalid-request-json", event);
      }
      const expected = slackCalls[slackCursor];
      if (
        expected === undefined || expected.method !== slackMethod ||
        canonical(actual) !== canonical(expected.request ?? {}) ||
        (expected.not_before_ms !== undefined && now_ms() < expected.not_before_ms)
      ) {
        return slackFailure(response, "slack-schedule-mismatch", event);
      }
      if (expected.frozen_card !== undefined) {
        // Set this verifier flag only on the complete review-card publication.
        // Terminal/status updates may legitimately change buttons or rendering;
        // their expected provider body is still checked by the sealed schedule.
        const card = record(actual);
        const approvalId = expected.frozen_card.approval_id;
        const content = canonical({
          text: card?.text,
          blocks: card?.blocks,
          mrkdwn: card?.mrkdwn,
          unfurl_links: card?.unfurl_links,
          unfurl_media: card?.unfurl_media,
        });
        const digest = sha256(content);
        const previous = frozenCards.get(approvalId);
        if (previous !== undefined && previous !== digest) return slackFailure(response, "frozen-card-content-mutation", event);
        frozenCards.set(approvalId, digest);
        event.card_content_sha256 = digest;
      }
      slackCursor += 1;
      const body = JSON.stringify(expected.response);
      append({ provider: "slack", accepted: true, ...event, response_sha256: sha256(body), response_bytes: Buffer.byteLength(body) });
      json(response, 200, expected.response);
      return;
    }
    response.writeHead(404).end();
  };
  const server = tls === undefined ? createServer(handler) : createHttpsServer(tls, handler);
  return Object.freeze({
    credentials: immutable({
      ...(granolaApiKey === undefined ? {} : { granola_api_key: granolaApiKey }),
      ...(slackToken === undefined ? {} : { slack_bot_token: slackToken }),
      ...(slackSigningSecret === undefined ? {} : { slack_signing_secret: slackSigningSecret }),
    }),
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("provider fixture has no TCP address");
      return `${tls === undefined ? "http" : "https"}://${host}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
    ledger() {
      return immutable(ledger.map((event) => ({ ...event })));
    },
  });
}

/** Sends a Slack-compatible signed form request through HTTP, never to a DB port. */
export async function postSignedSlackInteraction({ url, payload, signing_secret, timestamp = Math.floor(Date.now() / 1000), fetch_impl = fetch }) {
  if (!nonEmpty(url) || !nonEmpty(signing_secret) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("signed Slack interaction input is invalid");
  }
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const signature = `v0=${createHmac("sha256", signing_secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  const response = await fetch_impl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
  });
  return response;
}

export function verifySyntheticSlackSignature({ raw_body, timestamp, signature, signing_secret }) {
  const expected = `v0=${createHmac("sha256", signing_secret).update(`v0:${timestamp}:`).update(raw_body).digest("hex")}`;
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
