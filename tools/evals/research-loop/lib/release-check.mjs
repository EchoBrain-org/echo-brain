import { reachChecks, traceCounts } from "./reach.mjs";

/**
 * The staging release check's open-ended Asks (deploy/release/README.md), read from their LangSmith traces. A staging
 * trace's `research` run holds the same research result an evaluation run saves, and its root run the released answer,
 * so the open-ended family's reach and cost checks apply unchanged: every collection holding part of the answer looked
 * at, no refused call sent again, unchecked items stated, research finished within 4 rounds. A trace whose research
 * run was not captured is read from its tool runs instead, which carry each call's arguments, result and round.
 */

const metadataOf = run => run?.metadata ?? run?.extra?.metadata ?? {};
const startOf = run => run?.start_time ?? run?.started_at ?? null;
/** Runs as LangSmith returns them: an array, the MCP's `{ items }` or an API page's `{ runs }`. */
function runsOf(value) {
  const runs = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.runs) ? value.runs : null;
  if (runs === null) throw new Error("the LangSmith export holds no runs: save an array of runs, or the response of a runs query");
  return runs;
}
/** A run's trace: its own field, else its root ancestor (the first parent), else itself when it is the root. */
function traceOf(run) {
  if (typeof run.trace_id === "string") return run.trace_id;
  if (Array.isArray(run.parent_run_ids) && run.parent_run_ids.length > 0) return run.parent_run_ids[0];
  if (typeof run.parent_run_id === "string") return run.parent_run_id;
  return run.id;
}
const isRoot = run => run.is_root === true || (run.parent_run_id == null && (run.parent_run_ids ?? []).length === 0 && /^ECHO /u.test(run.name ?? ""));
const TOOLS = new Set(["search", "list", "open", "finish"]);

/** Rounds rebuilt from tool runs, in call order: each run's arguments, result (or its error kind) and round. */
function roundsFromTools(tools) {
  const ordered = [...tools].sort((left, right) => (metadataOf(left).tool_call_id ?? 0) - (metadataOf(right).tool_call_id ?? 0) || String(startOf(left)).localeCompare(String(startOf(right))));
  const rounds = new Map();
  for (const run of ordered) {
    const round = metadataOf(run).round;
    if (!Number.isSafeInteger(round)) continue;
    const result = run.outputs ?? (typeof run.error === "string" ? { error: run.error } : {});
    rounds.set(round, [...(rounds.get(round) ?? []), { tool: run.name, args: run.inputs ?? {}, result: { items: result.results ?? result.items ?? [], ...result } }]);
  }
  return [...rounds.entries()].sort(([left], [right]) => left - right).map(([round, actions]) => ({ round, actions, rejected: [] }));
}

/**
 * Each trace in a LangSmith export: its question, start, release, whether its capture is complete, its research result
 * (from the research run, or rebuilt from its tool runs), and the answer its root run released.
 */
export function langsmithTraces(value) {
  const byTrace = new Map();
  for (const run of runsOf(value)) {
    if (run === null || typeof run !== "object" || typeof run.id !== "string") continue;
    const id = traceOf(run);
    byTrace.set(id, [...(byTrace.get(id) ?? []), run]);
  }
  return [...byTrace.entries()].flatMap(([traceId, runs]) => {
    const root = runs.find(isRoot);
    const captured = runs.find(run => run.name === "research" && run.outputs?.research !== undefined)?.outputs.research;
    const tools = runs.filter(run => TOOLS.has(run.name) && (run.run_type === undefined || run.run_type === "tool"));
    if (captured === undefined && tools.length === 0) return [];
    const metadata = metadataOf(root);
    const stopReason = captured?.stop?.reason ?? metadata.research_stop_reason ?? null;
    const research = captured ?? { rounds: roundsFromTools(tools), stop: { reason: stopReason }, items: [], lists: [], plan: [], goal: root?.inputs?.brief?.goal };
    const question = research.goal?.question ?? root?.inputs?.brief?.goal?.question ?? null;
    return [{
      trace_id: traceId, question, started_at: startOf(root) ?? startOf(runs.find(run => run.name === "research")) ?? null,
      release_sha: metadata.release_sha ?? null, complete: metadata.complete ?? null, rebuilt_from_tools: captured === undefined,
      stop_reason: stopReason, research, answer: root?.outputs?.result ?? null,
    }];
  });
}

const sameQuestion = (left, right) => typeof left === "string" && typeof right === "string" &&
  left.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase() === right.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();

/**
 * The release check: for each of its questions, the latest trace that asked it, checked as its case's reach and cost
 * keys say. A question with no trace, a trace from another release, or an incomplete capture fails the check.
 */
export function releaseCheck(value, questions, { release_sha: releaseSha } = {}) {
  const traces = langsmithTraces(value);
  const results = questions.map(entry => {
    const asked = traces.filter(trace => sameQuestion(trace.question, entry.question)).sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
    const trace = asked[0];
    if (trace === undefined) return { case_id: entry.id, question: entry.question, found: false, problems: ["no trace asked this question"], passed: false };
    const run = { outcome: "completed", started_at: trace.started_at, result: { status: "completed", research: trace.research, ...(trace.answer === null ? {} : { ask: { response: trace.answer } }) } };
    const reach = reachChecks({ reach: entry.reach }, run);
    const problems = [
      ...(releaseSha !== undefined && trace.release_sha !== releaseSha ? [`the trace ran release ${trace.release_sha ?? "unknown"}, not ${releaseSha}`] : []),
      ...(trace.complete === false ? ["the trace's capture is incomplete"] : []),
      ...(reach.looked_at_every_collection ? [] : [`collections not looked at: ${reach.missing.join(", ")}`]),
      ...(reach.no_repeated_refusal ? [] : ["a refused call was sent again"]),
      ...(reach.unchecked_stated === false ? ["unchecked items were not stated"] : []),
      ...(reach.within_rounds ? [] : [`research did not finish within ${reach.max_rounds} rounds`]),
    ];
    return {
      case_id: entry.id, question: entry.question, found: true, trace_id: trace.trace_id, started_at: trace.started_at, release_sha: trace.release_sha,
      rebuilt_from_tools: trace.rebuilt_from_tools, counts: traceCounts(trace.research), reach, problems, passed: problems.length === 0,
    };
  });
  return { schema_version: 1, kind: "echo-research-release-check-v1", passed: results.every(result => result.passed), questions: results };
}

/** One line per question, for the operator's terminal. */
export function releaseCheckLines(report) {
  return report.questions.map(result => {
    if (!result.found) return `FAIL ${result.case_id}: no trace asked "${result.question}"`;
    const counts = result.counts;
    const summary = `rounds ${counts.rounds} (${counts.stop_reason ?? "no stop reason"}), calls per round ${counts.calls_per_round.join("/") || "none"}, refused ${counts.refused}, repeated refusals ${counts.repeated_refusals}, unchecked ${counts.unchecked}, looked at ${counts.collections.join(", ") || "nothing"}`;
    return `${result.passed ? "PASS" : "FAIL"} ${result.case_id} (trace ${result.trace_id}): ${summary}${result.problems.length === 0 ? "" : `; ${result.problems.join("; ")}`}`;
  });
}
