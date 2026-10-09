import type { CoreRuntimeDetailV1 } from "@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1";

export function coreRuntimeDetail(overrides: Partial<CoreRuntimeDetailV1> = {}): CoreRuntimeDetailV1 {
  return {
    operation_id: "2b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012",
    span_id: "3b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012",
    parent_span_id: null,
    phase: "research_run",
    purpose: "research_run",
    root: true,
    linked_journey_ids: [],
    counts: {},
    result: "answered",
    generation: null,
    source_revision: null,
    cursor: null,
    action: null,
    provider: null,
    model: null,
    finish_reason: null,
    provider_request: null,
    resource_scope: "process_overlap",
    sqlite_lock_time: "unavailable",
    disk_io_latency: "unavailable",
    event_loop_delay: "unavailable",
    ...overrides,
  };
}
