import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTrace, traceCompleteness } from "../lib/trace.mjs";

const captureId = "cap_00000000-0000-4000-8000-000000000001";
const projectId = "prj_00000000-0000-4000-8000-000000000002";
const outDir = () => mkdtempSync(join(tmpdir(), "echo-private-research-trace-"));
const read = (out, file) => JSON.parse(readFileSync(join(out, file), "utf8"));
const prompt = { last_results: [{ tool: "open", id: "E1", opened: ["E1"], results: [{ id: "E2", title: "Fixture readiness" }] }], opened: [{ id: "E1", text: "Gate\nReadiness depends on fixtures." }] };
const trace = () => ({ schema_version: 1, kind: "echo-agentic-research-trace-v1", complete: true, dropped_events: 0, events: [
  { sequence: 1, kind: "tool_request", tool_call_id: 1, round: 1, tool: "open", args: { id: "E1" } },
  { sequence: 2, kind: "tool_response", tool_call_id: 1, round: 1, tool: "open", result: prompt.last_results[0] },
  { sequence: 3, kind: "model_request", call_id: 1, role: "step", recovery: false, input: { model: "fixture", system_prompt: "Read related items.\nThen decide.", user_prompt: JSON.stringify(prompt), schema: { type: "object" }, max_output_tokens: 100, timeout_ms: 1000 } },
  { sequence: 4, kind: "model_response", call_id: 1, role: "step", value: { parts: [], actions: [{ tool: "open", args: { id: "E2" } }] } },
] });
const captured = () => ({ schema_version: 1, kind: "echo-person-diagnostic-result-v1", capture_id: captureId, status: "completed", expires_at: "2026-10-09T00:00:00.000Z", trace: trace() });
const prepared = () => ({ schema_version: 1, kind: "echo-person-diagnostic-capture-v1", capture_id: captureId, status: "prepared", expires_at: "2026-10-09T00:00:00.000Z" });

test("prepares and saves a capture before exactly one ordinary Ask, then saves all exact payloads privately", async () => {
  const out = outDir(); const starts = []; const asks = []; let polls = 0;
  const result = captured();
  const client = {
    async diagnostics(request) {
      if (request.operation === "prepare") { starts.push(request); return prepared(); }
      assert.equal(request.capture_id, captureId);
      return ++polls === 1 ? { ...prepared(), status: "running" } : result;
    },
    async askWithLiveSources(...args) {
      asks.push(args);
      assert.deepEqual(read(out, "receipt.json"), prepared());
      assert.equal(read(out, "execution-request.json").capture_id, captureId);
      return { outcome: "answered", statements: [] };
    },
  };
  const args = { run: true, question: "What must happen before PVT?", "project-id": projectId, out };
  const summary = await runTrace(args, { client, poll_ms: 0, source_sha: "fixture-sha" });
  assert.equal(summary.complete, true);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], { schema_version: 1, operation: "prepare", target: { kind: "ask" } });
  assert.deepEqual(asks, [[args.question, projectId, undefined, captureId]]);
  assert.equal(summary.capture_id, captureId);
  assert.equal(summary.product_response, "response_received");
  assert.deepEqual(read(out, "product-response.json"), { outcome: "answered", statements: [] });
  assert.deepEqual(read(out, "result.json"), result);
  assert.deepEqual(read(out, "events/0004-model_response.json"), result.trace.events[3]);
  assert.equal(readFileSync(join(out, "models/0001-user.txt"), "utf8"), result.trace.events[2].input.user_prompt);
  assert.deepEqual(read(out, "models/0001-user.json"), prompt);
  assert.equal(readFileSync(join(out, "models/0001-system.txt"), "utf8"), result.trace.events[2].input.system_prompt);
  assert.deepEqual(read(out, "models/0001-response-0004.json"), result.trace.events[3]);
  assert.equal(read(out, "inventory.json").events.length, 4);
  assert.match(readFileSync(join(out, "transcript.md"), "utf8"), /Fixture readiness/u);
  assert.equal(statSync(out).mode & 0o077, 0);
  assert.equal(statSync(join(out, "result.json")).mode & 0o077, 0);
  await assert.rejects(runTrace(args, { client, poll_ms: 0 }), /fresh output directory/u);
  assert.equal(starts.length, 1);
  assert.equal(asks.length, 1);
});

test("missing capture or a missing terminal event is saved but never reported as complete", async () => {
  for (const missing of ["trace", "response", "overflow"]) {
    const out = outDir(); const result = captured();
    if (missing === "trace") delete result.trace;
    else if (missing === "response") result.trace.events.pop();
    else { result.trace.complete = false; result.trace.dropped_events = 1; }
    await assert.rejects(runTrace({ "capture-id": captureId, out }, { client: { async diagnostics() { return result; } }, poll_ms: 0 }), /Saved incomplete diagnostic evidence/u);
    assert.deepEqual(read(out, "result.json"), result);
    assert.equal(read(out, "summary.json").complete, false);
  }
});

test("capture completeness detects duplicate identifiers and orphan replies", () => {
  const value = trace();
  value.events.push({ ...value.events[2], sequence: 5 });
  value.events.push({ kind: "model_response", sequence: 6, call_id: 99, role: "step", value: {} });
  const checked = traceCompleteness(value);
  assert.equal(checked.complete, false);
  assert.ok(checked.problems.includes("Duplicate model request identifiers."));
  assert.ok(checked.problems.includes("A model terminal event has no request."));
});

test("an ordinary Ask failure never retries execution and still exports a complete failed trace", async () => {
  const out = outDir(); let asks = 0;
  const result = { ...captured(), status: "failed", error: { code: "unavailable", message: "Captured operation failed" } };
  result.trace.events[3] = { sequence: 4, kind: "model_error", call_id: 1, role: "step", error_kind: "unavailable" };
  const client = {
    async diagnostics(request) { return request.operation === "prepare" ? prepared() : result; },
    async askWithLiveSources() { asks += 1; throw Object.assign(new Error("private transport detail"), { code: "unavailable", status: 503 }); },
  };
  const summary = await runTrace({ run: true, question: "What must happen before PVT?", "project-id": projectId, out }, { client, poll_ms: 0 });
  assert.equal(asks, 1);
  assert.equal(summary.complete, true);
  assert.equal(summary.status, "failed");
  assert.equal(summary.product_response, "response_unavailable");
  assert.equal(read(out, "product-error.json").code, "unavailable");
  assert.doesNotMatch(readFileSync(join(out, "product-error.json"), "utf8"), /private transport detail/u);
  assert.deepEqual(read(out, "result.json"), result);
});

test("a lost Ask response can resume by capture id without preparing or repeating product work", async () => {
  const out = outDir();
  writeFileSync(join(out, "receipt.json"), JSON.stringify(prepared()), { mode: 0o600 });
  let reads = 0;
  const client = {
    async diagnostics(request) { assert.deepEqual(request, { schema_version: 1, operation: "read", capture_id: captureId }); reads += 1; return captured(); },
    async askWithLiveSources() { throw new Error("must not repeat Ask"); },
    async runs() { throw new Error("must not start a run"); },
  };
  const summary = await runTrace({ "capture-id": captureId, out }, { client, poll_ms: 0 });
  assert.equal(reads, 1);
  assert.equal(summary.capture_id, captureId);
  assert.equal(summary.product_response, "unknown_on_resume");
});

test("selects one existing pending trigger run without approving or retrying it", async () => {
  const out = outDir(); const run_id = "run_00000000-0000-4000-8000-000000000001"; const starts = [];
  const client = {
    async diagnostics(request) {
      if (request.operation === "prepare") { assert.deepEqual(request.target, { kind: "trigger_run", run_id }); return prepared(); }
      return captured();
    },
    async runs(request) {
      assert.deepEqual(read(out, "receipt.json"), prepared());
      starts.push(request); return { state: "running" };
    },
  };
  await runTrace({ run: true, "trigger-run-id": run_id, out }, { client, poll_ms: 0 });
  assert.deepEqual(starts, [{ schema_version: 1, operation: "start", run_id, capture_id: captureId }]);
});

test("an unclaimed capture is retained for inspection without retrying a busy trigger run", async () => {
  const out = outDir(); let starts = 0;
  const client = {
    async diagnostics(request) { return request.operation === "prepare" ? prepared() : { ...captured(), status: "prepared", trace: undefined }; },
    async runs() { starts += 1; return { state: "busy" }; },
  };
  await assert.rejects(runTrace({ run: true, "trigger-run-id": "run_pending", out }, { client, poll_ms: 0 }), /no product execution claimed/u);
  assert.equal(starts, 1);
  assert.equal(read(out, "last-status.json").status, "prepared");
  assert.equal(existsSync(join(out, "result.json")), false);
});

test("read failure preserves the known capture and sanitized failure without repeating execution", async () => {
  const out = outDir(); let asks = 0;
  const client = {
    async diagnostics(request) {
      if (request.operation === "prepare") return prepared();
      throw new Error("private provider or transport error");
    },
    async askWithLiveSources() { asks += 1; return { outcome: "answered" }; },
  };
  await assert.rejects(runTrace({ run: true, question: "PVT readiness?", "project-id": projectId, out }, { client, poll_ms: 0 }), /may have expired or been lost on restart/u);
  assert.equal(asks, 1);
  assert.equal(read(out, "receipt.json").capture_id, captureId);
  assert.doesNotMatch(readFileSync(join(out, "capture-read-error.json"), "utf8"), /private provider/u);
});

test("capture selection rejects contradictory requests and identity mismatches before further work", async () => {
  for (const args of [
    { "capture-id": captureId, run: true },
    { "capture-id": captureId, "run-id": "rr_00000000-0000-4000-8000-000000000001" },
    { "capture-id": captureId, question: "Another Ask" },
    { "run-id": "rr_00000000-0000-4000-8000-000000000001" },
    { run: true, "trigger-run-id": "run_pending", "project-id": projectId },
  ]) await assert.rejects(runTrace({ ...args, out: outDir() }, { get_client() { throw new Error("must not construct client"); } }));
  const out = outDir();
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ ...prepared(), capture_id: "cap_00000000-0000-4000-8000-000000000099" }), { mode: 0o600 });
  await assert.rejects(runTrace({ "capture-id": captureId, out }, { get_client() { throw new Error("must not construct client"); } }), /does not match/u);
  await assert.rejects(runTrace({ "capture-id": captureId, out: outDir() }, {
    client: { async diagnostics() { return { ...captured(), capture_id: "cap_00000000-0000-4000-8000-000000000099" }; } }, poll_ms: 0,
  }), /does not match/u);
});

test("retains every model input when separate operations reuse a call number, and checks product lifecycle terminals", async () => {
  const result = captured();
  result.trace.events = [
    { ...trace().events[2], sequence: 1, operation_id: "first" },
    { ...trace().events[3], sequence: 2, operation_id: "first" },
    { ...trace().events[2], sequence: 3, operation_id: "second" },
    { ...trace().events[3], sequence: 4, operation_id: "second" },
    { kind: "lifecycle", stage: "trigger", event: "started", sequence: 5 },
    { kind: "lifecycle", stage: "application", event: "succeeded", sequence: 6 },
  ];
  const out = outDir();
  const summary = await runTrace({ "capture-id": captureId, out }, { client: { async diagnostics() { return result; } }, poll_ms: 0 });
  assert.equal(summary.complete, true);
  assert.equal(read(out, "inventory.json").events.length, 6);
  assert.deepEqual(read(out, "models/0001-request.json"), result.trace.events[0].input);
  assert.deepEqual(read(out, "models/0001-event-0003-request.json"), result.trace.events[2].input);
  result.trace.events.pop();
  assert.ok(traceCompleteness(result.trace).problems.includes("The captured product operation has no terminal lifecycle event."));
});
