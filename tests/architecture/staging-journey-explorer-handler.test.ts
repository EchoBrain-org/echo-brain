import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mod = require(
  resolve(
    import.meta.dirname,
    "../../deploy/organization-authority/staging-journey-explorer-handler-v1.cjs",
  ),
) as {
  createStagingJourneyExplorerHandlerV1(
    options: Record<string, unknown>,
  ): (event: unknown) => Promise<Record<string, unknown>>;
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
  public constructor(private readonly replies: unknown[]) {}
  public async send(command: unknown) {
    this.sent.push(command);
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}
function handler(client: Client, more: Record<string, unknown> = {}) {
  return mod.createStagingJourneyExplorerHandlerV1({
    logsClient: client,
    commands,
    logGroupName: group,
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
    const slow = new Client([{ queryId: "slow" }, { status: "Running" }, {}]);
    await expect(
      handler(slow, {
        monotonicNow: () => {
          clock += 1_000;
          return clock;
        },
        queryDeadlineMs: 1_000,
      })({ operation: "list" }),
    ).resolves.toEqual({ error: "query_timeout" });
    expect(slow.sent[1]).toBeInstanceOf(Stop);
    const broken = new Client([new Error("provider secret token")]);
    const hidden = await handler(broken)({ operation: "list" });
    expect(hidden).toEqual({ error: "journey_explorer_unavailable" });
    expect(JSON.stringify(hidden)).not.toContain("secret");
  });
});
