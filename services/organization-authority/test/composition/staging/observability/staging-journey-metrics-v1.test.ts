import { describe, expect, it } from "vitest";
import {
  annotateCoreRuntimeV1,
  observeCoreRuntimeSyncV1,
  type CoreRuntimeDetailV1,
} from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "@echo-brain/organization-authority-kernel/shared/journey-telemetry-v1";
import {
  formatJourneyLivenessMetricV1,
  formatJourneyTelemetryMetricsV1,
  STAGING_JOURNEY_METRICS_NAMESPACE_V1,
} from "../../../../src/composition/observability/journey-metrics-v1.js";
import { createJourneyTelemetryTransportV1 } from "../../../../src/composition/observability/journey-telemetry-transport-v1.js";

const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const OPERATION_ID = "2b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const SPAN_ID = "3b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const RELEASE_SHA = "a".repeat(40);
const OBSERVED_AT = "2026-09-02T12:34:56.000Z";
const VOCABULARY = {
  providers: ["fixture-provider", "other"],
  models: ["fixture-model", "other"],
};

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

function journey(event: Record<string, unknown> = {}): JourneyTelemetryEventV1 {
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
      elapsed_ms: 17,
      diagnostic: detail(),
      ...event,
    } as never,
  }, VOCABULARY);
}

describe("journey EMF metrics v1", () => {
  it("keeps child HTTP diagnostics in logs without changing ingress metrics", async () => {
    const lines: string[] = [];
    const transport = createJourneyTelemetryTransportV1(
      "staging",
      { release_sha: RELEASE_SHA, build_number: 123 },
      { write: line => { lines.push(line); }, now: () => OBSERVED_AT },
    );
    observeCoreRuntimeSyncV1("http_request", () => {
      observeCoreRuntimeSyncV1("http_request", () => {
        annotateCoreRuntimeV1({ counts: { http_status: 429 } });
      });
    }, transport.core_runtime);
    await Promise.resolve();
    transport.close();

    const events = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(record => record.kind === "echo-authority-journey-stage-v1") as unknown as JourneyTelemetryEventV1[];
    const children = events.filter(event => !event.diagnostic.root);
    const roots = events.filter(event => event.diagnostic.root);
    expect(children.flatMap(event => formatJourneyTelemetryMetricsV1(event))).toEqual([]);
    expect(roots.flatMap(event => formatJourneyTelemetryMetricsV1(event))).toEqual(expect.arrayContaining([
      expect.objectContaining({ StageStarted: 1, workflow: "core_runtime", stage: "http_request" }),
      expect.objectContaining({ StageSucceeded: 1, workflow: "core_runtime", stage: "http_request" }),
    ]));
  });

  it("projects model calls with reported tokens, cache, reasoning, latency, provider, and model", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      diagnostic: detail({
        phase: "model_call",
        purpose: "ask_planner",
        result: "completed",
        provider: "fixture-provider",
        model: "fixture-model",
        counts: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          cached_input_tokens: 3,
          reasoning_tokens: 2,
          provider_latency_ms: 11,
        },
      }),
    }), VOCABULARY);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflow: "core_runtime",
        stage: "model_call",
        StageSucceeded: 1,
        StageClosedLatencyMs: 17,
      }),
      expect.objectContaining({
        workflow: "core_runtime",
        stage: "ask_planner",
        CoreModelAttempt: 1,
        CoreModelTotalTokens: 14,
        CoreModelUsageReported: 1,
      }),
      expect.objectContaining({
        stage: "ask_planner",
        provider: "fixture-provider",
        model: "fixture-model",
        LlmAttempt: 1,
        LlmUsageReported: 1,
        LlmProviderLatencyMs: 11,
        LlmCachedInputTokens: 3,
        LlmReasoningTokens: 2,
      }),
    ]));
  });

  it("does not fabricate unavailable model totals or latency", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      event: "failed",
      elapsed_ms: 4,
      failure_class: "timeout",
      retryable: true,
      diagnostic: detail({ phase: "model_call", purpose: "ask_planner", result: "timeout" }),
    }));
    const usage = records.find(record => record.LlmAttempt === 1)!;
    expect(usage).toMatchObject({ LlmUsageUnavailable: 1, provider: "other", model: "other" });
    expect(usage).not.toHaveProperty("LlmTotalTokens");
    expect(usage).not.toHaveProperty("LlmProviderLatencyMs");
  });

  it("emits one terminal research outcome and retrieval projection for each completed research run", () => {
    const root = formatJourneyTelemetryMetricsV1(journey({
      diagnostic: detail({
        phase: "research_run",
        purpose: "research_run",
        result: "answered",
        counts: {
          planned_query_count: 2,
          query_hit_count: 3,
          released_atom_count: 3,
          context_atom_count: 2,
          citation_count: 1,
        },
      }),
    }));
    const nested = formatJourneyTelemetryMetricsV1(journey({
      diagnostic: detail({
        root: false,
        phase: "research_run",
        purpose: "research_run",
        result: "partial",
        counts: { planned_query_count: 9, citation_count: 4 },
      }),
    }));
    expect(root).toEqual(expect.arrayContaining([
      expect.objectContaining({ TerminalOutcome: 1, outcome: "answered", stage: "research_run" }),
      expect.objectContaining({
        RetrievalPlannedQueries: 2,
        RetrievalQueryHits: 3,
        RetrievalReleasedAtoms: 3,
        RetrievalContextAtoms: 2,
        RetrievalCitations: 1,
      }),
    ]));
    expect(nested).toEqual(expect.arrayContaining([
      expect.objectContaining({ TerminalOutcome: 1, outcome: "partial", stage: "research_run" }),
      expect.objectContaining({ RetrievalPlannedQueries: 9, RetrievalCitations: 4 }),
    ]));
  });

  it("records research-loop failures separately from the stage failure breakdown", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      event: "failed",
      elapsed_ms: 4,
      failure_class: "unavailable",
      retryable: true,
      diagnostic: detail({ phase: "research_loop", purpose: "research_loop", result: "unavailable" }),
    }));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ AskRetrievalFailure: 1 }),
      expect.objectContaining({ StageFailure: 1, failure_class: "unavailable", stage: "research_loop" }),
    ]));
  });

  it("recanonicalizes forged records before metric projection and excludes content and deploy identity", () => {
    const forged = {
      ...journey(),
      journey_id: JOURNEY_ID,
      release_sha: RELEASE_SHA,
      prompt: "prompt-sentinel",
      diagnostic: { ...detail(), private_body: "private-sentinel" },
    } as unknown as JourneyTelemetryEventV1;
    const serialized = JSON.stringify(formatJourneyTelemetryMetricsV1(forged));
    expect(serialized).not.toContain(JOURNEY_ID);
    expect(serialized).not.toContain(RELEASE_SHA);
    expect(serialized).not.toContain("prompt-sentinel");
    expect(serialized).not.toContain("private-sentinel");
  });

  it("formats liveness in the staging namespace", () => {
    const liveness = formatJourneyLivenessMetricV1(OBSERVED_AT, "staging");
    expect(liveness).toMatchObject({ JourneyTelemetryAlive: 1 });
    expect(liveness._aws.CloudWatchMetrics[0].Namespace).toBe(STAGING_JOURNEY_METRICS_NAMESPACE_V1);
  });
});
