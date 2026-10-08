import { existsSync } from "node:fs";
import { join } from "node:path";
import { pollDeadlineMs } from "./requests.mjs";
import { privateDirectory, readJson, writePrivateJson, writePrivateText } from "./private-files.mjs";

const CAPTURE_ID = /^cap_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRIGGER_RUN_ID = /^run_[A-Za-z0-9-]{4,60}$/u;
const PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_KINDS = new Set(["model_request", "model_response", "model_error", "tool_request", "tool_response", "tool_error", "lifecycle", "capture_error"]);
const ERROR_CODES = new Set(["conflict", "invalid_request", "invalid_output", "not_found", "stale_access_state", "unauthorized", "rate_limited", "quota_exceeded", "unavailable", "timed_out"]);
const callKey = (event, key) => `${event.operation_id ?? "unscoped"}:${event[key]}`;

/** A successful product request and a complete capture are separate outcomes. */
export function traceCompleteness(trace) {
  const problems = [];
  if (trace === undefined) return { complete: false, problems: ["The server returned no diagnostic trace; it may be unavailable or access could not be revalidated."] };
  if (trace.complete !== true || trace.dropped_events !== 0) problems.push("The server could not retain every trace event.");
  const events = trace.events ?? [];
  if (events.length === 0) problems.push("The trace contains no events.");
  if (events.some((event, index) => event.sequence !== index + 1)) problems.push("The trace event sequence is incomplete.");
  if (events.some(event => event.kind === "capture_error")) problems.push("A trace snapshot could not be captured.");
  for (const [prefix, key] of [["model", "call_id"], ["tool", "tool_call_id"]]) {
    const requests = events.filter(event => event.kind === `${prefix}_request`);
    const ids = requests.map(event => callKey(event, key));
    if (requests.some(event => !Number.isSafeInteger(event[key]) || event[key] < 1)) problems.push(`Invalid ${prefix} request identifiers.`);
    if (new Set(ids).size !== ids.length) problems.push(`Duplicate ${prefix} request identifiers.`);
    for (const request of requests) {
      const terminals = events.filter(event => callKey(event, key) === callKey(request, key) && [`${prefix}_response`, `${prefix}_error`].includes(event.kind));
      if (terminals.length === 0) problems.push(`${prefix} request ${request[key]} has no terminal event.`);
      else if (terminals.length !== 1 || terminals[0].sequence <= request.sequence) problems.push(`${prefix} request ${request[key]} has an invalid terminal sequence.`);
    }
    if (events.some(event => [`${prefix}_response`, `${prefix}_error`].includes(event.kind) && !ids.includes(callKey(event, key)))) problems.push(`A ${prefix} terminal event has no request.`);
  }
  if (events.some(event => event.kind === "lifecycle" && event.stage === "trigger" && event.event === "started") &&
      !events.some(event => event.kind === "lifecycle" && event.stage === "application" && ["succeeded", "failed"].includes(event.event))) {
    problems.push("The captured product operation has no terminal lifecycle event.");
  }
  return { complete: problems.length === 0, problems };
}

function jsonBlock(value) {
  const text = JSON.stringify(value, null, 2);
  let backticks = 3;
  for (const match of text.matchAll(/`+/gu)) backticks = Math.max(backticks, match[0].length + 1);
  const fence = "`".repeat(backticks);
  return `${fence}json\n${text}\n${fence}`;
}

/** Save each event before deriving readable copies; prompts remain exact strings in both original and text files. */
function saveTrace(out, result) {
  writePrivateJson(out, "result.json", result);
  const inventory = [];
  const transcript = ["# Captured product trace", "Exact model-port inputs, structured decisions, model-facing tool calls, and lifecycle events. This does not include hidden reasoning or provider HTTP/authentication traffic."];
  const modelStems = new Map();
  const usedStems = new Set();
  for (const [index, event] of (result.trace?.events ?? []).entries()) {
    const sequence = String(index + 1).padStart(4, "0");
    const kind = EVENT_KINDS.has(event.kind) ? event.kind : "unknown";
    const file = `events/${sequence}-${kind}.json`;
    writePrivateJson(out, file, event);
    const files = [file];
    if (kind.startsWith("model_") && Number.isSafeInteger(event.call_id) && event.call_id > 0) {
      const key = callKey(event, "call_id");
      const call = String(event.call_id).padStart(4, "0");
      let stem = modelStems.get(key);
      if (kind === "model_request" || stem === undefined) {
        stem = usedStems.has(call) ? `${call}-event-${sequence}` : call;
        usedStems.add(stem);
        modelStems.set(key, stem);
      }
      if (kind === "model_request") {
        const requestFile = `models/${stem}-request.json`;
        writePrivateJson(out, requestFile, event.input);
        files.push(requestFile);
        if (typeof event.input?.system_prompt === "string") { const path = `models/${stem}-system.txt`; writePrivateText(out, path, event.input.system_prompt); files.push(path); }
        if (typeof event.input?.user_prompt === "string") {
          const path = `models/${stem}-user.txt`; writePrivateText(out, path, event.input.user_prompt); files.push(path);
          try { const parsed = JSON.parse(event.input.user_prompt); const json = `models/${stem}-user.json`; writePrivateJson(out, json, parsed); files.push(json); } catch { /* Exact user text is already retained. */ }
        }
      } else {
        const path = `models/${stem}-${kind === "model_response" ? "response" : "error"}-${sequence}.json`;
        writePrivateJson(out, path, event); files.push(path);
      }
    }
    inventory.push({ sequence: event.sequence, kind: event.kind, files,
      ...(event.operation_id === undefined ? {} : { operation_id: event.operation_id }),
      ...(event.span_id === undefined ? {} : { span_id: event.span_id }),
      ...(event.call_id === undefined ? {} : { call_id: event.call_id }),
      ...(event.tool_call_id === undefined ? {} : { tool_call_id: event.tool_call_id }) });
    transcript.push(`## ${sequence} ${kind}`, jsonBlock(event));
  }
  writePrivateJson(out, "inventory.json", { schema_version: 1, events: inventory });
  writePrivateText(out, "transcript.md", `${transcript.join("\n\n")}\n`);
  const completeness = traceCompleteness(result.trace);
  const productStatus = existsSync(join(out, "product-response.json")) ? "response_received" : existsSync(join(out, "product-error.json")) ? "response_unavailable" : "unknown_on_resume";
  const summary = { schema_version: 1, kind: "echo-research-trace-export-v1",
    ...(result.run_id === undefined ? {} : { run_id: result.run_id }), ...(result.capture_id === undefined ? {} : { capture_id: result.capture_id }),
    status: result.status, product_response: productStatus, ...completeness, events: result.trace?.events.length ?? 0,
    model_calls: result.trace?.events.filter(event => event.kind === "model_request").length ?? 0,
    tool_calls: result.trace?.events.filter(event => event.kind === "tool_request").length ?? 0 };
  writePrivateJson(out, "summary.json", summary);
  return summary;
}

/** Failure receipts contain closed metadata, never raw transport exceptions or provider text. */
function failureReceipt(error) {
  return { schema_version: 1, kind: "echo-diagnostic-request-failure-v1", code: ERROR_CODES.has(error?.code) ? error.code : "unavailable",
    ...(Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599 ? { http_status: error.status } : {}),
    message: "The request failed or its response was lost. The product operation was not retried." };
}

function selection(args) {
  const resume = args["capture-id"];
  if (resume !== undefined) {
    if (args["run-id"] !== undefined || !CAPTURE_ID.test(resume) || args.run !== undefined || args.question !== undefined || args["project-id"] !== undefined || args["trigger-run-id"] !== undefined) {
      throw new Error("Resume needs --capture-id cap_… and cannot start another request.");
    }
    return { resume };
  }
  if (args["run-id"] !== undefined) throw new Error("Resume needs --capture-id cap_…; --run-id is no longer supported.");
  if (args.run !== true) throw new Error("pass --run to capture one ordinary product request");
  if (args["trigger-run-id"] !== undefined) {
    if (!TRIGGER_RUN_ID.test(args["trigger-run-id"]) || args.question !== undefined || args["project-id"] !== undefined) throw new Error("--trigger-run-id needs one existing run and cannot be combined with question or project-id");
    return { target: { kind: "trigger_run", run_id: args["trigger-run-id"] } };
  }
  if (typeof args.question !== "string" || args.question.trim().length === 0 || !PROJECT_ID.test(args["project-id"] ?? "")) throw new Error("trace needs --question and a valid --project-id");
  return { target: { kind: "ask" } };
}

/** One ordinary Ask or existing-run start, or read-only resume. Never starts an evaluation or automatically retries execution. */
export async function runTrace(args, { client, get_client, poll_ms = 2_000, source_sha = null } = {}) {
  const chosen = selection(args);
  const out = privateDirectory(args.out);
  if (existsSync(join(out, "result.json")) || (chosen.resume === undefined && ["request.json", "receipt.json", "execution-request.json"].some(name => existsSync(join(out, name))))) throw new Error("Use a fresh output directory; an existing diagnostic request must not be overwritten or started again.");
  if (chosen.resume !== undefined && existsSync(join(out, "receipt.json"))) {
    const saved = readJson(join(out, "receipt.json"));
    if (saved.capture_id !== chosen.resume) throw new Error("Resume id does not match this output directory's saved receipt");
  }
  const selected = client ?? await get_client();
  let receipt = { capture_id: chosen.resume };
  if (chosen.resume === undefined) {
    const prepare = { schema_version: 1, operation: "prepare", target: chosen.target };
    writePrivateJson(out, "request.json", { started_at: new Date().toISOString(), source_sha, request: prepare,
      ...(chosen.target.kind === "ask" ? { question: args.question, project_id: args["project-id"] } : {}) });
    receipt = await selected.diagnostics(prepare);
    if (!CAPTURE_ID.test(receipt.capture_id) || receipt.status !== "prepared") throw new Error("The server did not return a prepared diagnostic capture; no product operation was started.");
    // This file survives a lost product response. The operation below is invoked exactly once.
    writePrivateJson(out, "receipt.json", receipt);
    const execution = chosen.target.kind === "ask"
      ? { schema_version: 3, question: args.question, project_id: args["project-id"], capture_id: receipt.capture_id }
      : { schema_version: 1, operation: "start", run_id: chosen.target.run_id, capture_id: receipt.capture_id };
    writePrivateJson(out, "execution-request.json", execution);
    try {
      const response = chosen.target.kind === "ask"
        ? await selected.askWithLiveSources(args.question, args["project-id"], undefined, receipt.capture_id)
        : await selected.runs(execution);
      writePrivateJson(out, "product-response.json", response);
    } catch (error) { writePrivateJson(out, "product-error.json", failureReceipt(error)); }
  }
  const id = receipt.capture_id;
  const resumeFlag = "--capture-id";
  const deadline = Date.now() + pollDeadlineMs(chosen.target?.kind === "trigger_run" || chosen.resume !== undefined ? "background" : "live");
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, poll_ms));
    let result;
    try {
      result = await selected.diagnostics({ schema_version: 1, operation: "read", capture_id: id });
    } catch (error) {
      writePrivateJson(out, "capture-read-error.json", failureReceipt(error));
      throw new Error(`Capture ${id} is unavailable or its read failed; exact payloads may have expired or been lost on restart. Resume only with trace ${resumeFlag} ${id} --out ${out}; do not repeat the product request.`);
    }
    if (result.capture_id !== id) throw new Error("The diagnostic response does not match the saved capture identity.");
    if (result.status === "completed" || result.status === "failed") {
      const summary = saveTrace(out, result);
      if (!summary.complete) throw new Error(`Saved incomplete diagnostic evidence in ${out}: ${summary.problems.join(" ")}`);
      return { ...summary, out };
    }
    writePrivateJson(out, "last-status.json", result);
    if (result.status === "prepared") throw new Error(`Capture ${id} was prepared but no product execution claimed it. Saved its receipt; do not repeat the product request. Resume only with trace ${resumeFlag} ${id} --out ${out}.`);
    if (result.status !== "running") throw new Error("The server returned an unknown diagnostic status.");
    if (Date.now() > deadline) throw new Error(`Capture ${id} is still running; resume with trace ${resumeFlag} ${id} --out ${out}. Do not start it again.`);
  }
}
