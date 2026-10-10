import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runOrganizationAuthorityApprovalPublicationV1,
  runOrganizationAuthorityProcessingCycleV1,
  startOrganizationAuthorityServiceLifecycle,
  type OrganizationAuthorityProcessingCycleV1,
  type OrganizationAuthorityServiceLifecycleDependencies,
} from "../src/composition/organization-authority-service-lifecycle.js";
import type { MeetingProcessingWorkerTelemetryEventV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-worker-lifecycle";
import type { ApprovalPresentationReconciliationResultV1 } from "@echo-brain/organization-processing/ports/approval-workflow-bundle-v1";
import { AdapterError } from "@echo-brain/organization-processing/core/contracts/adapter";
import type {
  OrganizationAuthorityApiRuntimeConfig,
  RunningOrganizationAuthorityApiRuntime,
} from "../src/composition/organization-authority-api-runtime.js";
import { approvalCoreFixture } from "./fixtures/approval-core.js";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const apiConfig: OrganizationAuthorityApiRuntimeConfig = {
  state_directory: "/clean-state",
  host: "127.0.0.1",
  port: 14_000,
  authority_url: "https://authority.example",
  oidc: {
    issuer: "https://issuer.example",
    client_id: "person-client",
    redirect_uri: "https://authority.example/v2/session/oidc/callback",
    tenant: { kind: "issuer" },
    id_token_algorithms: ["RS256"],
  },
  client_authentication: { method: "none" },
  pkce_sealing_key: new Uint8Array(32),
};

function processing(
  operations: string[],
  append: () => Promise<void> = async () => undefined,
  reconcile: () => Promise<void> = async () => undefined,
): OrganizationAuthorityProcessingCycleV1 {
  return {
    recoverV4Appends: async () => {
      operations.push("recover");
    },
    pollAndStageAdmittedMeetings: async () => {
      operations.push("stage");
    },
    observeAndFinalizePendingApprovals: async () => {
      operations.push("finalize");
    },
    appendFinalizedApprovalsToV4: async () => {
      operations.push("append");
      await append();
    },
    reconcileReadableSearchGeneration: async () => {
      operations.push("reconcile");
      await reconcile();
    },
  };
}

function apiRuntime(events: string[]): RunningOrganizationAuthorityApiRuntime {
  return {
    address: { address: "127.0.0.1", family: "IPv4", port: 14_000 },
    close: async () => {
      events.push("api-close");
    },
  };
}

function startLifecycle(
  worker_interval_ms: number,
  dependencies: OrganizationAuthorityServiceLifecycleDependencies,
  events: string[] = [],
) {
  return startOrganizationAuthorityServiceLifecycle(
    { api: apiConfig, worker_interval_ms },
    { start_api_runtime: async () => apiRuntime(events), ...dependencies },
  );
}

describe("Organization Authority service lifecycle", () => {
  it("recovers personal approvals before search readiness and serializes their publication in the existing worker", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const personalEvents: string[] = [];
    const runtime = await startLifecycle(1_000, {
      processing: processing(events, undefined, async () => { expect(personalEvents[0]).toBe('recover'); }),
      additional_processing: processing(personalEvents),
      start_api_runtime: async () => { expect(events).toEqual(['recover', 'reconcile']); return apiRuntime(events); },
    });
    try {
      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(5);
      expect(personalEvents).toContain('finalize');
      expect(personalEvents).toContain('append');
      expect(personalEvents).not.toContain('reconcile');
    } finally { await runtime.close(); }
  });

  it("does not serve search if a personal approved append cannot recover", async () => {
    const start = vi.fn();
    const primary = processing([]);
    const search = vi.spyOn(primary, 'reconcileReadableSearchGeneration');
    await expect(startLifecycle(1_000, {
      processing: primary,
      additional_processing: { ...processing([]), recoverV4Appends: async () => { throw new Error('pending signed append'); } },
      start_api_runtime: start,
    })).rejects.toThrow('pending signed append');
    expect(search).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("binds after a recovery pass in which one approval row cannot publish", async () => {
    const f = await approvalCoreFixture();
    f.core.decide("desktop", f.approve(), () => f.session);
    const poisoned = f.withAppend(async () => { throw new Error("row cannot publish"); }).processing;
    const runtime = await startLifecycle(60_000, {
      processing: processing([]),
      additional_processing: { ...processing([]), recoverV4Appends: poisoned.recoverV4Appends },
    });
    try {
      expect(runtime.address.port).toBe(14_000);
      expect(f.core.proposal(f.approvalId)!.status).toBe("publishing");
    } finally { await runtime.close(); }
  });
  it("coalesces search wakes at completion and failure boundaries without self-retrying failures", async () => {
    vi.useFakeTimers();
    const blocked = deferred();
    const errors: Error[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let fail = true;
    const runtime = await startLifecycle(1_000, {
      processing: { ...processing([]), reconcileReadableSearchGeneration: async () => {
        calls++;
        if (calls === 1) return; // Startup validation.
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls === 2) await blocked.promise;
          if (fail) throw new Error("projector unavailable");
          if (calls === 4) {
            runtime.requestApprovalPublication();
            return { status: "superseded" };
          }
          return { status: "current" };
        } finally { active--; }
      } },
      on_worker_error: (error) => { errors.push(error); throw new Error("observer failed"); },
      on_worker_telemetry: (event) => { telemetry.push(event); throw new Error("observer failed"); },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      runtime.requestApprovalPublication();
      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      blocked.resolve();
      await vi.advanceTimersByTimeAsync(3);
      expect(calls).toBe(3); // One real queued wake survives the first failure.
      expect(errors).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toBe(3); // No wake generated by either failure.
      expect(telemetry).toContainEqual(expect.objectContaining({ kind: "echo-clean-live-worker-cycle-v1", event: "succeeded" }));
      expect(telemetry.filter((event) => event.event === "failed")).toEqual([
        expect.objectContaining({ cycle_phase: "search_reconciliation", retryable: true }),
        expect.objectContaining({ cycle_phase: "search_reconciliation", retryable: true }),
      ]);
      fail = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(5); // Periodic recovery, then the completion-boundary wake.
      expect(maxActive).toBe(1);
    } finally { blocked.resolve(); await runtime.close(); }
  });

  it("waits for abort-ignoring search before closing handles and cancels queued work", async () => {
    vi.useFakeTimers();
    const blocked = deferred();
    const events: string[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let calls = 0;
    let searchSignal!: AbortSignal;
    const runtime = await startLifecycle(1_000, {
      processing: { ...processing(events), reconcileReadableSearchGeneration: async (signal) => {
        if (++calls === 1) return;
        searchSignal = signal;
        await blocked.promise; // Deliberately ignores abort until it settles.
        events.push("search-settled");
      } },
      start_api_runtime: async () => ({ ...apiRuntime(events), stopAcceptingRequests: () => { events.push("ingress-stop"); } }),
      clear_readable_search_handle: () => { events.push("handle-clear"); },
      on_worker_telemetry: (event) => { telemetry.push(event); },
    });
    await vi.advanceTimersByTimeAsync(1);
    runtime.requestApprovalPublication();
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(searchSignal.aborted).toBe(true);
    expect(events.at(-1)).toBe("ingress-stop");
    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).not.toContain("api-close");
    await expect(runtime.runExclusive(async () => { events.push("operator"); })).rejects.toThrow();
    blocked.resolve();
    await closing;
    expect(events.slice(-3)).toEqual(["search-settled", "api-close", "handle-clear"]);
    expect(events).not.toContain("operator");
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(telemetry).toContainEqual(expect.objectContaining({ cycle_phase: "search_reconciliation", event: "failed", failure_class: "cancelled", retryable: false }));
  });

  it("closes database handles only after an abort-ignoring source pass outside the gate settles", async () => {
    vi.useFakeTimers();
    const pass = deferred();
    const events: string[] = [];
    const runtime = await startLifecycle(1_000, {
      processing: processing([]),
      additional_processing: { ...processing([]), pollAndStageAdmittedMeetings: async () => { events.push("pass"); await pass.promise; events.push("pass-settled"); } },
      clear_readable_search_handle: () => { events.push("handle-clear"); },
    }, events);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)).toBe("pass");
    const closing = runtime.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).not.toContain("api-close");
    pass.resolve();
    await closing;
    expect(events.slice(-3)).toEqual(["pass-settled", "api-close", "handle-clear"]);
  });

  it("gives the personal intake a reporter, and drains and closes handles only after its detached lanes settle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let lanes = deferred(), cycle: AbortSignal | undefined;
    const runtime = await startLifecycle(1_000, {
      processing: processing([]),
      additional_processing: { ...processing([]),
        pollAndStageAdmittedMeetings: async (signal, report) => { cycle = signal; events.push(report === undefined ? "in-place" : "lanes"); },
        settle: async () => { await lanes.promise; events.push(cycle?.aborted ? "settled-after-stop" : "settled"); } },
      clear_readable_search_handle: () => { events.push("handle-clear"); },
    }, events);
    await vi.advanceTimersByTimeAsync(1);
    let drained = false;
    const draining = runtime.drain(new AbortController().signal).then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect([events, drained]).toEqual([["handle-clear", "lanes"], false]);
    lanes.resolve(); await draining;
    lanes = deferred();
    const closing = runtime.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).not.toContain("api-close");
    lanes.resolve(); await closing;
    expect(events).toEqual(["handle-clear", "lanes", "settled", "settled-after-stop", "api-close", "handle-clear"]);
  });

  it("keeps operator mutations exclusive from search and writer work", async () => {
    vi.useFakeTimers();
    const blockedSearch = deferred();
    const blockedOperator = deferred();
    const events: string[] = [];
    let calls = 0;
    const runtime = await startLifecycle(1_000, {
      processing: processing(events, undefined, async () => { if (++calls === 2) await blockedSearch.promise; }),
    }, events);
    try {
      await vi.advanceTimersByTimeAsync(1);
      const operator = runtime.runExclusive(async () => { events.push("operator-start"); await blockedOperator.promise; events.push("operator-end"); });
      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      expect(events).not.toContain("operator-start");
      blockedSearch.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(events.at(-1)).toBe("operator-start");
      blockedOperator.resolve();
      await operator;
      await vi.advanceTimersByTimeAsync(1);
      expect(events.slice(-4)).toEqual(["operator-end", "finalize", "append", "reconcile"]);
    } finally { blockedSearch.resolve(); blockedOperator.resolve(); await runtime.close(); }
  });

  it("runs ungated operator work beside publication and search, and closes handles only after it settles", async () => {
    vi.useFakeTimers();
    const work = deferred();
    const events: string[] = [];
    const runtime = await startLifecycle(60_000, { processing: processing(events) }, events);
    await vi.advanceTimersByTimeAsync(1);
    events.length = 0;
    const canary = runtime.runUngated(async (signal) => { events.push("canary"); await work.promise; return signal.aborted; });
    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["canary", "finalize", "append", "reconcile"]);
    const closing = runtime.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).not.toContain("api-close");
    work.resolve();
    await expect(canary).resolves.toBe(true);
    await closing;
    expect(events.at(-1)).toBe("api-close");
  });

  it("bounds drain waiting without cancelling shared search", async () => {
    vi.useFakeTimers();
    const blocked = deferred();
    let calls = 0;
    let searchSignal!: AbortSignal;
    const runtime = await startLifecycle(1_000, {
      processing: { ...processing([]), reconcileReadableSearchGeneration: async (signal) => {
        if (++calls === 1) return;
        searchSignal = signal;
        await blocked.promise;
      } },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      const deadline = new AbortController();
      const draining = expect(runtime.drain(deadline.signal)).rejects.toThrow("drain deadline");
      deadline.abort(new Error("drain deadline"));
      await draining;
      expect(searchSignal.aborted).toBe(false);
      blocked.resolve();
      await runtime.drain(new AbortController().signal);
    } finally { blocked.resolve(); await runtime.close(); }
  });

  it("emits a successful content-free heartbeat for an empty cycle", async () => {
    vi.useFakeTimers();
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const runtime = await startLifecycle(1_000, {
      processing: processing([]),
      on_worker_telemetry: (event) => events.push(event),
      worker_telemetry_now: () => 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual({
      schema_version: 1,
      kind: "echo-clean-live-worker-cycle-v1",
      event: "succeeded",
      elapsed_ms: 0,
    });
    await runtime.close();
  });

  it("recovers and prewarms before starting Person, then retains worker ordering", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startLifecycle(1_000, {
      processing: processing(events),
      start_api_runtime: async () => {
        events.push("api-start");
        return apiRuntime(events);
      },
      clear_readable_search_handle: () => events.push("handle-clear"),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.address.port).toBe(14_000);
    expect(events).toEqual([
      "recover",
      "handle-clear", // Startup fully validates even a warm generation.
      "reconcile",
      "api-start",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
    ]);

    await runtime.close();
    expect(events.slice(9)).toEqual(["api-close", "handle-clear"]);
  });

  it("retries after an interrupted V4 append with recovery before another source poll, still waking search and presentation", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let attempts = 0;
    const errors: string[] = [];
    const runtime = await startLifecycle(100, {
      processing: {
        ...processing(events, async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("append interrupted");
        }),
        reconcileApprovalPresentations: async () => { events.push("presentation"); },
      },
      on_worker_error: (error) => {
        errors.push(error.message);
      },
    }, events);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      "recover",
      "reconcile",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
      "presentation",
    ]);
    expect(errors).toEqual(["append interrupted"]);

    await vi.advanceTimersByTimeAsync(101);
    expect(events.slice(8)).toEqual(["recover", "stage", "finalize", "append", "reconcile", "presentation"]);
    expect(errors).toEqual(["append interrupted"]);

    await runtime.close();
  });

  it("defers optional approval presentation until after startup and durable periodic phases", async () => {
    const events: string[] = [];
    const setup = {
      ...processing(events),
      reconcileApprovalPresentations: async () => { events.push("presentation"); },
    } satisfies OrganizationAuthorityProcessingCycleV1;

    await runOrganizationAuthorityProcessingCycleV1(
      setup,
      new AbortController().signal,
    );
    expect(events).toEqual(["recover", "stage", "finalize", "append"]);

    events.length = 0;
    await runOrganizationAuthorityApprovalPublicationV1(
      setup,
      new AbortController().signal,
    );
    expect(events).toEqual(["finalize", "append"]);

    events.length = 0;
    let beforeApiStart: string[] = [];
    const runtime = await startLifecycle(10_000, {
      processing: setup,
      start_api_runtime: async () => {
        beforeApiStart = [...events];
        return apiRuntime(events);
      },
    });
    try {
      expect(beforeApiStart).toEqual(["recover", "reconcile"]);
      await runtime.drain(AbortSignal.timeout(1_000));
      expect(events).toContain("presentation");
    } finally {
      await runtime.close();
    }
  });

  it("invokes the additional processing lane's approval presenter", async () => {
    vi.useFakeTimers();
    const presented: string[] = [];
    const runtime = await startLifecycle(30_000, {
      processing: processing([]),
      additional_processing: {
        ...processing([]),
        reconcileApprovalPresentations: async () => { presented.push("personal"); return "idle"; },
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);
      expect(presented).toEqual(["personal"]);
    } finally {
      await runtime.close();
    }
  });

  it("reports a presentation failure without skipping search or the next cycle", async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let searchCalls = 0;
    let presentationCalls = 0;
    const runtime = await startLifecycle(100, {
      processing: {
        ...processing([]),
        reconcileReadableSearchGeneration: async () => { searchCalls += 1; },
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          if (presentationCalls === 1) throw new Error("terminal card unavailable");
        },
      },
      on_worker_error: (error) => errors.push(error),
      on_worker_telemetry: (event) => telemetry.push(event),
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(presentationCalls).toBe(1);
      expect(errors.map((error) => error.message)).toEqual(["terminal card unavailable"]);
      // One startup reconciliation and one completion-bound search wake.
      expect(searchCalls).toBeGreaterThanOrEqual(2);
      expect(telemetry).toContainEqual(
        expect.objectContaining({ kind: "echo-clean-live-worker-cycle-v1", event: "succeeded" }),
      );

      await vi.advanceTimersByTimeAsync(101);
      expect(presentationCalls).toBe(2);
      expect(searchCalls).toBeGreaterThanOrEqual(3);
    } finally {
      await runtime.close();
    }
  });

  it("rejects startup, clears the handle, and never starts the API when prewarm fails", async () => {
    const events: string[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const startApi = vi.fn(async () => apiRuntime(events));
    await expect(
      startLifecycle(100, {
        processing: processing(events, undefined, async () => {
          throw new Error("generation reconciliation interrupted");
        }),
        start_api_runtime: startApi,
        on_worker_telemetry: (event) => telemetry.push(event),
        clear_readable_search_handle: () => events.push("handle-clear"),
      }),
    ).rejects.toThrow("generation reconciliation interrupted");
    expect(startApi).not.toHaveBeenCalled();
    expect(events).toEqual(["recover", "handle-clear", "reconcile", "handle-clear"]);
    expect(telemetry).toMatchObject([
      { event: "started", cycle_phase: "recovery" },
      { event: "succeeded", cycle_phase: "recovery" },
      { event: "started", cycle_phase: "search_reconciliation" },
      {
        event: "failed",
        cycle_phase: "search_reconciliation",
        failure_class: "unknown",
        retryable: false,
      },
    ]);
  });

  it("rejects startup before prewarm or API start when append recovery fails", async () => {
    const events: string[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const startApi = vi.fn(async () => apiRuntime(events));
    const startupProcessing = processing(events);

    await expect(
      startLifecycle(100, {
        processing: {
          ...startupProcessing,
          recoverV4Appends: async () => {
            events.push("recover");
            throw new Error("append recovery interrupted");
          },
        },
        start_api_runtime: startApi,
        on_worker_telemetry: (event) => telemetry.push(event),
        clear_readable_search_handle: () => events.push("handle-clear"),
      }),
    ).rejects.toThrow("append recovery interrupted");

    expect(startApi).not.toHaveBeenCalled();
    expect(events).toEqual(["recover", "handle-clear"]);
    expect(telemetry).toMatchObject([
      { event: "started", cycle_phase: "recovery" },
      {
        event: "failed",
        cycle_phase: "recovery",
        failure_class: "unknown",
        retryable: false,
      },
    ]);
  });

  it("marks an in-flight aborted phase and its cycle as cancelled", async () => {
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let phaseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      phaseStarted = resolve;
    });
    const runtime = await startLifecycle(100, {
      processing: {
        ...processing([]),
        pollAndStageAdmittedMeetings: async (signal) => {
          phaseStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("private cancellation sentinel")),
              { once: true },
            );
          });
        },
      },
      on_worker_telemetry: (event) => telemetry.push(event),
    });
    await started;
    await runtime.close();

    expect(telemetry.filter((event) => event.event === "failed")).toEqual([
      expect.objectContaining({
        kind: "echo-clean-live-worker-phase-v1",
        cycle_phase: "source_intake",
        failure_class: "cancelled",
        retryable: false,
      }),
      expect.objectContaining({
        kind: "echo-clean-live-worker-cycle-v1",
        failure_class: "cancelled",
        retryable: false,
      }),
    ]);
  });

  it("reports a later automatic retry even when an adapter marks its error non-retryable", async () => {
    vi.useFakeTimers();
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const order: string[] = [];
    let attempts = 0;
    const runtime = await startLifecycle(100, {
      processing: processing([], async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AdapterError("invalid_config", "private adapter sentinel", false);
        }
      }),
      on_worker_telemetry: (event) => {
        if (event.event === "failed") {
          order.push(
            event.kind === "echo-clean-live-worker-phase-v1"
              ? `phase:${event.cycle_phase}`
              : "cycle",
          );
        }
        telemetry.push(event);
      },
      on_worker_error: () => order.push("legacy"),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["phase:record_append", "cycle", "legacy"]);
    expect(telemetry).toContainEqual(
      expect.objectContaining({
        kind: "echo-clean-live-worker-phase-v1",
        cycle_phase: "record_append",
        event: "failed",
        failure_class: "invalid_contract",
        retryable: true,
      }),
    );
    expect(telemetry).toContainEqual(
      expect.objectContaining({
        kind: "echo-clean-live-worker-cycle-v1",
        event: "failed",
        failure_class: "invalid_contract",
        retryable: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(101);
    expect(attempts).toBe(2);
    expect(telemetry).toContainEqual(
      expect.objectContaining({
        kind: "echo-clean-live-worker-cycle-v1",
        event: "succeeded",
      }),
    );
    await runtime.close();
  });

  it("reports a notes enrichment failure and still runs the cycle's personal intake and publication", async () => {
    vi.useFakeTimers();
    const personal: string[] = [];
    const errors: string[] = [];
    const runtime = await startLifecycle(60_000, {
      processing: { ...processing([]), pollAndStageAdmittedMeetings: async () => { throw new Error("notes item failed"); } },
      additional_processing: processing(personal),
      on_worker_error: (error) => errors.push(error.message),
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(personal).toEqual(["recover", "recover", "stage", "finalize", "append"]);
      expect(errors).toEqual(["notes item failed"]);
    } finally { await runtime.close(); }
  });

  it("does not reconcile after append observes cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();

    await expect(
      runOrganizationAuthorityProcessingCycleV1(
        processing(events, async () => {
          controller.abort();
        }),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(events).toEqual(["recover", "stage", "finalize", "append"]);
  });

  it("publishes a requested approval without waiting for the periodic cycle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startLifecycle(60_000, {
      processing: processing(events),
    }, events);
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(1);

    // No 60 s tick has elapsed, yet the approval phases ran, and no source
    // poll ran with them.
    expect(events).toEqual(["finalize", "append", "reconcile"]);
    await runtime.close();
  });

  it("wakes approval-card presentation after requested publication without waiting for the next cycle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing(events),
        reconcileApprovalPresentations: async () => { events.push("presentation"); },
      },
    }, events);
    try {
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);
      events.length = 0;

      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);

      // The next 30 s periodic tick has not elapsed. A completed requested
      // approval must wake both its search-derived work and its terminal-card
      // redraw, after the durable approval phases release the writer gate.
      expect(events).toContain("reconcile");
      expect(events).toContain("presentation");
      expect(events).not.toContain("stage");
      expect(events.indexOf("finalize")).toBeLessThan(events.indexOf("append"));
      expect(events.indexOf("append")).toBeLessThan(events.indexOf("reconcile"));
      expect(events.indexOf("append")).toBeLessThan(events.indexOf("presentation"));
    } finally {
      await runtime.close();
    }
  });

  it("keeps immediate search wake when requested approval-card presentation fails", async () => {
    vi.useFakeTimers();
    const errors: Error[] = [];
    let searchCalls = 0;
    let presentationCalls = 0;
    let failPresentation = false;
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing([]),
        reconcileReadableSearchGeneration: async () => { searchCalls += 1; },
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          if (failPresentation) throw new Error("terminal card unavailable");
        },
      },
      on_worker_error: (error) => errors.push(error),
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);
      searchCalls = 0;
      presentationCalls = 0;
      failPresentation = true;

      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);

      expect(searchCalls).toBe(1);
      expect(presentationCalls).toBe(1);
      expect(errors.map((error) => error.message)).toEqual(["terminal card unavailable"]);

      // A provider redraw failure reports once, and waits for a normal later
      // trigger instead of generating an immediate retry loop.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(searchCalls).toBe(1);
      expect(presentationCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("drains a rendered approval-card backlog before the next periodic cycle", async () => {
    vi.useFakeTimers();
    let presentationCalls = 0;
    const outcomes = ["rendered", "rendered", "idle"] as const satisfies readonly ApprovalPresentationReconciliationResultV1[];
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing([]),
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          return outcomes[presentationCalls - 1] ?? "idle";
        },
      },
    });
    try {
      // The startup cycle's redraw and each rendered card run in their own
      // event loop turn. Advance enough turns for the bounded three-card backlog.
      for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);

      // A rendered card can reveal another ready card. Drain that bounded
      // backlog now; do not leave it to the 30 s source-processing timer.
      expect(presentationCalls).toBe(3);
    } finally {
      await runtime.close();
    }
  });

  it("does not self-retry an uncertain approval-card presentation", async () => {
    vi.useFakeTimers();
    let presentationCalls = 0;
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing([]),
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          return "uncertain";
        },
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      await runtime.drain(new AbortController().signal);
      expect(presentationCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(presentationCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("publishes while a card presentation is blocked and retains the wake that publication sends", async () => {
    vi.useFakeTimers();
    const active = deferred();
    const events: string[] = [];
    let presentationCalls = 0;
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing(events),
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          if (presentationCalls === 1) await active.promise;
          return "idle";
        },
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(presentationCalls).toBe(1);
      events.length = 0;

      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(["finalize", "append", "reconcile"]);
      active.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await runtime.drain(new AbortController().signal);

      expect(presentationCalls).toBe(2);
    } finally {
      active.resolve();
      await runtime.close();
    }
  });

  it("cancels a scheduled approval-card follow-up when closing", async () => {
    vi.useFakeTimers();
    const active = deferred();
    let presentationCalls = 0;
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing([]),
        reconcileApprovalPresentations: async () => {
          presentationCalls += 1;
          if (presentationCalls === 1) await active.promise;
          return presentationCalls === 1 ? "rendered" : "idle";
        },
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(presentationCalls).toBe(1);
      const timers = vi.getTimerCount();

      active.resolve();
      // Settle the active redraw and let it queue, but do not run, its
      // rendered-backlog follow-up.
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(timers);
      await runtime.close();
      await vi.advanceTimersByTimeAsync(1);

      expect(presentationCalls).toBe(1);
    } finally {
      active.resolve();
      await runtime.close();
    }
  });

  it("waits for an active approval-card presentation before closing the API", async () => {
    vi.useFakeTimers();
    const active = deferred();
    const events: string[] = [];
    let presentationCalls = 0;
    const runtime = await startLifecycle(30_000, {
      processing: {
        ...processing(events),
        reconcileApprovalPresentations: async (signal) => {
          presentationCalls += 1;
          await active.promise; // Deliberately ignores abort until it settles.
          events.push(signal.aborted ? "presentation-cancelled" : "presentation-settled");
          return "idle";
        },
      },
    }, events);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(presentationCalls).toBe(1);

      const closing = runtime.close();
      await vi.advanceTimersByTimeAsync(1);
      expect(events).not.toContain("api-close");
      active.resolve();
      await closing;

      expect(events.slice(-2)).toEqual(["presentation-cancelled", "api-close"]);
    } finally {
      active.resolve();
      await runtime.close();
    }
  });

  it("publishes coalesced requests within one tick, with no gate wait, while source intake waits on a provider", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const gateWaits: unknown[] = [];
    const runtime = await startLifecycle(60_000, {
      processing: processing(events),
      additional_processing: { ...processing([]), pollAndStageAdmittedMeetings: (signal) => new Promise<void>((_resolve, reject) => {
        events.push("intake");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) },
      core_runtime_observation: { observer: (event) => { if (event.phase === "worker_request" && event.event === "succeeded") gateWaits.push(event.counts.gate_wait_ms); } },
    }, events);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // The first periodic cycle never leaves source intake.
      expect(events.at(-1)).toBe("intake");
      events.length = 0;
      gateWaits.length = 0;
      runtime.requestApprovalPublication();
      runtime.requestApprovalPublication();
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(["finalize", "append", "reconcile"]);
      expect(gateWaits).toEqual([0]);
    } finally { await runtime.close(); }
  });

  it("schedules exactly one follow-up for a request made mid-publication", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const gate: { release?: () => void; open: boolean } = { open: false };
    const runtime = await startLifecycle(60_000, {
      processing: processing(events, async () => {
        if (gate.open) return;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }),
    }, events);
    await vi.advanceTimersByTimeAsync(0);
    // The first periodic cycle is parked in append; let it finish.
    gate.release?.();
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["finalize", "append"]);

    runtime.requestApprovalPublication();
    runtime.requestApprovalPublication();
    gate.open = true;
    gate.release?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([
      "finalize",
      "append",
      "finalize",
      "append",
      "reconcile",
    ]);
    await runtime.close();
  });

  it("reports a failed publication and leaves the periodic cycle running", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const errors: Error[] = [];
    let failNext = false;
    const runtime = await startLifecycle(1_000, {
      processing: processing(events, async () => {
        if (failNext) {
          failNext = false;
          throw new Error("append unavailable");
        }
      }),
      on_worker_error: (error) => errors.push(error),
    }, events);
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    failNext = true;
    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(1);
    // A failed wake still requests search: it derives only from the record log.
    expect(events).toEqual(["finalize", "append", "reconcile"]);
    expect(errors.map((error) => error.message)).toEqual(["append unavailable"]);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(events.slice(3)).toEqual([
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
    ]);
    await runtime.close();
  });

  it("cancels a deferred publication when close begins before it starts", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startLifecycle(60_000, {
      processing: processing(events),
    }, events);
    try {
      await vi.advanceTimersByTimeAsync(0);
      events.length = 0;
      runtime.requestApprovalPublication();
      await runtime.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(["api-close"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("ignores publication requests after close", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const errors: Error[] = [];
    const runtime = await startLifecycle(60_000, {
      processing: processing(events),
      on_worker_error: (error) => errors.push(error),
    }, events);
    await vi.advanceTimersByTimeAsync(0);
    await runtime.close();
    events.length = 0;

    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });
});
