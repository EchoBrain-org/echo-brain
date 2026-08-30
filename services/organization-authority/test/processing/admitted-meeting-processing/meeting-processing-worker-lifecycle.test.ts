import { describe, expect, it } from "vitest";
import {
  MeetingProcessingWorkerLifecycleV1,
  type MeetingProcessingWorkerTelemetryEventV1,
} from "../../../src/processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.js";
import { AdapterError } from "../../../src/processing/core/contracts/adapter.js";

describe("admitted processing worker lifecycle", () => {
  it("emits only closed lifecycle fields and keeps failure contents out", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    let now = 1_000;
    const lifecycle = new MeetingProcessingWorkerLifecycleV1(
      (event) => events.push(event),
      () => now,
    );

    lifecycle.startCycle();
    await lifecycle.runPhase("source_intake", async () => {
      now += 12;
    });
    now += 8;
    const failure = new Error(
      "meeting-title-sentinel prompt-sentinel token-sentinel stack-sentinel",
    );
    lifecycle.failCycle(failure);

    const encoded = JSON.stringify(events);
    for (const forbidden of [
      "meeting-title-sentinel",
      "prompt-sentinel",
      "token-sentinel",
      "stack-sentinel",
      "Error",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(events).toEqual([
      {
        schema_version: 1,
        kind: "echo-clean-live-worker-cycle-v1",
        event: "started",
        elapsed_ms: 0,
      },
      {
        schema_version: 1,
        kind: "echo-clean-live-worker-phase-v1",
        event: "started",
        cycle_phase: "source_intake",
        elapsed_ms: 0,
      },
      {
        schema_version: 1,
        kind: "echo-clean-live-worker-phase-v1",
        event: "succeeded",
        cycle_phase: "source_intake",
        elapsed_ms: 12,
      },
      {
        schema_version: 1,
        kind: "echo-clean-live-worker-cycle-v1",
        event: "failed",
        elapsed_ms: 20,
        failure_class: "unknown",
        retryable: true,
      },
    ]);
  });

  it("leaves retries untouched when a telemetry observer fails", async () => {
    const lifecycle = new MeetingProcessingWorkerLifecycleV1(() => {
      throw new Error("observer failure");
    });

    lifecycle.startCycle();
    await expect(
      lifecycle.runPhase("record_append", async () => undefined),
    ).resolves.toBeUndefined();
    lifecycle.succeedCycle();
  });

  it("maps an internal rate-limit signal to a bounded retryable class", async () => {
    const events: MeetingProcessingWorkerTelemetryEventV1[] = [];
    const lifecycle = new MeetingProcessingWorkerLifecycleV1(
      (event) => events.push(event),
      () => 1_000,
    );

    await expect(
      lifecycle.runPhase("extraction", async () => {
        throw new AdapterError("rate_limited", "detail=private-sentinel", true);
      }),
    ).rejects.toThrow("private-sentinel");

    expect(events.at(-1)).toEqual({
      schema_version: 1,
      kind: "echo-clean-live-worker-phase-v1",
      event: "failed",
      cycle_phase: "extraction",
      elapsed_ms: 0,
      failure_class: "rate_limited",
      retryable: true,
    });
    expect(JSON.stringify(events)).not.toContain("private-sentinel");
  });
});
