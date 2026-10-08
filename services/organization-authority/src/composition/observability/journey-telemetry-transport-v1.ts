import { createTelemetryVocabularyV1, EMPTY_TELEMETRY_VOCABULARY_V1, type TelemetryVocabularyV1 } from "@echo-brain/organization-authority-kernel/shared/telemetry-vocabulary-v1";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { CoreRuntimeDetailV1, CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  createJourneyTelemetryV1,
  recanonicalizeJourneyTelemetryEventV1,
  type JourneyTelemetryObserverV1,
  type JourneyFailureClassV1,
} from "@echo-brain/organization-authority-kernel/shared/journey-telemetry-v1";
import {
  formatStagingJourneyContentRecordsV2,
  type StagingJourneyContentRecordInputV2 as JourneyContentRecordInputV2,
} from "../staging/observability/staging-journey-content-telemetry-v1.js";
import {
  formatJourneyTelemetryMetricsV1,
  formatJourneyLivenessMetricV1,
  type OperationalJourneyEnvironmentV1,
} from "./journey-metrics-v1.js";
import { isCanonicalUtcTimestampV1 } from "../../application/canonical-utc-timestamp-v1.js";

export const JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1 = 1 as const;
export const JOURNEY_TELEMETRY_LIVENESS_KIND_V1 =
  "echo-authority-journey-telemetry-liveness-v1" as const;
export const JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1 = 60_000;

export interface JourneyTelemetryIdentityV1 {
  readonly release_sha: string;
  readonly build_number: number;
}

/** Exhaustive local rejection origins. No caller-controlled keys or error values. */
export interface TelemetryRejectionCountsV1 {
  readonly journey_observer: { readonly invalid_journey_event: number };
  readonly content_capture: {
    readonly invalid_content_record: number;
    readonly content_format_error: number;
  };
  /** Historical Explorer health shape; this obsolete producer never reports failures. */
  readonly meeting_approval_observer: { readonly observation_callback_failure: number };
}

export interface JourneyTelemetryLivenessEventV1 {
  readonly schema_version: typeof JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1;
  readonly kind: typeof JOURNEY_TELEMETRY_LIVENESS_KIND_V1;
  readonly observed_at: string;
  readonly environment: OperationalJourneyEnvironmentV1;
  readonly release_sha: string;
  readonly build_number: number;
  readonly event: "startup" | "heartbeat";
  readonly delivery?: Readonly<Record<string, number>>;
  /** Process-cumulative local accounting, separate from writes and downstream ingestion. */
  readonly rejection_counts?: TelemetryRejectionCountsV1;
}

export type JourneyTelemetryWriterV1 = (line: string) => void | Promise<void>;

export interface JourneyTelemetrySchedulerV1 {
  set_interval(callback: () => void, interval_ms: number): unknown;
  clear_interval(id: unknown): void;
}

export interface JourneyTelemetryTransportDependenciesV1 {
  readonly write: JourneyTelemetryWriterV1;
  readonly now?: () => string;
  readonly scheduler?: JourneyTelemetrySchedulerV1;
}

export interface JourneyTelemetryTransportOptionsV1 {
  readonly vocabulary?: TelemetryVocabularyV1;
  /** Staging debugging switch: also write prompts, released text, and raw model output. */
  readonly content_enabled?: boolean;
}

export type JourneyContentObserverV1 = (
  record: JourneyContentRecordInputV2,
) => void;

export interface JourneyTelemetryTransportV1 {
  readonly environment: OperationalJourneyEnvironmentV1 | null;
  /** False only when the deploy identity is unsafe to emit. */
  readonly enabled: boolean;
  readonly core_runtime: CoreRuntimeObservationScopeV1;
  /** Immutable deploy identity shared by the operational journey emitters. */
  readonly identity: JourneyTelemetryIdentityV1 | null;
  /**
   * Begins liveness delivery after the Authority runtime opens.
   * It is safe to call more than once and is inert after close.
   */
  start(): void;
  /** Safe to pass directly to createJourneyTelemetryV1, including while liveness is inert. */
  readonly observer: JourneyTelemetryObserverV1;
  /** True only when the staging content switch is on for a valid identity. */
  readonly content_enabled: boolean;
  /** Writes bounded content records; inert unless content_enabled. */
  readonly content_observer: JourneyContentObserverV1;
  /** Stops liveness emission. Safe to call more than once. */
  close(): void;
}

const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Project finite core results without ever inspecting error text or payloads. */
function coreFailure(result: CoreRuntimeDetailV1["result"]): { failure_class: JourneyFailureClassV1; retryable: boolean } {
  switch (result) {
    case "authorization": return { failure_class: "authorization", retryable: false };
    case "invalid_request": return { failure_class: "invalid_request", retryable: false };
    case "timeout": return { failure_class: "timeout", retryable: true };
    case "rate_limited": return { failure_class: "rate_limited", retryable: true };
    case "unavailable": return { failure_class: "unavailable", retryable: true };
    case "invalid_output": case "parse_failure": case "schema_failure": case "grounding_failure": return { failure_class: "invalid_contract", retryable: false };
    case "provider_failure": return { failure_class: "provider_rejected", retryable: false };
    case "cancelled": return { failure_class: "cancelled", retryable: false };
    default: return { failure_class: "unknown", retryable: false };
  }
}

function isValidIdentity(
  identity: JourneyTelemetryIdentityV1,
): identity is JourneyTelemetryIdentityV1 {
  return (
    typeof identity?.release_sha === "string" &&
    GIT_COMMIT_SHA.test(identity.release_sha) &&
    typeof identity.build_number === "number" &&
    Number.isSafeInteger(identity.build_number) &&
    identity.build_number > 0
  );
}

function defaultScheduler(): JourneyTelemetrySchedulerV1 {
  return {
    set_interval: (callback, intervalMs) => {
      const interval = setInterval(callback, intervalMs);
      interval.unref();
      return interval;
    },
    clear_interval: (id) => clearInterval(id as NodeJS.Timeout),
  };
}

function disabledTransport(): JourneyTelemetryTransportV1 {
  return Object.freeze({
    environment: null,
    enabled: false,
    core_runtime: {},
    identity: null,
    start: () => undefined,
    observer: () => undefined,
    content_enabled: false,
    content_observer: () => undefined,
    close: () => undefined,
  });
}

/**
 * Opens a local JSON-lines transport for operational telemetry. The transport is
 * deliberately fail-open: clocks, writers, schedulers, and observers cannot
 * affect Authority startup or request processing.
 */
export function createJourneyTelemetryTransportV1(
  deploymentEnvironment: OperationalJourneyEnvironmentV1,
  identity: JourneyTelemetryIdentityV1,
  dependencies: JourneyTelemetryTransportDependenciesV1,
  options: JourneyTelemetryTransportOptionsV1 = {},
): JourneyTelemetryTransportV1 {
  if (!["staging", "production"].includes(deploymentEnvironment) || !isValidIdentity(identity)) return disabledTransport();
  const immutableIdentity = Object.freeze({ release_sha: identity.release_sha, build_number: identity.build_number });
  const vocabulary = createTelemetryVocabularyV1(options.vocabulary ?? EMPTY_TELEMETRY_VOCABULARY_V1);
  // Historical staging content capture is never enabled in production.
  const contentEnabled = deploymentEnvironment === "staging" && options.content_enabled === true;

  const now = dependencies.now ?? (() => new Date().toISOString());
  const scheduler = dependencies.scheduler ?? defaultScheduler();
  let closed = false;
  let started = false;
  let intervalId: unknown | undefined;
  let intervalScheduled = false;
  const delivery = { writes_attempted: 0, writes_failed: 0, writes_pending: 0, writes_dropped: 0, rejected_events: 0, attempted_bytes: 0, observer_overhead_us: 0, partial_captures: 0 };
  const rejectionCounts = {
    journey_observer: { invalid_journey_event: 0 },
    content_capture: { invalid_content_record: 0, content_format_error: 0 },
    meeting_approval_observer: { observation_callback_failure: 0 },
  } satisfies TelemetryRejectionCountsV1;

  function reject<E extends keyof TelemetryRejectionCountsV1>(
    emitter: E,
    reason: keyof TelemetryRejectionCountsV1[E],
  ): void {
    // Only source-owned literal pairs reach this helper. No formatting, callbacks,
    // or writes here: reporting a rejection cannot recursively reject telemetry.
    const counters = rejectionCounts[emitter] as Record<typeof reason, number>;
    counters[reason] += 1;
    delivery.rejected_events += 1;
  }

  let eventLoop: ReturnType<typeof monitorEventLoopDelay> | undefined;


  function write(value: unknown): void {
    const began = performance.now();
    try {
      if (delivery.writes_pending >= 1000) { delivery.writes_dropped += 1; return; }
      const line = `${canonicalJson(value)}\n`;
      delivery.writes_attempted += 1;
      delivery.attempted_bytes += Buffer.byteLength(line);
      delivery.writes_pending += 1;
      let result: void | Promise<void>;
      try { result = dependencies.write(line); }
      catch { delivery.writes_pending -= 1; delivery.writes_failed += 1; return; }
      if (result === undefined) delivery.writes_pending -= 1;
      else void Promise.resolve(result).catch(() => { delivery.writes_failed += 1; }).finally(() => { delivery.writes_pending -= 1; });
    } catch { delivery.writes_failed += 1; }
    finally { delivery.observer_overhead_us += Math.max(0, Math.floor((performance.now() - began) * 1000)); }
  }

  function emitLiveness(event: JourneyTelemetryLivenessEventV1["event"]): void {
    if (closed) return;
    try {
      const observedAt = now();
      if (!isCanonicalUtcTimestampV1(observedAt)) return;
      const liveness = {
        schema_version: JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1,
        kind: JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
        observed_at: observedAt,
        environment: deploymentEnvironment,
        release_sha: immutableIdentity.release_sha,
        build_number: immutableIdentity.build_number,
        event,
        delivery: { ...delivery },
        rejection_counts: {
          journey_observer: { ...rejectionCounts.journey_observer },
          content_capture: { ...rejectionCounts.content_capture },
          meeting_approval_observer: { ...rejectionCounts.meeting_approval_observer },
        },
      } satisfies JourneyTelemetryLivenessEventV1;
      write(liveness);
      write(formatJourneyLivenessMetricV1(observedAt, deploymentEnvironment));
    } catch {
      // A faulty clock is not allowed to change the service's behavior.
    }
  }

  const observer: JourneyTelemetryObserverV1 = (event) => {
    if (closed) return;
    try {
      if (
        event.environment !== deploymentEnvironment ||
        event.release_sha !== immutableIdentity.release_sha ||
        event.build_number !== immutableIdentity.build_number
      ) {
        return;
      }
      // Reconstruct the contract before serialization to drop injected fields.
      const normalized = recanonicalizeJourneyTelemetryEventV1(event, vocabulary);
      write(normalized);
      for (const metric of formatJourneyTelemetryMetricsV1(normalized, vocabulary)) {
        write(metric);
      }
    } catch {
      reject("journey_observer", "invalid_journey_event");
      // An invalid observer input is omitted rather than surfacing to callers.
    }
  };

  const contentObserver: JourneyContentObserverV1 = (record) => {
    if (!contentEnabled || closed) return;
    try {
      if (
        record.release_sha !== immutableIdentity.release_sha ||
        record.build_number !== immutableIdentity.build_number
      ) {
        return;
      }
      const records = formatStagingJourneyContentRecordsV2(record);
      if (records.length === 0) reject("content_capture", "invalid_content_record");
      if (records[0]?.truncated === true) delivery.partial_captures += 1;
      for (const formatted of records) write(formatted);
    } catch {
      reject("content_capture", "content_format_error");
      // Content telemetry is strictly outside answer control flow.
    }
  };

  const coreJourneys = new Map<string, { journey: NonNullable<ReturnType<ReturnType<typeof createJourneyTelemetryV1>["resumeJourney"]>>; content_sequence: number }>();
  const coreEmitter = createJourneyTelemetryV1(observer, {}, vocabulary);
  const coreRuntime: CoreRuntimeObservationScopeV1 = {
    vocabulary,
    observer(event) {
      if (closed) return;
      let entry = coreJourneys.get(event.operation_id);
      if (!entry) {
        if (coreJourneys.size >= 1000) { delivery.writes_dropped += 1; return; }
        const journey = coreEmitter.resumeJourney({ environment: deploymentEnvironment, workflow: "core_runtime", ...immutableIdentity, journey_id: event.operation_id, previous_sequence: 0 });
        if (!journey) return;
        entry = { journey, content_sequence: 0 };
        coreJourneys.set(event.operation_id, entry);
      }
      entry.journey.emit({ stage: "core_operation", event: event.event, elapsed_ms: event.elapsed_ms, diagnostic: { ...event,
          event_loop_delay: eventLoop && Number.isFinite(eventLoop.mean) ? "process_sample" : "unavailable",
          counts: { ...event.counts, event_loop_delay_max_us: eventLoop && Number.isFinite(eventLoop.mean) ? Math.max(0, Math.floor(eventLoop.max / 1000)) : null } },
        ...(event.event === "failed" ? coreFailure(event.result) : {}) });
      if (event.root && event.event !== "started") coreJourneys.delete(event.operation_id);
    },
    ...(contentEnabled ? { content_observer(event) {
      const entry = coreJourneys.get(event.operation_id);
      if (!entry) return;
      contentObserver({ journey_id: event.operation_id, sequence: ++entry.content_sequence, observed_at: now(), ...immutableIdentity,
        stage: "core_operation", content_kind: event.content_kind, span_id: event.span_id, content: event.content });
    } } satisfies CoreRuntimeObservationScopeV1 : {}),
  };
  return Object.freeze({
    environment: deploymentEnvironment,
    enabled: true,
    core_runtime: coreRuntime,
    identity: immutableIdentity,
    start(): void {
      if (closed || started) return;
      started = true;
      try { eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable(); } catch { /* optional resource measurement */ }
      emitLiveness("startup");
      try {
        intervalId = scheduler.set_interval(
          () => emitLiveness("heartbeat"),
          JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
        );
        intervalScheduled = true;
      } catch {
        // Liveness is useful, but failure to schedule it is never fatal.
      }
    },
    observer,
    content_enabled: contentEnabled,
    content_observer: contentObserver,
    close(): void {
      if (closed) return;
      closed = true;
      try { eventLoop?.disable(); } catch { /* observation only */ }
      coreJourneys.clear();
      if (!intervalScheduled) return;
      try {
        scheduler.clear_interval(intervalId);
      } catch {
        // Closing observability must also be fail-open.
      }
    },
  });
}

/**
 * Reads validated deploy identity baked into the image. The historical staging
 * capability name remains the release verifier's image binding for both
 * environments; its separate content switch is ignored in production.
 */
export function createJourneyTelemetryTransportFromEnvironmentV1(
  deploymentEnvironment: OperationalJourneyEnvironmentV1,
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: JourneyTelemetryTransportDependenciesV1,
  vocabulary: TelemetryVocabularyV1 = EMPTY_TELEMETRY_VOCABULARY_V1,
): JourneyTelemetryTransportV1 {
  if (environment.ECHO_STAGING_JOURNEY_TELEMETRY_V1 !== "true") {
    return disabledTransport();
  }
  const buildNumber = environment.ECHO_BUILD_NUMBER;
  if (buildNumber === undefined || !/^[1-9][0-9]*$/.test(buildNumber)) {
    return disabledTransport();
  }
  const parsedBuildNumber = Number(buildNumber);
  if (!Number.isSafeInteger(parsedBuildNumber)) return disabledTransport();
  return createJourneyTelemetryTransportV1(
    deploymentEnvironment,
    {
      release_sha: environment.ECHO_SOURCE_SHA ?? "",
      build_number: parsedBuildNumber,
    },
    dependencies,
    {
      vocabulary,
      content_enabled:
        environment.ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1 === "true",
    },
  );
}
