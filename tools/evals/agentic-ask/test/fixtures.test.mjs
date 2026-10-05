import assert from "node:assert/strict";
import test from "node:test";
import { CASES, createFixtureDesk, fixtureSha256 } from "../fixtures.mjs";
import { grade, researchStepDiagnostic, runTrial } from "../run.mjs";

test("ticket inventory is metadata-only and later-page discovery remains synthetic", async () => {
  const definition = CASES.find((entry) => entry.id === "later-page-discovery");
  const { desk, trace } = createFixtureDesk(definition);
  const first = await desk.list({ source: "ticket", limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.items.every((item) => item.text === undefined), true);
  assert.equal(first.next_cursor, "synthetic-page:50");
  assert.deepEqual(trace, [{ tool: "list", source: "ticket", result_count: 50, discovered_count: 50, page: 1, more: true }]);
});

test("the fixture catalog exposes the selected ticket tool and never supplies tickets to V1", () => {
  const jira = CASES.find((entry) => entry.id === "ticket-jira-label");
  const linear = CASES.find((entry) => entry.id === "ticket-linear-label");
  const meeting = CASES.find((entry) => entry.id === "approved-meeting");
  assert.deepEqual(createFixtureDesk(jira).desk.live_sources, [{ source: "ticket", tool_id: "jira" }]);
  assert.deepEqual(createFixtureDesk(linear).desk.live_sources, [{ source: "ticket", tool_id: "linear" }]);
  assert.deepEqual(createFixtureDesk(meeting).desk.live_sources, []);
});

test("search filters exactly by requested kinds, reports truncation, and cursors honor their offset", async () => {
  const mixed = CASES.find((entry) => entry.id === "mixed-meeting-and-ticket");
  const { desk } = createFixtureDesk(mixed);
  const documents = await desk.search({ query: "Pilot Delta", kinds: ["document_passage"], limit: 8 });
  assert.deepEqual(documents.items, []);
  const tickets = await desk.search({ query: "Pilot Delta", kinds: ["ticket"], limit: 1 });
  assert.equal(tickets.items.length, 1);
  assert.equal(tickets.items[0].kind, "ticket");
  assert.equal(tickets.truncated, false);
  const later = CASES.find((entry) => entry.id === "later-page-discovery");
  const searchableLater = { ...later, search_empty: false };
  const search = await createFixtureDesk(searchableLater).desk.search({ query: "Background", kinds: ["ticket"], limit: 7 });
  assert.equal(search.items.length, 7);
  assert.equal(search.truncated, true);
  const laterDesk = createFixtureDesk(later).desk;
  const page = await laterDesk.list({ source: "ticket", limit: 7, cursor: "synthetic-page:49" });
  assert.equal(page.items.length, 3);
  assert.equal(page.next_cursor, undefined);
});

test("fixture identity is stable and contains no work-tool host", () => {
  const digest = fixtureSha256();
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(CASES).includes("atlassian.net"), false);
  assert.equal(JSON.stringify(CASES).includes("slack.com"), false);
});

test("empty-source grading rejects an early partial answer and a no-read not-found answer", () => {
  const empty = CASES.find((entry) => entry.id === "empty-source");
  const earlyPartial = grade(empty, { outcome: "partial", citations: [] }, [], null);
  assert.equal(earlyPartial.passed, false);
  assert.equal(earlyPartial.checks.find((entry) => entry.name === "empty_source_was_read").passed, false);
  assert.equal(earlyPartial.checks.find((entry) => entry.name === "honest_empty_outcome").passed, false);
  const noReadNotFound = grade(empty, { outcome: "not_found", citations: [] }, [], null);
  assert.equal(noReadNotFound.passed, false);
  assert.equal(noReadNotFound.checks.find((entry) => entry.name === "honest_empty_outcome").passed, true);
  assert.equal(noReadNotFound.checks.find((entry) => entry.name === "empty_source_was_read").passed, false);
});

test("a rejected generation is retained as safe attempt metadata without its error message", async () => {
  const rejected = Object.assign(new Error("synthetic secret-like diagnostic must not be retained"), {
    diagnostic: { failure_class: "adapter_http", http_status: 429, finish_reason: null },
    generation_observation: { usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 }, provider_latency_ms: 7 },
  });
  const result = await runTrial(
    CASES.find((entry) => entry.id === "approved-meeting"),
    1,
    { generate_with_observation: async () => { throw rejected; } },
    { generation_adapter_id: "synthetic", planner_model: "synthetic", answer_model: "synthetic", timeout_ms: 30_000 },
    { maxModelCalls: 6, timeoutMs: 60_000 },
  );
  assert.equal(result.admitted_model_attempts, 2);
  assert.equal(result.failure_trace.model_calls.length, 2);
  assert.deepEqual(result.failure_trace.model_calls.map((entry) => entry.error.failure_class), ["adapter_http", "adapter_http"]);
  assert.equal(JSON.stringify(result.failure_trace).includes("secret-like"), false);
});

test("a locally rejected over-budget proposal does not inflate admitted provider attempts", async () => {
  const result = await runTrial(
    CASES.find((entry) => entry.id === "approved-meeting"),
    1,
    { generate_with_observation: async () => ({
      value: { parts: [{ question: "What happened?", needs: [{ need: "decision", status: "open", evidence: [] }], notes: "" }], actions: [{ tool: "finish", args: {} }] },
      finish_reason: "stop",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      provider_latency_ms: 1,
    }) },
    { generation_adapter_id: "synthetic", planner_model: "synthetic", answer_model: "synthetic", timeout_ms: 30_000 },
    { maxModelCalls: 1, timeoutMs: 60_000 },
  );
  assert.equal(result.admitted_model_attempts, 1);
  assert.equal(result.failure_trace.admitted_model_attempts, 1);
  assert.equal(result.failure_trace.model_calls.at(-1).attempt, 2);
  assert.equal(result.failure_trace.model_calls.at(-1).error.name, "EvaluationModelCallBudgetError");
});

test("held-out cases require reader-visible decision and precise missing facts beyond a citation", () => {
  const release = CASES.find((entry) => entry.id === "held-out-long-release-decision");
  const multipart = CASES.find((entry) => entry.id === "held-out-multipart-missing-date-owner");
  const operations = [{ tool: "search", source: "meeting", result_count: 1 }, { tool: "open", source: "meeting", known_before_open: true, result_count: 1 }];
  const citation = { citation: { kind: "approved_record" } };
  const citationOnly = grade(release, { outcome: "answered", citations: [citation], parts: [{ statements: [{ text: "A record exists." }] }] }, operations, null);
  assert.equal(citationOnly.passed, false);
  const full = grade(release, { outcome: "answered", citations: [citation], parts: [{ statements: [{ text: "The approved release may proceed." }] }] }, operations, null);
  assert.equal(full.passed, true);
  const partial = grade(multipart, {
    outcome: "partial",
    citations: [citation],
    parts: [{ statements: [{ text: "The approved launch gate may proceed." }], gap: "Not found: approved date; owner." }],
  }, operations, null);
  assert.equal(partial.passed, true);
  const recordsOnly = grade(release, {
    outcome: "answered",
    citations: [citation],
    parts: [{ statements: [], records: [{ text: "A synthetic record exists." }] }],
  }, operations, null);
  assert.equal(recordsOnly.passed, false);
});

test("gap grading accepts controller prefixes and who-owns wording but rejects real meeting context", () => {
  const multipart = CASES.find((entry) => entry.id === "held-out-multipart-missing-date-owner");
  const operations = [{ tool: "search", source: "meeting", result_count: 1 }, { tool: "open", source: "meeting", known_before_open: true, result_count: 1 }];
  const citation = { citation: { kind: "approved_record" } };
  const wrapped = grade(multipart, {
    outcome: "partial",
    citations: [citation],
    parts: [{ statements: [{ text: "The approved launch gate may proceed." }], gap: "I couldn't complete the search. Please try again. Missing context: the date that was approved; who owns the launch gate decision." }],
  }, operations, null);
  assert.equal(wrapped.passed, true);
  const actualContext = grade(multipart, {
    outcome: "partial",
    citations: [citation],
    parts: [{ statements: [{ text: "The approved launch gate may proceed." }], gap: "Not found: approved date; who owns the launch gate decision; meeting context." }],
  }, operations, null);
  assert.equal(actualContext.passed, false);
  assert.equal(actualContext.checks.find((entry) => entry.name === "reader_visible_no_gap_context").passed, false);
});

test("the missing-date-owner fixture carries neither an approved date nor an owner", () => {
  const multipart = CASES.find((entry) => entry.id === "held-out-multipart-missing-date-owner");
  const record = multipart.items[0];
  assert.equal(Object.hasOwn(record, "occurred_at"), false);
  assert.equal(Object.hasOwn(record.attributes ?? {}, "owner"), false);
  assert.equal(record.text.toLocaleLowerCase().includes("october"), false);
});

test("research diagnostics retain only structural planner facts", () => {
  const diagnostic = researchStepDiagnostic({
    parts: [{ needs: [{ need: "secret launch date", status: "open" }, { need: "private owner", status: "found" }, { need: "unused", status: "not_found" }] }],
    actions: [{ tool: "search", args: { query: "private project code" } }, { tool: "finish", args: {} }],
  });
  assert.deepEqual(diagnostic, {
    part_count: 1,
    need_status_counts: { open: 1, found: 1, not_found: 1, other: 0 },
    action_names: ["search", "finish"],
    finish_only: false,
    has_read_action: true,
  });
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
});
