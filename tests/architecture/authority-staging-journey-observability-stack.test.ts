import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const TEMPLATE = resolve(
  REPO,
  "deploy/organization-authority/authority-staging-journey-observability-v1.template.json",
);
const STAGING_LOG_GROUP = "/echo-brain/authority/authority-staging.echobrain.org";
const NAMESPACE = "EchoBrain/StagingJourneyV1";

type Resource = {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
};

type Template = {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, Resource>;
  readonly Outputs: Record<string, Record<string, unknown>>;
};

function template(): Template {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as Template;
}

function resource(stack: Template, logicalId: string): Resource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}

function dashboardBodyTemplate(stack: Template): string {
  const body = resource(stack, "StagingJourneyOverviewDashboard").Properties
    ?.DashboardBody as { readonly "Fn::Sub": string };
  expect(body).toEqual({ "Fn::Sub": expect.any(String) });
  return body["Fn::Sub"];
}

function dashboardBody(stack: Template): Record<string, unknown> {
  return JSON.parse(
    dashboardBodyTemplate(stack).replace(/\$\{[^}]+\}/g, "placeholder"),
  ) as Record<string, unknown>;
}

function metricNames(widget: Record<string, unknown>): readonly string[] {
  const metrics = widget.properties as { readonly metrics?: unknown };
  const entries = Array.isArray(metrics.metrics) ? metrics.metrics : [];
  return entries.flatMap((entry) => {
    if (Array.isArray(entry)) {
      const value = entry[1];
      return typeof value === "string" && value !== "." ? [value] : [];
    }
    if (entry === null || typeof entry !== "object") return [];
    const expression = (entry as { readonly expression?: unknown }).expression;
    if (typeof expression !== "string") return [];
    return [...expression.matchAll(/MetricName="([^"]+)"/g)].map((match) => match[1]!);
  });
}

describe("staging journey observability overview stack", () => {
  it("is structurally valid JSON and constrains every deployment to the one staging log group", () => {
    const stack = template();
    expect(stack.Parameters.StagingLogGroupName).toEqual({
      Type: "String",
      Default: STAGING_LOG_GROUP,
      AllowedValues: [STAGING_LOG_GROUP],
      ConstraintDescription:
        "must be the one owned Authority staging runtime log group",
    });
    expect(stack.Parameters.AlertTopicArn).toMatchObject({
      Type: "String",
      AllowedPattern: expect.stringContaining(":sns:"),
    });

    const serialized = JSON.stringify(stack);
    expect(serialized).toContain(STAGING_LOG_GROUP);
    expect(serialized).not.toContain("authority-prod");
    expect(serialized).not.toMatch(/production|prod\.echobrain\.org/i);
    expect(Object.values(stack.Resources).map((item) => item.Type)).not.toEqual(
      expect.arrayContaining([
        "AWS::IAM::Role",
        "AWS::IAM::ManagedPolicy",
        "AWS::Lambda::Function",
        "AWS::Logs::LogGroup",
        "AWS::DynamoDB::Table",
        "AWS::S3::Bucket",
      ]),
    );
    expect(Object.keys(stack.Resources)).toHaveLength(5);
  });

  it("derives only successful worker-cycle liveness from the supplied staging log group", () => {
    const stack = template();
    const filters = Object.values(stack.Resources).filter(
      (item) => item.Type === "AWS::Logs::MetricFilter",
    );
    expect(filters).toHaveLength(1);
    expect(resource(stack, "WorkerCycleCompletedMetricFilter").Properties).toMatchObject({
      LogGroupName: { Ref: "StagingLogGroupName" },
      FilterPattern:
        '{ ($.kind = "echo-clean-live-worker-cycle-v1") && ($.event = "succeeded") }',
      MetricTransformations: [
        {
          MetricNamespace: NAMESPACE,
          MetricName: "WorkerCycleCompleted",
          MetricValue: "1",
          Unit: "Count",
        },
      ],
    });

    for (const filter of filters) {
      const transformation = (filter.Properties?.MetricTransformations as readonly {
        readonly Dimensions?: unknown;
      }[])[0]!;
      expect(transformation.Dimensions).toBeUndefined();
    }
  });

  it("defines exactly the three staging alarms with the intended missing-data behavior and existing topic", () => {
    const stack = template();
    const alarms = Object.entries(stack.Resources).filter(
      ([, item]) => item.Type === "AWS::CloudWatch::Alarm",
    );
    expect(alarms).toHaveLength(3);
    for (const [, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions).toEqual([{ Ref: "AlertTopicArn" }]);
      expect(alarm.Properties?.OKActions).toEqual([{ Ref: "AlertTopicArn" }]);
      expect(alarm.Properties?.Namespace).toBe(NAMESPACE);
      expect(alarm.Properties).not.toHaveProperty("Metrics");
    }
    expect(resource(stack, "WorkerSilenceAlarm").Properties).toMatchObject({
      MetricName: "WorkerCycleCompleted",
      Statistic: "Sum",
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
    });
    expect(resource(stack, "AskRetrievalFailureAlarm").Properties).toMatchObject({
      MetricName: "AskRetrievalFailure",
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      Threshold: 2,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
    expect(resource(stack, "ApprovedSearchStuckAlarm").Properties).toMatchObject({
      MetricName: "ApprovedSearchStuckCount",
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("has a valid, staging-only dashboard with health, latency, LLM, retrieval, human-wait, funnel, and backlog views", () => {
    const stack = template();
    const dashboard = dashboardBody(stack);
    expect(dashboard).toMatchObject({ start: "-PT8H", periodOverride: "inherit" });
    const widgets = dashboard.widgets as Record<string, unknown>[];
    expect(widgets).toHaveLength(12);
    expect(widgets.filter((widget) => widget.type === "alarm")).toHaveLength(1);
    expect(widgets.filter((widget) => widget.type === "log")).toHaveLength(4);
    const nonTextWidgets = widgets.filter((widget) => widget.type !== "text");
    expect(nonTextWidgets).toHaveLength(11);
    for (const widget of nonTextWidgets) {
      expect(widget.properties).toMatchObject({ region: "placeholder" });
    }
    const rawBody = dashboardBodyTemplate(stack);
    expect(rawBody.match(/"region":/g)).toHaveLength(nonTextWidgets.length);
    expect(rawBody).not.toContain('"region":""');

    const metrics = widgets
      .filter((widget) => widget.type === "metric")
      .flatMap(metricNames);
    expect(metrics).toEqual(
      expect.arrayContaining([
        "TerminalOutcome",
        "LlmTotalTokens",
        "LlmTotalTokensAvailable",
        "LlmUsageReported",
        "LlmAttempt",
        "LlmProviderLatencyMs",
        "RetrievalPlannedQueries",
        "RetrievalQueryHits",
        "RetrievalReleasedAtoms",
        "RetrievalContextAtoms",
        "RetrievalCitations",
        "ApprovalHumanWaitMs",
        "ApprovedSearchPendingCount",
        "ApprovedSearchStuckCount",
        "ApprovedSearchOldestAgeMs",
        "ApprovedSearchBacklogCheck",
      ]),
    );

    const metricWidgets = widgets.filter((widget) => widget.type === "metric");
    const serialized = JSON.stringify(dashboard);
    const metricSerialized = JSON.stringify(metricWidgets);
    expect(serialized).toContain("Machine-stage latency percentiles (no human wait)");
    expect(serialized).toContain("ApprovalHumanWaitMs");
    expect(metricSerialized).toContain("StageClosedLatencyMs");
    expect(metricSerialized).toContain("'p50'");
    expect(metricSerialized).toContain("'p95'");
    expect(metricSerialized).toContain("'p99'");
    expect(metricSerialized).toContain("token_total/total_available");
    expect(metricSerialized).toContain("100*usage_reported/llm_attempts");
    expect(metricSerialized).toContain('"workflow"');
    expect(metricSerialized).toContain('"stage"');
    expect(metricSerialized).toContain('"outcome"');
    expect(metricSerialized).toContain(
      '"TerminalOutcome","workflow","ask","stage","ask_response","outcome","answered"',
    );
    expect(metricSerialized).toContain('"outcome","insufficient_evidence"');
    expect(metricSerialized).toContain('"outcome","authorship_unsupported"');
    expect(metricSerialized).toContain('"outcome","actionable"');
    expect(metricSerialized).toContain('"outcome","staged"');
    expect(metricSerialized).toContain('"outcome","current"');
    expect(metricSerialized).toContain('"outcome","published"');
    expect(metricSerialized).toContain('"outcome","superseded"');
    expect(metricSerialized).toContain(
      `{${NAMESPACE},stage,provider,model} MetricName=\\"LlmTotalTokens\\"`,
    );
    expect(metricSerialized).toContain(
      `{${NAMESPACE},workflow,stage} MetricName=\\"RetrievalContextAtoms\\"`,
    );
    expect(metricSerialized).not.toMatch(
      /"Llm(?:TotalTokens|ProviderLatencyMs)","stage"/,
    );
    expect(metricSerialized).not.toMatch(
      /"Retrieval(?:PlannedQueries|QueryHits|ReleasedAtoms|ContextAtoms|Citations)","workflow"/,
    );
    expect(metricSerialized).not.toMatch(
      /journey_id|request_id|candidate_id|approval_id|person_id|slack|meeting_id/i,
    );
  });

  it("uses bounded Logs Insights views with timestamp-derived journey wall-clock, token totals, and rates", () => {
    const stack = template();
    const dashboard = dashboardBody(stack);
    const logWidgets = (dashboard.widgets as Record<string, unknown>[]).filter(
      (widget) => widget.type === "log",
    );
    const queries = logWidgets.map(
      (widget) => (widget.properties as { readonly query: string }).query,
    );
    expect(queries).toHaveLength(4);
    expect(dashboardBodyTemplate(stack)).toContain(
      "SOURCE '${StagingLogGroupName}'",
    );
    for (const query of queries) expect(query).toMatch(/limit (25|30)$/);
    expect(queries.join("\n")).toContain("failure_class");

    const wallClock = queries.find((query) => query.includes("p50_wall_clock_ms"));
    expect(wallClock).toBeDefined();
    expect(wallClock).toContain("observed_at");
    expect(wallClock).toContain("parseDate(observed_at");
    expect(wallClock).toContain('event = "started" and sequence = 1');
    expect(wallClock).toContain("canonical_start_observed_at_ms");
    expect(wallClock).toContain("terminal_observed_at_ms");
    expect(wallClock).toContain("canonical_start_observed_at_ms < 32503680000000");
    expect(wallClock).toContain(
      "terminal_observed_at_ms >= canonical_start_observed_at_ms",
    );
    expect(wallClock).toContain("p50_wall_clock_ms");
    expect(wallClock).toContain("p95_wall_clock_ms");
    expect(wallClock).toContain("p99_wall_clock_ms");
    expect(wallClock).toContain("max(queue_age_ms) as human_wait_ms");
    expect(wallClock).toContain("retryable, sequence, queue_age_ms | stats");
    expect(wallClock).toContain("coalesce(human_wait_ms, 0)");
    expect(wallClock).toContain("filter journey_wall_clock_ms >= human_wait_ms");
    expect(wallClock).toContain(
      "journey_wall_clock_ms - human_wait_ms as service_wall_clock_ms",
    );
    expect(wallClock).toContain("p50_service_wall_clock_ms");
    expect(wallClock).toContain("p95_service_wall_clock_ms");
    expect(wallClock).toContain("p99_service_wall_clock_ms");
    expect(JSON.stringify(logWidgets)).toContain("Full and service wall-clock");
    expect(wallClock).toContain('event = "failed" and retryable = false');
    expect(wallClock).toContain('outcome in ["current", "published"]');
    expect(wallClock).toContain('outcome in ["rejected", "denied"]');
    expect(wallClock).not.toContain("superseded");
    expect(wallClock).not.toContain("first_observed_at_ms");
    expect(wallClock).not.toMatch(/sum\(elapsed_ms\)/i);
    expect(queries.join("\n")).not.toMatch(/sum\(elapsed_ms\)/i);
    const tokenTotals = queries.find((query) => query.includes("journey_total_tokens"));
    expect(tokenTotals).toContain("llm_usage.total_tokens as total_tokens");
    expect(tokenTotals).toContain('event = "started" and sequence = 1');
    expect(tokenTotals).toContain("canonical_start_observed_at_ms");
    expect(tokenTotals).toContain("canonical_start_observed_at_ms < 32503680000000");
    expect(tokenTotals).toContain(
      "terminal_observed_at_ms >= canonical_start_observed_at_ms",
    );
    expect(tokenTotals).toContain("sum(total_tokens) as journey_total_tokens");
    expect(tokenTotals).toContain("total_token_samples");
    expect(tokenTotals).toContain("sum(if(ispresent(total_tokens), 1, 0))");
    expect(tokenTotals).toContain("total_token_samples > 0");
    expect(tokenTotals).toContain('event = "failed" and retryable = false');
    expect(tokenTotals).toContain('outcome in ["current", "published"]');
    expect(tokenTotals).not.toContain("superseded");
    expect(tokenTotals).toContain("p95_total_tokens");
    const rates = queries.find((query) => query.includes("failure_rate_pct"));
    expect(rates).toContain('filter event in ["started", "succeeded", "failed"]');
    expect(rates).toContain('sum(if(event = "failed", 1, 0))');
    expect(rates).toContain('sum(if(event = "started" and attempt > 1, 1, 0))');
    expect(rates).toContain("succeeded_attempts / closed_attempts");
    expect(rates).toContain("failed_attempts / closed_attempts");
    expect(rates).toContain("retry_attempts / started_attempts");
    expect(rates).not.toContain("ask_response");
    expect(rates).not.toContain("meeting_terminal_persist");
  });
});
