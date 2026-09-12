import {
  annotateCoreRuntimeV1,
  observeCoreRuntimeSyncV1,
  observeCoreRuntimeV1,
  type CoreRuntimeObservationV1
} from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { SerializedMeetingProcessingWorker } from "@echo-brain/organization-processing/admitted-meeting-processing/serialized-meeting-processing-worker";
import { describe, expect, it } from "vitest";
const linked = "11111111-1111-4111-8111-111111111111";
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("core runtime observations", () => {
  it("keeps concurrent operations separate, links shared work, and isolates throwing observers", async () => {
    const events: CoreRuntimeObservationV1[] = [];
    const scope = { observer: (event: CoreRuntimeObservationV1) => { events.push(event); } };
    await Promise.all([1, 2].map(() => observeCoreRuntimeV1("worker_execution", async () => {
      annotateCoreRuntimeV1({ linked_journey_ids: [linked] });
      await observeCoreRuntimeV1("search_reconciliation", async () => {
        observeCoreRuntimeSyncV1("search_build", () => 42);
      });
    }, scope)));
    const roots = events.filter((event) => event.root && event.event === "started");
    expect(new Set(roots.map((event) => event.operation_id)).size).toBe(2);
    expect(events.filter((event) => event.phase === "search_build")).toHaveLength(4);
    expect(events.filter((event) => event.phase === "search_build").every((event) => event.linked_journey_ids.includes(linked))).toBe(true);
    await expect(observeCoreRuntimeV1("search_reconciliation", async () => 42, { observer: () => { throw new Error("observer failure"); } })).resolves.toBe(42);
    const failure = new Error("business failure");
    await expect(observeCoreRuntimeV1("search_reconciliation", async () => { throw failure; }, { observer: async () => { throw new Error("observer failure"); } })).rejects.toBe(failure);
  });


  it("keeps queued worker traces complete after the scheduling HTTP request finishes", async () => {
    const events: CoreRuntimeObservationV1[] = [];
    const scope = { observer: (event: CoreRuntimeObservationV1) => { events.push(event); } };
    const worker = new SerializedMeetingProcessingWorker({ runCycle: async () => {}, observation: scope });
    await flush();
    events.length = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = worker.runExclusive(() => gate);
    let queued!: Promise<number>;
    await observeCoreRuntimeV1("http_request", async () => {
      queued = worker.runExclusive(async () => 42);
    }, scope);
    release();
    await first;
    await expect(queued).resolves.toBe(42);
    const roots = events.filter((event) => event.root && event.event === "started");
    expect(new Set(roots.map((event) => event.operation_id)).size).toBe(3);
    for (const root of roots) {
      expect(events).toContainEqual(expect.objectContaining({ operation_id: root.operation_id, root: true, event: "succeeded" }));
    }
    expect(events).toContainEqual(expect.objectContaining({ phase: "worker_request", event: "succeeded", counts: expect.objectContaining({ gate_wait_ms: expect.any(Number), pending_depth: 1 }) }));
    await worker.close();
  });
});
