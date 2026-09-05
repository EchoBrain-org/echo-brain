import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The inference fixture is intentionally a wire-level HTTP service.  It does
 * not import Authority code, interpret an internal retrieval object, or turn
 * a fixture atom into a citation for the caller.  The verifier supplies the
 * sealed packets and independently computes every canonical packet below.
 *
 * The two capacity transport headers are a qualification prerequisite, not a
 * test-only branch:
 *
 *   x-echo-operation-correlation verifier-minted offered-request nonce
 *   x-echo-causal-token           predecessor/successor dependency token
 *
 * Production clients forward these generic headers and preserve the opaque
 * response token. The fixture identifies the sealed stage from the bound
 * operation correlation, exact request digest, and response schema name.
 */

const STAGES = new Set([
  "extraction",
  "relationship_projection",
  "answer_planner",
  "answer_generation",
]);
const JSON_CONTENT_TYPE = /^application\/json(?:;|$)/i;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function immutable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutable(child)])));
}

function opaqueToken(seed, label) {
  return createHash("sha256").update(seed).update("\0").update(label).digest("base64url");
}

function header(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameOpaqueToken(actual, expected) {
  if (!nonEmptyString(actual) || !nonEmptyString(expected)) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function statusForReason(reason) {
  if (reason === "duplicate-stage-attempt") return 409;
  if (reason === "missing-causal-token") return 428;
  if (reason === "unknown-semantic-root") return 404;
  return 422;
}

function bodyJsonError(reason) {
  return { error: { code: "capacity_fixture_rejected", message: reason } };
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request-body-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseOpenRouterRequest(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  const root = record(payload);
  if (
    root === null ||
    !nonEmptyString(root.model) ||
    root.stream !== false ||
    !Number.isSafeInteger(root.max_tokens) ||
    root.max_tokens < 1 ||
    !Array.isArray(root.messages) ||
    root.messages.length !== 2
  ) {
    return { ok: false, reason: "invalid-openrouter-request" };
  }
  const [system, user] = root.messages;
  if (
    record(system) === null ||
    record(user) === null ||
    system.role !== "system" ||
    user.role !== "user" ||
    !nonEmptyString(system.content) ||
    !nonEmptyString(user.content) ||
    record(root.response_format) === null
  ) {
    return { ok: false, reason: "invalid-openrouter-request" };
  }
  const responseFormat = record(root.response_format);
  const jsonSchema = responseFormat === null ? null : record(responseFormat.json_schema);
  if (jsonSchema === null || !nonEmptyString(jsonSchema.name)) {
    return { ok: false, reason: "invalid-openrouter-request" };
  }
  return {
    ok: true,
    payload: root,
    user_prompt: user.content,
    response_schema_name: jsonSchema.name,
  };
}

function validatePlannerOutput(value) {
  const root = record(value);
  if (root === null || !exactKeys(root, ["queries"]) || !Array.isArray(root.queries)) {
    throw new TypeError("planner response must be exactly {queries: string[]}");
  }
  if (
    root.queries.length > 3 ||
    root.queries.some((query) => !nonEmptyString(query) || query.length > 512)
  ) {
    throw new TypeError("planner queries are invalid");
  }
}

function validateAnswerEvidence(packet) {
  const evidence = record(packet.answer_evidence);
  if (
    evidence === null ||
    !exactKeys(evidence, ["canonical_packet_bytes", "canonical_packet_json"]) ||
    !nonEmptyString(evidence.canonical_packet_json) ||
    !Number.isSafeInteger(evidence.canonical_packet_bytes) ||
    evidence.canonical_packet_bytes < 1 ||
    Buffer.byteLength(evidence.canonical_packet_json, "utf8") !== evidence.canonical_packet_bytes
  ) {
    throw new TypeError("answer evidence packet is invalid");
  }
  let prompt;
  try {
    prompt = JSON.parse(evidence.canonical_packet_json);
  } catch {
    throw new TypeError("answer evidence packet is not JSON");
  }
  const root = record(prompt);
  if (
    root === null ||
    !exactKeys(root, ["question", "sources"]) ||
    !nonEmptyString(root.question) ||
    !Array.isArray(root.sources)
  ) {
    throw new TypeError("answer evidence packet is not a production answer prompt");
  }
  const aliases = new Set();
  for (const source of root.sources) {
    const item = record(source);
    if (
      item === null ||
      !exactKeys(item, ["citation_id", "text"]) ||
      !nonEmptyString(item.citation_id) ||
      !nonEmptyString(item.text) ||
      aliases.has(item.citation_id)
    ) {
      throw new TypeError("answer evidence source is invalid");
    }
    aliases.add(item.citation_id);
  }
  return { canonical_packet_json: evidence.canonical_packet_json, aliases };
}

function validateAnswerOutput(value, aliases) {
  const root = record(value);
  if (
    root === null ||
    !exactKeys(root, ["answer", "citations", "status"]) ||
    (root.status !== "answered" && root.status !== "insufficient_evidence") ||
    !nonEmptyString(root.answer) ||
    !Array.isArray(root.citations)
  ) {
    throw new TypeError("answer response is invalid");
  }
  const cited = new Set();
  for (const citation of root.citations) {
    if (!nonEmptyString(citation) || !aliases.has(citation) || cited.has(citation)) {
      throw new TypeError("answer response cites evidence absent from the request");
    }
    cited.add(citation);
  }
  if (
    (root.status === "answered" && cited.size === 0) ||
    (root.status === "insufficient_evidence" && cited.size !== 0)
  ) {
    throw new TypeError("answer response citation status is invalid");
  }
}

function validatePacket(packet) {
  const root = record(packet);
  if (
    root === null ||
    !nonEmptyString(root.semantic_root) ||
    !nonEmptyString(root.population) ||
    !STAGES.has(root.stage) ||
    record(root.wire_budget) === null ||
    record(root.request_match) === null ||
    record(root.response_value) === null
  ) {
    throw new TypeError("fixture packet is invalid");
  }
  if (
    !nonEmptyString(root.offer_nonce) &&
    root.offer_nonce_binding !== "driver-mint-at-offer"
  ) {
    throw new TypeError("fixture packet requires an offer nonce or verifier binding");
  }
  if (
    !exactKeys(root.wire_budget, ["canonical_request_bytes", "canonical_response_bytes", "expected_call_count"]) ||
    !Number.isSafeInteger(root.wire_budget.canonical_request_bytes) ||
    !Number.isSafeInteger(root.wire_budget.canonical_response_bytes) ||
    !Number.isSafeInteger(root.wire_budget.expected_call_count) ||
    root.wire_budget.canonical_request_bytes < 1 ||
    root.wire_budget.canonical_response_bytes < 1 ||
    root.wire_budget.expected_call_count < 1
  ) {
    throw new TypeError("fixture packet wire budget is invalid");
  }
  if (
    !exactKeys(root.request_match, ["request_sha256", "response_schema_name"]) ||
    !/^[a-f0-9]{64}$/.test(root.request_match.request_sha256) ||
    !nonEmptyString(root.request_match.response_schema_name)
  ) {
    throw new TypeError("fixture packet request match is invalid");
  }
  if (root.stage === "answer_planner") validatePlannerOutput(root.response_value);
  if (root.stage === "answer_generation") {
    const evidence = validateAnswerEvidence(root);
    validateAnswerOutput(root.response_value, evidence.aliases);
  }
  if (
    root.stage === "relationship_projection" &&
    !nonEmptyString(root.approved_snapshot_token)
  ) {
    throw new TypeError("projection packet requires an approved snapshot token");
  }
  if (
    Buffer.byteLength(generationEnvelope(root, root.response_value, 1), "utf8") !==
    root.wire_budget.canonical_response_bytes
  ) {
    throw new TypeError("fixture packet canonical response byte count is invalid");
  }
  return root;
}

function deterministicDelay(run, packet, ordinal) {
  const range = (record(run.delays_ms) ?? record(run.delay_ranges_ms))?.[packet.stage];
  if (
    record(range) === null ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new TypeError(`fixture run has no delay range for ${packet.stage}`);
  }
  const fraction = Number.parseInt(
    sha256(`${run.sealed_seed}\0${packet.semantic_root}\0${packet.stage}\0${ordinal}`).slice(0, 13),
    16,
  ) / 0xfffffffffffff;
  return Math.round(range.min + (range.max - range.min) * fraction);
}

function generationEnvelope(packet, responseValue, ordinal) {
  const content = JSON.stringify(responseValue);
  return JSON.stringify({
    id: `gen-${sha256(`${packet.semantic_root}\0${packet.stage}\0${ordinal}`).slice(0, 20)}`,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function isAcceptedCallbackResult(value) {
  return value === undefined || value === true || (record(value) !== null && value.accept === true);
}

/**
 * Starts an OpenRouter-compatible HTTP fixture for a verifier-owned sealed
 * run. `expected_packets` is held outside the candidate allocation. Callback
 * validation and the append-only effect hook are verifier hooks; they cannot
 * change response values, delays, ordinals, or packet expectations.
 */
export function createProductionWireFixtureServer({ run, expected_packets, callbacks = {}, tls }) {
  if (
    record(run) === null ||
    !nonEmptyString(run.id) ||
    !nonEmptyString(run.sealed_seed) ||
    !Array.isArray(expected_packets) || expected_packets.length === 0
  ) {
    throw new TypeError("fixture run is invalid");
  }
  const packets = new Map();
  for (const rawPacket of expected_packets) {
    const packet = validatePacket(rawPacket);
    const key = `${packet.semantic_root}\0${packet.stage}`;
    if (packets.has(key)) throw new TypeError("fixture packets duplicate a semantic root and stage");
    packets.set(key, immutable(packet));
  }
  const attempts = new Map();
  const plannerTokens = new Map();
  const boundOfferNonces = new Map();
  const effects = [];
  let eventSequence = 0;
  let server;

  function appendEffect(effect) {
    const frozen = immutable({ event_id: ++eventSequence, at_ms: performance.now(), ...effect });
    effects.push(frozen);
    callbacks.on_effect?.(frozen);
    return frozen;
  }

  function reject(response, event, reason) {
    const body = JSON.stringify(bodyJsonError(reason));
    appendEffect({
      ...event,
      accepted: false,
      reason,
      response_status: statusForReason(reason),
      response_sha256: sha256(body),
      response_bytes: Buffer.byteLength(body),
    });
    response.writeHead(statusForReason(reason), { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    response.end(body);
  }

  const requestHandler = async (request, response) => {
    const baseEvent = {
      run_id: run.id,
      request_method: request.method,
      request_path: request.url,
      semantic_root: null,
      stage: null,
      operation_correlation_sha256: nonEmptyString(header(request, "x-echo-operation-correlation"))
        ? sha256(header(request, "x-echo-operation-correlation"))
        : null,
      request_sha256: null,
      request_bytes: 0,
      attempt_ordinal: null,
    };
    if (request.method !== "POST" || request.url !== "/api/v1/chat/completions") {
      reject(response, baseEvent, "unexpected-provider-route");
      return;
    }
    if (!JSON_CONTENT_TYPE.test(header(request, "content-type") ?? "") || !/^Bearer\s+\S+$/.test(header(request, "authorization") ?? "")) {
      reject(response, baseEvent, "invalid-provider-headers");
      return;
    }
    let rawBody;
    try {
      rawBody = await readRequestBody(request);
    } catch (error) {
      reject(response, baseEvent, error instanceof Error ? error.message : "invalid-request-body");
      return;
    }
    const event = { ...baseEvent, request_sha256: sha256(rawBody), request_bytes: rawBody.length };
    const operationCorrelation = header(request, "x-echo-operation-correlation");
    if (!nonEmptyString(operationCorrelation)) {
      reject(response, event, "invalid-operation-correlation");
      return;
    }
    const parsed = parseOpenRouterRequest(rawBody);
    if (!parsed.ok) {
      reject(response, event, parsed.reason);
      return;
    }
    const correlated = [...packets.values()].filter((candidate) => {
      const expectedCorrelation = candidate.offer_nonce ?? boundOfferNonces.get(candidate.semantic_root);
      return (
        sameOpaqueToken(operationCorrelation, expectedCorrelation) &&
        candidate.request_match.response_schema_name === parsed.response_schema_name
      );
    });
    let matching = correlated.filter(
      (candidate) => candidate.request_match.request_sha256 === event.request_sha256,
    );
    if (matching.length === 0) {
      matching = correlated.filter(
        (candidate) =>
          candidate.stage === "answer_generation" &&
          sameOpaqueToken(
            header(request, "x-echo-causal-token"),
            plannerTokens.get(candidate.semantic_root),
          ),
      );
    }
    if (matching.length !== 1) {
      reject(response, event, matching.length === 0 ? "unknown-sealed-request" : "ambiguous-sealed-request");
      return;
    }
    const packet = matching[0];
    const semanticRoot = packet.semantic_root;
    const stage = packet.stage;
    const matchedEvent = { ...event, semantic_root: semanticRoot, stage };
    let canonicalPacketBytes = null;
    if (stage === "answer_generation") {
      const expected = validateAnswerEvidence(packet);
      canonicalPacketBytes = Buffer.byteLength(expected.canonical_packet_json, "utf8");
      if (
        parsed.user_prompt !== expected.canonical_packet_json ||
        Buffer.byteLength(parsed.user_prompt, "utf8") !== Buffer.byteLength(expected.canonical_packet_json, "utf8")
      ) {
        reject(response, matchedEvent, "answer-evidence-does-not-match-oracle-packet");
        return;
      }
      if (packet.request_match.request_sha256 !== matchedEvent.request_sha256) {
        reject(response, matchedEvent, "request-does-not-match-sealed-packet");
        return;
      }
      const plannerToken = plannerTokens.get(semanticRoot);
      if (!sameOpaqueToken(header(request, "x-echo-causal-token"), plannerToken)) {
        reject(response, matchedEvent, "missing-causal-token");
        return;
      }
    } else if (packet.request_match.request_sha256 !== matchedEvent.request_sha256) {
      reject(response, matchedEvent, "request-does-not-match-sealed-packet");
      return;
    }
    if (stage === "relationship_projection" && !sameOpaqueToken(header(request, "x-echo-causal-token"), packet.approved_snapshot_token)) {
      reject(response, matchedEvent, "missing-causal-token");
      return;
    }
    try {
      const callbackResult = await callbacks.validate_stage_request?.(
        immutable({
          run_id: run.id,
          semantic_root: semanticRoot,
          stage,
          operation_correlation_sha256: matchedEvent.operation_correlation_sha256,
          request_sha256: matchedEvent.request_sha256,
          request_bytes: matchedEvent.request_bytes,
          canonical_packet_bytes: canonicalPacketBytes,
          request_body: rawBody.toString("utf8"),
        }),
      );
      if (!isAcceptedCallbackResult(callbackResult)) {
        reject(response, matchedEvent, record(callbackResult)?.reason ?? "verifier-stage-rejected");
        return;
      }
    } catch {
      reject(response, matchedEvent, "verifier-stage-rejected");
      return;
    }
    const previous = attempts.get(`${semanticRoot}\0${stage}`) ?? 0;
    if (previous > 0) {
      const retry = await callbacks.authorize_retry?.(
        immutable({ run_id: run.id, semantic_root: semanticRoot, stage, population: packet.population, next_attempt_ordinal: previous + 1 }),
      );
      if (retry !== true) {
        reject(response, { ...matchedEvent, attempt_ordinal: previous + 1 }, "duplicate-stage-attempt");
        return;
      }
    }
    const ordinal = previous + 1;
    attempts.set(`${semanticRoot}\0${stage}`, ordinal);
    let waitMs;
    try {
      waitMs = deterministicDelay(run, packet, ordinal);
    } catch (error) {
      reject(response, { ...matchedEvent, attempt_ordinal: ordinal }, error instanceof Error ? error.message : "invalid-delay");
      return;
    }
    const causalToken = opaqueToken(run.sealed_seed, `${semanticRoot}\0${stage}\0${ordinal}`);
    if (stage === "answer_planner") plannerTokens.set(semanticRoot, causalToken);
    const waitStartedAt = performance.now();
    await delay(waitMs);
    const observedWaitMs = Math.max(0, performance.now() - waitStartedAt);
    const body = generationEnvelope(packet, packet.response_value, ordinal);
    const responseSha256 = sha256(body);
    appendEffect({
      ...matchedEvent,
      canonical_packet_bytes: canonicalPacketBytes,
      accepted: true,
      reason: null,
      response_status: 200,
      attempt_ordinal: ordinal,
      population: packet.population,
      prescribed_wait_ms: waitMs,
      observed_wait_ms: observedWaitMs,
      response_sha256: responseSha256,
      response_bytes: Buffer.byteLength(body),
      causal_token_sha256: sha256(causalToken),
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-generation-id": `gen-${sha256(`${semanticRoot}\0${stage}\0${ordinal}`).slice(0, 20)}`,
      "x-echo-causal-token": causalToken,
    });
    response.end(body);
  };
  server = tls === undefined ? createServer(requestHandler) : createHttpsServer(tls, requestHandler);

  return Object.freeze({
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("fixture server has no TCP address");
      return `${tls === undefined ? "http" : "https"}://${host}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
    ledger() {
      return immutable(effects.map((effect) => ({ ...effect })));
    },
    bind_offer_nonce({ semantic_root, offer_nonce }) {
      if (!nonEmptyString(semantic_root) || !nonEmptyString(offer_nonce)) {
        throw new TypeError("fixture offer binding is invalid");
      }
      const rootPackets = [...packets.values()].filter(
        (packet) => packet.semantic_root === semantic_root,
      );
      if (
        rootPackets.length === 0 ||
        rootPackets.some((packet) => packet.offer_nonce_binding !== "driver-mint-at-offer") ||
        boundOfferNonces.has(semantic_root)
      ) {
        throw new Error("fixture offer binding is unavailable");
      }
      boundOfferNonces.set(semantic_root, offer_nonce);
    },
    effect_budgets(call_multiplier_max = 1.02, wire_byte_multiplier_max = 1.02) {
      if (
        !Number.isFinite(call_multiplier_max) || call_multiplier_max < 1 ||
        !Number.isFinite(wire_byte_multiplier_max) || wire_byte_multiplier_max < 1
      ) {
        throw new TypeError("fixture budget multipliers are invalid");
      }
      const unmatchedEffects = effects.filter((effect) => !packets.has(`${effect.semantic_root}\0${effect.stage}`)).length;
      return immutable([...packets.values()].map((packet) => {
        const matching = effects.filter((effect) =>
          effect.semantic_root === packet.semantic_root && effect.stage === packet.stage,
        );
        const expectedCalls = packet.wire_budget.expected_call_count;
        const expectedBytes = expectedCalls * (
          packet.wire_budget.canonical_request_bytes + packet.wire_budget.canonical_response_bytes
        );
        const actualBytes = matching.reduce(
          (total, effect) => total + effect.request_bytes + (effect.response_bytes ?? 0),
          0,
        );
        const allowedCalls = Math.floor(call_multiplier_max * expectedCalls);
        const allowedBytes = Math.floor(wire_byte_multiplier_max * expectedBytes);
        // Projection may reuse an approved prior result or coalesce publications;
        // its independent corpus proof must establish that reuse. Required
        // extraction/planner/answer stages cannot disappear from the ledger.
        const requiredSuccessfulCalls = packet.stage === "relationship_projection" ? 0 : 1;
        const successfulCalls = matching.filter((effect) => effect.accepted === true).length;
        return {
          semantic_root: packet.semantic_root,
          population: packet.population,
          stage: packet.stage,
          expected_call_count: expectedCalls,
          actual_call_count: matching.length,
          required_successful_call_count: requiredSuccessfulCalls,
          successful_call_count: successfulCalls,
          unmatched_provider_effects: unmatchedEffects,
          allowed_call_count: allowedCalls,
          expected_wire_bytes: expectedBytes,
          actual_wire_bytes: actualBytes,
          allowed_wire_bytes: allowedBytes,
          pass: unmatchedEffects === 0 && successfulCalls >= requiredSuccessfulCalls && matching.every((effect) => effect.accepted === true) && matching.length <= allowedCalls && actualBytes <= allowedBytes,
        };
      }));
    },
    wait_diagnostics() {
      const byPopulation = new Map();
      for (const effect of effects) {
        if (effect.accepted !== true || !Number.isSafeInteger(effect.prescribed_wait_ms)) continue;
        const key = `${effect.population}\0${effect.stage}`;
        const current = byPopulation.get(key) ?? {
          population: effect.population,
          stage: effect.stage,
          prescribed_wait_ms: [],
          observed_wait_ms: [],
        };
        current.prescribed_wait_ms.push(effect.prescribed_wait_ms);
        current.observed_wait_ms.push(effect.observed_wait_ms);
        byPopulation.set(key, current);
      }
      const nearestRankP95 = (values) => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.ceil(sorted.length * 0.95) - 1];
      };
      return immutable([...byPopulation.values()].map((entry) => ({
        population: entry.population,
        stage: entry.stage,
        count: entry.prescribed_wait_ms.length,
        prescribed_wait_p95_ms: nearestRankP95(entry.prescribed_wait_ms),
        observed_wait_p95_ms: nearestRankP95(entry.observed_wait_ms),
      })).sort((left, right) => `${left.population}/${left.stage}`.localeCompare(`${right.population}/${right.stage}`)));
    },
  });
}
