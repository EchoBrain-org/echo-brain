import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryObserverV1,
} from "../../../shared/journey-telemetry-v1.js";
import {
  formatStagingJourneyContentRecordV1,
  type StagingJourneyContentRecordInputV1,
} from "./staging-journey-content-telemetry-v1.js";
import {
  formatApprovedSearchBacklogMetricsV1,
  formatJourneyTelemetryMetricsV1,
  formatStagingJourneyLivenessMetricV1,
  type StagingApprovedSearchBacklogObserverV1,
} from "./staging-journey-metrics-v1.js";

export const STAGING_JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1 = 1 as const;
export const STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1 =
  "echo-authority-journey-telemetry-liveness-v1" as const;
export const STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1 = 60_000;
export const STAGING_APPROVED_SEARCH_BACKLOG_SCHEMA_VERSION_V1 = 1 as const;
export const STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1 =
  "echo-authority-approved-search-backlog-v1" as const;

export interface StagingJourneyTelemetryIdentityV1 {
  readonly release_sha: string;
  readonly build_number: number;
}

export interface StagingJourneyTelemetryLivenessEventV1 {
  readonly schema_version: typeof STAGING_JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1;
  readonly kind: typeof STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1;
  readonly observed_at: string;
  readonly environment: "staging";
  readonly release_sha: string;
  readonly build_number: number;
  readonly event: "startup" | "heartbeat";
}

export interface StagingApprovedSearchBacklogEventV1 {
  readonly schema_version: typeof STAGING_APPROVED_SEARCH_BACKLOG_SCHEMA_VERSION_V1;
  readonly kind: typeof STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1;
  readonly observed_at: string;
  readonly environment: "staging";
  readonly pending_count: number;
  readonly stuck_count: number;
  readonly oldest_age_ms: number | null;
}

export type StagingJourneyTelemetryWriterV1 = (line: string) => void | Promise<void>;

export interface StagingJourneyTelemetrySchedulerV1 {
  set_interval(callback: () => void, interval_ms: number): unknown;
  clear_interval(id: unknown): void;
}

export interface StagingJourneyTelemetryTransportDependenciesV1 {
  readonly write: StagingJourneyTelemetryWriterV1;
  readonly now?: () => string;
  readonly scheduler?: StagingJourneyTelemetrySchedulerV1;
}

export interface StagingJourneyTelemetryTransportOptionsV1 {
  /** Staging debugging switch: also write prompts, released text, and raw model output. */
  readonly content_enabled?: boolean;
}

export type StagingJourneyContentObserverV1 = (
  record: StagingJourneyContentRecordInputV1,
) => void;

export interface StagingJourneyTelemetryTransportV1 {
  /** False only when the deploy identity is unsafe to emit. */
  readonly enabled: boolean;
  /** Immutable deploy identity for future staging journey emitters. */
  readonly identity: StagingJourneyTelemetryIdentityV1 | null;
  /**
   * Begins liveness delivery after the Authority runtime opens.
   * It is safe to call more than once and is inert after close.
   */
  start(): void;
  /** Safe to pass directly to createJourneyTelemetryV1, including while liveness is inert. */
  readonly observer: JourneyTelemetryObserverV1;
  /** Safe to pass to the staging approval sidecar recorder. */
  readonly approved_search_backlog_observer: StagingApprovedSearchBacklogObserverV1;
  /** True only when the staging content switch is on for a valid identity. */
  readonly content_enabled: boolean;
  /** Writes bounded content records; inert unless content_enabled. */
  readonly content_observer: StagingJourneyContentObserverV1;
  /** Stops liveness emission. Safe to call more than once. */
  close(): void;
}

const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/;

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isValidIdentity(
  identity: StagingJourneyTelemetryIdentityV1,
): identity is StagingJourneyTelemetryIdentityV1 {
  return (
    typeof identity?.release_sha === "string" &&
    GIT_COMMIT_SHA.test(identity.release_sha) &&
    typeof identity.build_number === "number" &&
    Number.isSafeInteger(identity.build_number) &&
    identity.build_number > 0
  );
}

function defaultScheduler(): StagingJourneyTelemetrySchedulerV1 {
  return {
    set_interval: (callback, intervalMs) => {
      const interval = setInterval(callback, intervalMs);
      interval.unref();
      return interval;
    },
    clear_interval: (id) => clearInterval(id as NodeJS.Timeout),
  };
}

function disabledTransport(): StagingJourneyTelemetryTransportV1 {
  return Object.freeze({
    enabled: false,
    identity: null,
    start: () => undefined,
    observer: () => undefined,
    approved_search_backlog_observer: () => undefined,
    content_enabled: false,
    content_observer: () => undefined,
    close: () => undefined,
  });
}

/**
 * Opens a local JSON-lines transport for staging telemetry. The transport is
 * deliberately fail-open: clocks, writers, schedulers, and observers cannot
 * affect Authority startup or request processing.
 */
export function createStagingJourneyTelemetryTransportV1(
  identity: StagingJourneyTelemetryIdentityV1,
  dependencies: StagingJourneyTelemetryTransportDependenciesV1,
  options: StagingJourneyTelemetryTransportOptionsV1 = {},
): StagingJourneyTelemetryTransportV1 {
  if (!isValidIdentity(identity)) return disabledTransport();
  const immutableIdentity = Object.freeze({ ...identity });
  const contentEnabled = options.content_enabled === true;

  const now = dependencies.now ?? (() => new Date().toISOString());
  const scheduler = dependencies.scheduler ?? defaultScheduler();
  let closed = false;
  let started = false;
  let intervalId: unknown | undefined;
  let intervalScheduled = false;

  function write(value: unknown): void {
    try {
      void Promise.resolve(dependencies.write(`${canonicalJson(value)}\n`)).catch(
        () => undefined,
      );
    } catch {
      // Telemetry is strictly outside service control flow.
    }
  }

  function emitLiveness(event: StagingJourneyTelemetryLivenessEventV1["event"]): void {
    if (closed) return;
    try {
      const observedAt = now();
      if (!isCanonicalUtcTimestamp(observedAt)) return;
      const liveness = {
        schema_version: STAGING_JOURNEY_TELEMETRY_LIVENESS_SCHEMA_VERSION_V1,
        kind: STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
        observed_at: observedAt,
        environment: "staging",
        release_sha: immutableIdentity.release_sha,
        build_number: immutableIdentity.build_number,
        event,
      } satisfies StagingJourneyTelemetryLivenessEventV1;
      write(liveness);
      write(formatStagingJourneyLivenessMetricV1(observedAt));
    } catch {
      // A faulty clock is not allowed to change the service's behavior.
    }
  }

  const observer: JourneyTelemetryObserverV1 = (event) => {
    if (closed) return;
    try {
      if (
        event.environment !== "staging" ||
        event.release_sha !== immutableIdentity.release_sha ||
        event.build_number !== immutableIdentity.build_number
      ) {
        return;
      }
      // Reconstruct the contract before serialization to drop injected fields.
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
      write(normalized);
      for (const metric of formatJourneyTelemetryMetricsV1(normalized)) {
        write(metric);
      }
    } catch {
      // An invalid observer input is omitted rather than surfacing to callers.
    }
  };

  const contentObserver: StagingJourneyContentObserverV1 = (record) => {
    if (!contentEnabled || closed) return;
    try {
      if (
        record.release_sha !== immutableIdentity.release_sha ||
        record.build_number !== immutableIdentity.build_number
      ) {
        return;
      }
      const formatted = formatStagingJourneyContentRecordV1(record);
      if (formatted === null) return;
      write(formatted);
    } catch {
      // Content telemetry is strictly outside answer control flow.
    }
  };

  const approvedSearchBacklogObserver: StagingApprovedSearchBacklogObserverV1 =
    (snapshot) => {
      if (closed) return;
      try {
        // Format first so the strict content-free snapshot contract is checked
        // before either the diagnostic event or its metric projection is written.
        const metric = formatApprovedSearchBacklogMetricsV1(snapshot);
        write({
          schema_version: STAGING_APPROVED_SEARCH_BACKLOG_SCHEMA_VERSION_V1,
          kind: STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1,
          observed_at: snapshot.observed_at,
          environment: "staging",
          pending_count: snapshot.pending_count,
          stuck_count: snapshot.stuck_count,
          oldest_age_ms: snapshot.oldest_age_ms,
        } satisfies StagingApprovedSearchBacklogEventV1);
        write(metric);
      } catch {
        // Invalid backlog health must remain outside approval control flow.
      }
    };
  return Object.freeze({
    enabled: true,
    identity: immutableIdentity,
    start(): void {
      if (closed || started) return;
      started = true;
      emitLiveness("startup");
      try {
        intervalId = scheduler.set_interval(
          () => emitLiveness("heartbeat"),
          STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
        );
        intervalScheduled = true;
      } catch {
        // Liveness is useful, but failure to schedule it is never fatal.
      }
    },
    observer,
    approved_search_backlog_observer: approvedSearchBacklogObserver,
    content_enabled: contentEnabled,
    content_observer: contentObserver,
    close(): void {
      if (closed) return;
      closed = true;
      if (!intervalScheduled) return;
      try {
        scheduler.clear_interval(intervalId);
      } catch {
        // Closing observability must also be fail-open.
      }
    },
  });
}

/** Reads deploy identity baked into the image and left unoverridden by Compose. */
export function createStagingJourneyTelemetryTransportFromEnvironmentV1(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: StagingJourneyTelemetryTransportDependenciesV1,
): StagingJourneyTelemetryTransportV1 {
  if (environment.ECHO_STAGING_JOURNEY_TELEMETRY_V1 !== "true") {
    return disabledTransport();
  }
  const buildNumber = environment.ECHO_BUILD_NUMBER;
  if (buildNumber === undefined || !/^[1-9][0-9]*$/.test(buildNumber)) {
    return disabledTransport();
  }
  const parsedBuildNumber = Number(buildNumber);
  if (!Number.isSafeInteger(parsedBuildNumber)) return disabledTransport();
  return createStagingJourneyTelemetryTransportV1(
    {
      release_sha: environment.ECHO_SOURCE_SHA ?? "",
      build_number: parsedBuildNumber,
    },
    dependencies,
    {
      content_enabled:
        environment.ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1 === "true",
    },
  );
}
