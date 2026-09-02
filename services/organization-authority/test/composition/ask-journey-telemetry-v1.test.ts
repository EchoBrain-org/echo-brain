import { describe, expect, it, vi } from "vitest";
import { createAskJourneyTelemetryFactoryV1 } from "../../src/composition/ask-journey-telemetry-v1.js";
import type { JourneyTelemetryEventV1 } from "../../src/shared/journey-telemetry-v1.js";

const CLOCK = Object.freeze({
  now: () => "2026-09-02T17:00:00.000Z",
  create_uuid: () => "123e4567-e89b-42d3-a456-426614174000",
});

describe("Ask journey telemetry", () => {
  it("preserves the closed LLM stage when an observed model disagrees with the trusted profile", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const recorder = createAskJourneyTelemetryFactoryV1({
      observer: (event) => {
        events.push(event);
      },
      release_sha: "a".repeat(40),
      build_number: 42,
      planner_model: "deepseek/deepseek-v3.2",
      answer_model: "deepseek/deepseek-v3.2",
      clock: CLOCK,
      now_ms: () => 100,
    }).start();

    recorder.observeComposition({
      stage: "planner",
      event: "succeeded",
      elapsed_ms: 7,
      failure_class: null,
      http_status: null,
      generation_usage: {
        adapter_id: "unexpected-provider",
        model: "provider/new-model",
        provider_latency_ms: 5,
        input_tokens: 999,
        output_tokens: 999,
        total_tokens: 1_998,
        cached_input_tokens: 999,
        reasoning_tokens: 999,
        finish_reason: "stop",
      },
      retrieval: { planned_query_count: 1 },
    });
    recorder.complete("answered", recorder.startTimer());

    await vi.waitFor(() => expect(events).toHaveLength(9));
    expect(events[0]).toMatchObject({
      stage: "ask_planner",
      event: "succeeded",
      llm_usage: {
        usage_status: "unavailable",
        provider: "other",
        model: "deepseek/deepseek-v3.2",
        provider_latency_ms: 7,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
        finish_reason: "unknown",
      },
    });
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("rejects a runtime model that is outside the telemetry allowlist", () => {
    expect(() =>
      createAskJourneyTelemetryFactoryV1({
        observer: () => undefined,
        release_sha: "b".repeat(40),
        build_number: 43,
        planner_model: "provider/new-model" as never,
        answer_model: "deepseek/deepseek-v3.2",
      }),
    ).toThrow("Ask journey telemetry model is not allowlisted");
  });
});
