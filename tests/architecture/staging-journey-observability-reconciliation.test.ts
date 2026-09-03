import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@echo-brain/federation-protocol";

const FIXTURE = resolve(
  import.meta.dirname,
  "../fixtures/staging-journey-observability/phase4-reconciliation-v1.jsonl",
);
const JOURNEY_KIND = "echo-authority-journey-stage-v1";
const LIVENESS_KIND = "echo-authority-journey-telemetry-liveness-v1";
const WORKER_CYCLE_KIND = "echo-clean-live-worker-cycle-v1";
const APPROVED_SEARCH_BACKLOG_KIND = "echo-authority-approved-search-backlog-v1";
const STUCK_AFTER_MS = 5 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

interface JourneyEvent {
  readonly attempt: number;
  readonly elapsed_ms: number;
  readonly event: "started" | "succeeded" | "failed" | "skipped";
  readonly journey_id: string;
  readonly kind: typeof JOURNEY_KIND;
  readonly llm_usage: {
    readonly total_tokens: number | null;
    readonly usage_status: "reported" | "unavailable";
  } | null;
  readonly observed_at: string;
  readonly outcome: string | null;
  readonly queue_age_ms: number | null;
  readonly retryable: boolean | null;
  readonly stage: string;
  readonly workflow: "ask" | "meeting_approval";
}

type ClosedJourneyEvent = Omit<JourneyEvent, "event"> & {
  readonly event: "succeeded" | "failed" | "skipped";
};

function fixture(): { readonly asOf: number; readonly records: JsonRecord[] } {
  const lines = readFileSync(FIXTURE, "utf8").trim().split("\n");
  const records = lines.map((line) => {
    const record = JSON.parse(line) as JsonRecord;
    expect(canonicalJson(record)).toBe(line);
    return record;
  });
  const header = records.shift();
  expect(header).toEqual({
    as_of: "2026-09-02T03:25:00.025Z",
    fixture: "staging-journey-observability-phase4-reconciliation-v1",
    schema_version: 1,
  });
  return { asOf: Date.parse("2026-09-02T03:25:00.025Z"), records };
}

function journeys(records: readonly JsonRecord[]): JourneyEvent[] {
  return records.filter(
    (record): record is JsonRecord & JourneyEvent => record.kind === JOURNEY_KIND,
  );
}

function closed(events: readonly JourneyEvent[]): ClosedJourneyEvent[] {
  return events.filter(
    (event): event is ClosedJourneyEvent => event.event !== "started",
  );
}

function journeyEndEvent(events: readonly JourneyEvent[]): JourneyEvent | undefined {
  const workflow = events[0]?.workflow;
  if (workflow === "meeting_approval") {
    return [...events]
      .filter(
        (event) =>
          (event.stage === "meeting_search_publication" &&
            event.event === "succeeded" &&
            (event.outcome === "published" || event.outcome === "current")) ||
          (event.stage === "meeting_terminal_persist" &&
            event.event === "succeeded" &&
            (event.outcome === "rejected" || event.outcome === "denied")) ||
          (event.event === "failed" && event.retryable === false),
      )
      .sort(
        (left, right) =>
          Date.parse(right.observed_at) - Date.parse(left.observed_at),
      )[0];
  }
  return [...events]
    .filter(
      (event) =>
        (event.stage === "ask_response" && event.event === "succeeded") ||
        (event.event === "failed" && event.retryable === false),
    )
    .sort(
      (left, right) =>
        Date.parse(right.observed_at) - Date.parse(left.observed_at),
    )[0];
}

function percentile(values: readonly number[], percent: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((percent / 100) * ordered.length) - 1]!;
}

function byJourney(events: readonly JourneyEvent[]): Map<string, JourneyEvent[]> {
  const result = new Map<string, JourneyEvent[]>();
  for (const event of events) {
    const group = result.get(event.journey_id) ?? [];
    group.push(event);
    result.set(event.journey_id, group);
  }
  return result;
}

describe("staging journey observability Phase 4 reconciliation fixture", () => {
  it("is canonical, content-free raw telemetry that spans every agreed journey outcome", () => {
    const { records } = fixture();
    const journeyKeys = new Set([
      "attempt", "build_number", "elapsed_ms", "environment", "event",
      "failure_class", "journey_id", "kind", "llm_usage", "observed_at",
      "outcome", "queue_age_ms", "release_sha", "retrieval", "retryable",
      "schema_version", "sequence", "stage", "workflow",
    ]);
    for (const record of journeys(records)) {
      expect(Object.keys(record).sort()).toEqual([...journeyKeys].sort());
    }
    expect(JSON.stringify(records)).not.toContain("-sentinel");

    const events = journeys(records);
    expect(new Set(events.map((event) => event.workflow))).toEqual(
      new Set(["ask", "meeting_approval"]),
    );
    expect(events.some((event) => event.outcome === "approved")).toBe(true);
    expect(events.some((event) => event.outcome === "rejected")).toBe(true);
    expect(events.some((event) => event.outcome === "denied")).toBe(true);
    expect(events.some((event) => event.outcome === "published")).toBe(true);
    expect(events.some((event) => event.llm_usage?.usage_status === "reported")).toBe(true);
    expect(events.some((event) => event.llm_usage?.usage_status === "unavailable")).toBe(true);
  });

  it("reconciles stage closed counts, rates, and source-intake percentiles from raw events", () => {
    const events = closed(journeys(fixture().records));
    const counts = new Map<string, { succeeded: number; failed: number; skipped: number }>();
    for (const event of events) {
      const current = counts.get(event.stage) ?? { succeeded: 0, failed: 0, skipped: 0 };
      current[event.event] += 1;
      counts.set(event.stage, current);
    }

    expect(Object.fromEntries(counts)).toEqual({
      ask_answer: { succeeded: 1, failed: 0, skipped: 0 },
      ask_planner: { succeeded: 1, failed: 1, skipped: 0 },
      ask_response: { succeeded: 1, failed: 0, skipped: 0 },
      ask_retrieval: { succeeded: 1, failed: 1, skipped: 0 },
      ask_validation: { succeeded: 2, failed: 0, skipped: 0 },
      meeting_approval_action_queue: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_approval_action_verify: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_approval_staging: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_candidate_persist: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_extraction: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_record_append: { succeeded: 2, failed: 0, skipped: 2 },
      meeting_search_publication: { succeeded: 1, failed: 0, skipped: 2 },
      meeting_source_intake: { succeeded: 4, failed: 0, skipped: 0 },
      meeting_terminal_persist: { succeeded: 4, failed: 0, skipped: 0 },
    });

    const nonSkipped = events.filter((event) => event.event !== "skipped");
    expect(nonSkipped.filter((event) => event.event === "failed")).toHaveLength(2);
    expect(nonSkipped.filter((event) => event.event === "failed").length / nonSkipped.length).toBeCloseTo(2 / 39);
    expect(counts.get("ask_planner")!.failed / (counts.get("ask_planner")!.failed + counts.get("ask_planner")!.succeeded)).toBe(0.5);
    expect(counts.get("ask_retrieval")!.failed / (counts.get("ask_retrieval")!.failed + counts.get("ask_retrieval")!.succeeded)).toBe(0.5);

    const sourceLatencies = events
      .filter((event) => event.stage === "meeting_source_intake" && event.event === "succeeded")
      .map((event) => event.elapsed_ms);
    expect(sourceLatencies).toEqual([3, 2, 1, 4]);
    expect(percentile(sourceLatencies, 50)).toBe(2);
    expect(percentile(sourceLatencies, 95)).toBe(4);
    expect(percentile(sourceLatencies, 99)).toBe(4);
  });

  it("uses timestamps, never summed elapsed durations, for end-to-end and keeps human wait distinct", () => {
    const grouped = byJourney(journeys(fixture().records));
    const endToEnd = new Map<string, number>();
    const serviceEndToEnd = new Map<string, number>();
    for (const [journeyId, events] of grouped) {
      const start = events
        .filter((event) => event.event === "started")
        .map((event) => Date.parse(event.observed_at))
        .sort((left, right) => left - right)[0];
      const end = journeyEndEvent(events);
      if (start !== undefined && end !== undefined) {
        const wallClock = Date.parse(end.observed_at) - start;
        const humanWait = Math.max(
          0,
          ...events.map((event) => event.queue_age_ms ?? 0),
        );
        endToEnd.set(journeyId, wallClock);
        serviceEndToEnd.set(journeyId, wallClock - humanWait);
      }
    }

    expect(Object.fromEntries(endToEnd)).toEqual({
      "11111111-1111-4111-8111-111111111111": 55,
      "22222222-2222-4222-8222-222222222222": 9,
      "33333333-3333-4333-8333-333333333333": 600_050,
      "55555555-5555-4555-8555-555555555555": 120_024,
      "66666666-6666-4666-8666-666666666666": 180_025,
    });
    expect(endToEnd.has("44444444-4444-4444-8444-444444444444")).toBe(false);
    expect(Object.fromEntries(serviceEndToEnd)).toEqual({
      "11111111-1111-4111-8111-111111111111": 55,
      "22222222-2222-4222-8222-222222222222": 9,
      "33333333-3333-4333-8333-333333333333": 50,
      "55555555-5555-4555-8555-555555555555": 24,
      "66666666-6666-4666-8666-666666666666": 25,
    });
    expect(endToEnd.get("33333333-3333-4333-8333-333333333333")).not.toBe(
      closed(grouped.get("33333333-3333-4333-8333-333333333333")!).reduce(
        (total, event) => total + event.elapsed_ms,
        0,
      ),
    );

    const verifiedActions = closed(journeys(fixture().records)).filter(
      (event) => event.stage === "meeting_approval_action_verify" && event.event === "succeeded",
    );
    expect(verifiedActions.map((event) => event.queue_age_ms)).toEqual([
      600_000,
      300_000,
      120_000,
      180_000,
    ]);
    expect(verifiedActions.reduce((total, event) => total + event.elapsed_ms, 0)).toBe(10);
    expect(verifiedActions.reduce((total, event) => total + (event.queue_age_ms ?? 0), 0)).toBe(1_200_000);

    const endToEndByWorkflow = new Map<JourneyEvent["workflow"], number[]>();
    for (const [journeyId, duration] of endToEnd) {
      const workflow = grouped.get(journeyId)![0]!.workflow;
      const values = endToEndByWorkflow.get(workflow) ?? [];
      values.push(duration);
      endToEndByWorkflow.set(workflow, values);
    }
    expect(
      Object.fromEntries(
        [...endToEndByWorkflow].map(([workflow, values]) => [workflow, {
          p50: percentile(values, 50),
          p95: percentile(values, 95),
          p99: percentile(values, 99),
        }]),
      ),
    ).toEqual({
      ask: { p50: 9, p95: 55, p99: 55 },
      meeting_approval: { p50: 180_025, p95: 600_050, p99: 600_050 },
    });

    const serviceByWorkflow = new Map<JourneyEvent["workflow"], number[]>();
    for (const [journeyId, duration] of serviceEndToEnd) {
      const workflow = grouped.get(journeyId)![0]!.workflow;
      const values = serviceByWorkflow.get(workflow) ?? [];
      values.push(duration);
      serviceByWorkflow.set(workflow, values);
    }
    expect(
      Object.fromEntries(
        [...serviceByWorkflow].map(([workflow, values]) => [
          workflow,
          {
            p50: percentile(values, 50),
            p95: percentile(values, 95),
            p99: percentile(values, 99),
          },
        ]),
      ),
    ).toEqual({
      ask: { p50: 9, p95: 55, p99: 55 },
      meeting_approval: { p50: 25, p95: 50, p99: 50 },
    });
  });

  it("reconciles LLM tokens, retries, funnel outcomes, pending work, and liveness", () => {
    const { asOf, records } = fixture();
    const events = journeys(records);
    const llmAttempts = closed(events).filter((event) => event.llm_usage !== null);
    const reported = llmAttempts.filter((event) => event.llm_usage?.usage_status === "reported");
    expect(llmAttempts).toHaveLength(7);
    expect(reported).toHaveLength(4);
    expect(reported.reduce((total, event) => total + (event.llm_usage?.total_tokens ?? 0), 0)).toBe(105);
    expect(reported.reduce((total, event) => total + (event.llm_usage?.total_tokens ?? 0), 0) / reported.length).toBe(26.25);
    expect(reported.length / llmAttempts.length).toBeCloseTo(4 / 7);
    const retryStarts = events.filter(
      (event) => event.event === "started" && event.attempt > 1,
    );
    expect(retryStarts).toHaveLength(1);
    expect(retryStarts).toMatchObject([
      {
        attempt: 2,
        journey_id: "11111111-1111-4111-8111-111111111111",
        stage: "ask_planner",
      },
    ]);

    const succeeded = closed(events).filter((event) => event.event === "succeeded");
    const funnel = (stage: string, outcome?: string) => succeeded.filter(
      (event) => event.stage === stage && (outcome === undefined || event.outcome === outcome),
    ).length;
    expect({
      intake: funnel("meeting_source_intake"),
      actionable: funnel("meeting_candidate_persist", "actionable"),
      staged: funnel("meeting_approval_staging", "staged"),
      verified: funnel("meeting_approval_action_verify"),
      approved: funnel("meeting_terminal_persist", "approved"),
      rejected: funnel("meeting_terminal_persist", "rejected"),
      denied: funnel("meeting_terminal_persist", "denied"),
      published: funnel("meeting_search_publication", "published"),
    }).toEqual({
      intake: 4,
      actionable: 4,
      staged: 4,
      verified: 4,
      approved: 2,
      rejected: 1,
      denied: 1,
      published: 1,
    });

    const grouped = byJourney(events);
    const pendingApproved = [...grouped.values()].filter((journey) => {
      const approved = journey.find(
        (event) => event.stage === "meeting_terminal_persist" && event.outcome === "approved" && event.event === "succeeded",
      );
      const published = journey.some(
        (event) => event.stage === "meeting_search_publication" && event.outcome === "published" && event.event === "succeeded",
      );
      return approved !== undefined && !published;
    });
    expect(pendingApproved).toHaveLength(1);
    const approvedAt = Date.parse(
      pendingApproved[0]!.find((event) => event.stage === "meeting_terminal_persist")!.observed_at,
    );
    expect(asOf - approvedAt).toBe(1_200_000);
    expect(asOf - approvedAt >= STUCK_AFTER_MS).toBe(true);

    const backlog = records.find(
      (record) => record.kind === APPROVED_SEARCH_BACKLOG_KIND,
    );
    expect(backlog).toEqual({
      environment: "staging",
      kind: APPROVED_SEARCH_BACKLOG_KIND,
      observed_at: "2026-09-02T03:25:00.025Z",
      oldest_age_ms: asOf - approvedAt,
      pending_count: pendingApproved.length,
      schema_version: 1,
      stuck_count: pendingApproved.filter((journey) => {
        const approved = journey.find(
          (event) => event.stage === "meeting_terminal_persist" && event.outcome === "approved",
        )!;
        return asOf - Date.parse(approved.observed_at) >= STUCK_AFTER_MS;
      }).length,
    });

    const liveness = records.filter((record) => record.kind === LIVENESS_KIND);
    expect(liveness).toHaveLength(3);
    expect(liveness.map((record) => record.event)).toEqual(["startup", "heartbeat", "heartbeat"]);
    expect(records.filter((record) => record.kind === WORKER_CYCLE_KIND)).toEqual([
      {
        cycle_phase: "source_intake",
        elapsed_ms: 8,
        event: "succeeded",
        kind: WORKER_CYCLE_KIND,
        observed_at: "2026-09-02T00:02:00.010Z",
        retryable: null,
        schema_version: 1,
      },
    ]);
  });
});
