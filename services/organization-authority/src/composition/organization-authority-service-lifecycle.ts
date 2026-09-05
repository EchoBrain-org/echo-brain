import type { AddressInfo } from "node:net";
import {
  SerializedMeetingProcessingWorker,
  type SerializedMeetingProcessingWorkerOptions,
} from "../processing/admitted-meeting-processing/serialized-meeting-processing-worker.js";
import {
  MeetingProcessingWorkerLifecycleV1,
  type MeetingProcessingWorkerPhaseRunnerV1,
  type MeetingProcessingWorkerTelemetryEventV1,
} from "../processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";
import {
  startOrganizationAuthorityApiRuntime,
  type OrganizationAuthorityApiRuntimeConfig,
  type OrganizationAuthorityApiRuntimeDependencies,
  type RunningOrganizationAuthorityApiRuntime,
} from "./organization-authority-api-runtime.js";
import { clearReadableSearchActiveGenerationV1 } from "@echo-brain/organization-retrieval/readable-search-engine-v1";

/**
 * The narrow durable-work seam for the Organization Authority's admitted
 * meeting-processing cycle. The concrete
 * adapters own their respective stores: source cursor and staged approvals in
 * Authority/control, then the V4 record append outbox. Keeping those writes
 * behind this seam makes the process lifecycle independent of old runtime
 * installation, enrollment, lease, and record-writer machinery.
 */
export interface OrganizationAuthorityProcessingCycleV1 {
  /** Replays finalized control-plane actions that were not appended to V4. */
  recoverV4Appends(signal: AbortSignal): Promise<void>;
  /** Polls the admitted source cursor and durably stages one card. */
  pollAndStageAdmittedMeetings(signal: AbortSignal): Promise<void>;
  /** Observes one staged approval and commits its approve or reject result. */
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  /** Appends finalized actions to V4; rejected actions produce no readable fact. */
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
  /**
   * Reconciles the immutable permission-aware search generation with the V4
   * record head after the complete append phase. Implementations may no-op
   * while the processing service is waiting for its activation prerequisites.
   */
  reconcileReadableSearchGeneration(signal: AbortSignal): Promise<void>;
  /** Optional composition seam for source/extraction/staging phase telemetry. */
  setWorkerLifecycle?(lifecycle: MeetingProcessingWorkerPhaseRunnerV1): void;
  /** True only when the processing implementation emits its inner phases. */
  readonly hasFineGrainedSourceLifecycle?: boolean;
}

export interface OrganizationAuthorityServiceLifecycleConfig {
  readonly api: OrganizationAuthorityApiRuntimeConfig;
  readonly worker_interval_ms?: number;
}

export interface OrganizationAuthorityServiceLifecycleDependencies {
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
  readonly processing: OrganizationAuthorityProcessingCycleV1;
  readonly start_api_runtime?: (
    config: OrganizationAuthorityApiRuntimeConfig,
    dependencies: OrganizationAuthorityApiRuntimeDependencies,
  ) => Promise<RunningOrganizationAuthorityApiRuntime>;
  readonly on_worker_error?: SerializedMeetingProcessingWorkerOptions["onError"];
  /** Content-free lifecycle events; observer failures never affect the worker. */
  readonly on_worker_telemetry?: (event: MeetingProcessingWorkerTelemetryEventV1) => void;
  /** Deterministic test seam for elapsed lifecycle telemetry. */
  readonly worker_telemetry_now?: () => number;
  /** Test seam; production always clears the sole lean-V1 process handle. */
  readonly clear_readable_search_handle?: () => void;
}

export interface RunningOrganizationAuthorityServiceLifecycle {
  readonly address: AddressInfo;
  /** Runs bounded operator work through the same gate as the processing worker. */
  runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Asks the worker to publish queued approval actions now instead of at the
   * next periodic cycle. It runs only the approval phases (finalize, append,
   * reconcile) through the same exclusive gate as the periodic cycle, so no
   * second writer is introduced. Requests made while one is still waiting for
   * the gate coalesce into that one run; a request made while a publication is
   * already executing schedules exactly one follow-up run. It never throws and
   * never blocks the caller; failures go to `on_worker_error`.
   */
  requestApprovalPublication(): void;
  /** Stops the worker before closing the Authority API database handles. */
  close(): Promise<void>;
}

/**
 * Runs exactly one Organization Authority processing cycle. Recovery leads so
 * a restart completes an
 * already-finalized action before consuming new source input. Every operation
 * is awaited in order; `SerializedMeetingProcessingWorker` supplies the single
 * in-process serialization guarantee.
 */
export async function runOrganizationAuthorityProcessingCycleV1(
  processing: OrganizationAuthorityProcessingCycleV1,
  signal: AbortSignal,
  lifecycle?: MeetingProcessingWorkerPhaseRunnerV1,
): Promise<void> {
  const phase = <T>(
    name: Parameters<MeetingProcessingWorkerPhaseRunnerV1["runPhase"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => lifecycle?.runPhase(name, operation, signal) ?? operation();
  await phase("recovery", () => processing.recoverV4Appends(signal));
  signal.throwIfAborted();
  if (processing.hasFineGrainedSourceLifecycle === true) {
    await processing.pollAndStageAdmittedMeetings(signal);
  } else {
    await phase("source_intake", () =>
      processing.pollAndStageAdmittedMeetings(signal),
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
 * Runs only the approval-publication phases of the cycle: finalize queued
 * actions, append approved ones to V4, and reconcile the search generation.
 * Source intake is deliberately excluded so an approval never waits behind a
 * source poll or an extraction call. The periodic cycle still runs these same
 * phases, so a lost or failed publication request is recovered by the next
 * tick rather than by any retry logic here.
 */
export async function runOrganizationAuthorityApprovalPublicationV1(
  processing: OrganizationAuthorityProcessingCycleV1,
  signal: AbortSignal,
  lifecycle?: MeetingProcessingWorkerPhaseRunnerV1,
): Promise<void> {
  const phase = <T>(
    name: Parameters<MeetingProcessingWorkerPhaseRunnerV1["runPhase"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => lifecycle?.runPhase(name, operation, signal) ?? operation();
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
 * Owns the Organization Authority process lifecycle: the self-session-
 * authenticated API plus one serialized source-processing worker. The API
 * runtime owns request handling and database handles; this component owns
 * their startup and shutdown order around the worker.
 */
export async function startOrganizationAuthorityServiceLifecycle(
  config: OrganizationAuthorityServiceLifecycleConfig,
  dependencies: OrganizationAuthorityServiceLifecycleDependencies,
): Promise<RunningOrganizationAuthorityServiceLifecycle> {
  const startApi =
    dependencies.start_api_runtime ?? startOrganizationAuthorityApiRuntime;
  const clearHandle =
    dependencies.clear_readable_search_handle ??
    clearReadableSearchActiveGenerationV1;
  const startup = new AbortController();
  const lifecycle = new MeetingProcessingWorkerLifecycleV1(
    dependencies.on_worker_telemetry ?? (() => undefined),
    dependencies.worker_telemetry_now,
  );
  dependencies.processing.setWorkerLifecycle?.(lifecycle);
  let api: RunningOrganizationAuthorityApiRuntime | undefined;
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
    // validated into the sole process-local handle. Never bind the API
    // listener before that startup boundary succeeds.
    await lifecycle.runPhase(
      "search_reconciliation",
      () => dependencies.processing.reconcileReadableSearchGeneration(startup.signal),
      startup.signal,
      false,
    );
    startup.signal.throwIfAborted();
    api = await startApi(config.api, dependencies.api ?? {});
    const startedApi = api;
    const worker = new SerializedMeetingProcessingWorker({
      intervalMs: config.worker_interval_ms,
      runCycle: async (signal) => {
        lifecycle.startCycle();
        try {
          await runOrganizationAuthorityProcessingCycleV1(
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
    let closing = false;
    let publicationPending = false;
    let publicationImmediate: ReturnType<typeof setImmediate> | undefined;
    const requestApprovalPublication = (): void => {
      if (closing || publicationPending) return;
      publicationPending = true;
      // An idle runExclusive gate starts synchronously. Yield to the next
      // event-loop turn so the ingress can write its HTTP acknowledgement
      // before SQLite finalization begins, including any busy-lock wait.
      publicationImmediate = setImmediate(() => {
        publicationImmediate = undefined;
        void worker
          .runExclusive(async (signal) => {
            // Clear before running so a request that arrives mid-publication
            // schedules one follow-up run rather than being dropped.
            publicationPending = false;
            await runOrganizationAuthorityApprovalPublicationV1(
              dependencies.processing,
              signal,
              lifecycle,
            );
          })
          .catch((failure: unknown) => {
            // `publicationPending` was already cleared when the run started;
            // the only pre-start failure is the closed worker's aborted signal.
            if (closing) return;
            try {
              dependencies.on_worker_error?.(
                failure instanceof Error ? failure : new Error(String(failure)),
              );
            } catch {
              // Error reporting is observational and cannot become control flow.
            }
          });
      });
    };
    return {
      address: startedApi.address,
      runExclusive: (operation) => worker.runExclusive(operation),
      requestApprovalPublication,
      close: async () => {
        closing = true;
        if (publicationImmediate !== undefined) {
          clearImmediate(publicationImmediate);
          publicationImmediate = undefined;
          publicationPending = false;
        }
        try {
          try {
            await worker.close();
          } finally {
            await startedApi.close();
          }
        } finally {
          clearHandle();
        }
      },
    };
  } catch (error) {
    clearHandle();
    await api?.close();
    throw error;
  }
}
