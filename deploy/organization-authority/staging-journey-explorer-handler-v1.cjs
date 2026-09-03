"use strict";

// This Lambda exposes fixed, staging-only query shapes. Callers can select a
// bounded time range or canonical journey UUID, but never query text, a query
// ID, a source log group, or raw log content.
const KIND = "echo-authority-journey-stage-v1";
const LOG_GROUP = "/echo-brain/authority/authority-staging.echobrain.org";
const HOUR = 60 * 60 * 1000;
const MAX_RANGE = 14 * 24 * HOUR;
const MAX_PAGE = 25;
const LIST_LIMIT = 2500;
const MAX_OFFSET = LIST_LIMIT;
const DETAIL_LIMIT = 2500;
const CLEANUP_TIMEOUT_MS = 1000;
const MAX_MACHINE_DURATION = 31 * 24 * HOUR;
const MAX_ATTEMPT = 100;
const WORKFLOWS = new Set(["ask", "meeting_approval"]);
const STAGES = new Set([
  "ask_validation",
  "ask_authorization",
  "ask_planner",
  "ask_retrieval",
  "ask_context",
  "ask_answer",
  "ask_revalidation",
  "ask_audit",
  "ask_response",
  "meeting_source_intake",
  "meeting_extraction",
  "meeting_candidate_persist",
  "meeting_approval_staging",
  "meeting_approval_action_verify",
  "meeting_approval_action_queue",
  "meeting_terminal_persist",
  "meeting_record_append",
  "meeting_search_publication",
]);
const EVENTS = new Set(["started", "succeeded", "failed", "skipped"]);
const OUTCOMES = new Set([
  "completed",
  "answered",
  "insufficient_evidence",
  "authorship_unsupported",
  "actionable",
  "no_signals",
  "coalesced",
  "staged",
  "delivery_pending",
  "quarantined",
  "approved",
  "rejected",
  "denied",
  "current",
  "published",
  "superseded",
  "skipped",
]);
const FAILURES = new Set([
  "authorization",
  "invalid_request",
  "invalid_contract",
  "rate_limited",
  "timeout",
  "unavailable",
  "cancelled",
  "provider_rejected",
  "unknown",
]);
const PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "ollama",
  "other",
]);
const MODELS = new Set([
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v3.2",
]);
const FINISH = new Set([
  "completed",
  "length",
  "stop",
  "content_filter",
  "tool_call",
  "unknown",
]);
const USAGE = new Set(["reported", "unavailable"]);
const STAGES_BY_WORKFLOW = {
  ask: new Set([
    "ask_validation",
    "ask_authorization",
    "ask_planner",
    "ask_retrieval",
    "ask_context",
    "ask_answer",
    "ask_revalidation",
    "ask_audit",
    "ask_response",
  ]),
  meeting_approval: new Set([
    "meeting_source_intake",
    "meeting_extraction",
    "meeting_candidate_persist",
    "meeting_approval_staging",
    "meeting_approval_action_verify",
    "meeting_approval_action_queue",
    "meeting_terminal_persist",
    "meeting_record_append",
    "meeting_search_publication",
  ]),
};
const CANONICAL_START_BY_WORKFLOW = {
  ask: "ask_validation",
  meeting_approval: "meeting_source_intake",
};
const OUTCOMES_BY_STAGE = {
  ask_response: new Set([
    "answered",
    "insufficient_evidence",
    "authorship_unsupported",
    "completed",
  ]),
  meeting_candidate_persist: new Set(["actionable", "no_signals", "coalesced"]),
  meeting_approval_staging: new Set([
    "staged",
    "delivery_pending",
    "quarantined",
  ]),
  meeting_terminal_persist: new Set(["approved", "rejected", "denied"]),
  meeting_search_publication: new Set(["current", "published", "superseded"]),
};
const LLM_STAGES = new Set(["ask_planner", "ask_answer", "meeting_extraction"]);
const RETRIEVAL_STAGES = new Set([
  "ask_planner",
  "ask_retrieval",
  "ask_context",
  "ask_answer",
  "ask_audit",
  "ask_response",
]);
const WIDGET_CONTEXT_KEYS = new Set([
  "dashboardName",
  "widgetId",
  "accountId",
  "locale",
  "timezone",
  "period",
  "isAutoPeriod",
  "timeRange",
  "theme",
  "linkCharts",
  "title",
  "forms",
  "params",
  "width",
  "height",
]);
const TIME_RANGE_KEYS = new Set([
  "mode",
  "start",
  "end",
  "relativeStart",
  "zoom",
]);
const BASE =
  "journey_id, environment, schema_version, sequence, release_sha, build_number, workflow, stage, event, outcome, retryable, observed_at, elapsed_ms, attempt, failure_class, queue_age_ms";
const LIST_QUERY =
  "fields " +
  BASE +
  ' | filter kind = "' +
  KIND +
  '" and environment = "staging" and ispresent(journey_id) | sort observed_at desc | limit ' +
  LIST_LIMIT;
let cached;

function detailQuery(id) {
  return (
    "fields " +
    BASE +
    ', retrieval.planned_query_count as retrieval_planned_query_count, retrieval.query_hit_count as retrieval_query_hit_count, retrieval.released_atom_count as retrieval_released_atom_count, retrieval.context_atom_count as retrieval_context_atom_count, retrieval.citation_count as retrieval_citation_count, llm_usage.provider as llm_provider, llm_usage.model as llm_model, llm_usage.usage_status as llm_usage_status, llm_usage.provider_latency_ms as llm_provider_latency_ms, llm_usage.input_tokens as llm_input_tokens, llm_usage.output_tokens as llm_output_tokens, llm_usage.total_tokens as llm_total_tokens, llm_usage.cached_input_tokens as llm_cached_input_tokens, llm_usage.reasoning_tokens as llm_reasoning_tokens, llm_usage.finish_reason as llm_finish_reason | filter kind = "' +
    KIND +
    '" and environment = "staging" and journey_id = "' +
    id +
    '" | sort observed_at asc, sequence asc | limit ' +
    DETAIL_LIMIT
  );
}
function sdk() {
  return require("@aws-sdk/client-cloudwatch-logs");
}
function error(message) {
  const value = new Error(message);
  value.code = "INVALID_REQUEST";
  return value;
}
function resultLimitError() {
  const value = new Error("query result limit reached");
  value.code = "RESULT_LIMIT";
  return value;
}
function queryTimeoutError() {
  const value = new Error("query timed out");
  value.code = "QUERY_TIMEOUT";
  return value;
}
function notFoundError() {
  const value = new Error("journey not found");
  value.code = "NOT_FOUND";
  return value;
}
function incompleteHistoryError() {
  const value = new Error("journey history is incomplete");
  value.code = "INCOMPLETE_HISTORY";
  return value;
}
function uint(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
  )
    return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}
function enumValue(value, values) {
  return value === undefined ? null : values.has(value) ? value : null;
}
function uuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : null;
}
function iso(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value
    ? ms
    : null;
}
function row(fields) {
  const out = Object.create(null);
  if (Array.isArray(fields))
    for (const field of fields)
      if (
        field &&
        typeof field.field === "string" &&
        typeof field.value === "string"
      )
        out[field.field] = field.value;
  return out;
}
function stage(raw) {
  const journey_id = uuid(raw.journey_id),
    observed_ms = iso(raw.observed_at),
    workflow = enumValue(raw.workflow, WORKFLOWS),
    name = enumValue(raw.stage, STAGES),
    event = enumValue(raw.event, EVENTS),
    outcome = enumValue(raw.outcome, OUTCOMES),
    failure_class = enumValue(raw.failure_class, FAILURES),
    schema_version = uint(raw.schema_version, 1),
    sequence = uint(raw.sequence, 1),
    build_number = uint(raw.build_number, 1),
    elapsed_ms = uint(raw.elapsed_ms, 0, MAX_MACHINE_DURATION),
    attempt = uint(raw.attempt, 1, MAX_ATTEMPT),
    queue_age_ms =
      raw.queue_age_ms === undefined ? null : uint(raw.queue_age_ms),
    retryable =
      raw.retryable === undefined
        ? null
        : raw.retryable === "true"
          ? true
          : raw.retryable === "false"
            ? false
            : null;
  if (
    journey_id === null ||
    observed_ms === null ||
    raw.environment !== "staging" ||
    schema_version !== 1 ||
    sequence === null ||
    build_number === null ||
    typeof raw.release_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(raw.release_sha) ||
    workflow === null ||
    name === null ||
    event === null ||
    elapsed_ms === null ||
    attempt === null ||
    (raw.outcome !== undefined && outcome === null) ||
    (raw.failure_class !== undefined && failure_class === null) ||
    (raw.queue_age_ms !== undefined && queue_age_ms === null) ||
    (raw.retryable !== undefined && retryable === null)
  )
    return null;
  if (!STAGES_BY_WORKFLOW[workflow].has(name)) return null;

  if (event === "skipped") {
    if (outcome !== "skipped" || elapsed_ms !== 0) return null;
  } else if (event === "succeeded") {
    const allowedOutcomes = OUTCOMES_BY_STAGE[name];
    if (allowedOutcomes ? !allowedOutcomes.has(outcome) : outcome !== null)
      return null;
  } else if (outcome !== null) {
    return null;
  }

  if (event === "failed") {
    if (failure_class === null || typeof retryable !== "boolean") return null;
  } else if (failure_class !== null || retryable !== null) {
    return null;
  }
  if (event === "started" && elapsed_ms !== 0) return null;
  if (queue_age_ms !== null && name !== "meeting_approval_action_verify")
    return null;

  return {
    journey_id,
    environment: "staging",
    schema_version,
    sequence,
    release_sha: raw.release_sha,
    build_number,
    workflow,
    stage: name,
    event,
    outcome,
    failure_class,
    retryable,
    observed_at: raw.observed_at,
    observed_ms,
    elapsed_ms,
    attempt,
    queue_age_ms,
  };
}
function nested(raw, item) {
  const retrievalKeys = [
      "retrieval_planned_query_count",
      "retrieval_query_hit_count",
      "retrieval_released_atom_count",
      "retrieval_context_atom_count",
      "retrieval_citation_count",
    ],
    hasRetrieval = retrievalKeys.some((key) => raw[key] !== undefined),
    retrievalValues = retrievalKeys.map((key) =>
      raw[key] === undefined ? null : uint(raw[key]),
    );
  if (
    retrievalValues.some(
      (value, index) =>
        raw[retrievalKeys[index]] !== undefined && value === null,
    ) ||
    (hasRetrieval &&
      (item.workflow !== "ask" ||
        item.event !== "succeeded" ||
        !RETRIEVAL_STAGES.has(item.stage)))
  )
    return null;
  const llmKeys = [
    "llm_provider",
    "llm_model",
    "llm_usage_status",
    "llm_provider_latency_ms",
    "llm_input_tokens",
    "llm_output_tokens",
    "llm_total_tokens",
    "llm_cached_input_tokens",
    "llm_reasoning_tokens",
    "llm_finish_reason",
  ];
  const hasLlm = llmKeys.some((key) => raw[key] !== undefined);
  const expectsLlm =
    LLM_STAGES.has(item.stage) &&
    (item.event === "succeeded" || item.event === "failed");
  if (hasLlm !== expectsLlm) return null;
  let llm = {
    provider: null,
    model: null,
    usage_status: null,
    provider_latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cached_input_tokens: null,
    reasoning_tokens: null,
    finish_reason: null,
  };
  if (hasLlm) {
    const tokens = llmKeys
      .slice(4, 9)
      .map((key) => (raw[key] === undefined ? null : uint(raw[key])));
    const provider = enumValue(raw.llm_provider, PROVIDERS),
      model = enumValue(raw.llm_model, MODELS),
      usage_status = enumValue(raw.llm_usage_status, USAGE),
      provider_latency_ms = uint(
        raw.llm_provider_latency_ms,
        0,
        MAX_MACHINE_DURATION,
      ),
      finish_reason = enumValue(raw.llm_finish_reason, FINISH);
    const hasTokenUsage = tokens.some((value) => value !== null);
    if (
      provider === null ||
      model === null ||
      usage_status === null ||
      provider_latency_ms === null ||
      finish_reason === null ||
      tokens.some(
        (value, index) =>
          raw[llmKeys[index + 4]] !== undefined && value === null,
      ) ||
      (usage_status === "unavailable" && hasTokenUsage) ||
      (usage_status === "reported" && !hasTokenUsage)
    )
      return null;
    llm = {
      provider,
      model,
      usage_status,
      provider_latency_ms,
      input_tokens: tokens[0],
      output_tokens: tokens[1],
      total_tokens: tokens[2],
      cached_input_tokens: tokens[3],
      reasoning_tokens: tokens[4],
      finish_reason,
    };
  }
  return {
    retrieval: {
      planned_query_count: retrievalValues[0],
      query_hit_count: retrievalValues[1],
      released_atom_count: retrievalValues[2],
      context_atom_count: retrievalValues[3],
      citation_count: retrievalValues[4],
    },
    llm,
  };
}
function terminal(item) {
  if (item.event === "failed" && item.retryable === false)
    return {
      outcome: "failed",
      failure_class: item.failure_class || "unknown",
    };
  if (
    item.workflow === "ask" &&
    item.stage === "ask_response" &&
    item.event === "succeeded"
  )
    return { outcome: item.outcome || "answered", failure_class: null };
  if (
    item.workflow === "meeting_approval" &&
    item.stage === "meeting_search_publication" &&
    item.event === "succeeded" &&
    (item.outcome === "current" || item.outcome === "published")
  )
    return { outcome: item.outcome, failure_class: null };
  if (
    item.workflow === "meeting_approval" &&
    item.stage === "meeting_terminal_persist" &&
    item.event === "succeeded" &&
    (item.outcome === "rejected" || item.outcome === "denied")
  )
    return { outcome: item.outcome, failure_class: null };
  return null;
}
function summarize(rows) {
  const all = new Map();
  for (const fields of rows) {
    const item = stage(row(fields));
    if (!item) continue;
    const current = all.get(item.journey_id) || {
      journey_id: item.journey_id,
      workflow: item.workflow,
      first_observed_at: item.observed_at,
      last_observed_at: item.observed_at,
      first: item.observed_ms,
      last: item.observed_ms,
      closed_event_count: 0,
      terminal: null,
      pending_outcome: null,
      pending_outcome_at: null,
    };
    if (item.observed_ms < current.first) {
      current.first = item.observed_ms;
      current.first_observed_at = item.observed_at;
    }
    if (item.observed_ms >= current.last) {
      current.last = item.observed_ms;
      current.last_observed_at = item.observed_at;
      current.workflow = item.workflow;
    }
    if (
      (item.outcome === "approved" || item.outcome === "superseded") &&
      (current.pending_outcome_at === null ||
        item.observed_ms >= current.pending_outcome_at)
    ) {
      current.pending_outcome = item.outcome;
      current.pending_outcome_at = item.observed_ms;
    }
    if (item.event !== "started") current.closed_event_count += 1;
    const done = terminal(item);
    if (done && (!current.terminal || item.observed_ms >= current.terminal.at))
      current.terminal = Object.assign({ at: item.observed_ms }, done);
    all.set(item.journey_id, current);
  }
  return [...all.values()]
    .sort((a, b) => b.last - a.last || a.journey_id.localeCompare(b.journey_id))
    .map((item) => ({
      journey_id: item.journey_id,
      workflow: item.workflow,
      first_observed_at: item.first_observed_at,
      last_observed_at: item.last_observed_at,
      closed_event_count: item.closed_event_count,
      status: item.terminal ? "complete" : "pending",
      terminal_outcome: item.terminal ? item.terminal.outcome : null,
      terminal_failure_class: item.terminal
        ? item.terminal.failure_class
        : null,
      pending_outcome: item.terminal ? null : item.pending_outcome,
    }));
}
function timeline(rows, id) {
  const stages = [];
  for (const fields of rows) {
    const raw = row(fields),
      item = stage(raw),
      details = item === null ? null : nested(raw, item);
    if (!item || !details || item.journey_id !== id) continue;
    const { observed_ms: _observedMs, ...publicItem } = item;
    stages.push(Object.assign(publicItem, details));
  }
  stages.sort(
    (a, b) =>
      a.sequence - b.sequence || a.observed_at.localeCompare(b.observed_at),
  );
  const first = stages.reduce(
      (earliest, item) =>
        earliest === null || item.observed_at < earliest.observed_at
          ? item
          : earliest,
      null,
    ),
    canonicalStart =
      first !== null &&
      first.stage === CANONICAL_START_BY_WORKFLOW[first.workflow] &&
      first.event === "started" &&
      first.sequence === 1 &&
      first.attempt === 1,
    final = stages.reduce(
      (latest, item) =>
        terminal(item) !== null &&
        (latest === null || item.observed_at > latest.observed_at)
          ? item
          : latest,
      null,
    ),
    complete = final ? terminal(final) : null,
    full =
      !canonicalStart || !final
        ? null
        : iso(final.observed_at) - iso(first.observed_at),
    waitValues = stages
      .map((item) => item.queue_age_ms)
      .filter((value) => value !== null),
    wait = waitValues.length === 0 ? null : Math.max(...waitValues);
  return {
    journey_id: id,
    history_complete: canonicalStart,
    status: !canonicalStart ? "incomplete" : final ? "complete" : "pending",
    terminal_outcome: canonicalStart && complete ? complete.outcome : null,
    terminal_failure_class:
      canonicalStart && complete ? complete.failure_class : null,
    full_wall_clock_ms: full,
    service_wall_clock_ms:
      full === null ? null : Math.max(0, full - (wait === null ? 0 : wait)),
    human_wait_ms: wait,
    stages,
  };
}
function cursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decode(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw error("cursor");
  let result;
  try {
    result = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw error("cursor");
  }
  if (
    !result ||
    Object.keys(result).length !== 4 ||
    result.v !== 1 ||
    !Number.isSafeInteger(result.start) ||
    !Number.isSafeInteger(result.end) ||
    !Number.isSafeInteger(result.offset) ||
    result.start < 0 ||
    result.end <= result.start ||
    result.end - result.start > MAX_RANGE ||
    result.offset < 0 ||
    result.offset >= MAX_OFFSET
  )
    throw error("cursor");
  return result;
}
function time(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  const parsed = iso(value);
  if (parsed !== null) return parsed;
  throw error("time");
}
function context(value) {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !WIDGET_CONTEXT_KEYS.has(key)) ||
    !value.timeRange ||
    typeof value.timeRange !== "object" ||
    Array.isArray(value.timeRange) ||
    Object.keys(value.timeRange).some((key) => !TIME_RANGE_KEYS.has(key))
  )
    throw error("widgetContext");
  let selected = value.timeRange;
  if (value.timeRange.zoom !== undefined) {
    if (
      !value.timeRange.zoom ||
      typeof value.timeRange.zoom !== "object" ||
      Array.isArray(value.timeRange.zoom) ||
      Object.keys(value.timeRange.zoom).some(
        (key) => key !== "start" && key !== "end",
      )
    )
      throw error("widgetContext");
    selected = value.timeRange.zoom;
  }
  return { start: time(selected.start), end: time(selected.end) };
}
function request(event, now) {
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw error("event");
  const allowed = new Set([
    "describe",
    "operation",
    "from",
    "to",
    "page_size",
    "cursor",
    "journey_id",
    "widgetContext",
  ]);
  for (const [key, value] of Object.entries(event))
    if (!allowed.has(key) || value === null) throw error("event");
  if (event.describe === true) {
    context(event.widgetContext);
    return { operation: "describe" };
  }
  if (event.describe !== undefined) throw error("describe");
  const operation = event.operation === undefined ? "list" : event.operation;
  if (operation !== "list" && operation !== "detail") throw error("operation");
  const range = context(event.widgetContext),
    saved = event.cursor === undefined ? null : decode(event.cursor);
  let start;
  let end;
  if (saved) {
    start = saved.start;
    end = saved.end;
    if (event.from !== undefined && time(event.from) !== start)
      throw error("range");
    if (event.to !== undefined && time(event.to) !== end) throw error("range");
  } else {
    end = event.to === undefined ? (range ? range.end : now) : time(event.to);
    start =
      event.from === undefined
        ? range
          ? range.start
          : end - 8 * HOUR
        : time(event.from);
  }
  if (start >= end || end - start > MAX_RANGE || end > now + 60_000)
    throw error("range");
  if (operation === "detail") {
    if (
      saved ||
      event.page_size !== undefined ||
      uuid(event.journey_id) === null
    )
      throw error("detail");
    return { operation, start, end, journeyId: event.journey_id };
  }
  if (event.journey_id !== undefined) throw error("list");
  const pageSize =
    event.page_size === undefined ? 20 : uint(event.page_size, 1);
  if (pageSize === null || pageSize > MAX_PAGE) throw error("page");
  return { operation, start, end, pageSize, offset: saved ? saved.offset : 0 };
}
function safe(errorValue) {
  return {
    error:
      errorValue && errorValue.code === "INVALID_REQUEST"
        ? "invalid_request"
        : errorValue && errorValue.code === "QUERY_TIMEOUT"
          ? "query_timeout"
          : errorValue && errorValue.code === "RESULT_LIMIT"
            ? "result_limit_exceeded"
            : errorValue && errorValue.code === "NOT_FOUND"
              ? "journey_not_found"
              : errorValue && errorValue.code === "INCOMPLETE_HISTORY"
                ? "journey_history_incomplete"
              : "journey_explorer_unavailable",
  };
}
function createStagingJourneyExplorerHandlerV1(options) {
  if (
    !options ||
    !options.logsClient ||
    typeof options.logsClient.send !== "function" ||
    options.logGroupName !== LOG_GROUP
  )
    throw new TypeError("exact staging Logs client configuration is required");
  const commands = options.commands || sdk(),
    now = typeof options.now === "function" ? options.now : () => Date.now(),
    clock =
      typeof options.monotonicNow === "function"
        ? options.monotonicNow
        : () => Date.now(),
    pause =
      typeof options.pause === "function"
        ? options.pause
        : (durationMs) =>
            new Promise((resolve) => setTimeout(resolve, durationMs)),
    deadlineMs =
      Number.isSafeInteger(options.queryDeadlineMs) &&
      options.queryDeadlineMs >= 1000 &&
      options.queryDeadlineMs <= 12000
        ? options.queryDeadlineMs
        : 12000;
  async function sendBounded(command, timeoutMs, timeoutError) {
    const abortController = new AbortController();
    let timer;
    const request = Promise.resolve().then(() =>
      options.logsClient.send(command, { abortSignal: abortController.signal }),
    );
    const settled = request.then(
      (value) => ({ ok: true, value }),
      (failure) => ({ ok: false, failure }),
    );
    try {
      const outcome = await Promise.race([
        settled,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            abortController.abort();
            resolve(null);
          }, timeoutMs);
        }),
      ]);
      if (outcome === null) throw timeoutError();
      if (!outcome.ok) throw outcome.failure;
      return outcome.value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function run(queryString, start, end, limit) {
    const deadline = clock() + deadlineMs;
    const startRemaining = deadline - clock();
    if (startRemaining <= 0) throw queryTimeoutError();
    const started = await sendBounded(
      new commands.StartQueryCommand({
        logGroupName: LOG_GROUP,
        startTime: Math.floor(start / 1000),
        endTime: Math.ceil(end / 1000),
        queryString,
        limit,
      }),
      startRemaining,
      queryTimeoutError,
    );
    if (
      !started ||
      typeof started.queryId !== "string" ||
      started.queryId.length === 0 ||
      started.queryId.length > 256
    )
      throw new Error("query id");
    const queryId = started.queryId;
    try {
      for (let polls = 0; polls < 50; polls += 1) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw queryTimeoutError();
        const result = await sendBounded(
          new commands.GetQueryResultsCommand({ queryId }),
          remaining,
          queryTimeoutError,
        );
        if (result && result.status === "Complete")
          return Array.isArray(result.results) ? result.results : [];
        if (result && result.status === "Timeout") throw queryTimeoutError();
        if (
          result &&
          ["Failed", "Cancelled", "Unknown"].includes(result.status)
        )
          throw new Error("query");
        const pauseRemaining = deadline - clock();
        if (pauseRemaining <= 0) throw queryTimeoutError();
        await pause(Math.min(250, pauseRemaining));
      }
      throw queryTimeoutError();
    } catch (caught) {
      try {
        await sendBounded(
          new commands.StopQueryCommand({ queryId }),
          CLEANUP_TIMEOUT_MS,
          () => new Error("cleanup timed out"),
        );
      } catch {
        // Best-effort cleanup must not replace the original query failure.
      }
      throw caught;
    }
  }
  return async (event) => {
    try {
      const current = now(),
        parsed = request(event, current);
      if (parsed.operation === "describe")
        return {
          markdown:
            "# Staging Journey Explorer\n\nRead-only staging telemetry. Select a dashboard time range, list journeys, then request a canonical UUID detail timeline.",
        };
      if (parsed.operation === "list") {
        const results = await run(
          LIST_QUERY,
          parsed.start,
          parsed.end,
          LIST_LIMIT,
        );
        if (results.length >= LIST_LIMIT) throw resultLimitError();
        const items = summarize(results),
          journeys = items.slice(
            parsed.offset,
            parsed.offset + parsed.pageSize,
          ),
          next = parsed.offset + journeys.length;
        return {
          journeys,
          next_cursor:
            next < items.length
              ? cursor({
                  v: 1,
                  start: parsed.start,
                  end: parsed.end,
                  offset: next,
                })
              : null,
        };
      }
      const results = await run(
        detailQuery(parsed.journeyId),
        Math.max(0, current - MAX_RANGE),
        current,
        DETAIL_LIMIT,
      );
      if (results.length >= DETAIL_LIMIT) throw resultLimitError();
      const detail = timeline(results, parsed.journeyId);
      if (detail.stages.length === 0) throw notFoundError();
      if (!detail.history_complete) throw incompleteHistoryError();
      return detail;
    } catch (caught) {
      return safe(caught);
    }
  };
}
exports.createStagingJourneyExplorerHandlerV1 =
  createStagingJourneyExplorerHandlerV1;
exports.parseRequestV1 = request;
exports.summarizeJourneyEventsV1 = summarize;
exports.timelineV1 = timeline;
exports.handler = async (event) => {
  if (!cached) {
    const client = sdk();
    if (!process.env.AWS_REGION) throw new Error("AWS_REGION is required");
    const queryDeadlineMs = Number(
      process.env.STAGING_JOURNEY_QUERY_TIMEOUT_MS_V1,
    );
    if (queryDeadlineMs !== 12000)
      throw new Error("staging query timeout configuration is invalid");
    cached = createStagingJourneyExplorerHandlerV1({
      logsClient: new client.CloudWatchLogsClient({
        region: process.env.AWS_REGION,
        maxAttempts: 2,
      }),
      commands: client,
      logGroupName: process.env.STAGING_JOURNEY_LOG_GROUP_NAME_V1,
      queryDeadlineMs,
    });
  }
  return cached(event);
};
