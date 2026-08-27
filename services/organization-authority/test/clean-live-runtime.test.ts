import { describe, expect, it, vi } from "vitest";
import {
  runCleanLiveProcessingCycleV1,
  startCleanLiveRuntime,
  type CleanLiveProcessingCycleV1,
} from "../src/composition/clean-live-runtime.js";
import type { CleanLiveWorkerTelemetryEventV1 } from "../src/processing/clean-v1/clean-live-worker-lifecycle.js";
import type {
  CleanPersonRuntimeConfig,
  RunningCleanPersonRuntime,
} from "../src/composition/clean-person-runtime.js";

const personConfig: CleanPersonRuntimeConfig = {
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
): CleanLiveProcessingCycleV1 {
  return {
    recoverV4Appends: async () => {
      operations.push("recover");
    },
    pollAndStageLiveOnlySource: async () => {
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

function personRuntime(events: string[]): RunningCleanPersonRuntime {
  return {
    address: { address: "127.0.0.1", family: "IPv4", port: 14_000 },
    close: async () => {
      events.push("person-close");
    },
  };
}

describe("clean live runtime", () => {
  it("emits a successful content-free heartbeat for an empty cycle", async () => {
    vi.useFakeTimers();
    const events: CleanLiveWorkerTelemetryEventV1[] = [];
    let now = 1_000;
    const runtime = await startCleanLiveRuntime(
      { person: personConfig, worker_interval_ms: 1_000 },
      {
        processing: processing([]),
        start_person_runtime: async () => personRuntime([]),
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
    expect(JSON.stringify(events)).not.toContain("personConfig");
    await runtime.close();
  });

  it("recovers and prewarms before starting Person, then retains worker ordering", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const runtime = await startCleanLiveRuntime(
      { person: personConfig, worker_interval_ms: 1_000 },
      {
        processing: processing(events),
        start_person_runtime: async () => {
          events.push("person-start");
          return personRuntime(events);
        },
        clear_readable_search_handle: () => events.push("handle-clear"),
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.address.port).toBe(14_000);
    expect(events).toEqual([
      "recover",
      "reconcile",
      "person-start",
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
      "person-start",
      "recover",
      "stage",
      "finalize",
      "append",
      "reconcile",
      "person-close",
      "handle-clear",
    ]);
    vi.useRealTimers();
  });

  it("retries after an interrupted V4 append with recovery before another source poll", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let attempts = 0;
    const errors: string[] = [];
    const runtime = await startCleanLiveRuntime(
      { person: personConfig, worker_interval_ms: 100 },
      {
        processing: processing(events, async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("append interrupted");
        }),
        start_person_runtime: async () => personRuntime(events),
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

    await runCleanLiveProcessingCycleV1(
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

  it("rejects startup, clears the handle, and never starts Person when prewarm fails", async () => {
    const events: string[] = [];
    const startPerson = vi.fn(async () => personRuntime(events));
    await expect(
      startCleanLiveRuntime(
        { person: personConfig, worker_interval_ms: 100 },
        {
          processing: processing(events, undefined, async () => {
            throw new Error("generation reconciliation interrupted");
          }),
          start_person_runtime: startPerson,
          clear_readable_search_handle: () => events.push("handle-clear"),
        },
      ),
    ).rejects.toThrow("generation reconciliation interrupted");
    expect(startPerson).not.toHaveBeenCalled();
    expect(events).toEqual(["recover", "reconcile", "handle-clear"]);
  });

  it("rejects startup before prewarm or Person when append recovery fails", async () => {
    const events: string[] = [];
    const startPerson = vi.fn(async () => personRuntime(events));
    const startupProcessing = processing(events);

    await expect(
      startCleanLiveRuntime(
        { person: personConfig, worker_interval_ms: 100 },
        {
          processing: {
            ...startupProcessing,
            recoverV4Appends: async () => {
              events.push("recover");
              throw new Error("append recovery interrupted");
            },
          },
          start_person_runtime: startPerson,
          clear_readable_search_handle: () => events.push("handle-clear"),
        },
      ),
    ).rejects.toThrow("append recovery interrupted");

    expect(startPerson).not.toHaveBeenCalled();
    expect(events).toEqual(["recover", "handle-clear"]);
  });

  it("does not reconcile after append observes cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();

    await expect(
      runCleanLiveProcessingCycleV1(
        processing(events, async () => {
          controller.abort();
        }),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(events).toEqual(["recover", "stage", "finalize", "append"]);
  });
});
