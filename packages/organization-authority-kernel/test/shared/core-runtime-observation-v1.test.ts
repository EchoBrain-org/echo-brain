import {
  annotateCoreRuntimeV1,
  coreRuntimeIdentityV1,
  normalizeCoreRuntimeDetailV1,
  observeCoreRuntimeSyncV1,
  observeCoreRuntimeV1,
  type CoreRuntimeObservationV1
} from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";
import { SerializedMeetingProcessingWorker } from "@echo-brain/organization-processing/admitted-meeting-processing/serialized-meeting-processing-worker";
import { describe, expect, it } from "vitest";
const linked = "11111111-1111-4111-8111-111111111111";
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("core runtime observations", () => {
  it('links meeting and approval spans using hashes and rejects raw identities or delivery labels', async () => {
    const events: CoreRuntimeObservationV1[] = [];
    const meeting_id = coreRuntimeIdentityV1('meeting', 'PRIVATE-MEETING'), approval_id = coreRuntimeIdentityV1('approval', 'PRIVATE-APPROVAL');
    await observeCoreRuntimeV1('extraction', async () => {
      annotateCoreRuntimeV1({ meeting_id, approval_id, attempt: 2 });
      await observeCoreRuntimeV1('approval_delivery', async () => {
        annotateCoreRuntimeV1({ approval_surface: 'slack', delivery_step: 'publish_card', result: 'done' });
      });
    }, { observer: event => { events.push(event); } });
    const delivery = events.find(event => event.phase === 'approval_delivery' && event.event === 'succeeded')!;
    expect(delivery).toMatchObject({ meeting_id, approval_id, attempt: 2, approval_surface: 'slack', delivery_step: 'publish_card', result: 'done' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(() => normalizeCoreRuntimeDetailV1({ ...delivery, grounding_stage: 'PRIVATE QUOTE' as 'evidence_quote' })).toThrow();
    expect(() => normalizeCoreRuntimeDetailV1({ ...delivery, meeting_id: 'PRIVATE-MEETING' })).toThrow();
    expect(() => normalizeCoreRuntimeDetailV1({ ...delivery, approval_id: 'PRIVATE-APPROVAL' })).toThrow();
    expect(() => normalizeCoreRuntimeDetailV1({ ...delivery, delivery_step: 'PRIVATE' as 'publish_card' })).toThrow();
    expect(() => normalizeCoreRuntimeDetailV1({ ...delivery, approval_surface: 'PRIVATE' as 'slack' })).toThrow();
  });

  it.each([
    [Object.assign(new Error("PRIVATE"), { name: "AgenticAskDeadlineErrorV1" }), "timeout"],
    [Object.assign(new Error("PRIVATE"), { name: "AbortError" }), "cancelled"],
    [{ code: "stale_access_state" }, "authorization"],
    [{ code: "invalid_request" }, "invalid_request"],
    [{ code: "invalid_output" }, "invalid_output"],
    [{ diagnostic: { failure_class: "adapter_http", http_status: 429 } }, "rate_limited"],
    [{ diagnostic: { failure_class: "adapter_provider_error", http_status: 503 } }, "unavailable"],
    [{ diagnostic: { failure_class: "adapter_transport" } }, "unavailable"],
    [{ diagnostic: { failure_class: "adapter_json" } }, "invalid_output"],
    [{ diagnostic: { failure_class: "adapter_refusal" } }, "provider_failure"],
    [new Error("PRIVATE"), "failed"],
    [new Proxy({}, { get() { throw new Error("PRIVATE"); } }), "failed"],
  ])("classifies research failures through finite shared metadata (%#)", async (error, result) => {
    const events: CoreRuntimeObservationV1[] = [];
    await expect(observeCoreRuntimeV1("research_run", async () => { throw error; }, { observer: event => { events.push(event); } })).rejects.toBe(error);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ event: "failed", result });
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  });

  it("round-trips only finite live-source categories and preserves legacy observations", async () => {
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("evidence_connection", async () => {
      annotateCoreRuntimeV1({ evidence_source: "ticket", result: "verified" });
    }, { observer: event => { events.push(event); } });
    expect(normalizeCoreRuntimeDetailV1(events[0]!)).not.toHaveProperty("evidence_source");
    expect(normalizeCoreRuntimeDetailV1(events[1]!)).toMatchObject({ evidence_source: "ticket", result: "verified" });
    await observeCoreRuntimeV1("evidence_connection", async () => {
      annotateCoreRuntimeV1({ evidence_source: "page", result: "verified" });
    }, { observer: event => { events.push(event); } });
    expect(normalizeCoreRuntimeDetailV1(events.at(-1)!)).toMatchObject({ evidence_source: "page", result: "verified" });
    expect(() => normalizeCoreRuntimeDetailV1({ ...events[1]!, evidence_source: "private-provider-url" as "ticket" })).toThrow("invalid core runtime observation");
  });

  it("admits only bounded upstream rate-limit attribution and numeric hints", async () => {
    const events: CoreRuntimeObservationV1[] = [];
    await observeCoreRuntimeV1("http_request", async () => {
      annotateCoreRuntimeV1({
        upstream_service: "nango",
        upstream_operation: "connection_read",
        upstream_rate_limit_reason: "burst",
        counts: { upstream_retry_after_seconds: 30, upstream_rate_limit: 100, upstream_rate_remaining: 0, upstream_rate_reset_unix_seconds: 1_790_000_000 },
      });
    }, { observer: event => { events.push(event); } });
    expect(normalizeCoreRuntimeDetailV1(events.at(-1)!)).toMatchObject({
      upstream_service: "nango", upstream_operation: "connection_read", upstream_rate_limit_reason: "burst",
      counts: { upstream_retry_after_seconds: 30, upstream_rate_limit: 100, upstream_rate_remaining: 0, upstream_rate_reset_unix_seconds: 1_790_000_000 },
    });
    expect(() => normalizeCoreRuntimeDetailV1({ ...events.at(-1)!, upstream_service: "https://private.example" as "nango" })).toThrow("invalid core runtime observation");
    expect(() => normalizeCoreRuntimeDetailV1({ ...events.at(-1)!, upstream_operation: "raw_header" as "connection_read" })).toThrow("invalid core runtime observation");
    expect(() => normalizeCoreRuntimeDetailV1({ ...events.at(-1)!, upstream_rate_limit_reason: "X-RateLimit-Reason: private" as "burst" })).toThrow("invalid core runtime observation");
    expect(() => normalizeCoreRuntimeDetailV1({ ...events.at(-1)!, counts: { ...events.at(-1)!.counts, upstream_retry_after_seconds: 1.5 } })).toThrow("invalid core runtime count");
  });

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
