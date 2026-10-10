import { annotateCoreRuntimeV1, observeCoreRuntimeRootV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { ReadableSearchReconciliationTask } from "./readable-search-reconciliation-task.js";
import type { ApprovalPresentationReconciliationResultV1 } from "@echo-brain/organization-processing/ports/approval-workflow-bundle-v1";
import type { CoreRuntimeObservationScopeV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import type { AddressInfo } from "node:net";
import {
  SerializedMeetingProcessingWorker,
  type MeetingProcessingExclusiveV1,
  type SerializedMeetingProcessingWorkerOptions,
} from "@echo-brain/organization-processing/admitted-meeting-processing/serialized-meeting-processing-worker";
import {
  MeetingProcessingWorkerLifecycleV1,
  type MeetingProcessingWorkerPhaseRunnerV1,
  type MeetingProcessingWorkerTelemetryEventV1,
} from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-worker-lifecycle";
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
  /**
   * Polls admitted sources and durably stages their meetings for approval. Given `report`, it may leave passes
   * running after it returns, send their failures there and call `settled` as each one settles (neither throws);
   * `settle` waits for them.
   */
  pollAndStageAdmittedMeetings(signal: AbortSignal, report?: (failure: unknown) => void, settled?: () => void): Promise<void>;
  /** Resolves once no meeting pass is running: detached lanes, their top-ups and targeted passes (the staging canary). */
  settle?(): Promise<void>;
  /** Observes one staged approval and commits its approve or reject result. */
  observeAndFinalizePendingApprovals(signal: AbortSignal): Promise<void>;
  /** Appends finalized actions to V4; rejected actions produce no readable fact. */
  appendFinalizedApprovalsToV4(signal: AbortSignal): Promise<void>;
  /**
   * Optional bounded provider presentation reconciliation after durable approval
   * work, never at startup. Confirmed progress schedules another bounded turn;
   * an idle queue or uncertain outcome waits for a new wake.
   */
  reconcileApprovalPresentations?(signal: AbortSignal): Promise<ApprovalPresentationReconciliationResultV1 | void>;
  /**
   * Reconciles the immutable permission-aware search generation with the V4
   * record head after the complete append phase. Implementations may no-op
   * while the processing service is waiting for its activation prerequisites.
   */
  reconcileReadableSearchGeneration(signal: AbortSignal): Promise<{
    readonly status: "current" | "published" | "superseded";
  } | void>;
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
  readonly core_runtime_observation?: CoreRuntimeObservationScopeV1;
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
  readonly processing: OrganizationAuthorityProcessingCycleV1;
  readonly additional_processing?: OrganizationAuthorityProcessingCycleV1;
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
  /**
   * Excludes search and every gated writer turn (recovery, publication) for
   * bounded operator mutations. Source intake, notes enrichment, card
   * presentation and `runUngated` work run outside the gate and are not excluded.
   */
  runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Runs bounded operator work that appends no records (the staging canary)
   * outside the writer gate, one at a time, on the shutdown signal. Search and
   * the worker keep running; drain and close wait for it.
   */
  runUngated<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Waits for the running cycle, meeting lanes, card presentation, ungated work and queued writer/search work; callers
   * must supply a bounded signal. This is a readiness barrier, not operator exclusion or a retry trigger. */
  drain(signal: AbortSignal): Promise<void>;
  /**
   * Asks the worker to publish queued approval actions now instead of at the
   * next periodic cycle. It runs only the approval phases (finalize, append,
   * then requests search and card presentation) through the same writer gate
   * as the periodic cycle's recovery and publication, never behind its source
   * intake.
   * Requests made while one is still waiting for
   * the gate coalesce into that one run; a request made while a publication is
   * already executing schedules exactly one follow-up run. It never throws and
   * never blocks the caller; failures go to `on_worker_error`.
   */
  requestApprovalPublication(): void;
  /** Stops the worker and waits for meeting lanes, card presentation and ungated work before closing the Authority API database handles. */
  close(): Promise<void>;
}

/**
 * Runs exactly one Organization Authority processing cycle. Recovery leads so
 * a restart completes every recoverable finalized action before consuming new
 * source input; a row that cannot publish waits for a later pass. Every operation
 * is awaited in order. Only recovery and publication, which append to the record
 * log, hold the writer gate (`exclusive`); notes enrichment and source intake wait
 * on providers and models outside it, kept correct by durable fences (leases,
 * cursor compare-and-swap). Direct callers run everything in place. Given
 * `report`, a failed primary intake (the Authority's notes enrichment, which
 * marks a corrupt item unavailable and defers any other failure to a later
 * cycle) is reported and the cycle goes on, and the
 * personal intake may leave detached meeting lanes running, reporting their
 * failures there and calling `settled` as each one settles.
 */
export async function runOrganizationAuthorityProcessingCycleV1(
  processing: OrganizationAuthorityProcessingCycleV1,
  signal: AbortSignal,
  lifecycle?: MeetingProcessingWorkerPhaseRunnerV1,
  additional?: OrganizationAuthorityProcessingCycleV1,
  exclusive: MeetingProcessingExclusiveV1 = (operation) => operation(signal),
  report?: (failure: unknown) => void,
  settled?: () => void,
): Promise<void> {
  const phase = <T>(
    name: Parameters<MeetingProcessingWorkerPhaseRunnerV1["runPhase"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => lifecycle?.runPhase(name, operation, signal) ?? operation();
  await exclusive(() => phase("recovery", async () => { await processing.recoverV4Appends(signal); await additional?.recoverV4Appends(signal); }));
  signal.throwIfAborted();
  try {
    if (processing.hasFineGrainedSourceLifecycle === true) await processing.pollAndStageAdmittedMeetings(signal);
    else await phase("source_intake", () => processing.pollAndStageAdmittedMeetings(signal));
  } catch (failure) {
    if (report === undefined || signal.aborted) throw failure;
    report(failure);
  }
  signal.throwIfAborted();
  await additional?.pollAndStageAdmittedMeetings(signal, report, settled);
  signal.throwIfAborted();
  await exclusive(() => runOrganizationAuthorityApprovalPublicationV1(processing, signal, lifecycle, additional));
}

/**
 * Runs only the approval-publication phases of the cycle: finalize queued
 * actions and append approved ones to V4. The lifecycle requests search after
 * releasing the writer gate.
 * Source intake and card presentation are deliberately excluded, and run
 * outside the gate, so an approval never waits behind a source poll, an
 * extraction call or a Slack post; it waits only for other gated turns
 * (recovery, publication, operator work).
 * The periodic cycle still runs these same phases, so a lost or failed
 * publication request is recovered by the next tick rather than by any retry
 * logic here.
 */
export async function runOrganizationAuthorityApprovalPublicationV1(
  processing: OrganizationAuthorityProcessingCycleV1,
  signal: AbortSignal,
  lifecycle?: MeetingProcessingWorkerPhaseRunnerV1,
  additional?: OrganizationAuthorityProcessingCycleV1,
): Promise<void> {
  const phase = <T>(
    name: Parameters<MeetingProcessingWorkerPhaseRunnerV1["runPhase"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => lifecycle?.runPhase(name, operation, signal) ?? operation();
  await phase("approval_observation", async () => {
    await processing.observeAndFinalizePendingApprovals(signal);
    await additional?.observeAndFinalizePendingApprovals(signal);
  });
  signal.throwIfAborted();
  await phase("record_append", async () => { await processing.appendFinalizedApprovalsToV4(signal); await additional?.appendFinalizedApprovalsToV4(signal); });
  signal.throwIfAborted();
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
    dependencies.core_runtime_observation,
  );
  dependencies.processing.setWorkerLifecycle?.(lifecycle);
  let api: RunningOrganizationAuthorityApiRuntime | undefined;
  try {
    // Recovery can append a finalized approval and advance the V4 head. Finish
    // it before validating the generation that will be served at startup.
    await lifecycle.runPhase(
      "recovery",
      async () => { await dependencies.processing.recoverV4Appends(startup.signal); await dependencies.additional_processing?.recoverV4Appends(startup.signal); },
      startup.signal,
      false,
    );
    startup.signal.throwIfAborted();
    // A persisted pointer is not ready until its immutable generation has been
    // validated into the sole process-local handle. Never bind the API
    // listener before that startup boundary succeeds. Clearing first makes
    // startup fully validate even a generation an earlier run left warm.
    clearHandle();
    await lifecycle.runPhase(
      "search_reconciliation",
      () => dependencies.processing.reconcileReadableSearchGeneration(startup.signal),
      startup.signal,
      false,
    );
    startup.signal.throwIfAborted();
    api = await startApi(config.api, dependencies.api ?? {});
    const startedApi = api;
    const reportError = (failure: unknown): void => {
      try {
        dependencies.on_worker_error?.(failure instanceof Error ? failure : new Error(String(failure)));
      } catch { /* observational only */ }
    };
    const search = new ReadableSearchReconciliationTask(
      (signal) => observeCoreRuntimeRootV1("search_reconciliation", async () => {
        try {
          const result = await lifecycle.runPhase("search_reconciliation",
            () => dependencies.processing.reconcileReadableSearchGeneration(signal), signal);
          if (result !== undefined) annotateCoreRuntimeV1({ result: result.status });
          return result;
        } catch (error) {
          annotateCoreRuntimeV1({ result: signal.aborted ? "cancelled" : "failed" });
          throw error;
        }
      }, dependencies.core_runtime_observation),
      reportError,
    );
    let closing = false;
    const shutdown = new AbortController();
    // Work outside the writer gate runs on the shutdown signal in its own trace; close and drain wait for it.
    const ungated = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => observeCoreRuntimeRootV1("worker_execution", async () => {
      shutdown.signal.throwIfAborted();
      return operation(shutdown.signal);
    }, dependencies.core_runtime_observation);
    let ungatedTail: Promise<void> = Promise.resolve();
    let presentationPending = false;
    let presentationActive = false;
    let presentationImmediate: ReturnType<typeof setImmediate> | undefined;
    let presentationTail: Promise<void> = Promise.resolve();
    let completePresentation: (() => void) | undefined;
    let requestApprovalPresentation!: () => void;
    // The running cycle, so drain also waits for its ungated intake.
    let cycleTail: Promise<void> = Promise.resolve();
    // The personal intake's meeting lanes outlive the cycle that started them, on the worker's signal.
    const meetingLanes = async (): Promise<void> => { await (dependencies.additional_processing ?? startedApi.processing)?.settle?.(); };
    const worker = new SerializedMeetingProcessingWorker({
      ...(dependencies.core_runtime_observation === undefined ? {} : { observation: dependencies.core_runtime_observation }),
      intervalMs: config.worker_interval_ms,
      runCycle: async (signal, exclusive) => {
        let finished!: () => void;
        cycleTail = new Promise((resolve) => { finished = resolve; });
        lifecycle.startCycle();
        try {
          await runOrganizationAuthorityProcessingCycleV1(
            dependencies.processing,
            signal,
            lifecycle,
            dependencies.additional_processing ?? startedApi.processing,
            exclusive,
            reportError,
            // A lane that staged after its cycle returned gets its card now, not at the next cycle's wake.
            () => requestApprovalPresentation(),
          );
          lifecycle.succeedCycle();
        } catch (error) {
          lifecycle.failCycle(error, signal.aborted);
          throw error;
        } finally { finished(); }
      },
      onCycleComplete: () => {
        // Search is durable-derived work and must be requested even when the
        // later, provider-only terminal-card redraw fails.
        search.request();
        requestApprovalPresentation();
      },
      onError: dependencies.on_worker_error,
    });
    const finishPresentation = (): void => {
      completePresentation?.();
      completePresentation = undefined;
    };
    const schedulePresentation = (): void => {
      if (closing || !presentationPending || presentationActive || presentationImmediate !== undefined) return;
      // Yield between turns so a healthy burst cannot monopolize the event
      // loop. A turn handles one bounded page of cards outside the writer gate
      // (its transitions are compare-and-swap guarded), one turn at a time so
      // a card's backoff is never counted twice.
      presentationImmediate = setImmediate(() => {
        presentationImmediate = undefined;
        presentationActive = true;
        void ungated(async (signal) => {
            // Coalesce wakes while queued, but preserve one that arrives
            // after this attempt starts, including if the provider fails.
            presentationPending = false;
            const primary = dependencies.processing.reconcileApprovalPresentations;
            const additional = dependencies.additional_processing?.reconcileApprovalPresentations;
            const first = primary === undefined ? 'idle' : await primary(signal);
            const second = additional === undefined ? 'idle' : await additional(signal);
            return first === 'uncertain' || second === 'uncertain' ? 'uncertain' : first === 'rendered' || second === 'rendered' ? 'rendered' : 'idle';
          })
          .then((result) => {
            if (result === "rendered") presentationPending = true;
          })
          .catch((failure: unknown) => {
            // Durable approval and search already have their own wake. A
            // failed/uncertain redraw never generates its own retry.
            if (!closing) reportError(failure);
          })
          .finally(() => {
            presentationActive = false;
            if (closing) presentationPending = false;
            if (presentationPending) schedulePresentation();
            else finishPresentation();
          });
      });
    };
    requestApprovalPresentation = (): void => {
      if (closing || (dependencies.processing.reconcileApprovalPresentations === undefined && dependencies.additional_processing?.reconcileApprovalPresentations === undefined)) return;
      presentationPending = true;
      if (completePresentation === undefined) {
        presentationTail = new Promise((resolve) => { completePresentation = resolve; });
      }
      schedulePresentation();
    };
    let publicationPending = false;
    let publicationImmediate: ReturnType<typeof setImmediate> | undefined;
    let publicationTail: Promise<void> = Promise.resolve();
    let cancelPublication: (() => void) | undefined;
    const requestApprovalPublication = (): void => {
      if (closing) return;
      if (publicationPending) { annotateCoreRuntimeV1({ result: "coalesced" }); return; }
      publicationPending = true;
      let complete!: () => void;
      publicationTail = new Promise((resolve) => { complete = resolve; });
      cancelPublication = complete;
      // An idle runExclusive gate starts synchronously. Yield to the next
      // event-loop turn so the ingress can write its HTTP acknowledgement
      // before SQLite finalization begins, including any busy-lock wait.
      publicationImmediate = setImmediate(() => {
        publicationImmediate = undefined;
        cancelPublication = undefined;
        void worker
          .runExclusive(async (signal) => {
            // Clear before running so a request that arrives mid-publication
            // schedules one follow-up run rather than being dropped.
            publicationPending = false;
            await runOrganizationAuthorityApprovalPublicationV1(
              dependencies.processing,
              signal,
              lifecycle,
              dependencies.additional_processing ?? startedApi.processing,
            );
          })
          .catch((failure: unknown) => {
            // `publicationPending` was already cleared when the run started;
            // the only pre-start failure is the closed worker's aborted signal.
            if (!closing) reportError(failure);
          })
          .then(() => {
            // Search and cards derive from durable state, so a failed run
            // still wakes them.
            if (!closing) {
              search.request();
              requestApprovalPresentation();
            }
          })
          .finally(complete);
      });
    };
    let closed: Promise<void> | undefined;
    return {
      address: startedApi.address,
      runExclusive: async (operation) => {
        search.suspend();
        try {
          return await worker.runExclusive(async (signal) => {
            await search.waitForActive();
            signal.throwIfAborted();
            return operation(signal);
          });
        } finally {
          search.resume();
          if (!closing) search.request();
        }
      },
      runUngated: (operation) => {
        const run = ungatedTail.then(() => ungated(operation));
        ungatedTail = run.then(() => undefined, () => undefined);
        return run;
      },
      drain: async (deadline) => {
        const signal = AbortSignal.any([deadline, shutdown.signal]);
        signal.throwIfAborted();
        // A caller's deadline bounds waiting only; it must not abort shared
        // work. Cleanup and handle ownership always remain with close().
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        });
        try {
          await Promise.race([cancelled, (async () => {
            let observedPublication: Promise<void>;
            let observedPresentation: Promise<void>;
            let observedCycle: Promise<void>;
            let observedUngated: Promise<void>;
            do {
              observedPublication = publicationTail;
              observedPresentation = presentationTail;
              observedCycle = cycleTail;
              observedUngated = ungatedTail;
              await Promise.all([observedPublication, observedPresentation, observedCycle, observedUngated, meetingLanes()]);
              signal.throwIfAborted();
              await worker.runExclusive(async () => undefined);
              signal.throwIfAborted();
              await search.drain();
              signal.throwIfAborted();
            } while (
              publicationTail !== observedPublication ||
              presentationTail !== observedPresentation ||
              cycleTail !== observedCycle ||
              ungatedTail !== observedUngated
            );
          })()]);
        } finally { signal.removeEventListener("abort", abort); }
      },
      requestApprovalPublication,
      close: () => {
        if (closed !== undefined) return closed;
        closing = true;
        shutdown.abort();
        presentationPending = false;
        if (presentationImmediate !== undefined) {
          clearImmediate(presentationImmediate);
          presentationImmediate = undefined;
        }
        if (!presentationActive) finishPresentation();
        if (publicationImmediate !== undefined) {
          clearImmediate(publicationImmediate);
          publicationImmediate = undefined;
          publicationPending = false;
          cancelPublication?.();
          cancelPublication = undefined;
        }
        startedApi.stopAcceptingRequests?.();
        const searchClosed = search.close();
        // Once the worker has stopped no cycle can start a meeting lane, so its aborted lanes are the last to wait for.
        const workerClosed = worker.close().finally(meetingLanes);
        // The other lanes outside the gate settle on the aborted shutdown signal.
        const lanesSettled = Promise.all([presentationTail, ungatedTail]);
        closed = (async () => {
          try {
            try {
              await Promise.all([workerClosed, searchClosed, lanesSettled]);
            } finally {
              await startedApi.close();
            }
          } finally {
            clearHandle();
          }
        })();
        return closed;
      },
    };
  } catch (error) {
    clearHandle();
    await api?.close();
    throw error;
  }
}
