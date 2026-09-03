import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const mod = require(
  resolve(
    import.meta.dirname,
    "../../deploy/organization-authority/staging-journey-explorer-handler-v1.cjs",
  ),
) as {
  createStagingJourneyExplorerHandlerV1(
    options: Record<string, unknown>,
  ): (event: unknown) => Promise<Record<string, unknown> | string>;
};
class Start {
  public constructor(public readonly input: Record<string, unknown>) {}
}
class Get {
  public constructor(public readonly input: Record<string, unknown>) {}
}
class Stop {
  public constructor(public readonly input: Record<string, unknown>) {}
}
const commands = {
  StartQueryCommand: Start,
  GetQueryResultsCommand: Get,
  StopQueryCommand: Stop,
};
const group = "/echo-brain/authority/authority-staging.echobrain.org";
const endpoint =
  "arn:aws:lambda:us-west-2:012345678901:function:customWidget-echo-staging-journey-explorer-v1";
const now = Date.parse("2026-09-02T12:00:00.000Z");
const id = "11111111-1111-4111-8111-111111111111";
function row(
  values: Record<string, string | number | boolean | null | undefined>,
) {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([field, value]) => ({ field, value: String(value) }));
}
function event(
  values: Record<string, string | number | boolean | null | undefined> = {},
) {
  return row({
    journey_id: id,
    environment: "staging",
    schema_version: 1,
    sequence: 1,
    release_sha: "a".repeat(40),
    build_number: 42,
    workflow: "ask",
    stage: "ask_response",
    event: "succeeded",
    outcome: "answered",
    observed_at: "2026-09-02T11:59:00.000Z",
    elapsed_ms: 4,
    attempt: 1,
    ...values,
  });
}
class Client {
  public readonly sent: unknown[] = [];
  public readonly sendOptions: unknown[] = [];
  public constructor(
    private readonly replies: Array<
      | unknown
      | ((command: unknown, options: unknown) => unknown)
    >,
  ) {}
  public async send(command: unknown, options?: unknown) {
    this.sent.push(command);
    this.sendOptions.push(options);
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(command, options);
    return next;
  }
}
function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function handler(client: Client, more: Record<string, unknown> = {}) {
  return mod.createStagingJourneyExplorerHandlerV1({
    logsClient: client,
    commands,
    logGroupName: group,
    endpointArn: endpoint,
    now: () => now,
    monotonicNow: () => 0,
    pause: async () => undefined,
    ...more,
  });
}

function widgetContext(start: number, end: number) {
  return {
    dashboardName: "staging-journey-observability-v1",
    widgetId: "widget-16",
    accountId: "012345678901",
    locale: "en",
    timezone: { label: "UTC", offsetISO: "+00:00", offsetInMinutes: 0 },
    period: 300,
    isAutoPeriod: true,
    timeRange: {
      mode: "relative",
      start: start - 60_000,
      end,
      relativeStart: end - start + 60_000,
      zoom: { start, end },
    },
    theme: "light",
    linkCharts: true,
    title: "Staging Journey Explorer",
    forms: { all: {} },
    params: { original: "list" },
    width: 588,
    height: 369,
  };
}

describe("staging Journey Explorer custom widget", () => {
  it("returns AWS custom-widget describe markdown without a query", async () => {
    const client = new Client([]);
    await expect(
      handler(client)({
        describe: true,
        operation: "list",
        page_size: 20,
        widgetContext: widgetContext(now - 60_000, now),
      }),
    ).resolves.toMatchObject({
      markdown: expect.stringContaining("Staging Journey Explorer"),
    });
    expect(client.sent).toEqual([]);
  });

  it("accepts top-level parameters and widgetContext timeRange, never an API-Gateway wrapper", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const results = [
      event(),
      event({
        journey_id: secondId,
        observed_at: "2026-09-02T11:58:00.000Z",
      }),
    ];
    const client = new Client([
      { queryId: "q" },
      { status: "Complete", results },
      { queryId: "q-next" },
      { status: "Complete", results },
    ]);
    const result = await handler(client)({
      operation: "list",
      page_size: 1,
      widgetContext: widgetContext(now - 60_000, now),
    });
    expect(result).toMatchObject({
      journeys: [
        expect.objectContaining({ journey_id: id, status: "complete" }),
      ],
    });
    if (typeof result === "string") throw new Error("expected raw list data");
    expect(result.next_cursor).toEqual(expect.any(String));
    const start = client.sent[0] as Start;
    expect(start.input).toMatchObject({
      logGroupName: group,
      startTime: Math.floor((now - 60_000) / 1000),
      endTime: Math.ceil(now / 1000),
      limit: 2500,
    });
    expect(String(start.input.queryString)).toContain(
      'environment = "staging"',
    );
    expect(String(start.input.queryString)).not.toContain("SOURCE");

    await expect(
      handler(client)({ operation: "list", cursor: result.next_cursor }),
    ).resolves.toMatchObject({
      journeys: [expect.objectContaining({ journey_id: secondId })],
      next_cursor: null,
    });
    expect(client.sent.some((command) => command instanceof Stop)).toBe(false);
  });

  it("rejects unknown, query, query-id, injection, and noncanonical inputs before querying", async () => {
    const client = new Client([]);
    const invoke = handler(client);
    for (const input of [
      { queryStringParameters: { operation: "list" } },
      { operation: "list", query: "fields @message" },
      { operation: "list", queryId: "q" },
      {
        operation: "detail",
        journey_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
      },
      { operation: "detail", journey_id: id + '" | fields @message' },
      { operation: "list", from: "2026-09-01T00:00:00Z" },
      {
        operation: "list",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-09-02T00:00:00.000Z",
      },
      {
        operation: "list",
        widgetContext: {
          ...widgetContext(now - 60_000, now),
          unexpected: "not a CloudWatch context field",
        },
      },
    ])
      await expect(invoke(input)).resolves.toEqual({
        error: "invalid_request",
      });
    expect(client.sent).toEqual([]);
  });

  it("uses finite allowlists and returns content-free metadata and null token fields only", async () => {
    const client = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event({
            sequence: 1,
            stage: "ask_validation",
            event: "started",
            outcome: null,
            elapsed_ms: 0,
            observed_at: "2026-09-02T11:58:00.000Z",
            secret: "never",
          }),
          event({
            sequence: 2,
            stage: "ask_answer",
            outcome: null,
            llm_provider: "openrouter",
            llm_model: "anthropic/claude-sonnet-4.6",
            llm_usage_status: "reported",
            llm_provider_latency_ms: 2,
            llm_total_tokens: 7,
            llm_finish_reason: "completed",
            observed_at: "2026-09-02T11:59:00.000Z",
          }),
          event({
            sequence: 3,
            stage: "ask_answer",
            outcome: null,
            llm_provider: "attacker-provider",
            llm_model: "attacker-model",
            llm_usage_status: "reported",
            llm_provider_latency_ms: 2,
            llm_finish_reason: "completed",
            observed_at: "2026-09-02T11:59:01.000Z",
          }),
          event({
            sequence: 4,
            observed_at: "2026-09-02T11:59:02.000Z",
          }),
          event({
            sequence: 5,
            outcome: "approved",
            observed_at: "2026-09-02T11:59:03.000Z",
          }),
          event({
            sequence: 6,
            build_number: 0,
            observed_at: "2026-09-02T11:59:04.000Z",
          }),
        ],
      },
    ]);
    const result = await handler(client)({
      operation: "detail",
      journey_id: id,
    });
    expect(result).toMatchObject({
      status: "complete",
      terminal_outcome: "answered",
      stages: [
        expect.objectContaining({
          schema_version: 1,
          sequence: 1,
          release_sha: "a".repeat(40),
          build_number: 42,
          llm: expect.objectContaining({ total_tokens: null }),
        }),
        expect.objectContaining({
          sequence: 2,
          llm: expect.objectContaining({
            provider: "openrouter",
            total_tokens: 7,
            input_tokens: null,
          }),
        }),
        expect.objectContaining({ sequence: 4 }),
      ],
    });
    if (typeof result === "string") throw new Error("expected raw detail data");
    expect(JSON.stringify(result)).not.toContain("never");
    expect(JSON.stringify(result)).not.toContain("attacker");
    expect(
      (result.stages as readonly Record<string, unknown>[]).map(
        (item) => item.sequence,
      ),
    ).toEqual([1, 2, 4]);
    expect(JSON.stringify(result)).not.toContain("observed_ms");
  });

  it("separates approval human wait from full and service wall-clock latency", async () => {
    const meeting = (
      values: Record<string, string | number | boolean | null>,
    ) => event({ workflow: "meeting_approval", outcome: null, ...values });
    const client = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          meeting({
            sequence: 1,
            stage: "meeting_source_intake",
            event: "started",
            elapsed_ms: 0,
            observed_at: "2026-09-02T10:00:00.000Z",
          }),
          meeting({
            sequence: 2,
            stage: "meeting_approval_action_verify",
            event: "succeeded",
            elapsed_ms: 10,
            queue_age_ms: 300_000,
            observed_at: "2026-09-02T10:05:00.000Z",
          }),
          meeting({
            sequence: 3,
            stage: "meeting_terminal_persist",
            event: "succeeded",
            outcome: "approved",
            elapsed_ms: 20,
            observed_at: "2026-09-02T10:05:00.020Z",
          }),
          meeting({
            sequence: 4,
            stage: "meeting_search_publication",
            event: "succeeded",
            outcome: "published",
            elapsed_ms: 30,
            observed_at: "2026-09-02T10:05:00.050Z",
          }),
        ],
      },
    ]);

    await expect(
      handler(client)({ operation: "detail", journey_id: id }),
    ).resolves.toMatchObject({
      status: "complete",
      terminal_outcome: "published",
      full_wall_clock_ms: 300_050,
      service_wall_clock_ms: 50,
      human_wait_ms: 300_000,
    });
  });

  it("marks nonretryable failure as failed with its bounded failure class and keeps approved or superseded pending", async () => {
    const failure = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event({
            sequence: 1,
            stage: "ask_validation",
            event: "started",
            outcome: null,
            elapsed_ms: 0,
            observed_at: "2026-09-02T11:58:59.000Z",
          }),
          event({
            sequence: 2,
            event: "failed",
            retryable: false,
            failure_class: "unavailable",
            outcome: null,
          }),
        ],
      },
    ]);
    await expect(
      handler(failure)({ operation: "detail", journey_id: id }),
    ).resolves.toMatchObject({
      status: "complete",
      terminal_outcome: "failed",
      terminal_failure_class: "unavailable",
    });
    const pending = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event({
            workflow: "meeting_approval",
            stage: "meeting_record_append",
            event: "succeeded",
            outcome: null,
            observed_at: "2026-09-02T11:59:02.000Z",
          }),
          event({
            workflow: "meeting_approval",
            stage: "meeting_terminal_persist",
            outcome: "approved",
          }),
          event({
            workflow: "meeting_approval",
            stage: "meeting_search_publication",
            outcome: "superseded",
            observed_at: "2026-09-02T11:59:01.000Z",
          }),
        ],
      },
    ]);
    await expect(
      handler(pending)({ operation: "list" }),
    ).resolves.toMatchObject({
      journeys: [
        expect.objectContaining({
          status: "pending",
          pending_outcome: "superseded",
          terminal_outcome: null,
        }),
      ],
    });
  });

  it("queries retained history for detail and rejects a time-clipped journey without its canonical start", async () => {
    const client = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event({
            sequence: 2,
            observed_at: "2026-09-02T11:59:00.000Z",
          }),
        ],
      },
    ]);
    await expect(
      handler(client)({
        operation: "detail",
        journey_id: id,
        from: now - 60_000,
        to: now,
      }),
    ).resolves.toEqual({ error: "journey_history_incomplete" });
    const start = client.sent[0] as Start;
    expect(start.input).toMatchObject({
      logGroupName: group,
      startTime: Math.floor((now - 14 * 24 * 60 * 60 * 1_000) / 1_000),
      endTime: Math.ceil(now / 1_000),
      limit: 2500,
    });
  });

  it("fails closed for a saturated detail and stops a timed out query without leaking provider errors", async () => {
    const full = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: Array.from({ length: 2500 }, () => event()),
      },
    ]);
    await expect(
      handler(full)({ operation: "detail", journey_id: id }),
    ).resolves.toEqual({ error: "result_limit_exceeded" });
    const fullList = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: Array.from({ length: 2500 }, () => event()),
      },
    ]);
    await expect(handler(fullList)({ operation: "list" })).resolves.toEqual({
      error: "result_limit_exceeded",
    });
    const missing = new Client([
      { queryId: "q" },
      { status: "Complete", results: [] },
    ]);
    await expect(
      handler(missing)({ operation: "detail", journey_id: id }),
    ).resolves.toEqual({ error: "journey_not_found" });
    const serviceTimeout = new Client([
      { queryId: "q" },
      { status: "Timeout" },
    ]);
    await expect(
      handler(serviceTimeout)({ operation: "list" }),
    ).resolves.toEqual({ error: "query_timeout" });
    let clock = 0;
    const pauses: number[] = [];
    const slow = new Client([
      { queryId: "slow" },
      { status: "Running" },
      { status: "Running" },
      { status: "Running" },
      { status: "Running" },
      { status: "Running" },
      {},
    ]);
    await expect(
      handler(slow, {
        monotonicNow: () => clock,
        pause: async (durationMs: number) => {
          pauses.push(durationMs);
          clock += durationMs;
        },
        queryDeadlineMs: 1_100,
      })({ operation: "list" }),
    ).resolves.toEqual({ error: "query_timeout" });
    expect(pauses).toEqual([250, 250, 250, 250, 100]);
    expect(slow.sent.at(-1)).toBeInstanceOf(Stop);
    const pollingError = Object.assign(new Error("private poll failure"), {
      code: "RESULT_LIMIT",
    });
    const pollFailure = new Client([
      { queryId: "poll-failure" },
      pollingError,
      new Error("private cleanup failure"),
    ]);
    const pollFailureResult = await handler(pollFailure)({ operation: "list" });
    expect(pollFailureResult).toEqual({ error: "result_limit_exceeded" });
    expect(pollFailure.sent).toHaveLength(3);
    expect(pollFailure.sent[1]).toBeInstanceOf(Get);
    expect(pollFailure.sent[2]).toBeInstanceOf(Stop);
    expect((pollFailure.sent[2] as Stop).input).toEqual({
      queryId: "poll-failure",
    });
    expect(JSON.stringify(pollFailureResult)).not.toContain("private");
    const broken = new Client([new Error("provider secret token")]);
    const hidden = await handler(broken)({ operation: "list" });
    expect(hidden).toEqual({ error: "journey_explorer_unavailable" });
    expect(JSON.stringify(hidden)).not.toContain("secret");
  });

  it("bounds a stalled StopQuery without replacing the polling failure", async () => {
    vi.useFakeTimers();
    try {
      const pollingError = Object.assign(new Error("private poll failure"), {
        code: "RESULT_LIMIT",
      });
      let stopSignal: AbortSignal | undefined;
      const stalled = new Client([
        { queryId: "stalled-stop" },
        pollingError,
        (_command: unknown, options: unknown) =>
          new Promise((_resolve, reject) => {
            stopSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
            stopSignal?.addEventListener(
              "abort",
              () => reject(new Error("private cleanup abort")),
              { once: true },
            );
          }),
      ]);
      const result = handler(stalled)({ operation: "list" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled.sent).toHaveLength(3);
      expect(stalled.sent[2]).toBeInstanceOf(Stop);
      expect(stopSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toEqual({ error: "result_limit_exceeded" });
      expect(stopSignal?.aborted).toBe(true);
      expect((stalled.sendOptions[2] as { abortSignal?: AbortSignal }).abortSignal).toBe(
        stopSignal,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an abort-ignoring poll and cancels the query as timed out", async () => {
    vi.useFakeTimers();
    try {
      let getSignal: AbortSignal | undefined;
      const stalled = new Client([
        { queryId: "stalled-poll" },
        (_command: unknown, options: unknown) => {
          getSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
          return new Promise(() => undefined);
        },
        {},
      ]);
      const result = handler(stalled)({ operation: "list" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled.sent).toHaveLength(2);
      expect(stalled.sent[1]).toBeInstanceOf(Get);
      expect(getSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(12_000);
      await expect(result).resolves.toEqual({ error: "query_timeout" });
      expect(getSignal?.aborted).toBe(true);
      expect((stalled.sendOptions[1] as { abortSignal?: AbortSignal }).abortSignal).toBe(
        getSignal,
      );
      expect(stalled.sent[2]).toBeInstanceOf(Stop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns from a never-settling StartQuery after bounded recovery", async () => {
    vi.useFakeTimers();
    try {
      const clockSamples = [0, 950];
      let startSignal: AbortSignal | undefined;
      const stalled = new Client([
        (_command: unknown, options: unknown) => {
          startSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
          return new Promise(() => undefined);
        },
      ]);
      const result = handler(stalled, {
        monotonicNow: () => clockSamples.shift() ?? 950,
        queryDeadlineMs: 1_000,
      })({ operation: "list" });
      let finished = false;
      void result.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled.sent).toHaveLength(1);
      expect(stalled.sent[0]).toBeInstanceOf(Start);
      expect(startSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(49);
      expect(startSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(startSignal?.aborted).toBe(true);
      expect(stalled.sent).toHaveLength(1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ error: "query_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not launch cleanup after bounded StartQuery recovery ends", async () => {
    vi.useFakeTimers();
    try {
      const lateStart = deferred<unknown>();
      const clockSamples = [0, 950];
      const client = new Client([() => lateStart.promise]);
      const result = handler(client, {
        monotonicNow: () => clockSamples.shift() ?? 950,
        queryDeadlineMs: 1_000,
      })({ operation: "list" });

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toEqual({ error: "query_timeout" });
      expect(client.sent).toHaveLength(1);

      lateStart.resolve({ queryId: "outside-recovery-window" });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a valid late StartQuery before returning its timeout result", async () => {
    vi.useFakeTimers();
    try {
      const lateStart = deferred<unknown>();
      const clockSamples = [0, 950];
      let startSignal: AbortSignal | undefined;
      let stopSignal: AbortSignal | undefined;
      const client = new Client([
        (_command: unknown, options: unknown) => {
          startSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
          return lateStart.promise;
        },
        (_command: unknown, options: unknown) => {
          stopSignal = (options as { abortSignal?: AbortSignal }).abortSignal;
          return new Promise(() => undefined);
        },
      ]);
      const result = handler(client, {
        monotonicNow: () => clockSamples.shift() ?? 950,
        queryDeadlineMs: 1_000,
      })({ operation: "list" });
      let finished = false;
      void result.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(startSignal?.aborted).toBe(true);
      expect(client.sent).toHaveLength(1);
      expect(finished).toBe(false);

      lateStart.resolve({ queryId: "late-start-query" });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sent).toHaveLength(2);
      expect(client.sent[1]).toBeInstanceOf(Stop);
      expect((client.sent[1] as Stop).input).toEqual({
        queryId: "late-start-query",
      });
      expect(stopSignal?.aborted).toBe(false);
      expect((client.sendOptions[1] as { abortSignal?: AbortSignal }).abortSignal).toBe(
        stopSignal,
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopSignal?.aborted).toBe(true);
      expect(client.sent).toHaveLength(2);
      await expect(result).resolves.toEqual({ error: "query_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores invalid and rejected late StartQuery results", async () => {
    vi.useFakeTimers();
    try {
      const invalid = deferred<unknown>();
      const invalidClock = [0, 950];
      const invalidClient = new Client([
        () => invalid.promise,
      ]);
      const invalidResult = handler(invalidClient, {
        monotonicNow: () => invalidClock.shift() ?? 950,
        queryDeadlineMs: 1_000,
      })({ operation: "list" });
      await vi.advanceTimersByTimeAsync(50);
      invalid.resolve({ queryId: "" });
      await vi.advanceTimersByTimeAsync(0);
      await expect(invalidResult).resolves.toEqual({ error: "query_timeout" });
      expect(invalidClient.sent).toHaveLength(1);

      const rejected = deferred<unknown>();
      const rejectedClock = [0, 950];
      const rejectedClient = new Client([
        () => rejected.promise,
      ]);
      const rejectedResult = handler(rejectedClient, {
        monotonicNow: () => rejectedClock.shift() ?? 950,
        queryDeadlineMs: 1_000,
      })({ operation: "list" });
      await vi.advanceTimersByTimeAsync(50);
      rejected.reject(new Error("private late StartQuery failure"));
      await vi.advanceTimersByTimeAsync(0);
      await expect(rejectedResult).resolves.toEqual({ error: "query_timeout" });
      expect(rejectedClient.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders only on strict render:true and places exact trusted custom-widget actions immediately after buttons", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const client = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event({ secret: "<script>never</script>" }),
          event({
            journey_id: secondId,
            observed_at: "2026-09-02T11:58:00.000Z",
          }),
        ],
      },
    ]);
    const html = await handler(client)({
      operation: "list",
      page_size: 1,
      render: true,
      widgetContext: widgetContext(now - 60_000, now),
    });
    expect(typeof html).toBe("string");
    expect(html).toContain("Results may be partial");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("never");
    const actions = [
      ...String(html).matchAll(
        /<button[^>]*>([^<]+)<\/button><cwdb-action action="call" display="widget" endpoint="([^"]+)">(.*?)<\/cwdb-action>/g,
      ),
    ];
    expect(actions).toHaveLength(2);
    for (const [, , actionEndpoint, payload] of actions) {
      expect(actionEndpoint).toBe(endpoint);
      expect(() => JSON.parse(payload)).not.toThrow();
    }
    expect(actions.map((item) => item[1])).toEqual([
      "View timeline",
      "Next page",
    ]);
    const view = JSON.parse(actions[0]![3]!);
    expect(view).toEqual({
      operation: "detail",
      journey_id: id,
      from: now - 60_000,
      to: now,
      render: true,
    });
    const next = JSON.parse(actions[1]![3]!);
    expect(next).toMatchObject({
      operation: "list",
      page_size: 1,
      render: true,
      cursor: expect.any(String),
    });

    const renderedError = await handler(new Client([]))({
      operation: "list",
      render: true,
      endpointArn: "attacker-controlled",
    });
    expect(renderedError).toContain("not valid");
    expect(renderedError).not.toContain("attacker");
    await expect(
      handler(new Client([]))({ operation: "list", render: "true" }),
    ).resolves.toEqual({ error: "invalid_request" });
  });

  it("renders paginated list and timeline from the same validated results with safe retry, latency, and token semantics", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const firstPage = new Client([
      { queryId: "q" },
      {
        status: "Complete",
        results: [
          event(),
          event({
            journey_id: secondId,
            observed_at: "2026-09-02T11:58:00.000Z",
          }),
        ],
      },
    ]);
    const pageOne = String(
      await handler(firstPage)({
        operation: "list",
        page_size: 1,
        render: true,
      }),
    );
    const nextPayload = JSON.parse(
      pageOne.match(
        /Next page<\/button><cwdb-action[^>]*>(.*?)<\/cwdb-action>/,
      )![1]!,
    );
    const secondPage = new Client([
      { queryId: "q-next" },
      {
        status: "Complete",
        results: [
          event(),
          event({
            journey_id: secondId,
            observed_at: "2026-09-02T11:58:00.000Z",
          }),
        ],
      },
    ]);
    const pageTwo = String(await handler(secondPage)(nextPayload));
    expect(pageTwo).toContain(secondId);
    expect(pageTwo).not.toContain("Next page</button>");

    const detailClient = new Client([
      { queryId: "detail" },
      {
        status: "Complete",
        results: [
          event({
            sequence: 1,
            stage: "ask_validation",
            event: "started",
            outcome: null,
            elapsed_ms: 0,
            observed_at: "2026-09-02T11:58:00.000Z",
          }),
          event({
            sequence: 2,
            stage: "ask_answer",
            outcome: null,
            attempt: 3,
            elapsed_ms: 0,
            llm_provider: "openrouter",
            llm_model: "anthropic/claude-sonnet-4.6",
            llm_usage_status: "reported",
            llm_provider_latency_ms: 0,
            llm_input_tokens: 0,
            llm_output_tokens: 0,
            llm_total_tokens: 0,
            llm_finish_reason: "completed",
            observed_at: "2026-09-02T11:58:01.000Z",
          }),
          event({
            sequence: 3,
            stage: "ask_planner",
            event: "succeeded",
            outcome: null,
            attempt: 2,
            elapsed_ms: 1,
            llm_provider: "openrouter",
            llm_model: "anthropic/claude-sonnet-4.6",
            llm_usage_status: "unavailable",
            llm_provider_latency_ms: 1,
            llm_finish_reason: "unknown",
            observed_at: "2026-09-02T11:58:01.500Z",
          }),
          event({
            sequence: 4,
            event: "failed",
            outcome: null,
            retryable: false,
            failure_class: "timeout",
            elapsed_ms: 4,
            observed_at: "2026-09-02T11:58:02.000Z",
          }),
        ],
      },
    ]);
    const detail = String(
      await handler(detailClient)({
        operation: "detail",
        journey_id: id,
        render: true,
      }),
    );
    expect(detail).toContain("<dd>complete</dd>");
    expect(detail).toContain("<dd>failed</dd>");
    expect(detail).toContain("<dd>timeout</dd>");
    expect(detail).toContain("0 ms");
    expect(detail).toContain('class="waterfall-track"');
    expect(detail).toContain(
      'class="waterfall-bar" style="left:0.000%;width:0.000%"',
    );
    expect(detail).toContain(
      'class="waterfall-bar" style="left:99.800%;width:0.200%"',
    );
    expect(detail).toContain('class="failure-boundary"');
    expect(detail).toContain(
      "LLM token total:</strong> 0 total tokens across 1 observed LLM attempts with totals; 1 observed LLM attempts did not report a total.",
    );
    expect(detail).toContain(
      "Human approval wait:</strong> not reported. This business interval is separate from the machine-stage bars",
    );
    expect(detail).toContain("total tokens: 0");
    expect(detail).toContain("usage: unavailable");
    expect(detail).toContain("total tokens: not reported");
    expect(detail).toContain("cached input tokens: not reported");
    expect(detail).toContain(">2</td><td>not reported</td>");
    expect(detail).toMatch(
      /Back to recent runs<\/button><cwdb-action action="call" display="widget" endpoint="arn:aws:lambda:us-west-2:012345678901:function:customWidget-echo-staging-journey-explorer-v1">(.*?)<\/cwdb-action>/,
    );
    const back = JSON.parse(
      detail.match(
        /Back to recent runs<\/button><cwdb-action[^>]*>(.*?)<\/cwdb-action>/,
      )![1]!,
    );
    expect(back).toMatchObject({ operation: "list", render: true });
  });

  it("renders approval human wait separately and never folds it into a machine bar", async () => {
    const meeting = (
      values: Record<string, string | number | boolean | null>,
    ) => event({ workflow: "meeting_approval", outcome: null, ...values });
    const client = new Client([
      { queryId: "meeting-detail" },
      {
        status: "Complete",
        results: [
          meeting({
            sequence: 1,
            stage: "meeting_source_intake",
            event: "started",
            elapsed_ms: 0,
            observed_at: "2026-09-02T10:00:00.000Z",
          }),
          meeting({
            sequence: 2,
            stage: "meeting_approval_action_verify",
            event: "succeeded",
            elapsed_ms: 10,
            queue_age_ms: 300_000,
            observed_at: "2026-09-02T10:05:00.000Z",
          }),
          meeting({
            sequence: 3,
            stage: "meeting_search_publication",
            event: "succeeded",
            outcome: "published",
            elapsed_ms: 30,
            observed_at: "2026-09-02T10:05:00.050Z",
          }),
        ],
      },
    ]);

    const html = String(
      await handler(client)({
        operation: "detail",
        journey_id: id,
        render: true,
      }),
    );
    expect(html).toContain("Human approval wait:</strong> 300000 ms");
    expect(html).toContain("Full wall-clock</dt><dd>300050 ms");
    expect(html).toContain("Service wall-clock</dt><dd>50 ms");
    expect(html).toContain("human wait is never drawn as machine work");
    expect(html).not.toContain('aria-label="300000 ms machine latency"');
    expect(html).toContain(
      'class="waterfall-bar" style="left:99.980%;width:0.003%"',
    );
  });

  it("fails closed instead of returning an oversized rendered timeline", async () => {
    const client = new Client([
      { queryId: "large-detail" },
      {
        status: "Complete",
        results: Array.from({ length: 2_000 }, (_, index) =>
          event({ sequence: index + 1 }),
        ),
      },
    ]);

    const html = String(
      await handler(client)({
        operation: "detail",
        journey_id: id,
        render: true,
      }),
    );
    expect(html).toContain("selected range returned too many events");
    expect(html).not.toContain(id);
  });

  it("requires a canonical factory endpoint and never accepts one from a request", async () => {
    expect(() =>
      mod.createStagingJourneyExplorerHandlerV1({
        logsClient: new Client([]),
        commands,
        logGroupName: group,
        endpointArn: "arn:aws:lambda:us-west-2:012345678901:function:other",
      }),
    ).toThrow("exact staging explorer configuration");
    await expect(
      handler(new Client([]))({
        operation: "list",
        endpointArn: endpoint,
      }),
    ).resolves.toEqual({ error: "invalid_request" });
  });
});
