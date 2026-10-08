import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTrace, traceCompleteness } from "../lib/trace.mjs";

const runId = "rr_00000000-0000-4000-8000-000000000001";
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
const completed = () => ({ schema_version: 1, kind: "echo-person-research-eval-result-v1", run_id: runId, status: "completed", trace: trace() });

test("one diagnostic start saves exact model and tool events privately and refuses a duplicate start", async () => {
  const out = outDir(); const starts = []; let polls = 0;
  const result = completed();
  const client = {
    async startResearchEval(request) { starts.push(request); return { run_id: runId, status: "running" }; },
    async readResearchEval(id) { assert.equal(id, runId); return ++polls === 1 ? { status: "running" } : result; },
  };
  const args = { run: true, question: "What must happen before PVT?", "project-id": projectId, out };
  const summary = await runTrace(args, { client, poll_ms: 0, source_sha: "fixture-sha" });
  assert.equal(summary.complete, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].capture_trace, true);
  assert.deepEqual(read(out, "result.json"), result);
  assert.deepEqual(read(out, "events/0004-model_response.json"), result.trace.events[3]);
  assert.equal(readFileSync(join(out, "models/0001-user.txt"), "utf8"), result.trace.events[2].input.user_prompt);
  assert.deepEqual(read(out, "models/0001-user.json"), prompt);
  assert.equal(readFileSync(join(out, "models/0001-system.txt"), "utf8"), result.trace.events[2].input.system_prompt);
  assert.equal(statSync(out).mode & 0o077, 0);
  assert.equal(statSync(join(out, "result.json")).mode & 0o077, 0);
  await assert.rejects(runTrace(args, { client, poll_ms: 0 }), /fresh output directory/u);
  assert.equal(starts.length, 1);
});

test("resume reads the recorded run without starting another model run", async () => {
  let starts = 0; const out = outDir();
  const client = { async startResearchEval() { starts += 1; throw new Error("must not start"); }, async readResearchEval() { return completed(); } };
  await runTrace({ "run-id": runId, out }, { client, poll_ms: 0 });
  assert.equal(starts, 0);
  assert.equal(read(out, "summary.json").complete, true);
});

test("resume refuses to mix evidence from a different saved run", async () => {
  const out = outDir();
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ run_id: "rr_00000000-0000-4000-8000-000000000099" }), { mode: 0o600 });
  await assert.rejects(runTrace({ "run-id": runId, out }, { client: { async readResearchEval() { throw new Error("must not read"); } }, poll_ms: 0 }), /does not match/u);
});

test("missing capture or a missing terminal event is saved but never reported as complete", async () => {
  for (const missing of ["trace", "response", "overflow"]) {
    const out = outDir(); const result = completed();
    if (missing === "trace") delete result.trace;
    else if (missing === "response") result.trace.events.pop();
    else { result.trace.complete = false; result.trace.dropped_events = 1; }
    await assert.rejects(runTrace({ "run-id": runId, out }, { client: { async readResearchEval() { return result; } }, poll_ms: 0 }), /Saved incomplete diagnostic evidence/u);
    assert.deepEqual(read(out, "result.json"), result);
    assert.equal(read(out, "summary.json").complete, false);
  }
});

test("capture completeness detects duplicate identifiers and orphan replies", () => {
  const value = trace();
  value.events.push({ ...value.events[2], sequence: 5 });
  value.events.push({ kind: "model_response", sequence: 6, call_id: 99, role: "step", value: {} });
  assert.deepEqual(traceCompleteness(value), { complete: false, problems: ["Duplicate model request identifiers.", "A model terminal event has no request."] });
});
