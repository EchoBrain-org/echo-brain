import { describe, expect, it, vi } from "vitest";
import {
  runOrganizationAuthorityApprovalPublicationV1,
  runOrganizationAuthorityProcessingCycleV1,
  startOrganizationAuthorityServiceLifecycle,
  type OrganizationAuthorityProcessingCycleV1,
} from "../src/composition/organization-authority-service-lifecycle.js";
import type { MeetingProcessingWorkerTelemetryEventV1 } from "../src/processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";
import { AdapterError } from "../src/processing/core/contracts/adapter.js";
import type {
  OrganizationAuthorityApiRuntimeConfig,
  RunningOrganizationAuthorityApiRuntime,
} from "../src/composition/organization-authority-api-runtime.js";

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

describe("Organization Authority service lifecycle", () => {
  it("emits a successful content-free heartbeat for an empty cycle", async () => {
    vi.useFakeTimers();
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let now = 1_000;
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 1_000 },
      {
        processing: processing([]),
        start_api_runtime: async () => apiRuntime([]),
        on_worker_telemetry: (event) => events.push(event),
        worker_telemetry_now: () => now,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    now += 25;

    expect(events).toContainEqual({
      schema_version: 1,
      kind: "echo-clean-live-worker-cycle-v1",
      event: "succeeded",
      elapsed_ms: 0,
    });
    expect(JSON.stringify(events)).not.toContain("apiConfig");
    await runtime.close();
  });

  it("recovers and prewarms before starting Person, then retains worker ordering", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 1_000 },
      {
        processing: processing(events),
        start_api_runtime: async () => {
          events.push("api-start");
          return apiRuntime(events);
        },
        clear_readable_search_handle: () => events.push("handle-clear"),
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.address.port).toBe(14_000);
    expect(events).toEqual([
      "recover",
      "reconcile",
      "api-start",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
    ]);

    await runtime.close();
    expect(events).toEqual([
      "recover",
      "reconcile",
      "api-start",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
      "api-close",
      "handle-clear",
    ]);
    vi.useRealTimers();
  });

  it("retries after an interrupted V4 append with recovery before another source poll", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let attempts = 0;
    const errors: string[] = [];
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 100 },
      {
        processing: processing(events, async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("append interrupted");
        }),
        start_api_runtime: async () => apiRuntime(events),
        on_worker_error: (error) => {
          errors.push(error.message);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      "recover",
      "reconcile",
      "recover",
      "stage",
      "finalize",
      "append",
    ]);
    expect(errors).toEqual(["append interrupted"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([
      "recover",
      "reconcile",
      "recover",
      "stage",
      "finalize",
      "append",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
    ]);
    expect(errors).toEqual(["append interrupted"]);

    await runtime.close();
    vi.useRealTimers();
  });

  it("reconciles once after a coalesced append phase", async () => {
    const events: string[] = [];

    await runOrganizationAuthorityProcessingCycleV1(
      processing(events, async () => {
        events.push("append:one");
        events.push("append:two");
      }),
      new AbortController().signal,
    );

    expect(events).toEqual([
      "recover",
      "stage",
      "finalize",
      "append",
      "append:one",
      "append:two",
      "reconcile",
    ]);
  });

  it("rejects startup, clears the handle, and never starts the API when prewarm fails", async () => {
    const events: string[] = [];
    const telemetry: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const startApi = vi.fn(async () => apiRuntime(events));
    await expect(
      startOrganizationAuthorityServiceLifecycle(
        { api: apiConfig, worker_interval_ms: 100 },
        {
          processing: processing(events, undefined, async () => {
            throw new Error("generation reconciliation interrupted");
          }),
          start_api_runtime: startApi,
          on_worker_telemetry: (event) => telemetry.push(event),
          clear_readable_search_handle: () => events.push("handle-clear"),
        },
      ),
    ).rejects.toThrow("generation reconciliation interrupted");
    expect(startApi).not.toHaveBeenCalled();
    expect(events).toEqual(["recover", "reconcile", "handle-clear"]);
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
      startOrganizationAuthorityServiceLifecycle(
        { api: apiConfig, worker_interval_ms: 100 },
        {
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
        },
      ),
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
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 100 },
      {
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
        start_api_runtime: async () => apiRuntime([]),
        on_worker_telemetry: (event) => telemetry.push(event),
      },
    );
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
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 100 },
      {
        processing: processing([], async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new AdapterError("invalid_config", "private adapter sentinel", false);
          }
        }),
        start_api_runtime: async () => apiRuntime([]),
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
      },
    );
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

    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(2);
    expect(telemetry).toContainEqual(
      expect.objectContaining({
        kind: "echo-clean-live-worker-cycle-v1",
        event: "succeeded",
      }),
    );
    await runtime.close();
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

  it("publishes only the approval phases, never source intake", async () => {
    const events: string[] = [];

    await runOrganizationAuthorityApprovalPublicationV1(
      processing(events),
      new AbortController().signal,
    );

    expect(events).toEqual(["finalize", "append", "reconcile"]);
  });

  it("publishes a requested approval without waiting for the periodic cycle", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 60_000 },
      {
        processing: processing(events),
        start_api_runtime: async () => apiRuntime(events),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);

    // No 60 s tick has elapsed, yet the approval phases ran, and no source
    // poll ran with them.
    expect(events).toEqual(["finalize", "append", "reconcile"]);
    await runtime.close();
    vi.useRealTimers();
  });

  it("coalesces requests that arrive while one is waiting for the gate", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let releaseStage: (() => void) | undefined;
    const slow = processing(events);
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 60_000 },
      {
        processing: {
          ...slow,
          pollAndStageAdmittedMeetings: async () => {
            events.push("stage");
            await new Promise<void>((resolve) => {
              releaseStage = resolve;
            });
          },
        },
        start_api_runtime: async () => apiRuntime(events),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    // The first periodic cycle is now parked inside source intake.
    expect(events.at(-1)).toBe("stage");
    events.length = 0;

    runtime.requestApprovalPublication();
    runtime.requestApprovalPublication();
    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);

    releaseStage?.();
    await vi.advanceTimersByTimeAsync(0);

    // The cycle finishes its own phases first, then exactly one publication.
    expect(events).toEqual([
      "finalize",
      "append",
      "reconcile",
      "finalize",
      "append",
      "reconcile",
    ]);
    await runtime.close();
    vi.useRealTimers();
  });

  it("schedules exactly one follow-up for a request made mid-publication", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const gate: { release?: () => void; open: boolean } = { open: false };
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 60_000 },
      {
        processing: processing(events, async () => {
          if (gate.open) return;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }),
        start_api_runtime: async () => apiRuntime(events),
      },
    );
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
      "reconcile",
      "finalize",
      "append",
      "reconcile",
    ]);
    await runtime.close();
    vi.useRealTimers();
  });

  it("reports a failed publication and leaves the periodic cycle running", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const errors: Error[] = [];
    let failNext = false;
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 1_000 },
      {
        processing: processing(events, async () => {
          if (failNext) {
            failNext = false;
            throw new Error("append unavailable");
          }
        }),
        start_api_runtime: async () => apiRuntime(events),
        on_worker_error: (error) => errors.push(error),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    events.length = 0;

    failNext = true;
    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["finalize", "append"]);
    expect(errors.map((error) => error.message)).toEqual(["append unavailable"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.slice(2)).toEqual([
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
    ]);
    await runtime.close();
    vi.useRealTimers();
  });

  it("cancels a deferred publication when close begins before it starts", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 60_000 },
      {
        processing: processing(events),
        start_api_runtime: async () => apiRuntime(events),
      },
    );
    let closed = false;
    try {
      await vi.advanceTimersByTimeAsync(0);
      events.length = 0;
      runtime.requestApprovalPublication();
      await runtime.close();
      closed = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(["api-close"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!closed) await runtime.close();
      vi.useRealTimers();
    }
  });

  it("ignores publication requests after close", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const errors: Error[] = [];
    const runtime = await startOrganizationAuthorityServiceLifecycle(
      { api: apiConfig, worker_interval_ms: 60_000 },
      {
        processing: processing(events),
        start_api_runtime: async () => apiRuntime(events),
        on_worker_error: (error) => errors.push(error),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await runtime.close();
    events.length = 0;

    runtime.requestApprovalPublication();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
    vi.useRealTimers();
  });
});
