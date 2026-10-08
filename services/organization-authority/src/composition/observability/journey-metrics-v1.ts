import { EMPTY_TELEMETRY_VOCABULARY_V1, type TelemetryVocabularyV1 } from "@echo-brain/organization-authority-kernel/shared/telemetry-vocabulary-v1";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "@echo-brain/organization-authority-kernel/shared/journey-telemetry-v1";

/** Historical staging namespace; production has its own metrics namespace. */
export const STAGING_JOURNEY_METRICS_NAMESPACE_V1 =
  "EchoBrain/StagingJourneyV1" as const;
export const AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1 = "EchoBrain/AuthorityJourneyV1" as const;
export type OperationalJourneyEnvironmentV1 = "staging" | "production";
type JourneyMetricsNamespaceV1 = typeof STAGING_JOURNEY_METRICS_NAMESPACE_V1 | typeof AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1;

function metricsNamespace(environment: OperationalJourneyEnvironmentV1): JourneyMetricsNamespaceV1 {
  if (environment === "staging") return STAGING_JOURNEY_METRICS_NAMESPACE_V1;
  if (environment === "production") return AUTHORITY_JOURNEY_METRICS_NAMESPACE_V1;
  throw new TypeError("Operational telemetry environment is invalid");
}

export interface JourneyEmfMetricDefinitionV1 {
  readonly Name: string;
  readonly Unit: "Count" | "Milliseconds";
}

export interface JourneyMetricRecordV1 {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly [{
      readonly Namespace: JourneyMetricsNamespaceV1;
      readonly Dimensions: readonly [readonly string[]];
      readonly Metrics: readonly JourneyEmfMetricDefinitionV1[];
    }];
  };
  readonly [key: string]: unknown;
}

export interface ApprovedSearchBacklogSnapshotV1 {
  readonly observed_at: string;
  /** Approved journeys awaiting a terminal search result at scan time. */
  readonly pending_count: number;
  /** Pending approved journeys older than the configured completion bound. */
  readonly stuck_count: number;
  /** Null only when no approved journey is awaiting search completion. */
  readonly oldest_age_ms: number | null;
}

export type ApprovedSearchBacklogObserverV1 = (
  snapshot: ApprovedSearchBacklogSnapshotV1,
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
function normalizedOperationalEvent(
  event: JourneyTelemetryEventV1,
  vocabulary: TelemetryVocabularyV1,
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
        ...(event.diagnostic === undefined ? {} : { diagnostic: event.diagnostic }),
        ...(event.accounting === undefined ? {} : { accounting: event.accounting }),
        elapsed_ms: event.elapsed_ms,
        queue_age_ms: event.queue_age_ms,
        retrieval: event.retrieval,
        llm_usage: event.llm_usage,
      },
    }, vocabulary);
    return normalized.environment === "staging" || normalized.environment === "production" ? normalized : null;
  } catch {
    return null;
  }
}

function record(
  namespace: JourneyMetricsNamespaceV1,
  timestamp: number,
  dimensions: Readonly<Record<string, string>>,
  values: readonly MetricValue[],
): JourneyMetricRecordV1 {
  const dimensionNames = Object.keys(dimensions);
  const metricDefinitions = values.map(([Name, , Unit]) => Object.freeze({ Name, Unit }));
  const metricValues = Object.fromEntries(values.map(([name, value]) => [name, value]));
  const directive: JourneyMetricRecordV1["_aws"]["CloudWatchMetrics"][number] = {
    Namespace: namespace,
    Dimensions: [Object.freeze(dimensionNames)],
    Metrics: Object.freeze(metricDefinitions),
  };
  const result: JourneyMetricRecordV1 = {
    _aws: Object.freeze({
      Timestamp: timestamp,
      CloudWatchMetrics: Object.freeze([Object.freeze(directive)]) as JourneyMetricRecordV1["_aws"]["CloudWatchMetrics"],
    }),
    ...dimensions,
    ...metricValues,
  };
  return Object.freeze(result);
}

/**
 * Projects one normalized operational journey event into independent EMF records.
 * Each record deliberately has only one dimension set, preventing accidental
 * CloudWatch metric cross-products. Correlation and deploy identifiers never
 * leave the source event through this formatter.
 */
export function formatJourneyTelemetryMetricsV1(
  input: JourneyTelemetryEventV1,
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): readonly JourneyMetricRecordV1[] {
  const event = normalizedOperationalEvent(input, vocabulary);
  if (event === null) return Object.freeze([]);
  // Connector exchanges are diagnostic children of the ingress request. Keep
  // them in journey logs without multiplying the existing ingress metrics.
  if (event.workflow === "core_runtime" && event.diagnostic?.phase === "http_request" && !event.diagnostic.root) {
    return Object.freeze([]);
  }
  const namespace = metricsNamespace(event.environment as OperationalJourneyEnvironmentV1);
  const timestamp = canonicalTimestamp(event.observed_at);
  if (timestamp === null) return Object.freeze([]);

  const workflowStage = { workflow: event.workflow, stage: (event.workflow === "core_runtime" ? event.diagnostic?.phase : undefined) ?? event.stage };
  const records: JourneyMetricRecordV1[] = [];

  if (event.diagnostic?.phase === "model_call" && event.event !== "started") {
    const counts = event.diagnostic.counts;
    const values: MetricValue[] = [["CoreModelAttempt", 1, "Count"]];
    if (counts.total_tokens != null) values.push(["CoreModelTotalTokens", counts.total_tokens, "Count"], ["CoreModelUsageReported", 1, "Count"]);
    records.push(record(namespace, timestamp, { workflow: "core_runtime", stage: event.diagnostic.purpose }, values));
  }
  if (event.event === "started") {
    const metrics: MetricValue[] = [["StageStarted", 1, "Count"]];
    if (event.accounting?.kind === "execution" && event.accounting.retry_of_attempt != null) metrics.push(["StageRetryAttempt", 1, "Count"]);
    records.push(record(namespace, timestamp, workflowStage, metrics));
  }
  if (event.event === "succeeded") {
    records.push(record(namespace, timestamp, workflowStage, [
      ["StageSucceeded", 1, "Count"],
      ...(["shared_reference", "recovery"].includes(event.accounting?.kind ?? "") ? [] : [["StageClosedLatencyMs", event.elapsed_ms, "Milliseconds"] as MetricValue]),
    ]));
    // Canonical research spans carry their outcome in normalized core metadata;
    // historical Ask rows retain their original top-level outcome contract.
    const outcome = event.outcome ?? (event.diagnostic?.phase === "research_run" &&
      ["answered", "partial", "not_found", "off_scope", "completed"].includes(event.diagnostic.result ?? "")
      ? event.diagnostic.result : null);
    if (outcome !== null) {
      records.push(record(namespace, timestamp, {
        ...workflowStage,
        outcome,
      }, [["TerminalOutcome", 1, "Count"]]));
    }
  }
  if (event.event === "failed") {
    records.push(record(namespace, timestamp, workflowStage, [
      ["StageFailed", 1, "Count"],
      ...(["shared_reference", "recovery"].includes(event.accounting?.kind ?? "") ? [] : [["StageClosedLatencyMs", event.elapsed_ms, "Milliseconds"] as MetricValue]),
    ]));
    records.push(record(namespace, timestamp, {
      ...workflowStage,
      failure_class: event.failure_class!,
    }, [["StageFailure", 1, "Count"]]));
    if ((event.workflow === "ask" && event.stage === "ask_retrieval") || event.diagnostic?.phase === "research_loop") {
      records.push(record(namespace, timestamp, {}, [["AskRetrievalFailure", 1, "Count"]]));
    }
  }
  if (event.event === "skipped") {
    records.push(record(namespace, timestamp, workflowStage, [["StageSkipped", 1, "Count"]]));
  }

  const modelCall = event.diagnostic?.phase === "model_call" && event.event !== "started" ? event.diagnostic : null;
  const usage = modelCall === null ? event.llm_usage : {
    provider: modelCall.provider ?? "other",
    model: modelCall.model ?? "other",
    usage_status: ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens"].some(key => modelCall.counts[key as keyof typeof modelCall.counts] != null) ? "reported" : "unavailable",
    provider_latency_ms: modelCall.counts.provider_latency_ms ?? null,
    input_tokens: modelCall.counts.input_tokens ?? null,
    output_tokens: modelCall.counts.output_tokens ?? null,
    total_tokens: modelCall.counts.total_tokens ?? null,
    cached_input_tokens: modelCall.counts.cached_input_tokens ?? null,
    reasoning_tokens: modelCall.counts.reasoning_tokens ?? null,
  };
  if (usage !== null && event.accounting?.kind !== "recovery") {
    const metrics: MetricValue[] = [
      ["LlmAttempt", 1, "Count"],
      [
        usage.usage_status === "reported" ? "LlmUsageReported" : "LlmUsageUnavailable",
        1,
        "Count",
      ],
    ];
    if (usage.provider_latency_ms !== null) metrics.push(["LlmProviderLatencyMs", usage.provider_latency_ms, "Milliseconds"]);
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
    records.push(record(namespace, timestamp, {
      stage: modelCall?.purpose ?? event.stage,
      provider: usage.provider,
      model: usage.model,
    }, metrics));
  }

  const researchRun = event.diagnostic?.phase === "research_run" && event.event !== "started" ? event.diagnostic : null;
  const retrieval = researchRun?.counts ?? event.retrieval;
  if (retrieval !== null) {
    type NumericRetrievalCounter =
      | "planned_query_count"
      | "query_hit_count"
      | "released_atom_count"
      | "context_atom_count"
      | "citation_count";
    const counters: readonly [NumericRetrievalCounter, string][] = [
      ["planned_query_count", "RetrievalPlannedQueries"],
      ["query_hit_count", "RetrievalQueryHits"],
      ["released_atom_count", "RetrievalReleasedAtoms"],
      ["context_atom_count", "RetrievalContextAtoms"],
      ["citation_count", "RetrievalCitations"],
    ];
    const metrics: MetricValue[] = [];
    for (const [key, name] of counters) {
      const value = retrieval[key];
      if (value != null) metrics.push([name, value, "Count"]);
    }
    if (metrics.length > 0) records.push(record(namespace, timestamp, workflowStage, metrics));
  }

  if (event.queue_age_ms !== null) {
    records.push(record(namespace, timestamp, workflowStage, [[
      "ApprovalHumanWaitMs",
      event.queue_age_ms,
      "Milliseconds",
    ]]));
  }

  return Object.freeze(records);
}

/** Emits one zero-dimension liveness point for transport startup or heartbeat. */
export function formatJourneyLivenessMetricV1(
  observed_at: string,
  environment: OperationalJourneyEnvironmentV1,
): JourneyMetricRecordV1 {
  const namespace = metricsNamespace(environment);
  const timestamp = requiredTimestamp(observed_at, "liveness observed_at");
  return record(namespace, timestamp, {}, [["JourneyTelemetryAlive", 1, "Count"]]);
}

/** Emits an explicit-zero, zero-dimension gauge after each durable backlog scan. */
export function formatApprovedSearchBacklogMetricsV1(
  snapshot: ApprovedSearchBacklogSnapshotV1,
  environment: OperationalJourneyEnvironmentV1,
): JourneyMetricRecordV1 {
  const namespace = metricsNamespace(environment);
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
  return record(namespace, timestamp, {}, metrics);
}
