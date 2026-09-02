import { canonicalJson } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  createJourneyTelemetryEventV1,
  type JourneyTelemetryEventV1,
} from "../../../../src/shared/journey-telemetry-v1.js";
import {
  createStagingJourneyTelemetryTransportV1,
  createStagingJourneyTelemetryTransportFromEnvironmentV1,
  STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1,
  STAGING_JOURNEY_TELEMETRY_LIVENESS_KIND_V1,
} from "../../../../src/composition/staging/observability/staging-journey-telemetry-transport-v1.js";

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
  it("writes exact startup and fixed-cadence heartbeat JSON lines, then closes idempotently", () => {
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
            expect(intervalMs).toBe(STAGING_JOURNEY_TELEMETRY_HEARTBEAT_INTERVAL_MS_V1);
            return intervalId;
          },
          clear_interval: (id) => cleared.push(id),
        },
      },
    );

    expect(transport.enabled).toBe(true);
    expect(transport.identity).toEqual({
      release_sha: RELEASE_SHA,
      build_number: 42,
    });
    expect(lines).toEqual([`${canonicalJson(liveness("startup", STARTED_AT))}\n`]);
    callback?.();
    expect(lines).toEqual([
      `${canonicalJson(liveness("startup", STARTED_AT))}\n`,
      `${canonicalJson(liveness("heartbeat", HEARTBEAT_AT))}\n`,
    ]);

    transport.close();
    transport.close();
    callback?.();
    expect(cleared).toEqual([intervalId]);
    expect(lines).toHaveLength(2);
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
      },
    );

    expect(transport.enabled).toBe(false);
    expect(transport.identity).toBeNull();
    expect(() => transport.observer({} as JourneyTelemetryEventV1)).not.toThrow();
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
    });

    identity.release_sha = "b".repeat(40);
    identity.build_number = 999;
    callback?.();

    expect(transport.identity).toEqual({
      release_sha: RELEASE_SHA,
      build_number: 42,
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
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
      },
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
        }).enabled,
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
    });
    const synchronous = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: () => {
          throw new Error("writer failed");
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      },
    );
    const asynchronous = createStagingJourneyTelemetryTransportV1(
      { release_sha: RELEASE_SHA, build_number: 42 },
      {
        write: async () => {
          throw new Error("writer rejected");
        },
        now: () => STARTED_AT,
        scheduler: { set_interval: () => 1, clear_interval: () => undefined },
      },
    );

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
      },
    );
    const throwingInput = new Proxy({} as JourneyTelemetryEventV1, {
      get: () => {
        throw new Error("malformed event getter");
      },
    });

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
      },
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
    });
    const injected = {
      ...event,
      request_content: "must-not-serialize",
      llm_usage: { ...event.llm_usage, provider_response: "must-not-serialize" },
    } as JourneyTelemetryEventV1;

    transport.observer(injected);

    expect(lines[1]).toBe(`${canonicalJson(event)}\n`);
    expect(lines[1]).not.toContain("must-not-serialize");
    expect(JSON.parse(lines[1] ?? "{}")).toEqual(event);

    for (const mismatched of [
      { ...event, environment: "production" },
      { ...event, release_sha: "a".repeat(40) },
      { ...event, build_number: 43 },
    ]) {
      transport.observer(mismatched as JourneyTelemetryEventV1);
    }
    expect(lines).toHaveLength(2);
  });
});
