import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError } from "../../src/processing/core/contracts/adapter.js";
import {
  openMeetingApprovalJourneyStateV1,
  type MeetingApprovalJourneyStateV1,
} from "../../src/composition/meeting-approval-journey-state-v1.js";
import {
  openMeetingApprovalJourneyTelemetryV1,
  STAGING_APPROVED_SEARCH_STUCK_THRESHOLD_MS_V1,
  type MeetingApprovalSearchBacklogObserverV1,
  type MeetingApprovalJourneyTelemetryDependenciesV1,
} from "../../src/composition/meeting-approval-journey-telemetry-v1.js";
import type { JourneyTelemetryEventV1 } from "../../src/shared/journey-telemetry-v1.js";

const RELEASE_SHA = "c".repeat(40);
const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const SECOND_JOURNEY_ID = "2b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";
const SOURCE_STARTED = {
  observed_at: "2026-09-02T12:34:56.000Z",
  monotonic_ms: 10,
} as const;
const SOURCE_CLOSED = "2026-09-02T12:34:56.007Z";
const SOURCE_CARD_STAGED = "2026-09-02T12:35:00.000Z";
const ACTION_STARTED = {
  observed_at: "2026-09-02T12:36:00.000Z",
  monotonic_ms: 100,
} as const;
const ACTION_CLOSED = "2026-09-02T12:36:00.024Z";
const roots: string[] = [];

function stateFile(): string {
  const root = mkdtempSync(join(tmpdir(), "echo-meeting-journey-telemetry-"));
  roots.push(root);
  return join(root, "journey-sidecar.sqlite");
}

function openState(
  path: string,
  uuid: string | (() => string) = JOURNEY_ID,
): MeetingApprovalJourneyStateV1 {
  return openMeetingApprovalJourneyStateV1(path, {
    create_uuid: typeof uuid === "function" ? uuid : () => uuid,
  });
}

function telemetry(
  state: MeetingApprovalJourneyStateV1,
  events: JourneyTelemetryEventV1[],
  dependencies: Omit<
    MeetingApprovalJourneyTelemetryDependenciesV1,
    "state"
  > = {},
  approvedSearchBacklogObserver?: MeetingApprovalSearchBacklogObserverV1,
) {
  return openMeetingApprovalJourneyTelemetryV1(
    {
      state_directory: "/unused-with-injected-state",
      observer: (event) => {
        events.push(event);
      },
      release_sha: RELEASE_SHA,
      build_number: 42,
      extraction_provider: "openrouter",
      extraction_model: "deepseek/deepseek-v3.2",
      ...(approvedSearchBacklogObserver === undefined
        ? {}
        : { approved_search_backlog_observer: approvedSearchBacklogObserver }),
    },
    { state, ...dependencies },
  );
}

async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function source() {
  return {
    source_adapter_id: "source-adapter-private-sentinel",
    source_instance_id: "source-instance-private-sentinel",
    external_id: "source-external-private-sentinel",
    canonical_revision: "source-revision-private-sentinel",
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("meeting approval journey telemetry v1", () => {
  it("emits a deterministic source start and success sequence without serializing business values", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const recorder = telemetry(openState(stateFile()), events, {
      now: () => SOURCE_CLOSED,
      now_ms: () => 17,
    });

    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED);
    expect(intake).toMatchObject({
      journey_id: JOURNEY_ID,
      stage: "meeting_source_intake",
      attempt: 1,
    });
    recorder.bindCandidate(intake!, {
      candidate_id: "candidate-private-sentinel",
      approval_id: "approval-private-sentinel",
    });
    recorder.succeedStage(intake);
    await flushObserver();

    expect(events).toEqual([
      expect.objectContaining({
        journey_id: JOURNEY_ID,
        sequence: 1,
        observed_at: SOURCE_STARTED.observed_at,
        stage: "meeting_source_intake",
        event: "started",
        attempt: 1,
        elapsed_ms: 0,
      }),
      expect.objectContaining({
        journey_id: JOURNEY_ID,
        sequence: 2,
        observed_at: SOURCE_CLOSED,
        stage: "meeting_source_intake",
        event: "succeeded",
        attempt: 1,
        elapsed_ms: 7,
      }),
    ]);
    const serialized = JSON.stringify(events);
    for (const sentinel of [
      "source-adapter-private-sentinel",
      "source-instance-private-sentinel",
      "source-external-private-sentinel",
      "source-revision-private-sentinel",
      "candidate-private-sentinel",
      "approval-private-sentinel",
      "meeting-content-private-sentinel",
      "provider-error-private-sentinel",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("keeps reported zero, cached, and reasoning extraction usage, but falls back safely for an untrusted provider", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const observedAt = [
      "2026-09-02T12:34:56.010Z",
      "2026-09-02T12:34:58.010Z",
      "2026-09-02T12:34:59.010Z",
    ];
    const elapsed = [20, 45, 55];
    const recorder = telemetry(openState(stateFile()), events, {
      now: () => observedAt.shift() ?? "2026-09-02T12:34:59.010Z",
      now_ms: () => elapsed.shift() ?? 35,
    });
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.succeedStage(intake);

    const first = recorder.beginStage(
      { journey_id: intake.journey_id },
      "meeting_extraction",
      { observed_at: "2026-09-02T12:34:58.000Z", monotonic_ms: 40 },
    );
    recorder.succeedExtractionStage(
      first,
      {
        outcome: "succeeded",
        provider: "openrouter",
        model: "deepseek/deepseek-v3.2",
        provider_latency_ms: 19,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 3,
        reasoning_tokens: 2,
        finish_reason: "stop",
      },
      99,
    );
    const second = recorder.beginStage(
      { journey_id: intake.journey_id },
      "meeting_extraction",
      { observed_at: "2026-09-02T12:34:59.000Z", monotonic_ms: 50 },
    );
    recorder.succeedExtractionStage(
      second,
      {
        outcome: "succeeded",
        provider: "other",
        model: "provider/private-model",
        provider_latency_ms: 1,
        input_tokens: 999,
        output_tokens: 999,
        total_tokens: 1_998,
        cached_input_tokens: 999,
        reasoning_tokens: 999,
        finish_reason: "stop",
      },
      91,
    );
    await flushObserver();

    const successes = events.filter(
      (event) =>
        event.stage === "meeting_extraction" && event.event === "succeeded",
    );
    expect(successes).toHaveLength(2);
    expect(successes[0]?.llm_usage).toEqual({
      usage_status: "reported",
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
      provider_latency_ms: 19,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
      finish_reason: "stop",
    });
    expect(successes[1]?.llm_usage).toEqual({
      usage_status: "unavailable",
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
      provider_latency_ms: 91,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
      finish_reason: "unknown",
    });
  });

  it("classifies retryable adapter failures and carries candidate correlation across a restart with human wait separate from machine work", async () => {
    const path = stateFile();
    const firstEvents: JourneyTelemetryEventV1[] = [];
    const first = telemetry(openState(path), firstEvents, {
      now: () => "2026-09-02T12:34:57.010Z",
      now_ms: () => 40,
    });
    const intake = first.beginOrResumeSource(source(), SOURCE_STARTED)!;
    first.bindCandidate(intake, {
      candidate_id: "candidate-private-sentinel",
      approval_id: "approval-private-sentinel",
    });
    const extraction = first.beginStage(intake, "meeting_extraction", {
      observed_at: "2026-09-02T12:34:57.000Z",
      monotonic_ms: 30,
    });
    first.failExtractionStage(
      extraction,
      new AdapterError("rate_limited", "provider-error-private-sentinel", true),
      null,
      12,
    );
    first.close();
    await flushObserver();
    expect(firstEvents.find((event) => event.event === "failed")).toMatchObject(
      {
        stage: "meeting_extraction",
        failure_class: "rate_limited",
        retryable: true,
        llm_usage: { usage_status: "unavailable", provider_latency_ms: 12 },
      },
    );

    const restartEvents: JourneyTelemetryEventV1[] = [];
    const now = ["2026-09-02T13:00:00.000Z", ACTION_CLOSED];
    const monotonic = [80, 124];
    const restarted = telemetry(
      openState(path, SECOND_JOURNEY_ID),
      restartEvents,
      {
        now: () => now.shift() ?? ACTION_CLOSED,
        now_ms: () => monotonic.shift() ?? 124,
      },
    );
    expect(restarted.readForApproval("approval-private-sentinel")).toEqual({
      journey_id: JOURNEY_ID,
    });
    restarted.markCardStaged(
      "approval-private-sentinel",
      SOURCE_CARD_STAGED,
    );
    expect(
      restarted.queueAgeMs(
        "approval-private-sentinel",
        ACTION_STARTED.observed_at,
      ),
    ).toBe(60_000);
    const verify = restarted.beginStageForApproval(
      "approval-private-sentinel",
      "meeting_approval_action_verify",
      ACTION_STARTED,
    );
    restarted.succeedStage(verify, {
      queue_age_ms: restarted.queueAgeMs(
        "approval-private-sentinel",
        ACTION_STARTED.observed_at,
      ),
    });
    await flushObserver();
    expect(restartEvents).toEqual([
      expect.objectContaining({
        sequence: 4,
        stage: "meeting_source_intake",
        event: "failed",
        failure_class: "unknown",
        retryable: true,
      }),
      expect.objectContaining({
        sequence: 5,
        stage: "meeting_approval_action_verify",
        event: "started",
      }),
      expect.objectContaining({
        sequence: 6,
        stage: "meeting_approval_action_verify",
        event: "succeeded",
        elapsed_ms: 24,
        queue_age_ms: 60_000,
      }),
    ]);
    expect(JSON.stringify([...firstEvents, ...restartEvents])).not.toContain(
      "provider-error-private-sentinel",
    );
  });

  it("reconciles an interrupted stage into a safe failed event before allowing its retry", async () => {
    const path = stateFile();
    const beforeRestart = openState(path);
    beforeRestart.beginOrResumeSource({
      source_identity: "restart-source-private-sentinel",
      source_revision: "restart-revision-private-sentinel",
    });
    beforeRestart.reserveStageStart(
      JOURNEY_ID,
      "meeting_extraction",
      SOURCE_STARTED.observed_at,
    );
    beforeRestart.close();

    const events: JourneyTelemetryEventV1[] = [];
    const restarted = telemetry(openState(path, SECOND_JOURNEY_ID), events, {
      now: () => SOURCE_CLOSED,
      now_ms: () => 20,
    });
    const retry = restarted.beginStage(
      { journey_id: JOURNEY_ID },
      "meeting_extraction",
      { observed_at: SOURCE_CARD_STAGED, monotonic_ms: 30 },
    );
    await flushObserver();

    expect(events).toEqual([
      expect.objectContaining({
        journey_id: JOURNEY_ID,
        sequence: 2,
        observed_at: SOURCE_CLOSED,
        stage: "meeting_extraction",
        event: "failed",
        attempt: 1,
        elapsed_ms: 0,
        failure_class: "unknown",
        retryable: true,
        llm_usage: {
          usage_status: "unavailable",
          provider: "openrouter",
          model: "deepseek/deepseek-v3.2",
          provider_latency_ms: 0,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          cached_input_tokens: null,
          reasoning_tokens: null,
          finish_reason: "unknown",
        },
      }),
      expect.objectContaining({
        journey_id: JOURNEY_ID,
        sequence: 3,
        observed_at: SOURCE_CARD_STAGED,
        stage: "meeting_extraction",
        event: "started",
        attempt: 2,
      }),
    ]);
    expect(retry).toMatchObject({ attempt: 2, stage: "meeting_extraction" });
    restarted.close();
  });

  it("records current, superseded, and later published search outcomes without letting observer failures affect the workflow", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const journeyIds = [JOURNEY_ID, SECOND_JOURNEY_ID];
    const state = openState(stateFile(), () => journeyIds.shift() as string);
    const recorder = openMeetingApprovalJourneyTelemetryV1(
      {
        state_directory: "/unused-with-injected-state",
        observer: async (event) => {
          events.push(event);
          if (event.sequence % 2 === 0)
            throw new Error("observer-private-error-sentinel");
        },
        release_sha: RELEASE_SHA,
        build_number: 42,
        extraction_provider: "openrouter",
        extraction_model: "deepseek/deepseek-v3.2",
      },
      {
        state,
        create_uuid: () => JOURNEY_ID,
        now: () => "2026-09-02T12:40:00.000Z",
        now_ms: () => 100,
      },
    );
    const first = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.bindCandidate(first, {
      candidate_id: "candidate-current",
      approval_id: "approval-current",
    });
    recorder.markAwaitingSearch("approval-current");
    const currentAttempts = recorder.beginAwaitingSearch();
    expect(currentAttempts).toHaveLength(1);
    expect(() =>
      recorder.completeAwaitingSearch(currentAttempts, "current"),
    ).not.toThrow();

    const second = recorder.beginOrResumeSource(
      { ...source(), external_id: "source-external-second" },
      SOURCE_STARTED,
    )!;
    recorder.bindCandidate(second, {
      candidate_id: "candidate-later",
      approval_id: "approval-later",
    });
    recorder.markAwaitingSearch("approval-later");
    const supersededAttempts = recorder.beginAwaitingSearch();
    expect(supersededAttempts).toHaveLength(1);
    expect(() =>
      recorder.completeAwaitingSearch(supersededAttempts, "superseded"),
    ).not.toThrow();
    const publishedAttempts = recorder.beginAwaitingSearch();
    expect(publishedAttempts).toHaveLength(1);
    expect(() =>
      recorder.completeAwaitingSearch(publishedAttempts, "published"),
    ).not.toThrow();
    await flushObserver();

    expect(
      events
        .filter(
          (event) =>
            event.stage === "meeting_search_publication" &&
            event.event === "succeeded",
        )
        .map((event) => event.outcome),
    ).toEqual(["current", "superseded", "published"]);
    expect(JSON.stringify(events)).not.toContain(
      "observer-private-error-sentinel",
    );
  });

  it("closes failed search work and leaves the record pending for the next reconciliation", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const recorder = telemetry(openState(stateFile()), events, {
      now: () => "2026-09-02T12:40:00.000Z",
      now_ms: () => 100,
    });
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.bindCandidate(intake, {
      candidate_id: "candidate-search-failure",
      approval_id: "approval-search-failure",
    });
    recorder.markAwaitingSearch("approval-search-failure");

    const failedAttempts = recorder.beginAwaitingSearch();
    expect(failedAttempts).toHaveLength(1);
    recorder.failAwaitingSearch(
      failedAttempts,
      new AdapterError(
        "temporarily_unavailable",
        "search-private-sentinel",
        true,
      ),
    );

    const retryAttempts = recorder.beginAwaitingSearch();
    expect(retryAttempts).toHaveLength(1);
    expect(retryAttempts[0]).toMatchObject({
      journey_id: intake.journey_id,
      stage: "meeting_search_publication",
      attempt: 2,
    });
    await flushObserver();

    expect(
      events
        .filter((event) => event.stage === "meeting_search_publication")
        .map((event) => [event.event, event.attempt, event.failure_class]),
    ).toEqual([
      ["started", 1, null],
      ["failed", 1, "unavailable"],
      ["started", 2, null],
    ]);
    expect(JSON.stringify(events)).not.toContain("search-private-sentinel");
  });

  it("clears a completed durable search marker even after its telemetry attempt budget is exhausted", () => {
    const state = openState(stateFile());
    const recorder = telemetry(state, [], {
      now: () => "2026-09-02T12:40:00.000Z",
      now_ms: () => 100,
    });
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.bindCandidate(intake, {
      candidate_id: "candidate-search-attempt-cap",
      approval_id: "approval-search-attempt-cap",
    });
    recorder.markAwaitingSearch("approval-search-attempt-cap");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const attempts = recorder.beginAwaitingSearch();
      expect(attempts).toHaveLength(1);
      recorder.failAwaitingSearch(attempts, new Error("search transport failed"));
    }
    const capped = recorder.beginAwaitingSearch();
    expect(capped).toEqual([]);
    recorder.completeAwaitingSearch(capped, "published");

    expect(state.listApprovedRecordsAwaitingSearch()).toEqual([]);
    recorder.close();
  });

  it("classifies an aborted extraction as cancelled", async () => {
    const events: JourneyTelemetryEventV1[] = [];
    const recorder = telemetry(openState(stateFile()), events, {
      now: () => SOURCE_CLOSED,
      now_ms: () => 17,
    });
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    const extraction = recorder.beginStage(intake, "meeting_extraction", SOURCE_STARTED);
    recorder.failExtractionStage(
      extraction,
      new DOMException("operator cancelled", "AbortError"),
      null,
      0,
    );
    await flushObserver();

    expect(events.at(-1)).toMatchObject({
      stage: "meeting_extraction",
      event: "failed",
      failure_class: "cancelled",
      retryable: false,
    });
    recorder.close();
  });

  it("reports explicit zero and thresholded approved-search backlog snapshots without identifiers", () => {
    const events: JourneyTelemetryEventV1[] = [];
    const snapshots: unknown[] = [];
    let now = "2026-09-02T12:40:00.000Z";
    const recorder = telemetry(
      openState(stateFile()),
      events,
      {
        now: () => now,
        now_ms: () => 100,
      },
      (snapshot) => {
        snapshots.push(snapshot);
      },
    );
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.bindCandidate(intake, {
      candidate_id: "candidate-backlog-private-sentinel",
      approval_id: "approval-backlog-private-sentinel",
    });

    recorder.markAwaitingSearch("approval-backlog-private-sentinel");
    now = new Date(
      Date.parse(now) + STAGING_APPROVED_SEARCH_STUCK_THRESHOLD_MS_V1,
    ).toISOString();
    const attempts = recorder.beginAwaitingSearch();
    recorder.completeAwaitingSearch(attempts, "published");

    expect(snapshots).toEqual([
      {
        observed_at: "2026-09-02T12:40:00.000Z",
        pending_count: 1,
        stuck_count: 0,
        oldest_age_ms: 0,
      },
      {
        observed_at: "2026-09-02T12:45:00.000Z",
        pending_count: 1,
        stuck_count: 1,
        oldest_age_ms: STAGING_APPROVED_SEARCH_STUCK_THRESHOLD_MS_V1,
      },
      {
        observed_at: "2026-09-02T12:45:00.000Z",
        pending_count: 0,
        stuck_count: 0,
        oldest_age_ms: null,
      },
    ]);
    const serialized = JSON.stringify(snapshots);
    expect(serialized).not.toContain(JOURNEY_ID);
    expect(serialized).not.toContain("candidate-backlog-private-sentinel");
    expect(serialized).not.toContain("approval-backlog-private-sentinel");
  });

  it("keeps backlog observer failures outside approval and search control flow", async () => {
    const recorder = telemetry(
      openState(stateFile()),
      [],
      {
        now: () => "2026-09-02T12:40:00.000Z",
        now_ms: () => 100,
      },
      async () => {
        throw new Error("backlog-observer-private-sentinel");
      },
    );
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED)!;
    recorder.bindCandidate(intake, {
      candidate_id: "candidate-backlog-failure",
      approval_id: "approval-backlog-failure",
    });

    expect(() =>
      recorder.markAwaitingSearch("approval-backlog-failure"),
    ).not.toThrow();
    const attempts = recorder.beginAwaitingSearch();
    expect(attempts).toHaveLength(1);
    expect(() =>
      recorder.failAwaitingSearch(attempts, new Error("search failed")),
    ).not.toThrow();
    await flushObserver();
  });

  it("contains synchronous observer throws as well", async () => {
    const state = openState(stateFile());
    const recorder = openMeetingApprovalJourneyTelemetryV1(
      {
        state_directory: "/unused-with-injected-state",
        observer: () => {
          throw new Error("observer-private-error-sentinel");
        },
        release_sha: RELEASE_SHA,
        build_number: 42,
        extraction_provider: "openrouter",
        extraction_model: "deepseek/deepseek-v3.2",
      },
      { state, now: () => SOURCE_CLOSED, now_ms: () => 17 },
    );
    const intake = recorder.beginOrResumeSource(source(), SOURCE_STARTED);
    expect(() => recorder.succeedStage(intake)).not.toThrow();
    await flushObserver();
  });
});
