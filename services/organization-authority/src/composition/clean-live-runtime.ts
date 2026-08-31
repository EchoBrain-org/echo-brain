import type { AddressInfo } from "node:net";
import {
  SerializedAuthorityMeetingWorker,
  type SerializedAuthorityMeetingWorkerOptions,
} from "../processing/live/serialized-authority-meeting-worker.js";
import {
  CleanLiveWorkerLifecycleV1,
  type CleanLiveWorkerPhaseRunnerV1,
  type CleanLiveWorkerTelemetryEventV1,
} from "../processing/clean-v1/clean-live-worker-lifecycle.js";
import {
  startCleanPersonRuntime,
  type CleanPersonRuntimeConfig,
  type CleanPersonRuntimeDependencies,
  type RunningCleanPersonRuntime,
} from "./clean-person-runtime.js";
import { clearCleanReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/new-lineage-v1";

/**
 * The narrow durable-work seam for the clean live runtime. The concrete
 * adapters own their respective stores: source cursor and staged approvals in
 * Authority/control, then the V4 record append outbox. Keeping those writes
 * behind this seam makes the process lifecycle independent of old runtime
 * installation, enrollment, lease, and record-writer machinery.
 */
export interface CleanLiveProcessingCycleV1 {
  /** Replays finalized control-plane actions that were not appended to V4. */
  recoverV4Appends(signal: AbortSignal): Promise<void>;
  /** Polls the admitted live-only source cursor and durably stages one card. */
  pollAndStageLiveOnlySource(signal: AbortSignal): Promise<void>;
  /** Observes one staged approval and commits its approve or reject result. */
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  /** Appends finalized actions to V4; rejected actions produce no readable fact. */
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
  /**
   * Reconciles the immutable permission-aware search generation with the V4
   * record head after the complete append phase. Implementations may no-op
   * while the live process is waiting for its activation prerequisites.
   */
  reconcileReadableSearchGeneration(signal: AbortSignal): Promise<void>;
  /** Optional composition seam for source/extraction/staging phase telemetry. */
  setWorkerLifecycle?(lifecycle: CleanLiveWorkerPhaseRunnerV1): void;
  /** True only when the processing implementation emits its inner phases. */
  readonly hasFineGrainedSourceLifecycle?: boolean;
}

export interface CleanLiveRuntimeConfig {
  readonly person: CleanPersonRuntimeConfig;
  readonly worker_interval_ms?: number;
}

export interface CleanLiveRuntimeDependencies {
  readonly person?: CleanPersonRuntimeDependencies;
  readonly processing: CleanLiveProcessingCycleV1;
  readonly start_person_runtime?: (
    config: CleanPersonRuntimeConfig,
    dependencies: CleanPersonRuntimeDependencies,
  ) => Promise<RunningCleanPersonRuntime>;
  readonly on_worker_error?: SerializedAuthorityMeetingWorkerOptions["onError"];
  /** Content-free lifecycle events; observer failures never affect the worker. */
  readonly on_worker_telemetry?: (event: CleanLiveWorkerTelemetryEventV1) => void;
  /** Deterministic test seam for elapsed lifecycle telemetry. */
  readonly worker_telemetry_now?: () => number;
  /** Test seam; production always clears the sole lean-V1 process handle. */
  readonly clear_readable_search_handle?: () => void;
}

export interface RunningCleanLiveRuntime {
  readonly address: AddressInfo;
  /** Stops the worker before closing its Person HTTP database handles. */
  close(): Promise<void>;
}

/**
 * Runs exactly one clean V1 cycle. Recovery leads so a restart completes an
 * already-finalized action before consuming new source input. Every operation
 * is awaited in order; `SerializedAuthorityMeetingWorker` supplies the single
 * in-process serialization guarantee.
 */
export async function runCleanLiveProcessingCycleV1(
  processing: CleanLiveProcessingCycleV1,
  signal: AbortSignal,
  lifecycle?: CleanLiveWorkerPhaseRunnerV1,
): Promise<void> {
  const phase = <T>(
    name: Parameters<CleanLiveWorkerPhaseRunnerV1["runPhase"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => lifecycle?.runPhase(name, operation, signal) ?? operation();
  await phase("recovery", () => processing.recoverV4Appends(signal));
  signal.throwIfAborted();
  if (processing.hasFineGrainedSourceLifecycle === true) {
    await processing.pollAndStageLiveOnlySource(signal);
  } else {
    await phase("source_intake", () =>
      processing.pollAndStageLiveOnlySource(signal),
    );
  }
  signal.throwIfAborted();
  await phase("approval_observation", () =>
    processing.observeAndFinalizePendingApprovals(signal),
  );
  signal.throwIfAborted();
  await phase("record_append", () => processing.appendFinalizedApprovalsToV4(signal));
  signal.throwIfAborted();
  await phase("search_reconciliation", () =>
    processing.reconcileReadableSearchGeneration(signal),
  );
}

/**
 * The clean server process: the existing self-session-authenticated Person
 * HTTP surface plus a single serialized, live-only worker. There is no
 * fallback to the former authority meeting runtime.
 * The Person runtime also owns the current-Person V4 record route; this
 * lifecycle only adds the serialized processing worker around it.
 */
export async function startCleanLiveRuntime(
  config: CleanLiveRuntimeConfig,
  dependencies: CleanLiveRuntimeDependencies,
): Promise<RunningCleanLiveRuntime> {
  const startPerson =
    dependencies.start_person_runtime ?? startCleanPersonRuntime;
  const clearHandle =
    dependencies.clear_readable_search_handle ??
    clearCleanReadableSearchActiveGenerationV1;
  const startup = new AbortController();
  const lifecycle = new CleanLiveWorkerLifecycleV1(
    dependencies.on_worker_telemetry ?? (() => undefined),
    dependencies.worker_telemetry_now,
  );
  dependencies.processing.setWorkerLifecycle?.(lifecycle);
  let person: RunningCleanPersonRuntime | undefined;
  try {
    // Recovery can append a finalized approval and advance the V4 head. Finish
    // it before validating the generation that will be served at startup.
    await lifecycle.runPhase(
      "recovery",
      () => dependencies.processing.recoverV4Appends(startup.signal),
      startup.signal,
      false,
    );
    startup.signal.throwIfAborted();
    // A persisted pointer is not ready until its immutable generation has been
    // validated into the sole process-local handle. Never bind the Person
    // listener before that startup boundary succeeds.
    await lifecycle.runPhase(
      "search_reconciliation",
      () => dependencies.processing.reconcileReadableSearchGeneration(startup.signal),
      startup.signal,
      false,
    );
    startup.signal.throwIfAborted();
    person = await startPerson(config.person, dependencies.person ?? {});
    const startedPerson = person;
    const worker = new SerializedAuthorityMeetingWorker({
      intervalMs: config.worker_interval_ms,
      runCycle: async (signal) => {
        lifecycle.startCycle();
        try {
          await runCleanLiveProcessingCycleV1(
            dependencies.processing,
            signal,
            lifecycle,
          );
          lifecycle.succeedCycle();
        } catch (error) {
          lifecycle.failCycle(error, signal.aborted);
          throw error;
        }
      },
      onError: dependencies.on_worker_error,
    });
    return {
      address: startedPerson.address,
      close: async () => {
        try {
          try {
            await worker.close();
          } finally {
            await startedPerson.close();
          }
        } finally {
          clearHandle();
        }
      },
    };
  } catch (error) {
    clearHandle();
    await person?.close();
    throw error;
  }
}
