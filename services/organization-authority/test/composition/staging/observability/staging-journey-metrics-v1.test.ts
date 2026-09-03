import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "../../../../src/shared/journey-telemetry-v1.js";
import {
  formatApprovedSearchBacklogMetricsV1,
  formatStagingJourneyLivenessMetricV1,
  formatJourneyTelemetryMetricsV1,
  STAGING_JOURNEY_METRICS_NAMESPACE_V1,
} from "../../../../src/composition/staging/observability/staging-journey-metrics-v1.js";

const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const RELEASE_SHA = "a".repeat(40);
const OBSERVED_AT = "2026-09-02T12:34:56.000Z";
const RECONCILIATION_FIXTURE = resolve(
  import.meta.dirname,
  "../../../../../../tests/fixtures/staging-journey-observability/phase4-reconciliation-v1.jsonl",
);

function journey(event: Record<string, unknown>): JourneyTelemetryEventV1 {
  return createJourneyTelemetryEventV1({
    journey_id: JOURNEY_ID,
    sequence: 1,
    observed_at: OBSERVED_AT,
    context: {
      environment: "staging",
      workflow: "ask",
      release_sha: RELEASE_SHA,
      build_number: 123,
    },
    event: {
      stage: "ask_answer",
      event: "succeeded",
      elapsed_ms: 17,
      llm_usage: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 11,
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cached_input_tokens: 3,
        reasoning_tokens: 2,
        finish_reason: "completed",
      },
      ...event,
    } as never,
  });
}

function metric(record: Record<string, unknown>, name: string): unknown {
  return record[name];
}

describe("staging journey EMF metrics v1", () => {
  it("projects a closed LLM stage into exact independent metric dimension sets", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({}));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      _aws: {
        Timestamp: Date.parse(OBSERVED_AT),
        CloudWatchMetrics: [{
          Namespace: STAGING_JOURNEY_METRICS_NAMESPACE_V1,
          Dimensions: [["workflow", "stage"]],
          Metrics: [
            { Name: "StageSucceeded", Unit: "Count" },
            { Name: "StageClosedLatencyMs", Unit: "Milliseconds" },
          ],
        }],
      },
      workflow: "ask",
      stage: "ask_answer",
      StageSucceeded: 1,
      StageClosedLatencyMs: 17,
    });
    expect(records[1]).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{
          Dimensions: [["stage", "provider", "model"]],
          Metrics: expect.arrayContaining([
            { Name: "LlmAttempt", Unit: "Count" },
            { Name: "LlmUsageReported", Unit: "Count" },
            { Name: "LlmProviderLatencyMs", Unit: "Milliseconds" },
            { Name: "LlmTotalTokens", Unit: "Count" },
          ]),
        }],
      },
      stage: "ask_answer",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      LlmAttempt: 1,
      LlmTotalTokens: 14,
      LlmTotalTokensAvailable: 1,
    });
  });

  it("omits unavailable token targets rather than publishing zero", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      event: "failed",
      failure_class: "timeout",
      retryable: true,
      llm_usage: {
        usage_status: "unavailable",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 11,
        finish_reason: "unknown",
      },
    }));
    const llm = records.find((record) => metric(record, "LlmAttempt") === 1)!;
    expect(llm.LlmUsageUnavailable).toBe(1);
    expect(JSON.stringify(llm)).not.toContain("LlmInputTokens");
    expect(JSON.stringify(llm)).not.toContain("LlmTotalTokens");
  });

  it("counts a total-token denominator only when a reported attempt has a total", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      llm_usage: {
        usage_status: "reported",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        provider_latency_ms: 11,
        cached_input_tokens: 3,
        finish_reason: "completed",
      },
    }));
    const llm = records.find((record) => metric(record, "LlmAttempt") === 1)!;
    expect(llm.LlmUsageReported).toBe(1);
    expect(llm.LlmCachedInputTokens).toBe(3);
    expect(llm).not.toHaveProperty("LlmTotalTokens");
    expect(llm).not.toHaveProperty("LlmTotalTokensAvailable");
  });

  it("emits a terminal outcome only in its dedicated three-dimension record", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      stage: "ask_response",
      llm_usage: null,
      outcome: "answered",
    }));
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      workflow: "ask",
      stage: "ask_response",
      outcome: "answered",
      TerminalOutcome: 1,
      _aws: {
        CloudWatchMetrics: [{ Dimensions: [["workflow", "stage", "outcome"]] }],
      },
    });
    expect(records[0]).not.toHaveProperty("outcome");
  });

  it("counts only attempts after the first as retries", () => {
    const first = formatJourneyTelemetryMetricsV1(journey({
      event: "started",
      elapsed_ms: 0,
      llm_usage: null,
      attempt: 1,
    }));
    const retry = formatJourneyTelemetryMetricsV1(journey({
      event: "started",
      elapsed_ms: 0,
      llm_usage: null,
      attempt: 2,
    }));
    expect(first[0]).toMatchObject({ StageStarted: 1 });
    expect(first[0]).not.toHaveProperty("StageRetryAttempt");
    expect(retry[0]).toMatchObject({ StageStarted: 1, StageRetryAttempt: 1 });
  });

  it("retains reported retrieval zeroes and keeps their dimensions separate", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      stage: "ask_retrieval",
      llm_usage: null,
      retrieval: {
        planned_query_count: 0,
        query_hit_count: 0,
        released_atom_count: 0,
        context_atom_count: 0,
        citation_count: 0,
      },
    }));
    const retrieval = records.find((record) => metric(record, "RetrievalPlannedQueries") === 0)!;
    expect(retrieval).toMatchObject({
      workflow: "ask",
      stage: "ask_retrieval",
      RetrievalPlannedQueries: 0,
      RetrievalQueryHits: 0,
      RetrievalReleasedAtoms: 0,
      RetrievalContextAtoms: 0,
      RetrievalCitations: 0,
    });
  });

  it("keeps human wait out of machine latency and attaches it only to approval verification", () => {
    const records = formatJourneyTelemetryMetricsV1(createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 3,
      observed_at: OBSERVED_AT,
      context: {
        environment: "staging",
        workflow: "meeting_approval",
        release_sha: RELEASE_SHA,
        build_number: 123,
      },
      event: {
        stage: "meeting_approval_action_verify",
        event: "succeeded",
        elapsed_ms: 9,
        queue_age_ms: 86_400_000,
      },
    }));
    expect(records[0]).toMatchObject({ StageClosedLatencyMs: 9 });
    expect(records[1]).toMatchObject({ ApprovalHumanWaitMs: 86_400_000 });
    expect(records[1]).not.toHaveProperty("StageClosedLatencyMs");
  });

  it("writes a stable zero-dimension retrieval-failure signal and a failure breakdown", () => {
    const records = formatJourneyTelemetryMetricsV1(journey({
      stage: "ask_retrieval",
      event: "failed",
      llm_usage: null,
      failure_class: "unavailable",
      retryable: true,
    }));
    expect(records).toContainEqual(expect.objectContaining({ AskRetrievalFailure: 1 }));
    expect(records).toContainEqual(expect.objectContaining({
      workflow: "ask",
      stage: "ask_retrieval",
      failure_class: "unavailable",
      StageFailure: 1,
    }));
  });

  it("never serializes correlation, deploy identity, injected content, or error data", () => {
    const forged = {
      ...journey({}),
      prompt: "prompt-sentinel",
      error: "error-sentinel",
    };
    const serialized = JSON.stringify(formatJourneyTelemetryMetricsV1(forged));
    for (const forbidden of [
      JOURNEY_ID,
      RELEASE_SHA,
      "prompt-sentinel",
      "error-sentinel",
      "build_number",
      "journey_id",
      "release_sha",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("formats validated zero-dimension liveness and explicit-zero backlog gauges", () => {
    expect(formatStagingJourneyLivenessMetricV1(OBSERVED_AT)).toMatchObject({
      JourneyTelemetryAlive: 1,
    });
    expect(formatApprovedSearchBacklogMetricsV1({
      observed_at: OBSERVED_AT,
      pending_count: 0,
      stuck_count: 0,
      oldest_age_ms: null,
    })).toMatchObject({
      ApprovedSearchPendingCount: 0,
      ApprovedSearchStuckCount: 0,
      ApprovedSearchBacklogCheck: 1,
    });
    expect(() => formatApprovedSearchBacklogMetricsV1({
      observed_at: "invalid",
      pending_count: 0,
      stuck_count: 0,
      oldest_age_ms: null,
    })).toThrow("backlog observed_at");
    expect(formatApprovedSearchBacklogMetricsV1({
      observed_at: OBSERVED_AT,
      pending_count: 2,
      stuck_count: 1,
      oldest_age_ms: 90_000,
    })).toMatchObject({
      ApprovedSearchPendingCount: 2,
      ApprovedSearchStuckCount: 1,
      ApprovedSearchOldestAgeMs: 90_000,
      ApprovedSearchBacklogCheck: 1,
    });
  });

  it("reconciles emitted metric totals with the independent raw-event fixture", () => {
    const events = readFileSync(RECONCILIATION_FIXTURE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (event) => event.kind === "echo-authority-journey-stage-v1",
      ) as unknown as JourneyTelemetryEventV1[];
    const records = events.flatMap((event) =>
      formatJourneyTelemetryMetricsV1(event),
    );
    const sum = (name: string): number =>
      records.reduce(
        (total, record) =>
          total + (typeof record[name] === "number" ? record[name] : 0),
        0,
      );

    expect({
      started: sum("StageStarted"),
      succeeded: sum("StageSucceeded"),
      failed: sum("StageFailed"),
      skipped: sum("StageSkipped"),
      retries: sum("StageRetryAttempt"),
      llm_attempts: sum("LlmAttempt"),
      llm_usage_reported: sum("LlmUsageReported"),
      llm_total_available: sum("LlmTotalTokensAvailable"),
      llm_total_tokens: sum("LlmTotalTokens"),
      ask_retrieval_failures: sum("AskRetrievalFailure"),
      approval_human_wait_ms: sum("ApprovalHumanWaitMs"),
      planned_queries: sum("RetrievalPlannedQueries"),
      query_hits: sum("RetrievalQueryHits"),
      released_atoms: sum("RetrievalReleasedAtoms"),
      context_atoms: sum("RetrievalContextAtoms"),
      citations: sum("RetrievalCitations"),
    }).toEqual({
      started: 7,
      succeeded: 36,
      failed: 3,
      skipped: 4,
      retries: 1,
      llm_attempts: 6,
      llm_usage_reported: 4,
      llm_total_available: 4,
      llm_total_tokens: 105,
      ask_retrieval_failures: 1,
      approval_human_wait_ms: 1_200_000,
      planned_queries: 2,
      query_hits: 3,
      released_atoms: 3,
      context_atoms: 2,
      citations: 1,
    });
    const serialized = JSON.stringify(records);
    for (const event of events) {
      expect(serialized).not.toContain(event.journey_id);
      expect(serialized).not.toContain(event.release_sha);
    }
  });
});
