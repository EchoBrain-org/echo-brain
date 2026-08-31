import { AdapterError } from "../core/contracts/adapter.js";

export const MEETING_PROCESSING_WORKER_PHASES_V1 = [
  "recovery",
  "source_intake",
  "extraction",
  "approval_staging",
  "approval_observation",
  "record_append",
  "search_reconciliation",
] as const;

export type MeetingProcessingWorkerPhaseV1 =
  (typeof MEETING_PROCESSING_WORKER_PHASES_V1)[number];

export type MeetingProcessingWorkerFailureClassV1 =
  | "authorization"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_contract"
  | "unknown"
  | "cancelled";

export type MeetingProcessingWorkerTelemetryEventV1 =
  | {
      readonly schema_version: 1;
      readonly kind: "echo-clean-live-worker-phase-v1";
      readonly event: "started" | "succeeded";
      readonly cycle_phase: MeetingProcessingWorkerPhaseV1;
      readonly elapsed_ms: number;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "echo-clean-live-worker-phase-v1";
      readonly event: "failed";
      readonly cycle_phase: MeetingProcessingWorkerPhaseV1;
      readonly elapsed_ms: number;
      readonly failure_class: MeetingProcessingWorkerFailureClassV1;
      readonly retryable: boolean;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "echo-clean-live-worker-cycle-v1";
      readonly event: "started" | "succeeded";
      readonly elapsed_ms: number;
    }
  | {
      readonly schema_version: 1;
      readonly kind: "echo-clean-live-worker-cycle-v1";
      readonly event: "failed";
      readonly elapsed_ms: number;
      readonly failure_class: MeetingProcessingWorkerFailureClassV1;
      readonly retryable: boolean;
    };

export interface MeetingProcessingWorkerPhaseRunnerV1 {
  runPhase<T>(
    phase: MeetingProcessingWorkerPhaseV1,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    retryableOnFailure?: boolean,
  ): Promise<T>;
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, Math.floor(now() - startedAt));
}

function classifyFailure(error: unknown, cancelled = false): {
  readonly failure_class: MeetingProcessingWorkerFailureClassV1;
  readonly retryable: boolean;
} {
  // Never inspect or serialize message, stack, cause, or arbitrary properties.
  // AdapterError is the core typed failure contract. Everything else remains
  // unknown rather than deriving an operational claim from opaque text.
  if (cancelled) return { failure_class: "cancelled", retryable: false };
  if (error instanceof AdapterError) {
    const failure_class = {
      invalid_config: "invalid_contract",
      unauthorized: "authorization",
      rate_limited: "rate_limited",
      temporarily_unavailable: "unavailable",
      permanently_rejected: "invalid_contract",
      timeout: "timeout",
      unknown_outcome: "unknown",
    } as const satisfies Record<
      typeof error.code,
      Exclude<MeetingProcessingWorkerFailureClassV1, "cancelled">
    >;
    // The serialized worker always starts a later cycle after every
    // non-aborted failure, regardless of an adapter's local retry hint.
    return { failure_class: failure_class[error.code], retryable: true };
  }
  return { failure_class: "unknown", retryable: true };
}

/**
 * In-process, content-free worker lifecycle reporter. It deliberately keeps
 * no durable state: operational detail must not widen the meeting custody
 * boundary.
 */
export class MeetingProcessingWorkerLifecycleV1
  implements MeetingProcessingWorkerPhaseRunnerV1
{
  private cycleStartedAt: number | undefined;

  constructor(
    private readonly emit: (event: MeetingProcessingWorkerTelemetryEventV1) => void,
    private readonly now: () => number = Date.now,
  ) {}

  startCycle(): void {
    this.cycleStartedAt = this.now();
    this.report({
      schema_version: 1,
      kind: "echo-clean-live-worker-cycle-v1",
      event: "started",
      elapsed_ms: 0,
    });
  }

  succeedCycle(): void {
    if (this.cycleStartedAt === undefined) return;
    const elapsed_ms = elapsed(this.cycleStartedAt, this.now);
    this.cycleStartedAt = undefined;
    this.report({
      schema_version: 1,
      kind: "echo-clean-live-worker-cycle-v1",
      event: "succeeded",
      elapsed_ms,
    });
  }

  failCycle(error: unknown, cancelled = false): void {
    if (this.cycleStartedAt === undefined) return;
    const elapsed_ms = elapsed(this.cycleStartedAt, this.now);
    const failure = classifyFailure(error, cancelled);
    this.cycleStartedAt = undefined;
    this.report({
      schema_version: 1,
      kind: "echo-clean-live-worker-cycle-v1",
      event: "failed",
      elapsed_ms,
      ...failure,
    });
  }

  async runPhase<T>(
    phase: MeetingProcessingWorkerPhaseV1,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    retryableOnFailure = true,
  ): Promise<T> {
    signal?.throwIfAborted();
    const startedAt = this.now();
    this.report({
      schema_version: 1,
      kind: "echo-clean-live-worker-phase-v1",
      event: "started",
      cycle_phase: phase,
      elapsed_ms: 0,
    });
    try {
      const value = await operation();
      signal?.throwIfAborted();
      this.report({
        schema_version: 1,
        kind: "echo-clean-live-worker-phase-v1",
        event: "succeeded",
        cycle_phase: phase,
        elapsed_ms: elapsed(startedAt, this.now),
      });
      return value;
    } catch (error) {
      const failure = classifyFailure(error, signal?.aborted === true);
      this.report({
        schema_version: 1,
        kind: "echo-clean-live-worker-phase-v1",
        event: "failed",
        cycle_phase: phase,
        elapsed_ms: elapsed(startedAt, this.now),
        ...failure,
        retryable:
          failure.failure_class === "cancelled" ? false : retryableOnFailure,
      });
      throw error;
    }
  }

  private report(event: MeetingProcessingWorkerTelemetryEventV1): void {
    try {
      this.emit(Object.freeze(event));
    } catch {
      // Observability must never alter worker retry or approval behavior.
    }
  }
}
