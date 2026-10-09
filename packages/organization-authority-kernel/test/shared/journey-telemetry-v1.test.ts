import { describe, expect, it } from "vitest";
import {
  createJourneyTelemetryEventV1,
  createJourneyTelemetryV1,
  parseJourneyIdV1,
  recanonicalizeJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "../../src/shared/journey-telemetry-v1.js";
import type { CoreRuntimeDetailV1 } from "../../src/shared/core-runtime-observation-v1.js";
import type { TelemetryVocabularyV1 } from "../../src/shared/telemetry-vocabulary-v1.js";

const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const OPERATION_ID = "2b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const SPAN_ID = "3b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const OBSERVED_AT = "2026-09-02T12:34:56.000Z";
const RELEASE_SHA = "f7018e16232aa11d24f9ecc880943b0bbb8c6ea2";

function detail(overrides: Partial<CoreRuntimeDetailV1> = {}): CoreRuntimeDetailV1 {
  return {
    operation_id: OPERATION_ID,
    span_id: SPAN_ID,
    parent_span_id: null,
    phase: "research_run",
    purpose: "research_run",
    root: true,
    linked_journey_ids: [],
    counts: {},
    result: "answered",
    generation: null,
    source_revision: null,
    cursor: null,
    action: null,
    provider: null,
    model: null,
    finish_reason: null,
    provider_request: null,
    resource_scope: "process_overlap",
    sqlite_lock_time: "unavailable",
    disk_io_latency: "unavailable",
    event_loop_delay: "unavailable",
    ...overrides,
  };
}

function coreEvent(
  overrides: Record<string, unknown> = {},
  vocabulary: TelemetryVocabularyV1 = { providers: [], models: [] },
): JourneyTelemetryEventV1 {
  return createJourneyTelemetryEventV1({
    journey_id: JOURNEY_ID,
    sequence: 1,
    observed_at: OBSERVED_AT,
    context: {
      environment: "staging",
      workflow: "core_runtime",
      release_sha: RELEASE_SHA,
      build_number: 123,
    },
    event: {
      stage: "core_operation",
      event: "succeeded",
      elapsed_ms: 37,
      diagnostic: detail(),
      ...overrides,
    } as never,
  }, vocabulary);
}

describe("journey telemetry v1", () => {
  it("constructs a frozen, exact, content-free core event", () => {
    const event = coreEvent({
      question: "prompt-sentinel",
      arbitrary_metadata: { answer: "answer-sentinel" },
      diagnostic: detail({
        counts: { citation_count: 2, ignored: 9 } as never,
      }),
    });

    expect(event).toMatchObject({
      schema_version: 2,
      kind: "echo-authority-journey-stage-v1",
      observed_at: OBSERVED_AT,
      journey_id: JOURNEY_ID,
      sequence: 1,
      environment: "staging",
      workflow: "core_runtime",
      stage: "core_operation",
      event: "succeeded",
      outcome: null,
      retrieval: null,
      llm_usage: null,
      diagnostic: {
        phase: "research_run",
        counts: { citation_count: 2 },
      },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.diagnostic)).toBe(true);
    const encoded = JSON.stringify(event);
    expect(encoded).not.toContain("prompt-sentinel");
    expect(encoded).not.toContain("answer-sentinel");
    expect(encoded).not.toContain("ignored");
  });

  it("requires the live core workflow, stage, identity, and terminal failure fields", () => {
    expect(() => coreEvent({ stage: "ask_response" })).toThrow("stage is invalid");
    expect(() => createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 1,
      observed_at: OBSERVED_AT,
      context: {
        environment: "staging",
        workflow: "ask",
        release_sha: RELEASE_SHA,
        build_number: 123,
      } as never,
      event: {
        stage: "core_operation",
        event: "succeeded",
        elapsed_ms: 1,
        diagnostic: detail(),
      },
    })).toThrow("workflow is invalid");
    expect(() => coreEvent({ event: "failed", failure_class: "timeout" })).toThrow("failed failure fields");
    expect(() => coreEvent({ event: "started", elapsed_ms: 1 })).toThrow("elapsed_ms is invalid");
    expect(() => coreEvent({ event: "succeeded", failure_class: "timeout", retryable: true })).toThrow("non-failed failure fields");
    expect(() => createJourneyTelemetryEventV1({
      journey_id: "candidate-hash",
      sequence: 1,
      observed_at: OBSERVED_AT,
      context: { environment: "staging", workflow: "core_runtime", release_sha: RELEASE_SHA, build_number: 123 },
      event: { stage: "core_operation", event: "succeeded", elapsed_ms: 1, diagnostic: detail() },
    })).toThrow("journey_id is not a UUID v4");
  });

  it("keeps model and retrieval counters in the normalized core diagnostic", () => {
    const vocabulary = {
      providers: ["fixture-provider", "other"],
      models: ["fixture-model", "other"],
    };
    const event = coreEvent({
      diagnostic: detail({
        phase: "model_call",
        purpose: "ask_planner",
        result: "completed",
        provider: "fixture-provider",
        model: "fixture-model",
        counts: {
          input_tokens: 42,
          output_tokens: 7,
          total_tokens: 50,
          cached_input_tokens: 3,
          reasoning_tokens: 2,
          provider_latency_ms: 31,
        },
      }),
    }, vocabulary);
    const normalized = recanonicalizeJourneyTelemetryEventV1(event, vocabulary);
    expect(normalized.diagnostic).toMatchObject({
      phase: "model_call",
      purpose: "ask_planner",
      provider: "fixture-provider",
      model: "fixture-model",
      counts: { total_tokens: 50, cached_input_tokens: 3, reasoning_tokens: 2 },
    });
  });

  it("resumes the operation id with a monotonic sequence and isolates observer failures", async () => {
    const observed: JourneyTelemetryEventV1[] = [];
    const telemetry = createJourneyTelemetryV1(
      event => {
        observed.push(event);
        throw new Error("observer must not reach the request");
      },
      { now: () => OBSERVED_AT },
    );
    const journey = telemetry.resumeJourney({
      journey_id: JOURNEY_ID,
      previous_sequence: 4,
      environment: "staging",
      workflow: "core_runtime",
      release_sha: RELEASE_SHA,
      build_number: 123,
    });
    expect(journey?.emit({ stage: "core_operation", event: "started", elapsed_ms: 0, diagnostic: detail() })?.sequence).toBe(5);
    expect(journey?.emit({ stage: "core_operation", event: "failed", elapsed_ms: 4, failure_class: "timeout", retryable: true, diagnostic: detail({ result: "timeout" }) })?.sequence).toBe(6);
    await Promise.resolve();
    expect(observed.map(event => event.sequence)).toEqual([5, 6]);
    expect(telemetry.resumeJourney({
      journey_id: "not-a-uuid",
      previous_sequence: 0,
      environment: "staging",
      workflow: "core_runtime",
      release_sha: RELEASE_SHA,
      build_number: 123,
    })).toBeNull();
  });

  it("recognizes only canonical UUID v4 operation ids", () => {
    expect(parseJourneyIdV1(JOURNEY_ID)).toBe(JOURNEY_ID);
    expect(parseJourneyIdV1("00000000-0000-4000-8000-000000000000")).toBe("00000000-0000-4000-8000-000000000000");
    expect(parseJourneyIdV1("not-a-uuid")).toBeNull();
  });
});
