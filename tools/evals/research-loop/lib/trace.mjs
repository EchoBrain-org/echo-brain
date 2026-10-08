import { existsSync } from "node:fs";
import { join } from "node:path";
import { pollDeadlineMs } from "./requests.mjs";
import { privateDirectory, readJson, writePrivateJson, writePrivateText } from "./private-files.mjs";

const RUN_ID = /^rr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A successful run and a complete capture are separate outcomes. */
export function traceCompleteness(trace) {
  const problems = [];
  if (trace === undefined) return { complete: false, problems: ["The server returned no diagnostic trace; it may need the capture-enabled release."] };
  if (trace.complete !== true || trace.dropped_events !== 0) problems.push("The server could not retain every trace event.");
  const events = trace.events ?? [];
  if (events.length === 0) problems.push("The trace contains no events.");
  if (events.some((event, index) => event.sequence !== index + 1)) problems.push("The trace event sequence is incomplete.");
  if (events.some(event => event.kind === "capture_error")) problems.push("A trace snapshot could not be captured.");
  for (const [prefix, key] of [["model", "call_id"], ["tool", "tool_call_id"]]) {
    const requests = events.filter(event => event.kind === `${prefix}_request`);
    const ids = requests.map(event => event[key]);
    if (new Set(ids).size !== ids.length) problems.push(`Duplicate ${prefix} request identifiers.`);
    for (const id of ids) {
      if (!events.some(event => event[key] === id && [ `${prefix}_response`, `${prefix}_error` ].includes(event.kind))) problems.push(`${prefix} request ${id} has no terminal event.`);
    }
    if (events.some(event => [ `${prefix}_response`, `${prefix}_error` ].includes(event.kind) && !ids.includes(event[key]))) problems.push(`A ${prefix} terminal event has no request.`);
  }
  return { complete: problems.length === 0, problems };
}

/** Save original events plus readable copies; user_prompt remains exact in result.json and request events. */
function saveTrace(out, result) {
  writePrivateJson(out, "result.json", result);
  for (const event of result.trace?.events ?? []) {
    const sequence = String(event.sequence).padStart(4, "0");
    writePrivateJson(out, `events/${sequence}-${event.kind}.json`, event);
    if (event.kind !== "model_request") continue;
    const call = String(event.call_id).padStart(4, "0");
    writePrivateJson(out, `models/${call}-request.json`, event.input);
    writePrivateText(out, `models/${call}-system.txt`, event.input.system_prompt);
    // Save the exact string even if a future adapter sends a non-JSON prompt.
    writePrivateText(out, `models/${call}-user.txt`, event.input.user_prompt);
    try { writePrivateJson(out, `models/${call}-user.json`, JSON.parse(event.input.user_prompt)); } catch { /* Exact prompt is already retained. */ }
  }
  const completeness = traceCompleteness(result.trace);
  const summary = { schema_version: 1, kind: "echo-research-trace-export-v1", run_id: result.run_id, status: result.status,
    ...completeness, events: result.trace?.events.length ?? 0,
    model_calls: result.trace?.events.filter(event => event.kind === "model_request").length ?? 0,
    tool_calls: result.trace?.events.filter(event => event.kind === "tool_request").length ?? 0 };
  writePrivateJson(out, "summary.json", summary);
  return summary;
}

/** One explicitly requested Ask, or a read-only resume of its recorded run id. Never automatically retries start. */
export async function runTrace(args, { client, get_client, poll_ms = 2_000, source_sha = null } = {}) {
  if (args["run-id"] === undefined && args.run !== true) throw new Error("pass --run to start one diagnostic run on staging");
  if (args["run-id"] !== undefined && (!RUN_ID.test(args["run-id"]) || args.question !== undefined || args["project-id"] !== undefined)) throw new Error("--run-id must identify an existing run and cannot be combined with question or project-id");
  if (args["run-id"] === undefined && (typeof args.question !== "string" || args.question.trim().length === 0 || !PROJECT_ID.test(args["project-id"] ?? ""))) throw new Error("trace needs --question and a valid --project-id");
  const out = privateDirectory(args.out);
  if (existsSync(join(out, "result.json")) || (args["run-id"] === undefined && existsSync(join(out, "request.json")))) throw new Error("Use a fresh output directory; an existing diagnostic run must not be overwritten or started again.");
  if (args["run-id"] !== undefined && existsSync(join(out, "receipt.json")) && readJson(join(out, "receipt.json")).run_id !== args["run-id"]) throw new Error("--run-id does not match this output directory's saved receipt");
  const selected = client ?? await get_client();
  const started = Date.now();
  let receipt;
  if (args["run-id"] !== undefined) receipt = { run_id: args["run-id"] };
  else {
    const request = { schema_version: 1, trigger: "ask", input: { question: args.question }, budget: "live", project_id: args["project-id"], capture_trace: true };
    writePrivateJson(out, "request.json", { started_at: new Date(started).toISOString(), source_sha, request });
    receipt = await selected.startResearchEval(request);
    writePrivateJson(out, "receipt.json", receipt);
  }
  const deadline = started + pollDeadlineMs("live");
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, poll_ms));
    const result = await selected.readResearchEval(receipt.run_id);
    if (result.status !== "running") {
      const summary = saveTrace(out, result);
      if (!summary.complete) throw new Error(`Saved incomplete diagnostic evidence in ${out}: ${summary.problems.join(" ")}`);
      return { ...summary, out };
    }
    if (Date.now() > deadline) throw new Error(`Diagnostic run ${receipt.run_id} is still running; resume with trace --run-id ${receipt.run_id} --out ${out}. Do not start it again.`);
  }
}
