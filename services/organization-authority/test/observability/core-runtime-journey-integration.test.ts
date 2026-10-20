import { observeCoreRuntimeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { describe, expect, it } from "vitest";
import { createOpenRouterStructuredGenerationAdapter } from "../../../../providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../../tests/support/telemetry-fixture-vocabulary-v1.js";
import { createJourneyTelemetryTransportV1 } from "../../src/composition/observability/journey-telemetry-transport-v1.js";

const identity = { release_sha: "a".repeat(40), build_number: 42 };
const request = { model: "anthropic/claude-sonnet-4.6", system_prompt: "fixture system", user_prompt: "fixture input", schema: { type: "object" }, max_output_tokens: 100, timeout_ms: 1000 } as const;
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("core runtime observations through the existing journey channel", () => {

  it("captures a failed model call followed by a successful call without inventing usage", async () => {
    const lines: string[] = [];
    const transport = createJourneyTelemetryTransportV1("staging", identity, { write: (line) => { lines.push(line); } }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 });
    let calls = 0;
    const adapter = createOpenRouterStructuredGenerationAdapter({
      credential_ref: "fixture", credential_resolver: () => "fixture-credential-never-record",
      fetch_impl: async () => {
        calls++;
        return calls === 1 ? new Response('{"error":{"message":"fixture throttle"}}', { status: 429 }) : new Response(JSON.stringify({ id: "fixture-generation", choices: [{ finish_reason: "stop", message: { content: '{"queries":[]}' } }] }), { status: 200 });
      },
    });
    await observeCoreRuntimeV1("ask_planner", async () => {
      await expect(adapter.generate(request)).rejects.toThrow();
      await expect(adapter.generate(request)).resolves.toEqual({ queries: [] });
    }, transport.core_runtime);
    await flush();
    const records = lines.map((line) => JSON.parse(line));
    const callsObserved = records.filter((event) => event.diagnostic?.phase === "model_call" && event.event !== "started");
    expect(callsObserved.map((event) => event.event)).toEqual(["failed", "succeeded"]);
    expect(callsObserved[0].diagnostic.counts).toMatchObject({ http_status: 429, input_tokens: null, total_tokens: null });
    expect(callsObserved[1].diagnostic).toMatchObject({ provider: "openrouter", model: request.model, purpose: "ask_planner", finish_reason: "stop", counts: { total_tokens: null } });
    expect(lines.join("")).not.toContain("fixture-credential-never-record");

    const closedCall = callsObserved[1];
    const beforeInjected = lines.length;
    transport.observer({
      ...closedCall,
      injected: "must-not-serialize",
      diagnostic: {
        ...closedCall.diagnostic,
        injected: "must-not-serialize",
        counts: { ...closedCall.diagnostic.counts, injected: "must-not-serialize" },
      },
    });
    const canonical = JSON.parse(lines[beforeInjected]!);
    expect(canonical).toEqual(closedCall);
    expect(canonical).toMatchObject({ workflow: "core_runtime", stage: "core_operation" });
    expect(lines.slice(beforeInjected).join("")).not.toContain("must-not-serialize");
    transport.close();
  });


  it("reports transport losses and keeps results intact when the writer throws", async () => {
    const lines: string[] = [];
    let callback = () => {};
    let fail = true;
    const transport = createJourneyTelemetryTransportV1("staging", identity, {
      write: (line) => { if (fail) throw new Error("writer failure"); lines.push(line); },
      scheduler: { set_interval: (fn) => { callback = fn; return 1; }, clear_interval: () => {} },
    }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 });
    transport.start();
    await expect(observeCoreRuntimeV1("search_reconciliation", async () => "published", transport.core_runtime)).resolves.toBe("published");
    await flush();
    fail = false;
    callback();
    const heartbeat = lines.map((line) => JSON.parse(line)).find((event) => event.event === "heartbeat");
    expect(heartbeat.delivery.writes_failed).toBeGreaterThan(0);
    transport.close();
  });
});
