import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProductionWireFixtureServer } from "../fixtures.mjs";

const offerNonce = "offer-7b4ad19e2c";
const answerPrompt = JSON.stringify({
  question: "What decision was made?",
  sources: [{ citation_id: "a1", text: "The team decided to ship." }],
});

function wireBudget(userPrompt, responseValue) {
  const content = JSON.stringify(responseValue);
  const response = JSON.stringify({
    id: `gen-${"a".repeat(20)}`,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
  return {
    canonical_request_bytes: Buffer.byteLength(JSON.stringify(productionRequest(userPrompt)), "utf8"),
    canonical_response_bytes: Buffer.byteLength(response, "utf8"),
    expected_call_count: 1,
  };
}

function requestMatch(userPrompt) {
  return {
    response_schema_name: "echo_layer4",
    request_sha256: createHash("sha256")
      .update(JSON.stringify(productionRequest(userPrompt)))
      .digest("hex"),
  };
}

function fixturePackets() {
  return [
    {
      semantic_root: "answer-1",
      population: "answer",
      stage: "answer_planner",
      offer_nonce: offerNonce,
      response_value: { queries: ["decision ship"] },
      request_match: requestMatch(JSON.stringify({ question: "What decision was made?" })),
      wire_budget: wireBudget(
        JSON.stringify({ question: "What decision was made?" }),
        { queries: ["decision ship"] },
      ),
    },
    {
      semantic_root: "answer-1",
      population: "answer",
      stage: "answer_generation",
      offer_nonce: offerNonce,
      answer_evidence: {
        canonical_packet_json: answerPrompt,
        canonical_packet_bytes: Buffer.byteLength(answerPrompt, "utf8"),
      },
      response_value: {
        status: "answered",
        answer: "The team decided to ship.",
        citations: ["a1"],
      },
      request_match: requestMatch(answerPrompt),
      wire_budget: wireBudget(answerPrompt, {
        status: "answered",
        answer: "The team decided to ship.",
        citations: ["a1"],
      }),
    },
    {
      semantic_root: "projection-1",
      population: "publication",
      stage: "relationship_projection",
      offer_nonce: "offer-projection-1",
      approved_snapshot_token: "approved-head-token",
      response_value: { relations: [] },
      request_match: requestMatch(JSON.stringify({ question: "project" })),
      wire_budget: wireBudget(JSON.stringify({ question: "project" }), { relations: [] }),
    },
  ];
}

async function withFixture(callback, packets = fixturePackets(), delayRanges = {}) {
  const fixture = createProductionWireFixtureServer({
    run: {
      id: "fixture-test-run",
      sealed_seed: "sealed-test-seed",
      delays_ms: {
        extraction: { min: 0, max: 0 },
        relationship_projection: { min: 0, max: 0 },
        answer_planner: { min: 0, max: 0 },
        answer_generation: { min: 0, max: 0 },
        ...delayRanges,
      },
    },
    expected_packets: packets,
  });
  const url = await fixture.listen();
  try {
    await callback({ fixture, endpoint: `${url}/api/v1/chat/completions` });
  } finally {
    await fixture.close();
  }
}

function productionRequest(userPrompt, overrides = {}) {
  return {
    model: "openai/gpt-4.1-mini",
    messages: [
      { role: "system", content: "Return only the JSON schema." },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    max_tokens: 300,
    response_format: {
      type: "json_schema",
      json_schema: { name: "echo_layer4", strict: true, schema: { type: "object" } },
    },
    provider: { require_parameters: true, data_collection: "deny" },
    ...overrides,
  };
}

async function request(endpoint, stage, userPrompt, headers = {}) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-token",
      "content-type": "application/json",
      "x-echo-operation-correlation": offerNonce,
      ...headers,
    },
    body: JSON.stringify(productionRequest(userPrompt)),
  });
}

test("missing required effects cannot pass a provider budget", async () => {
  await withFixture(async ({ fixture }) => {
    const budgets = fixture.effect_budgets();
    assert.equal(budgets.find((entry) => entry.stage === "answer_planner").pass, false);
    assert.equal(budgets.find((entry) => entry.stage === "answer_generation").pass, false);
    // A reusable projection is independently proved by corpus/publication gates.
    assert.equal(budgets.find((entry) => entry.stage === "relationship_projection").required_successful_call_count, 0);
  });
});

test("requests outside the declared provider route remain visible and fail budgets", async () => {
  await withFixture(async ({ fixture, endpoint }) => {
    await fetch(`${endpoint}/undeclared`);
    assert.equal(fixture.ledger()[0].reason, "unexpected-provider-route");
    assert.ok(fixture.effect_budgets().every((entry) => entry.pass === false && entry.unmatched_provider_effects === 1));
  });
});

test("serves a production OpenRouter envelope and records an external effect", async () => {
  await withFixture(async ({ fixture, endpoint }) => {
    const response = await request(endpoint, "answer_planner", JSON.stringify({ question: "What decision was made?" }));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-echo-causal-token") ?? "", /^[A-Za-z0-9_-]{20,}$/);
    const body = await response.json();
    assert.match(body.id, /^gen-[A-Za-z0-9]{8,64}$/);
    assert.deepEqual(body.choices[0].message, {
      role: "assistant",
      content: JSON.stringify({ queries: ["decision ship"] }),
    });
    assert.equal(body.choices[0].finish_reason, "stop");

    const [effect] = fixture.ledger();
    assert.equal(effect.accepted, true);
    assert.equal(effect.stage, "answer_planner");
    assert.equal(effect.attempt_ordinal, 1);
    assert.equal(effect.request_bytes > 0, true);
    assert.equal(effect.response_bytes > 0, true);
    assert.match(effect.response_sha256, /^[a-f0-9]{64}$/);
    assert.equal(effect.prescribed_wait_ms, 0);
    assert.equal(effect.observed_wait_ms >= 0, true);
    assert.deepEqual(fixture.wait_diagnostics(), [{
      population: "answer",
      stage: "answer_planner",
      count: 1,
      prescribed_wait_p95_ms: 0,
      observed_wait_p95_ms: effect.observed_wait_ms,
    }]);
    assert.equal(fixture.effect_budgets()[0].pass, true);
  });
});

test("rejects answer generation until the opaque planner token is presented", async () => {
  await withFixture(async ({ fixture, endpoint }) => {
    const missing = await request(endpoint, "answer_generation", answerPrompt);
    assert.equal(missing.status, 428);
    assert.equal((await missing.json()).error.message, "missing-causal-token");

    const planner = await request(endpoint, "answer_planner", JSON.stringify({ question: "What decision was made?" }));
    const plannerToken = planner.headers.get("x-echo-causal-token");
    assert.equal(planner.status, 200);
    assert.notEqual(plannerToken, null);

    const answer = await request(endpoint, "answer_generation", answerPrompt, {
      "x-echo-causal-token": plannerToken,
    });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(JSON.parse(body.choices[0].message.content), {
      status: "answered",
      answer: "The team decided to ship.",
      citations: ["a1"],
    });
    assert.deepEqual(
      fixture.ledger().map((effect) => [effect.stage, effect.accepted, effect.reason]),
      [
        ["answer_generation", false, "missing-causal-token"],
        ["answer_planner", true, null],
        ["answer_generation", true, null],
      ],
    );
  });
});

test("rejects an evidence packet with an extra authorized-looking source", async () => {
  await withFixture(async ({ fixture, endpoint }) => {
    const planner = await request(endpoint, "answer_planner", JSON.stringify({ question: "What decision was made?" }));
    const plannerToken = planner.headers.get("x-echo-causal-token");
    const extraPrompt = JSON.stringify({
      question: "What decision was made?",
      sources: [
        { citation_id: "a1", text: "The team decided to ship." },
        { citation_id: "a2", text: "A different but authorized-looking fact." },
      ],
    });
    const response = await request(endpoint, "answer_generation", extraPrompt, {
      "x-echo-causal-token": plannerToken,
    });

    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.message, "answer-evidence-does-not-match-oracle-packet");
    assert.equal(fixture.ledger().at(-1)?.accepted, false);
    assert.equal(fixture.ledger().at(-1)?.reason, "answer-evidence-does-not-match-oracle-packet");
  });
});

test("rejects a concurrent duplicate stage attempt as a hedge", async () => {
  await withFixture(async ({ fixture, endpoint }) => {
    const prompt = JSON.stringify({ question: "What decision was made?" });
    const [first, second] = await Promise.all([
      request(endpoint, "answer_planner", prompt),
      request(endpoint, "answer_planner", prompt),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.message, "duplicate-stage-attempt");
    const effects = fixture.ledger();
    assert.equal(effects.filter((effect) => effect.accepted).length, 1);
    assert.equal(effects.filter((effect) => effect.reason === "duplicate-stage-attempt").length, 1);
    const plannerBudget = fixture.effect_budgets().find((budget) => budget.stage === "answer_planner");
    assert.equal(plannerBudget?.actual_call_count, 2);
    assert.equal(plannerBudget?.allowed_call_count, 1);
    assert.equal(plannerBudget?.pass, false);
  }, fixturePackets(), { answer_planner: { min: 25, max: 25 } });
});

test("requires the verifier-issued approved snapshot token for projection", async () => {
  await withFixture(async ({ endpoint }) => {
    const withoutToken = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-token",
        "content-type": "application/json",
        "x-echo-operation-correlation": "offer-projection-1",
      },
      body: JSON.stringify(productionRequest(JSON.stringify({ question: "project" }))),
    });
    assert.equal(withoutToken.status, 428);

    const valid = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer fixture-token",
        "content-type": "application/json",
        "x-echo-operation-correlation": "offer-projection-1",
        "x-echo-causal-token": "approved-head-token",
      },
      body: JSON.stringify(productionRequest(JSON.stringify({ question: "project" }))),
    });
    assert.equal(valid.status, 200);
  });
});
