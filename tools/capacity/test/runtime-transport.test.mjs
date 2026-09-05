import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createProductionWireFixtureServer } from "../fixtures.mjs";

const root = resolve(import.meta.dirname, "../../..");
const correlation = "runtime_transport_offer_nonce_01";
const request = {
  model: "openai/gpt-4.1-mini",
  messages: [
    { role: "system", content: "Return only JSON." },
    { role: "user", content: "fixture transport request" },
  ],
  stream: false,
  max_tokens: 300,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "echo_layer4",
      strict: true,
      schema: { type: "object", additionalProperties: false },
    },
  },
  provider: { require_parameters: true, data_collection: "deny" },
};

function requestSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function causalToken(seed, value) {
  return createHash("sha256").update(seed).update("\0").update(value).digest("base64url");
}

function fixtureResponseBytes(semanticRoot, stage, value) {
  const ordinal = 1;
  const id = createHash("sha256")
    .update([semanticRoot, stage, String(ordinal)].join("\0"))
    .digest("hex")
    .slice(0, 20);
  return Buffer.byteLength(JSON.stringify({
    id: `gen-${id}`,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
  }), "utf8");
}

function child(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    process.stdout?.on("data", (chunk) => { stdout += chunk; });
    process.stderr?.on("data", (chunk) => { stderr += chunk; });
    process.once("error", reject);
    process.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`runtime transport child failed (${code}): ${stderr}`));
    });
  });
}

test("production OpenRouter adapter reaches a TLS fixture with normal CA verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-capacity-tls-"));
  chmodSync(directory, 0o700);
  const key = join(directory, "server-key.pem");
  const certificate = join(directory, "server-cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key,
      "-out", certificate,
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days", "1",
    ],
    { stdio: "ignore" },
  );
  assert.equal(generated.status, 0, "openssl must create the ephemeral test certificate");

  const fixture = createProductionWireFixtureServer({
    run: {
      id: "runtime-transport-test",
      sealed_seed: "runtime-transport-test-seed",
      delays_ms: {
        extraction: { min: 0, max: 0 },
        relationship_projection: { min: 0, max: 0 },
        answer_planner: { min: 0, max: 0 },
        answer_generation: { min: 0, max: 0 },
      },
    },
    expected_packets: [{
      semantic_root: "runtime-transport",
      population: "answer",
      stage: "answer_planner",
      offer_nonce: correlation,
      response_value: { queries: [] },
      request_match: {
        response_schema_name: "echo_layer4",
        request_sha256: requestSha256(request),
      },
      wire_budget: {
        canonical_request_bytes: Buffer.byteLength(JSON.stringify(request)),
        canonical_response_bytes: fixtureResponseBytes(
          "runtime-transport",
          "answer_planner",
          { queries: [] },
        ),
        expected_call_count: 1,
      },
    }],
    tls: { key: readFileSync(key), cert: readFileSync(certificate) },
  });
  try {
    const endpoint = `${await fixture.listen(0, "127.0.0.1")}/api/v1/chat/completions`;
    const adapter = join(
      root,
      "services/organization-authority/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
    );
    const script = `
      import { createOpenRouterStructuredGenerationAdapter } from ${JSON.stringify(adapter)};
      const adapter = createOpenRouterStructuredGenerationAdapter({
        credential_ref: "test:fixture",
        credential_resolver: () => "fixture-credential",
        endpoint: process.env.ECHO_CAPACITY_ENDPOINT,
      });
      const result = await adapter.generate_with_observation({
        model: "openai/gpt-4.1-mini",
        system_prompt: "Return only JSON.",
        user_prompt: "fixture transport request",
        schema: { type: "object", additionalProperties: false },
        max_output_tokens: 300,
        timeout_ms: 10000,
        transport: { operation_correlation: "${correlation}" },
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const result = await child(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root,
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certificate,
        ECHO_CAPACITY_ENDPOINT: endpoint,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const observed = JSON.parse(result.stdout);
    assert.deepEqual({ ...observed, provider_latency_ms: null }, {
      value: { queries: [] },
      usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
      },
      finish_reason: "stop",
      provider_latency_ms: null,
      causal_token: causalToken(
        "runtime-transport-test-seed",
        ["runtime-transport", "answer_planner", "1"].join("\0"),
      ),
    });
    assert.equal(Number.isSafeInteger(observed.provider_latency_ms), true);
    assert.ok(observed.provider_latency_ms >= 0);
    assert.equal(fixture.ledger()[0]?.accepted, true);
    assert.equal(fixture.ledger()[0]?.operation_correlation_sha256, createHash("sha256").update(correlation).digest("hex"));
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
