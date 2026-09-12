import {
  captureCoreRuntimeContentV1, observeCoreRuntimeV1
} from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { describe, expect, it } from "vitest";
import { createOpenRouterStructuredGenerationAdapter } from "../../../../providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../../tests/support/telemetry-fixture-vocabulary-v1.js";
import { formatStagingJourneyContentRecordsV2 } from "../../src/composition/staging/observability/staging-journey-content-telemetry-v1.js";
import { createStagingJourneyTelemetryTransportV1 } from "../../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js";

const identity = { release_sha: "a".repeat(40), build_number: 42 };
const linked = "11111111-1111-4111-8111-111111111111";
const request = { model: "anthropic/claude-sonnet-4.6", system_prompt: "fixture system", user_prompt: "fixture input", schema: { type: "object" }, max_output_tokens: 100, timeout_ms: 1000 } as const;
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("core runtime observations through the existing journey channel", () => {

  it("captures a failed model call followed by a successful call without inventing usage", async () => {
    const lines: string[] = [];
    const transport = createStagingJourneyTelemetryTransportV1(identity, { write: (line) => { lines.push(line); } }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, content_enabled: true });
    let calls = 0;
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "fixture", credential_resolver: () => "fixture-credential-never-record",
      fetch_impl: async () => {
        calls++;
        return calls === 1 ? new Response('{"error":{"message":"fixture throttle"}}', { status: 429 }) : new Response(JSON.stringify({ id: "fixture-generation", choices: [{ finish_reason: "stop", message: { content: '{"queries":[]}' } }] }), { status: 200 });
      },
    });
    await observeCoreRuntimeV1("related_projection", async () => {
      await expect(adapter.generate(request)).rejects.toThrow();
      await expect(adapter.generate(request)).resolves.toEqual({ queries: [] });
    }, transport.core_runtime);
    await flush();
    const records = lines.map((line) => JSON.parse(line));
    const callsObserved = records.filter((event) => event.diagnostic?.phase === "model_call" && event.event !== "started");
    expect(callsObserved.map((event) => event.event)).toEqual(["failed", "succeeded"]);
    expect(callsObserved[0].diagnostic.counts).toMatchObject({ http_status: 429, input_tokens: null, total_tokens: null });
    expect(callsObserved[1].diagnostic).toMatchObject({ provider: "openrouter", model: request.model, purpose: "related_projection", finish_reason: "stop", counts: { total_tokens: null } });
    expect(records.some((record) => record.content_kind === "model_request")).toBe(true);
    expect(records.some((record) => record.content_kind === "model_response")).toBe(true);
    expect(lines.join("")).not.toContain("fixture-credential-never-record");

    const closedCall = callsObserved[1];
    const accounting = { kind: "execution", execution_attempt: 2, retry_count: 1, retry_of_attempt: 1 };
    const beforeInjected = lines.length;
    transport.observer({
      ...closedCall,
      injected: "must-not-serialize",
      accounting: { ...accounting, injected: "must-not-serialize" },
      diagnostic: {
        ...closedCall.diagnostic,
        injected: "must-not-serialize",
        counts: { ...closedCall.diagnostic.counts, injected: "must-not-serialize" },
      },
    });
    expect(JSON.parse(lines[beforeInjected]!)).toEqual({ ...closedCall, accounting });
    expect(lines.slice(beforeInjected).join("")).not.toContain("must-not-serialize");
    transport.close();
  });


  it("reports transport losses and keeps results intact when content serialization throws", async () => {
    const lines: string[] = [];
    let callback = () => {};
    let fail = true;
    const transport = createStagingJourneyTelemetryTransportV1(identity, {
      write: (line) => { if (fail) throw new Error("writer failure"); lines.push(line); },
      scheduler: { set_interval: (fn) => { callback = fn; return 1; }, clear_interval: () => {} },
    }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, content_enabled: true });
    transport.start();
    await expect(observeCoreRuntimeV1("search_reconciliation", async () => {
      captureCoreRuntimeContentV1("model_response", new Proxy({}, { ownKeys() { throw new Error("content failure"); } }));
      return "published";
    }, transport.core_runtime)).resolves.toBe("published");
    await flush();
    fail = false;
    callback();
    const heartbeat = lines.map((line) => JSON.parse(line)).find((event) => event.event === "heartbeat");
    expect(heartbeat.delivery.writes_failed).toBeGreaterThan(0);
    expect(heartbeat.delivery.rejected_events).toBeGreaterThan(0);
    transport.close();
  });


  it("chunks complete Unicode evidence and excludes credentials independently of metadata", () => {
    const text = "fixture🙂".repeat(20_000);
    const records = formatStagingJourneyContentRecordsV2({ ...identity, journey_id: linked, sequence: 1, observed_at: "2026-09-08T00:00:00.000Z", stage: "core_operation", content_kind: "meeting_input", content: {
      text, authorization: "Bearer fixture-bearer", password: "fixture-password", signingSecret: "fixture-signing", loginGrant: "fixture-grant", nested: { apiKey: "fixture-key" },
      model_echo: 'login_grant="fixture-echo-grant" Bearer fixture-echo-bearer',
    } });
    expect(records.length).toBeGreaterThan(1);
    expect(records.every((record) => record.truncated === false && Buffer.byteLength(JSON.stringify(record)) < 200_000)).toBe(true);
    const serialized = records.map((record) => record.content).join("");
    records.forEach((record, index) => {
      expect(record).toMatchObject({
        schema_version: 2, environment: "staging", workflow: "core_runtime",
        ...identity, journey_id: linked, sequence: 1,
        observed_at: "2026-09-08T00:00:00.000Z",
        stage: "core_operation", content_kind: "meeting_input", span_id: null,
        capture_id: `${linked}:1`, encoding: "json_chunks",
        chunk_index: index, chunk_count: records.length,
        captured_bytes: Buffer.byteLength(serialized), truncated: false,
      });
      expect(Object.isFrozen(record)).toBe(true);
    });
    const content = JSON.parse(serialized);
    expect(content.text).toBe(text);
    for (const sentinel of ["fixture-bearer", "fixture-password", "fixture-signing", "fixture-grant", "fixture-key", "fixture-echo-grant", "fixture-echo-bearer"]) expect(JSON.stringify(records)).not.toContain(sentinel);
    const partial = formatStagingJourneyContentRecordsV2({ ...identity, journey_id: linked, sequence: 2, observed_at: "2026-09-08T00:00:00.000Z", stage: "core_operation", content_kind: "model_response", content: "x".repeat(9 * 1024 * 1024) });
    expect(partial[0]?.truncated).toBe(true);
  });
});
