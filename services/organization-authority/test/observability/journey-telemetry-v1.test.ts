import { describe, expect, it } from "vitest";
import {
  createJourneyIdV1,
  createJourneyTelemetryEventV1,
  createJourneyTelemetryV1,
  isJourneyMetricDimensionKeyV1,
  JOURNEY_ENVIRONMENTS_V1,
  JOURNEY_EVENTS_V1,
  JOURNEY_FAILURE_CLASSES_V1,
  JOURNEY_LLM_FINISH_REASONS_V1,
  JOURNEY_LLM_MODELS_V1,
  JOURNEY_LLM_PROVIDERS_V1,
  JOURNEY_LLM_USAGE_STATUSES_V1,
  JOURNEY_METRIC_DIMENSION_KEYS_V1,
  JOURNEY_OUTCOMES_V1,
  JOURNEY_STAGES_V1,
  JOURNEY_WORKFLOWS_V1,
  parseJourneyIdV1,
  type JourneyTelemetryContextInputV1,
} from "../../src/shared/journey-telemetry-v1.js";

const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const OBSERVED_AT = "2026-09-02T12:34:56.000Z";
const RELEASE_SHA = "f7018e16232aa11d24f9ecc880943b0bbb8c6ea2";
const LONG_HUMAN_WAIT_MS = 45 * 24 * 60 * 60 * 1_000;
const askContext: JourneyTelemetryContextInputV1 = {
  environment: "staging",
  workflow: "ask",
  release_sha: RELEASE_SHA,
  build_number: 123,
};

function strict(input: Record<string, unknown> = {}) {
  return createJourneyTelemetryEventV1({
    journey_id: JOURNEY_ID,
    sequence: 1,
    observed_at: OBSERVED_AT,
    context: askContext,
    event: {
      stage: "ask_answer",
      event: "succeeded",
      outcome: null,
      elapsed_ms: 37,
      llm_usage: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 31,
        input_tokens: 42,
        output_tokens: 7,
        total_tokens: 50,
        finish_reason: "completed",
      } as never,
      ...input,
    },
  });
}

describe("journey telemetry v1", () => {
  it("constructs a frozen, exact, content-free event without an external request identifier", () => {
    const event = strict({
      question: "prompt-sentinel",
      arbitrary_metadata: { answer: "answer-sentinel" },
      llm_usage: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 31,
        input_tokens: 42,
        output_tokens: 7,
        total_tokens: 50,
        finish_reason: "completed",
        nested: { meeting: "meeting-content-sentinel" },
      } as never,
    });

    expect(event).toEqual({
      schema_version: 1,
      kind: "echo-authority-journey-stage-v1",
      observed_at: OBSERVED_AT,
      journey_id: JOURNEY_ID,
      sequence: 1,
      environment: "staging",
      workflow: "ask",
      release_sha: RELEASE_SHA,
      build_number: 123,
      stage: "ask_answer",
      event: "succeeded",
      outcome: null,
      failure_class: null,
      retryable: null,
      attempt: 1,
      elapsed_ms: 37,
      queue_age_ms: null,
      retrieval: null,
      llm_usage: {
        usage_status: "reported",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 31,
        input_tokens: 42,
        output_tokens: 7,
        total_tokens: 50,
        cached_input_tokens: null,
        reasoning_tokens: null,
        finish_reason: "completed",
      },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.llm_usage)).toBe(true);
    const encoded = JSON.stringify(event);
    for (const forbidden of [
      "prompt-sentinel",
      "answer-sentinel",
      "meeting-content-sentinel",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(Object.keys(event.llm_usage ?? {})).not.toContain("provider" + "_request_id");
  });

  it("freezes and allowlists nested retrieval counters including citations", () => {
    const event = createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 3,
      observed_at: OBSERVED_AT,
      context: askContext,
      event: {
        stage: "ask_retrieval",
        event: "succeeded",
        elapsed_ms: 12,
        retrieval: {
          planned_query_count: 2,
          query_hit_count: 3,
          released_atom_count: 3,
          context_atom_count: 2,
          citation_count: 1,
          private_atoms: ["private-sentinel"],
        } as never,
      },
    });

    expect(event.retrieval).toEqual({
      planned_query_count: 2,
      query_hit_count: 3,
      released_atom_count: 3,
      context_atom_count: 2,
      citation_count: 1,
    });
    expect(Object.isFrozen(event.retrieval)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("private-sentinel");

    expect(
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 4,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_answer",
          event: "succeeded",
          elapsed_ms: 9,
          retrieval: { citation_count: 2 },
          llm_usage: {
            provider: "openrouter",
            model: "deepseek/deepseek-v3.2",
            provider_latency_ms: 8,
            input_tokens: 4,
            output_tokens: 2,
            finish_reason: "completed",
          },
        },
      }).retrieval,
    ).toMatchObject({ citation_count: 2 });
  });

  it("requires explicit LLM usage for closed LLM stages and forbids it elsewhere", () => {
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: { stage: "ask_planner", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toThrow("llm_usage is required");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_planner",
          event: "started",
          elapsed_ms: 0,
          llm_usage: {} as never,
        },
      }),
    ).toThrow("llm_usage is not allowed");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_retrieval",
          event: "succeeded",
          elapsed_ms: 1,
          llm_usage: {} as never,
        },
      }),
    ).toThrow("llm_usage is not allowed");
    expect(
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_planner",
          event: "failed",
          failure_class: "timeout",
          retryable: true,
          elapsed_ms: 1,
          llm_usage: {
            provider: "openrouter",
            model: "deepseek/deepseek-v3.2",
            provider_latency_ms: 1,
            finish_reason: "unknown",
          },
        },
      }).llm_usage,
    ).toMatchObject({ usage_status: "unavailable", input_tokens: null });
  });

  it("preserves long human wait while retaining machine-latency caps", () => {
    const telemetry = createJourneyTelemetryV1(undefined, {
      create_uuid: () => JOURNEY_ID,
      now: () => OBSERVED_AT,
    });
    const resumed = telemetry.resumeJourney({
      environment: "staging",
      workflow: "meeting_approval",
      release_sha: RELEASE_SHA,
      build_number: 123,
      journey_id: JOURNEY_ID,
      previous_sequence: 7,
    });

    expect(
      resumed?.emit({
        stage: "meeting_approval_action_verify",
        event: "succeeded",
        elapsed_ms: 2,
        queue_age_ms: LONG_HUMAN_WAIT_MS,
      }),
    ).toMatchObject({
      sequence: 8,
      queue_age_ms: LONG_HUMAN_WAIT_MS,
    });

    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_validation",
          event: "succeeded",
          elapsed_ms: LONG_HUMAN_WAIT_MS,
        },
      }),
    ).toThrow("elapsed_ms");
    expect(() =>
      strict({
        llm_usage: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: LONG_HUMAN_WAIT_MS,
          finish_reason: "unknown",
        },
      }),
    ).toThrow("provider_latency_ms");

    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: askContext,
        event: {
          stage: "ask_validation",
          event: "succeeded",
          elapsed_ms: 1,
          queue_age_ms: LONG_HUMAN_WAIT_MS,
        },
      }),
    ).toThrow("queue_age_ms");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, workflow: "meeting_approval" },
        event: {
          stage: "meeting_approval_action_queue",
          event: "succeeded",
          elapsed_ms: 1,
          queue_age_ms: LONG_HUMAN_WAIT_MS,
        },
      }),
    ).toThrow("queue_age_ms");
  });

  it("requires staging deploy identity while retaining local nullable context", () => {
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { environment: "staging", workflow: "ask" },
        event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toThrow("staging release_sha");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: {
          environment: "staging",
          workflow: "ask",
          release_sha: RELEASE_SHA,
        },
        event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toThrow("staging build_number");
    expect(
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { environment: "test", workflow: "ask" },
        event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toMatchObject({ environment: "test", release_sha: null, build_number: null });
  });

  it("exports a finite metric-dimension allowlist without correlation identifiers", () => {
    expect(JOURNEY_METRIC_DIMENSION_KEYS_V1).toEqual([
      "environment",
      "workflow",
      "stage",
      "outcome",
      "failure_class",
      "retryable",
      "provider",
      "model",
    ]);
    for (const allowed of JOURNEY_METRIC_DIMENSION_KEYS_V1) {
      expect(isJourneyMetricDimensionKeyV1(allowed)).toBe(true);
    }
    for (const forbidden of [
      "journey_id",
      "request_id",
      "user_id",
      "person_id",
      "meeting_id",
      "candidate_id",
      "approval_id",
    ]) {
      expect(isJourneyMetricDimensionKeyV1(forbidden)).toBe(false);
    }
  });

  it("freezes every validation allowlist so runtime mutation cannot admit new values", () => {
    const injected = "runtime-injected-value";
    const allowlists: readonly (readonly string[])[] = [
      JOURNEY_ENVIRONMENTS_V1,
      JOURNEY_WORKFLOWS_V1,
      JOURNEY_STAGES_V1,
      JOURNEY_METRIC_DIMENSION_KEYS_V1,
      JOURNEY_EVENTS_V1,
      JOURNEY_OUTCOMES_V1,
      JOURNEY_FAILURE_CLASSES_V1,
      JOURNEY_LLM_PROVIDERS_V1,
      JOURNEY_LLM_MODELS_V1,
      JOURNEY_LLM_FINISH_REASONS_V1,
      JOURNEY_LLM_USAGE_STATUSES_V1,
    ];

    for (const allowlist of allowlists) {
      expect(Object.isFrozen(allowlist)).toBe(true);
      expect(() => (allowlist as string[]).push(injected)).toThrow(TypeError);
      expect(allowlist).not.toContain(injected);
    }

    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, environment: injected } as never,
        event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toThrow("environment");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, workflow: injected } as never,
        event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
      }),
    ).toThrow("workflow");
    expect(() => strict({ stage: injected, llm_usage: null })).toThrow("stage");
    expect(() => strict({ event: injected })).toThrow("event");
    expect(() =>
      strict({ stage: "ask_response", outcome: injected, llm_usage: null }),
    ).toThrow("outcome");
    expect(() =>
      strict({ event: "failed", failure_class: injected, retryable: false }),
    ).toThrow("failure_class");
    expect(() =>
      strict({
        llm_usage: {
          provider: injected,
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 1,
          finish_reason: "completed",
        },
      }),
    ).toThrow("provider");
    expect(() =>
      strict({
        llm_usage: {
          provider: "openrouter",
          model: injected,
          provider_latency_ms: 1,
          finish_reason: "completed",
        },
      }),
    ).toThrow("model");
    expect(() =>
      strict({
        llm_usage: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 1,
          finish_reason: injected,
        },
      }),
    ).toThrow("finish_reason");
    expect(() =>
      strict({
        llm_usage: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 1,
          finish_reason: "completed",
          usage_status: injected,
        },
      }),
    ).toThrow("usage_status");
    expect(isJourneyMetricDimensionKeyV1(injected)).toBe(false);
  });

  it("enforces stage-compatible outcomes and keeps intermediate stages outcome-free", () => {
    expect(() => strict({ stage: "ask_planner", outcome: "answered" })).toThrow(
      "intermediate outcome",
    );
    expect(() =>
      strict({ stage: "ask_response", outcome: "approved", llm_usage: null }),
    ).toThrow("stage outcome");
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, workflow: "meeting_approval" },
        event: {
          stage: "meeting_search_publication",
          event: "succeeded",
          outcome: "approved",
          elapsed_ms: 1,
        },
      }),
    ).toThrow("stage outcome");
    expect(
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, workflow: "meeting_approval" },
        event: {
          stage: "meeting_terminal_persist",
          event: "succeeded",
          outcome: "approved",
          elapsed_ms: 1,
        },
      }).outcome,
    ).toBe("approved");
    expect(
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: { ...askContext, workflow: "meeting_approval" },
        event: {
          stage: "meeting_approval_staging",
          event: "succeeded",
          outcome: "staged",
          elapsed_ms: 1,
        },
      }).outcome,
    ).toBe("staged");
    expect(() =>
      strict({ event: "succeeded", outcome: "skipped" }),
    ).toThrow("intermediate outcome");
    expect(
      strict({ event: "skipped", outcome: "skipped", elapsed_ms: 0, llm_usage: null }),
    ).toMatchObject({ event: "skipped", outcome: "skipped" });
  });

  it("validates opaque UUID v4 IDs in the strict helpers", () => {
    expect(parseJourneyIdV1(JOURNEY_ID)).toBe(JOURNEY_ID);
    expect(parseJourneyIdV1("candidate-hash-or-slack-id")).toBeNull();
    expect(() => createJourneyIdV1(() => "not-a-uuid")).toThrow("UUID v4");
  });

  it("keeps the production API nonthrowing for bad UUID, clock, event, model, token, and sequence inputs", () => {
    const badUuid = createJourneyTelemetryV1(undefined, {
      create_uuid: () => "candidate-hash",
      now: () => OBSERVED_AT,
    });
    expect(badUuid.startJourney(askContext)).toBeNull();

    const badClock = createJourneyTelemetryV1(undefined, {
      create_uuid: () => JOURNEY_ID,
      now: () => "not-an-iso-clock",
    });
    const badClockJourney = badClock.startJourney(askContext);
    expect(badClockJourney?.emit({ stage: "ask_validation", event: "started", elapsed_ms: 0 })).toBeNull();
    const throwingClock = createJourneyTelemetryV1(undefined, {
      create_uuid: () => JOURNEY_ID,
      now: () => {
        throw new Error("clock sentinel");
      },
    });
    expect(
      throwingClock.startJourney(askContext)?.emit({
        stage: "ask_validation",
        event: "started",
        elapsed_ms: 0,
      }),
    ).toBeNull();

    const telemetry = createJourneyTelemetryV1(undefined, {
      create_uuid: () => JOURNEY_ID,
      now: () => OBSERVED_AT,
    });
    const journey = telemetry.startJourney(askContext);
    expect(journey).not.toBeNull();
    expect(
      journey?.emit({ stage: "unknown-stage", event: "started", elapsed_ms: 0 } as never),
    ).toBeNull();
    expect(
      journey?.emit({
        stage: "ask_answer",
        event: "succeeded",
        outcome: "answered",
        elapsed_ms: 1,
        llm_usage: {
          provider: "openrouter",
          model: "bad model with spaces",
          provider_latency_ms: 1,
          input_tokens: 1,
          finish_reason: "completed",
        },
      } as never),
    ).toBeNull();
    expect(
      journey?.emit({
        stage: "ask_answer",
        event: "succeeded",
        outcome: "answered",
        elapsed_ms: 1,
        llm_usage: {
          provider: "openrouter",
          model: "deepseek/deepseek-v3.2",
          provider_latency_ms: 1,
          input_tokens: -1,
          finish_reason: "completed",
        },
      } as never),
    ).toBeNull();
    expect(
      journey?.emit({
        stage: "ask_response",
        event: "succeeded",
        outcome: "answered",
        elapsed_ms: 1,
      }),
    ).toMatchObject({ sequence: 1 });

    expect(
      telemetry.resumeJourney({
        ...askContext,
        journey_id: "not-a-uuid",
        previous_sequence: 0,
      }),
    ).toBeNull();
    const exhausted = telemetry.resumeJourney({
      ...askContext,
      journey_id: JOURNEY_ID,
      previous_sequence: Number.MAX_SAFE_INTEGER,
    });
    expect(exhausted?.emit({ stage: "ask_validation", event: "started", elapsed_ms: 0 })).toBeNull();
  });

  it("binds context once and defers observer failures off the product call stack", async () => {
    let observerInvoked = false;
    const telemetry = createJourneyTelemetryV1(
      () => {
        observerInvoked = true;
        throw new Error("observer sentinel");
      },
      { create_uuid: () => JOURNEY_ID, now: () => OBSERVED_AT },
    );
    const journey = telemetry.startJourney(askContext);
    const event = journey?.emit({
      stage: "ask_response",
      event: "succeeded",
      outcome: "answered",
      elapsed_ms: 1,
      environment: "production",
      workflow: "meeting_approval",
      release_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      build_number: 999,
    } as never);
    expect(observerInvoked).toBe(false);
    await Promise.resolve();
    expect(observerInvoked).toBe(true);
    expect(event).toMatchObject({
      environment: "staging",
      workflow: "ask",
      release_sha: RELEASE_SHA,
      build_number: 123,
    });
  });

  it("rejects content-shaped values from every configuration-derived string field", () => {
    expect(() =>
      createJourneyTelemetryEventV1({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: OBSERVED_AT,
        context: {
          ...askContext,
          release_sha: "slack-user-or-secret",
        } as never,
        event: {
          stage: "ask_validation",
          event: "succeeded",
          elapsed_ms: 1,
        },
      }),
    ).toThrow("release_sha");
    expect(
      createJourneyTelemetryV1(undefined, {
        create_uuid: () => JOURNEY_ID,
        now: () => OBSERVED_AT,
      }).startJourney({ ...askContext, build_number: "candidate-id" } as never),
    ).toBeNull();
    expect(() =>
      strict({
        llm_usage: {
          provider: "provider-secret",
          model: "candidate-id",
          provider_latency_ms: 1,
          finish_reason: "raw-stop-content",
        },
      }),
    ).toThrow("llm provider");
  });
});
