import { TELEMETRY_FIXTURE_VOCABULARY_V1 } from "../../../observability/telemetry-fixture-vocabulary-v1.js";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "@echo-brain/organization-authority-kernel/shared/journey-telemetry-v1";
import {
  createStagingJourneyTelemetryTransportV1,
  createStagingJourneyTelemetryTransportFromEnvironmentV1,
  STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1,
  STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
  STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
} from "../../../../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js";
import { STAGING_JOURNEY_METRICS_NAMESPACE_V1 } from "../../../../src/composition/staging/observability/staging-journey-metrics-v1.js";

const RELEASE_SHA = "f7018e16232aa11d24f9ecc880943b0bbb8c6ea2";
const STARTED_AT = "2026-09-02T12:34:56.000Z";
const HEARTBEAT_AT = "2026-09-02T12:35:56.000Z";
const JOURNEY_ID = "1b3c4d5e-6f70-4a12-8b34-5c6d7e8f9012";

function liveness(event: "startup" | "heartbeat", observedAt: string) {
  return {
    schema_version: 1,
    kind: STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
    observed_at: observedAt,
    environment: "staging",
    release_sha: RELEASE_SHA,
    build_number: 42,
    event,
  };
}

describe("staging journey telemetry transport v1", () => {
  it("stays inert until explicitly started, then writes liveness and closes idempotently", () => {
    const lines: string[] = [];
    const times = [STARTED_AT, HEARTBEAT_AT];
    let callback: (() => void) | undefined;
    const cleared: unknown[] = [];
    const intervalId = { timer: "liveness" };
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => {
          lines.push(line);
        },
        now: () => times.shift() ?? HEARTBEAT_AT,
        scheduler: {
          set_interval: (received, intervalMs) => {
            callback = received;
            expect(intervalMs).toBe(
              STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
            );
            return intervalId;
          },
          clear_interval: (id) => cleared.push(id),
        },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );

    expect(transport.enabled).toBe(true);
    expect(transport.identity).toEqual({
      release_sha: RELEASE_SHA,
      build_number: 42,
    });
    expect(lines).toEqual([]);
    expect(callback).toBeUndefined();

    transport.start();
    expect(JSON.parse(lines[0]!)).toMatchObject(liveness("startup", STARTED_AT));
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      _aws: {
        Timestamp: Date.parse(STARTED_AT),
        CloudWatchMetrics: [
          {
            Namespace: STAGING_JOURNEY_METRICS_NAMESPACE_V1,
            Dimensions: [[]],
            Metrics: [{ Name: "JourneyTelemetryAlive", Unit: "Count" }],
          },
        ],
      },
      JourneyTelemetryAlive: 1,
    });
    callback?.();
    expect(JSON.parse(lines[2]!)).toMatchObject(liveness("heartbeat", HEARTBEAT_AT));
    expect(JSON.parse(lines[3] ?? "{}")).toMatchObject({
      _aws: { Timestamp: Date.parse(HEARTBEAT_AT) },
      JourneyTelemetryAlive: 1,
    });

    transport.close();
    transport.close();
    callback?.();
    expect(cleared).toEqual([intervalId]);
    expect(lines).toHaveLength(4);
  });

  it("makes close-before-start inert and prevents a later start from claiming liveness", () => {
    const lines: string[] = [];
    let scheduled = false;
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => {
          lines.push(line);
        },
        now: () => STARTED_AT,
        scheduler: {
          set_interval: () => {
            scheduled = true;
            return 1;
          },
          clear_interval: () => undefined,
        },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );

    transport.close();
    transport.start();
    transport.close();

    expect(lines).toEqual([]);
    expect(scheduled).toBe(false);
  });

  it("delivers journey events before start without emitting liveness", () => {
    const lines: string[] = [];
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => {
          lines.push(line);
        },
        scheduler: {
          set_interval: () => {
            throw new Error("liveness must stay inert before start");
          },
          clear_interval: () => undefined,
        },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    const event = createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 1,
      observed_at: HEARTBEAT_AT,
      context: {
        environment: "staging",
        workflow: "ask",
        release_sha: RELEASE_SHA,
        build_number: 42,
      },
      event: {
        stage: "ask_validation",
        event: "succeeded",
        elapsed_ms: 1,
      },
    }, TELEMETRY_FIXTURE_VOCABULARY_V1);

    transport.observer(event);

    expect(lines[0]).toBe(`${canonicalJson(event)}\n`);
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      StageSucceeded: 1,
      StageClosedLatencyMs: 1,
      workflow: "ask",
      stage: "ask_validation",
    });
    expect(lines.join("\n")).not.toContain(
      STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
    );
  });

  it("fails open without starting telemetry for an invalid deploy identity", () => {
    const lines: string[] = [];
    let scheduled = false;
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA.toUpperCase(), build_number: 0 },
      {
        write: (line) => {
          lines.push(line);
        },
        scheduler: {
          set_interval: () => {
            scheduled = true;
            return 1;
          },
          clear_interval: () => undefined,
        },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );

    expect(transport.enabled).toBe(false);
    expect(transport.identity).toBeNull();
    expect(() =>
      transport.observer({} as JourneyTelemetryEventV1),
    ).not.toThrow();
    expect(() =>
      transport.approved_search_backlog_observer({
        observed_at: STARTED_AT,
        pending_count: 0,
        stuck_count: 0,
        oldest_age_ms: null,
      }),
    ).not.toThrow();
    expect(() => transport.close()).not.toThrow();
    expect(lines).toEqual([]);
    expect(scheduled).toBe(false);
  });

  it("snapshots deploy identity so caller mutation cannot alter later telemetry", () => {
    const identity = { release_sha: RELEASE_SHA, build_number: 42 };
    const lines: string[] = [];
    let callback: (() => void) | undefined;
    const transport = createStagingJourneyTelemetryTransportV1(identity, {
      write: (line) => {
        lines.push(line);
      },
      now: () => STARTED_AT,
      scheduler: {
        set_interval: (received) => {
          callback = received;
          return 1;
        },
        clear_interval: () => undefined,
      },
    }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 });

    identity.release_sha = "b".repeat(40);
    identity.build_number = 999;
    transport.start();
    callback?.();

    expect(transport.identity).toEqual({
      release_sha: RELEASE_SHA,
      build_number: 42,
    });
    const heartbeat = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (value) =>
          value.kind === STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1 &&
          value.event === "heartbeat",
      );
    expect(heartbeat).toMatchObject({
      release_sha: RELEASE_SHA,
      build_number: 42,
      event: "heartbeat",
    });
  });

  it("accepts only canonical immutable image environment identity", () => {
    const valid = createStagingJourneyTelemetryTransportFromEnvironmentV1(
      {
        ECHO_STAGING_JOURNEY_TELEMETRY_V1: "true",
        ECHO_SOURCE_SHA: RELEASE_SHA,
        ECHO_BUILD_NUMBER: "42",
      },
      {
        write: () => undefined,
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, TELEMETRY_FIXTURE_VOCABULARY_V1,
    );
    expect(valid.enabled).toBe(true);
    expect(valid.identity).toEqual({
      release_sha: RELEASE_SHA,
      build_number: 42,
    });

    for (const environment of [
      { ECHO_SOURCE_SHA: RELEASE_SHA, ECHO_BUILD_NUMBER: "42" },
      {
        ECHO_STAGING_JOURNEY_TELEMETRY_V1: "false",
        ECHO_SOURCE_SHA: RELEASE_SHA,
        ECHO_BUILD_NUMBER: "42",
      },
      { ECHO_SOURCE_SHA: RELEASE_SHA, ECHO_BUILD_NUMBER: "01" },
      { ECHO_SOURCE_SHA: RELEASE_SHA, ECHO_BUILD_NUMBER: "0" },
      { ECHO_SOURCE_SHA: RELEASE_SHA, ECHO_BUILD_NUMBER: "1.5" },
      {
        ECHO_SOURCE_SHA: RELEASE_SHA,
        ECHO_BUILD_NUMBER: String(Number.MAX_SAFE_INTEGER + 1),
      },
      { ECHO_SOURCE_SHA: RELEASE_SHA.toUpperCase(), ECHO_BUILD_NUMBER: "42" },
    ]) {
      expect(
        createStagingJourneyTelemetryTransportFromEnvironmentV1(environment, {
          write: () => {
            throw new Error("disabled transport must not write");
          },
        }, TELEMETRY_FIXTURE_VOCABULARY_V1).enabled,
      ).toBe(false);
    }
  });

  it("isolates synchronous and asynchronous writer failures", async () => {
    const validEvent = createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 1,
      observed_at: HEARTBEAT_AT,
      context: {
        environment: "staging",
        workflow: "ask",
        release_sha: RELEASE_SHA,
        build_number: 42,
      },
      event: {
        stage: "ask_validation",
        event: "succeeded",
        elapsed_ms: 1,
      },
    }, TELEMETRY_FIXTURE_VOCABULARY_V1);
    const synchronous = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: () => {
          throw new Error("writer failed");
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    const asynchronous = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: async () => {
          throw new Error("writer rejected");
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );

    synchronous.start();
    asynchronous.start();
    expect(() => synchronous.observer(validEvent)).not.toThrow();
    expect(() => asynchronous.observer(validEvent)).not.toThrow();
    await Promise.resolve();
  });

  it("keeps malformed observer input outside application control flow", () => {
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: () => undefined,
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    const throwingInput = new Proxy({} as JourneyTelemetryEventV1, {
      get: () => {
        throw new Error("malformed event getter");
      },
    });

    transport.start();
    expect(() => transport.observer(null as never)).not.toThrow();
    expect(() => transport.observer(throwingInput)).not.toThrow();
  });

  it("reconstructs and canonically serializes exact journey events without injected fields", () => {
    const lines: string[] = [];
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => {
          lines.push(line);
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    const event = createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID,
      sequence: 3,
      observed_at: HEARTBEAT_AT,
      context: {
        environment: "staging",
        workflow: "ask",
        release_sha: RELEASE_SHA,
        build_number: 42,
      },
      event: {
        stage: "ask_answer",
        event: "succeeded",
        elapsed_ms: 8,
        llm_usage: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          provider_latency_ms: 7,
          input_tokens: 3,
          output_tokens: 2,
          finish_reason: "completed",
        },
      },
    }, TELEMETRY_FIXTURE_VOCABULARY_V1);
    const injected = {
      ...event,
      request_content: "must-not-serialize",
      llm_usage: {
        ...event.llm_usage,
        provider_response: "must-not-serialize",
      },
    } as JourneyTelemetryEventV1;

    transport.start();
    transport.observer(injected);

    expect(lines[2]).toBe(`${canonicalJson(event)}\n`);
    expect(lines[2]).not.toContain("must-not-serialize");
    expect(JSON.parse(lines[2] ?? "{}")).toEqual(event);
    for (const metricLine of lines.slice(3)) {
      expect(metricLine).not.toContain("must-not-serialize");
      expect(metricLine).not.toContain(JOURNEY_ID);
      expect(metricLine).not.toContain(RELEASE_SHA);
      expect(JSON.parse(metricLine)).toHaveProperty("_aws.CloudWatchMetrics");
    }

    for (const mismatched of [
      { ...event, environment: "production" },
      { ...event, release_sha: "a".repeat(40) },
      { ...event, build_number: 43 },
    ]) {
      transport.observer(mismatched as JourneyTelemetryEventV1);
    }
    expect(lines).toHaveLength(5);
  });

  it("writes validated content-free approved-search backlog diagnostics and metrics", () => {
    const lines: string[] = [];
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => {
          lines.push(line);
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    lines.length = 0;

    transport.approved_search_backlog_observer({
      observed_at: HEARTBEAT_AT,
      pending_count: 2,
      stuck_count: 1,
      oldest_age_ms: 600_000,
    });

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      schema_version: 1,
      kind: STAGING_APPROVED_SEARCH_BACKLOG_KIND_V1,
      observed_at: HEARTBEAT_AT,
      environment: "staging",
      pending_count: 2,
      stuck_count: 1,
      oldest_age_ms: 600_000,
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      _aws: {
        Timestamp: Date.parse(HEARTBEAT_AT),
        CloudWatchMetrics: [
          {
            Namespace: STAGING_JOURNEY_METRICS_NAMESPACE_V1,
            Dimensions: [[]],
          },
        ],
      },
      ApprovedSearchPendingCount: 2,
      ApprovedSearchStuckCount: 1,
      ApprovedSearchOldestAgeMs: 600_000,
      ApprovedSearchBacklogCheck: 1,
    });
    const serialized = lines.join("");
    expect(serialized).not.toContain(JOURNEY_ID);
    expect(serialized).not.toContain(RELEASE_SHA);

    expect(() =>
      transport.approved_search_backlog_observer({
        observed_at: "invalid",
        pending_count: 0,
        stuck_count: 1,
        oldest_age_ms: null,
      }),
    ).not.toThrow();
    expect(lines).toHaveLength(2);

    transport.close();
    transport.approved_search_backlog_observer({
      observed_at: HEARTBEAT_AT,
      pending_count: 0,
      stuck_count: 0,
      oldest_age_ms: null,
    });
    expect(lines).toHaveLength(2);
  });
});

const contentTransport = await import(
  "../../../../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js"
);

describe("staging journey content telemetry switch", () => {
  const identity = { release_sha: "a".repeat(40), build_number: 42 };
  const record = {
    journey_id: "123e4567-e89b-42d3-a456-426614174000",
    sequence: 1,
    observed_at: "2026-09-02T17:00:00.000Z",
    release_sha: identity.release_sha,
    build_number: 42,
    stage: "ask_answer" as const,
    content_kind: "answer_output" as const,
    content: { value: { status: "answered" } },
  };

  it("is off by default and writes nothing", () => {
    const lines: string[] = [];
    const transport = contentTransport.createStagingJourneyTelemetryTransportV1(
      identity,
      { write: (line) => void lines.push(line) }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    expect(transport.content_enabled).toBe(false);
    transport.content_observer(record);
    expect(lines).toEqual([]);
  });

  it("writes canonical bounded content records only for the exact identity when enabled", () => {
    const lines: string[] = [];
    const transport = contentTransport.createStagingJourneyTelemetryTransportV1(
      identity,
      { write: (line) => void lines.push(line) },
      { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, content_enabled: true },
    );
    expect(transport.content_enabled).toBe(true);
    transport.content_observer(record);
    transport.content_observer({ ...record, build_number: 43 });
    transport.content_observer({ ...record, journey_id: "nope" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      schema_version: 2,
      kind: "echo-authority-journey-content-v1",
      environment: "staging",
      workflow: "ask",
      journey_id: record.journey_id,
      sequence: 1,
      release_sha: identity.release_sha,
      build_number: 42,
      stage: "ask_answer",
      content_kind: "answer_output",
      truncated: false,
      content: JSON.stringify({ value: { status: "answered" } }),
    });
    transport.close();
    transport.content_observer(record);
    expect(lines).toHaveLength(1);
  });

  it("reads the staging content switch from the immutable image environment", () => {
    const write = () => undefined;
    const base = {
      ECHO_STAGING_JOURNEY_TELEMETRY_V1: "true",
      ECHO_SOURCE_SHA: identity.release_sha,
      ECHO_BUILD_NUMBER: "42",
    };
    const create = contentTransport.createStagingJourneyTelemetryTransportFromEnvironmentV1;
    expect(create(base, { write }).content_enabled).toBe(false);
    expect(
      create({ ...base, ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1: "true" }, { write })
        .content_enabled,
    ).toBe(true);
    expect(
      create({ ...base, ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1: "TRUE" }, { write })
        .content_enabled,
    ).toBe(false);
    // Content telemetry never exists without the content-free transport.
    expect(
      create(
        {
          ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1: "true",
          ECHO_SOURCE_SHA: identity.release_sha,
          ECHO_BUILD_NUMBER: "42",
        },
        { write },
      ).content_enabled,
    ).toBe(false);
  });
});


describe("bounded rejection accounting", () => {
  it("rejects malformed metric/observer inputs and still delivers the next valid event", () => {
    const lines: string[] = [];
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 }, {
        write: (line) => { lines.push(line); }, now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => {} },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    const valid = createJourneyTelemetryEventV1({
      journey_id: JOURNEY_ID, sequence: 1, observed_at: STARTED_AT,
      context: { environment: "staging", workflow: "ask", release_sha: RELEASE_SHA, build_number: 42 },
      event: { stage: "ask_validation", event: "succeeded", elapsed_ms: 1 },
    }, TELEMETRY_FIXTURE_VOCABULARY_V1);
    for (const invalid of [null, new Proxy({}, { get() { throw new Error("private-getter"); } }),
      { ...valid, llm_usage: { provider: "private-provider", model: "private-model", input_tokens: -1 } },
    ]) expect(() => transport.observer(invalid as never)).not.toThrow();
    expect(lines).toEqual([]);
    transport.observer(valid);
    expect(JSON.parse(lines[0]!)).toEqual(valid);
    expect(JSON.parse(lines[1]!)).toMatchObject({ StageSucceeded: 1 });
    transport.start();
    transport.close();
    expect(JSON.parse(lines[2]!)).toMatchObject({
      delivery: { rejected_events: 3, writes_failed: 0, writes_dropped: 0, writes_pending: 0 },
      rejection_counts: { journey_observer: { invalid_journey_event: 3 } },
    });
    expect(lines.join("")).not.toContain("private-");
  });

  it("keeps pending and dropped writes separate from rejection attribution", async () => {
    const lines: string[] = [];
    let heartbeat = () => {};
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let block = true;
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 }, {
        write: (line) => { lines.push(line); return block ? pending : undefined; }, now: () => STARTED_AT,
        scheduler: { set_interval: (fn) => { heartbeat = fn; return 1; }, clear_interval: () => {} },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    transport.start();
    for (let i = 0; i < 500; i += 1) heartbeat();
    expect(JSON.parse(lines[998]!)).toMatchObject({ delivery: { writes_pending: 998, rejected_events: 0 } });
    transport.observer(null as never);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    block = false;
    heartbeat();
    transport.close();
    expect(JSON.parse(lines[1000]!)).toMatchObject({
      delivery: { writes_pending: 0, writes_dropped: 2, writes_failed: 0, rejected_events: 1 },
      rejection_counts: { journey_observer: { invalid_journey_event: 1 } },
    });
  });

  it.each([false, true])("attributes all four origins without logging inputs (content enabled: %s)", (content_enabled) => {
    const lines: string[] = [];
    let heartbeat = () => {};
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: (line) => { lines.push(line); }, now: () => STARTED_AT,
        scheduler: { set_interval: (fn) => { heartbeat = fn; return 1; }, clear_interval: () => {} },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1, content_enabled },
    );
    const malformed = { environment: "staging", release_sha: RELEASE_SHA, build_number: 42, journey_id: "private-invalid-input" };
    expect(() => transport.observer(malformed as never)).not.toThrow();
    expect(() => transport.content_observer(malformed as never)).not.toThrow();
    expect(() => transport.content_observer({
      ...malformed, journey_id: JOURNEY_ID, sequence: 1, observed_at: STARTED_AT,
      stage: "ask_answer", content_kind: "answer_output",
      content: new Proxy({}, { ownKeys() { throw new Error("private-format-error"); } }),
    })).not.toThrow();
    expect(() => transport.observation_failure({ emitter: "meeting_approval_observer", reason: "observation_callback_failure" })).not.toThrow();
    // Even forged callback arguments cannot create dimensions or recursively reject.
    expect(() => transport.observation_failure(new Proxy({} as never, { get() { throw new Error("private-callback-error"); } }))).not.toThrow();
    expect(lines).toEqual([]);
    transport.start();
    heartbeat();
    transport.close();
    const expected = {
      journey_observer: { invalid_journey_event: 1 },
      content_capture: { invalid_content_record: content_enabled ? 1 : 0, content_format_error: content_enabled ? 1 : 0 },
      meeting_approval_observer: { observation_callback_failure: 2 },
    };
    for (const event of lines.map((line) => JSON.parse(line)).filter((event) => event.kind === STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1)) {
      expect(event.rejection_counts).toEqual(expected);
      expect(event.delivery).toMatchObject({ rejected_events: content_enabled ? 5 : 3, writes_failed: 0, writes_pending: 0, writes_dropped: 0 });
      expect(Object.values(event.rejection_counts).flatMap((counts) => Object.values(counts as Record<string, number>)).reduce((a, b) => a + b, 0)).toBe(event.delivery.rejected_events);
    }
    expect(lines).toHaveLength(4); // Existing liveness + EMF only, no per-rejection writes.
    expect(lines.join("")).not.toContain("private-");
    for (const metric of lines.map((line) => JSON.parse(line)).filter((event) => event._aws)) {
      expect(metric).not.toHaveProperty("rejection_counts");
      expect(metric._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    }
  });

  it.each(["synchronous", "asynchronous"])("keeps %s write failures separate from rejections", async (mode) => {
    const lines: string[] = [];
    let fail = true;
    let heartbeat = () => {};
    const transport = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 }, {
        now: () => STARTED_AT,
        write: (line) => {
          if (!fail) { lines.push(line); return; }
          if (mode === "synchronous") throw new Error("private-writer-error");
          return Promise.reject(new Error("private-writer-error"));
        },
        scheduler: { set_interval: (fn) => { heartbeat = fn; return 1; }, clear_interval: () => {} },
      }, { vocabulary: TELEMETRY_FIXTURE_VOCABULARY_V1 },
    );
    transport.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    fail = false;
    heartbeat();
    transport.close();
    expect(JSON.parse(lines[0]!).delivery).toMatchObject({ writes_failed: 2, writes_pending: 0, writes_dropped: 0, rejected_events: 0 });
    expect(JSON.parse(lines[0]!).rejection_counts).toEqual({
      journey_observer: { invalid_journey_event: 0 },
      content_capture: { invalid_content_record: 0, content_format_error: 0 },
      meeting_approval_observer: { observation_callback_failure: 0 },
    });
  });
});
