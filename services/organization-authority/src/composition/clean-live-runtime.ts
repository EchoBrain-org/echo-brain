import type { AddressInfo } from "node:net";
import {
  SerializedAuthorityMeetingWorker,
  type SerializedAuthorityMeetingWorkerOptions,
} from "../processing/live/serialized-authority-meeting-worker.js";
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
  /** Polls the admitted live-only Granola cursor and durably stages one card. */
  pollAndStageLiveOnlySource(signal: AbortSignal): Promise<void>;
  /** Observes one staged Slack card and commits its approve or reject result. */
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  /** Appends finalized actions to V4; rejected actions produce no readable fact. */
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
  /**
   * Reconciles the immutable permission-aware search generation with the V4
   * record head after the complete append phase. Implementations may no-op
   * while the live process is waiting for its activation prerequisites.
   */
  reconcileReadableSearchGeneration(signal: AbortSignal): Promise<void>;
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
): Promise<void> {
  await processing.recoverV4Appends(signal);
  signal.throwIfAborted();
  await processing.pollAndStageLiveOnlySource(signal);
  signal.throwIfAborted();
  await processing.observeAndFinalizePendingApprovals(signal);
  signal.throwIfAborted();
  await processing.appendFinalizedApprovalsToV4(signal);
  signal.throwIfAborted();
  await processing.reconcileReadableSearchGeneration(signal);
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
  let person: RunningCleanPersonRuntime | undefined;
  try {
    // Recovery can append a finalized approval and advance the V4 head. Finish
    // it before validating the generation that will be served at startup.
    await dependencies.processing.recoverV4Appends(startup.signal);
    startup.signal.throwIfAborted();
    // A persisted pointer is not ready until its immutable generation has been
    // validated into the sole process-local handle. Never bind the Person
    // listener before that startup boundary succeeds.
    await dependencies.processing.reconcileReadableSearchGeneration(
      startup.signal,
    );
    startup.signal.throwIfAborted();
    person = await startPerson(config.person, dependencies.person ?? {});
    const startedPerson = person;
    const worker = new SerializedAuthorityMeetingWorker({
      intervalMs: config.worker_interval_ms,
      runCycle: (signal) =>
        runCleanLiveProcessingCycleV1(dependencies.processing, signal),
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
