import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "../../../shared/journey-telemetry-v1.js";

/** The staging-only CloudWatch namespace for the V1 journey overview. */
export const STAGING_JOURNEY_METRICS_NAMESPACE_V1 =
  "EchoBrain/StagingJourneyV1" as const;

export interface StagingJourneyEmfMetricDefinitionV1 {
  readonly Name: string;
  readonly Unit: "Count" | "Milliseconds";
}

export interface StagingJourneyMetricRecordV1 {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly [{
      readonly Namespace: typeof STAGING_JOURNEY_METRICS_NAMESPACE_V1;
      readonly Dimensions: readonly [readonly string[]];
      readonly Metrics: readonly StagingJourneyEmfMetricDefinitionV1[];
    }];
  };
  readonly [key: string]: unknown;
}

export interface StagingApprovedSearchBacklogSnapshotV1 {
  readonly observed_at: string;
  /** Approved journeys awaiting a terminal search result at scan time. */
  readonly pending_count: number;
  /** Pending approved journeys older than the configured completion bound. */
  readonly stuck_count: number;
  /** Null only when no approved journey is awaiting search completion. */
  readonly oldest_age_ms: number | null;
}

export type StagingApprovedSearchBacklogObserverV1 = (
  snapshot: StagingApprovedSearchBacklogSnapshotV1,
) => void | Promise<void>;

type MetricValue = readonly [name: string, value: number, unit: "Count" | "Milliseconds"];

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function requiredTimestamp(value: unknown, label: string): number {
  const timestamp = canonicalTimestamp(value);
  if (timestamp === null) throw new TypeError(`${label} must be canonical ISO UTC`);
  return timestamp;
}

function validNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reconstructs the shared contract before projection. This keeps the formatter
 * pure and makes a forged observer value indistinguishable from malformed input.
 */
function normalizedStagingEvent(
  event: JourneyTelemetryEventV1,
): JourneyTelemetryEventV1 | null {
  try {
    const normalized = createJourneyTelemetryEventV1({
      journey_id: event.journey_id,
      sequence: event.sequence,
      observed_at: event.observed_at,
      context: {
        environment: event.environment,
        workflow: event.workflow,
        release_sha: event.release_sha,
        build_number: event.build_number,
      },
      event: {
        stage: event.stage,
        event: event.event,
        outcome: event.outcome,
        failure_class: event.failure_class,
        retryable: event.retryable,
        attempt: event.attempt,
        elapsed_ms: event.elapsed_ms,
        queue_age_ms: event.queue_age_ms,
        retrieval: event.retrieval,
        llm_usage: event.llm_usage,
      },
    });
    return normalized.environment === "staging" ? normalized : null;
  } catch {
    return null;
  }
}

function record(
  timestamp: number,
  dimensions: Readonly<Record<string, string>>,
  values: readonly MetricValue[],
): StagingJourneyMetricRecordV1 {
  const dimensionNames = Object.keys(dimensions);
  const metricDefinitions = values.map(([Name, , Unit]) => Object.freeze({ Name, Unit }));
  const metricValues = Object.fromEntries(values.map(([name, value]) => [name, value]));
  const directive: StagingJourneyMetricRecordV1["_aws"]["CloudWatchMetrics"][number] = {
    Namespace: STAGING_JOURNEY_METRICS_NAMESPACE_V1,
    Dimensions: [Object.freeze(dimensionNames)],
    Metrics: Object.freeze(metricDefinitions),
  };
  const result: StagingJourneyMetricRecordV1 = {
    _aws: Object.freeze({
      Timestamp: timestamp,
      CloudWatchMetrics: Object.freeze([Object.freeze(directive)]) as StagingJourneyMetricRecordV1["_aws"]["CloudWatchMetrics"],
    }),
    ...dimensions,
    ...metricValues,
  };
  return Object.freeze(result);
}

/**
 * Projects one normalized staging journey event into independent EMF records.
 * Each record deliberately has only one dimension set, preventing accidental
 * CloudWatch metric cross-products. Correlation and deploy identifiers never
 * leave the source event through this formatter.
 */
export function formatJourneyTelemetryMetricsV1(
  input: JourneyTelemetryEventV1,
): readonly StagingJourneyMetricRecordV1[] {
  const event = normalizedStagingEvent(input);
  if (event === null) return Object.freeze([]);
  const timestamp = canonicalTimestamp(event.observed_at);
  if (timestamp === null) return Object.freeze([]);

  const workflowStage = { workflow: event.workflow, stage: event.stage };
  const records: StagingJourneyMetricRecordV1[] = [];

  if (event.event === "started") {
    const metrics: MetricValue[] = [["StageStarted", 1, "Count"]];
    if (event.attempt > 1) metrics.push(["StageRetryAttempt", 1, "Count"]);
    records.push(record(timestamp, workflowStage, metrics));
  }
  if (event.event === "succeeded") {
    records.push(record(timestamp, workflowStage, [
      ["StageSucceeded", 1, "Count"],
      ["StageClosedLatencyMs", event.elapsed_ms, "Milliseconds"],
    ]));
    if (event.outcome !== null) {
      records.push(record(timestamp, {
        ...workflowStage,
        outcome: event.outcome,
      }, [["TerminalOutcome", 1, "Count"]]));
    }
  }
  if (event.event === "failed") {
    records.push(record(timestamp, workflowStage, [
      ["StageFailed", 1, "Count"],
      ["StageClosedLatencyMs", event.elapsed_ms, "Milliseconds"],
    ]));
    records.push(record(timestamp, {
      ...workflowStage,
      failure_class: event.failure_class!,
    }, [["StageFailure", 1, "Count"]]));
    if (event.workflow === "ask" && event.stage === "ask_retrieval") {
      records.push(record(timestamp, {}, [["AskRetrievalFailure", 1, "Count"]]));
    }
  }
  if (event.event === "skipped") {
    records.push(record(timestamp, workflowStage, [["StageSkipped", 1, "Count"]]));
  }

  if (event.llm_usage !== null) {
    const usage = event.llm_usage;
    const metrics: MetricValue[] = [
      ["LlmAttempt", 1, "Count"],
      [
        usage.usage_status === "reported" ? "LlmUsageReported" : "LlmUsageUnavailable",
        1,
        "Count",
      ],
      ["LlmProviderLatencyMs", usage.provider_latency_ms, "Milliseconds"],
    ];
    const tokenMetrics: readonly [keyof Pick<
      typeof usage,
      "input_tokens" | "output_tokens" | "total_tokens" | "cached_input_tokens" | "reasoning_tokens"
    >, string][] = [
      ["input_tokens", "LlmInputTokens"],
      ["output_tokens", "LlmOutputTokens"],
      ["total_tokens", "LlmTotalTokens"],
      ["cached_input_tokens", "LlmCachedInputTokens"],
      ["reasoning_tokens", "LlmReasoningTokens"],
    ];
    for (const [key, name] of tokenMetrics) {
      const value = usage[key];
      if (value !== null) metrics.push([name, value, "Count"]);
    }
    if (usage.total_tokens !== null) {
      metrics.push(["LlmTotalTokensAvailable", 1, "Count"]);
    }
    records.push(record(timestamp, {
      stage: event.stage,
      provider: usage.provider,
      model: usage.model,
    }, metrics));
  }

  if (event.retrieval !== null) {
    const counters: readonly [keyof typeof event.retrieval, string][] = [
      ["planned_query_count", "RetrievalPlannedQueries"],
      ["query_hit_count", "RetrievalQueryHits"],
      ["released_atom_count", "RetrievalReleasedAtoms"],
      ["context_atom_count", "RetrievalContextAtoms"],
      ["citation_count", "RetrievalCitations"],
    ];
    const metrics: MetricValue[] = [];
    for (const [key, name] of counters) {
      const value = event.retrieval[key];
      if (value !== null) metrics.push([name, value, "Count"]);
    }
    if (metrics.length > 0) records.push(record(timestamp, workflowStage, metrics));
  }

  if (event.queue_age_ms !== null) {
    records.push(record(timestamp, workflowStage, [[
      "ApprovalHumanWaitMs",
      event.queue_age_ms,
      "Milliseconds",
    ]]));
  }

  return Object.freeze(records);
}

/** Emits one zero-dimension liveness point for staging transport startup or heartbeat. */
export function formatStagingJourneyLivenessMetricV1(
  observed_at: string,
): StagingJourneyMetricRecordV1 {
  const timestamp = requiredTimestamp(observed_at, "liveness observed_at");
  return record(timestamp, {}, [["JourneyTelemetryAlive", 1, "Count"]]);
}

/** Emits an explicit-zero, zero-dimension gauge after each durable backlog scan. */
export function formatApprovedSearchBacklogMetricsV1(
  snapshot: StagingApprovedSearchBacklogSnapshotV1,
): StagingJourneyMetricRecordV1 {
  const timestamp = requiredTimestamp(snapshot.observed_at, "backlog observed_at");
  if (!validNonnegativeInteger(snapshot.pending_count)) {
    throw new TypeError("backlog pending_count must be a nonnegative safe integer");
  }
  if (!validNonnegativeInteger(snapshot.stuck_count)) {
    throw new TypeError("backlog stuck_count must be a nonnegative safe integer");
  }
  if (snapshot.stuck_count > snapshot.pending_count) {
    throw new TypeError("backlog stuck_count cannot exceed pending_count");
  }
  if (snapshot.oldest_age_ms !== null && !validNonnegativeInteger(snapshot.oldest_age_ms)) {
    throw new TypeError("backlog oldest_age_ms must be null or a nonnegative safe integer");
  }
  if (snapshot.pending_count === 0 && snapshot.oldest_age_ms !== null) {
    throw new TypeError("backlog oldest_age_ms must be null with no pending work");
  }
  if (snapshot.pending_count > 0 && snapshot.oldest_age_ms === null) {
    throw new TypeError("backlog oldest_age_ms is required with pending work");
  }
  const metrics: MetricValue[] = [
    ["ApprovedSearchPendingCount", snapshot.pending_count, "Count"],
    ["ApprovedSearchStuckCount", snapshot.stuck_count, "Count"],
    ["ApprovedSearchBacklogCheck", 1, "Count"],
  ];
  if (snapshot.oldest_age_ms !== null) {
    metrics.push(["ApprovedSearchOldestAgeMs", snapshot.oldest_age_ms, "Milliseconds"]);
  }
  return record(timestamp, {}, metrics);
}
