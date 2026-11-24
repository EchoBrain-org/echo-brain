#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of Ask's follow-up resolution (ADR-0047; Ask
 * timeline v1, "Follow-up resolution eval (pre-registered)") and, with
 * `--set threads`, of its thread resolution (ADR-0056; Ask threads v1,
 * "Thread resolution eval (pre-registered)").
 *
 * Each case in cases.json is a previous turn and a new question; each case in
 * thread-cases.json is an Ask with the asker's other threads and, for most,
 * an open thread. The kernel's resolver runs on it directly, with the
 * product's model route (the shipped OpenRouter bundle and its answer model,
 * ADR-0037), three times, and grade.mjs grades every trial deterministically.
 * The only network operation is the structured-generation request that bundle
 * makes, after the caller explicitly supplies --run and --credential-file.
 * The bundle reads the credential file; this runner only checks that it is a
 * private file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgenticFollowUpOnceV1, resolveAgenticThreadOnceV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { assertExplicitRun, boundedInteger, codeIdentity, generationMetadata, json, observedGeneration, outputDirectory, readFlags, safeError, sha256 } from "../shared/runner.mjs";
import {
  CASES_FILE, GROUPS, gradeTrial, loadCases, summarizeRules,
  THREAD_CASES_FILE, THREAD_GROUPS, gradeThreadTrial, loadThreadCases, summarizeThreadRules,
} from "./grade.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
const MAX_TRIALS = 3;
/** The resolver's own call waits up to 15 s, so a shorter trial could never finish. There is no upper bound: the operator chooses. */
const MIN_TIMEOUT_MS = 15_000;

/** The files every report fingerprints, beside the commit, its uncommitted changes and the set's own cases file. */
const CODE_FILES = Object.freeze([
  "tools/evals/ask-follow-up/run.mjs",
  "tools/evals/shared/runner.mjs",
  "tools/evals/ask-follow-up/grade.mjs",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-follow-up-resolver-v1.js",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-model-gate-v1.js",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js",
  "providers/openrouter/dist/openrouter-answer-composition-generation-bundle-v1.js",
  "providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
]);

/** A group's counts in a report: how many of its trials ran, passed, fell back and threw, and any counts of its own. */
const groupCounts = (trials, more) => Object.freeze({ trials: trials.length, passed: trials.filter((entry) => entry.passed).length, ...more(trials),
  fallback: trials.filter((entry) => entry.fallback === true).length, errors: trials.filter((entry) => entry.error !== undefined).length });

/**
 * The two pre-registered sets this runner holds, each with its own cases, trial, rules and report. Nothing is shared
 * between them but the runner: the follow-up set is exactly what it was before the thread set existed.
 */
const SETS = Object.freeze({
  "follow-up": Object.freeze({
    cases_file: CASES_FILE, cases_path: "tools/evals/ask-follow-up/cases.json", groups: GROUPS, load: loadCases,
    trial: (...args) => runTrial(...args), summarize: (results) => summarizeRules(results),
    group: (trials) => groupCounts(trials, (list) => ({ clarify: list.filter((entry) => entry.clarify).length })),
    report_kind: "echo-ask-follow-up-evaluation-v1", progress_kind: "echo-ask-follow-up-evaluation-progress-v1", report_prefix: "ask-follow-up-evaluation",
    progress: (result) => ({ resolution: result.resolution }),
    // Rules 1 and 2 decide whether follow-ups ship.
    ships: "follow_ups_ship",
  }),
  threads: Object.freeze({
    cases_file: THREAD_CASES_FILE, cases_path: "tools/evals/ask-follow-up/thread-cases.json", groups: THREAD_GROUPS, load: loadThreadCases,
    // The grader itself says whether the trials are the whole registered run: the gate is its, not the selection's.
    trial: (...args) => runThreadTrial(...args), summarize: (results, document) => summarizeThreadRules(results, document.cases),
    group: (trials) => groupCounts(trials, (list) => ({ named_all: list.filter((entry) => entry.named_all).length, merged: list.filter((entry) => entry.merged).length })),
    report_kind: "echo-ask-thread-evaluation-v1", progress_kind: "echo-ask-thread-evaluation-progress-v1", report_prefix: "ask-thread-evaluation",
    progress: (result) => ({ thread: result.thread }),
    // Rules 1, 2 and 4 decide whether ECHO picks threads, and only over the whole registered run.
    ships: "echo_picks_threads",
  }),
});
const caseCount = (set) => Object.values(set.groups).reduce((total, count) => total + count, 0);
/** One call and its one repair per trial. */
const maxModelCalls = (set) => caseCount(set) * MAX_TRIALS * 2;
/** The set a run's options name: the follow-up set unless `--set threads` chose the other. */
const setOf = (options) => SETS[options.set ?? "follow-up"];
/** Whether a run's report says its set's deciding rules passed: what the exit status follows, and nothing else does. */
export const qualifies = (report, options) => report[setOf(options).ships] === true;

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  npm run eval:ask-follow-up -- --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "  npm run eval:ask-threads -- --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id     Select cases, each once (default: all ${caseCount(SETS["follow-up"])} follow-up cases, or all ${caseCount(SETS.threads)} thread cases); only the whole set decides.`,
    `  --trials N        Trials per case, 1 through ${MAX_TRIALS} (default: ${MAX_TRIALS}, as pre-registered).`,
    "  --timeout-ms N    Per-trial timeout, at least 15000 (default: 60000).",
    "  --set NAME        The pre-registered set: follow-up (default), or threads, which eval:ask-threads passes.",
    "  --help            Show this text without reading a credential or making a request.",
    "",
    "Each trial runs the kernel's resolver once (one call and at most one repair) on a synthetic case: a previous turn and",
    "question, or, for threads, an open thread, the asker's other threads and a question. It goes through the production",
    "OpenRouter generation bundle; nothing is read from any tool. --out must be outside the repository and private; the",
    "report is written there with mode 0600. It keeps case ids, each trial's resolution (its resolved question, source",
    "numbers and choices, synthetic text) or placement (its thread and merge numbers), its grade, and model metadata; never",
    "prompts, raw replies, credentials or provider payloads.",
    "",
    "Exit 0 when the set's deciding rules pass (follow-up: rules 1 and 2, so follow-ups may ship; threads: rules 1, 2 and",
    "4 over the whole set, every case once with three trials, so ECHO may pick threads), 1 when they do not, 2 on a usage",
    "error. A run of some thread cases, or of fewer trials, reports its rules and always exits 1.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, trials: MAX_TRIALS, timeoutMs: 60_000, set: "follow-up" };
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--cases": (value) => { options.caseIds = value.split(",").map((part) => part.trim()).filter(Boolean); },
    "--trials": (value) => { options.trials = Number(value); },
    "--timeout-ms": (value) => { options.timeoutMs = Number(value); },
    "--set": (value) => { if (!Object.hasOwn(SETS, value)) throw new Error("--set must be follow-up or threads"); options.set = value; },
  })) return { help: true };
  assertExplicitRun(options);
  const set = setOf(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, MAX_TRIALS);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", MIN_TIMEOUT_MS, Number.MAX_SAFE_INTEGER);
  const known = new Set(set.load().cases.map((entry) => entry.id));
  // A case named twice would be run twice: its trials would count twice toward every rule.
  if (options.caseIds !== null && (options.caseIds.length === 0 || options.caseIds.some((id) => !known.has(id)) || new Set(options.caseIds).size !== options.caseIds.length)) throw new Error("--cases must select known cases, each once");
  if ((options.caseIds?.length ?? known.size) * options.trials * 2 > maxModelCalls(set)) throw new Error(`requested model-call budget exceeds ${maxModelCalls(set)}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/**
 * One resolver call of a trial, through `structuredOutput` (the production adapter, or a test's), with only model
 * metadata recorded per call. What it resolved, or the safe error of a trial that threw, which passes nothing.
 */
async function resolvedTrial(structuredOutput, resolve) {
  const calls = [];
  const model = Object.freeze({
    async generate(input) { return (await this.generate_with_observation(input)).value; },
    async generate_with_observation(input) {
      const attempt = calls.length + 1;
      try {
        const observed = await observedGeneration(structuredOutput, input);
        // Deliberately only provider metadata: `observed.value` is never copied.
        calls.push(Object.freeze({ attempt, result: "succeeded", ...generationMetadata(observed) }));
        return observed;
      } catch (error) {
        calls.push(Object.freeze({ attempt, result: "rejected", error: safeError(error) }));
        throw error;
      }
    },
  });
  const started = performance.now();
  let resolved = null;
  let error = null;
  try {
    resolved = await resolve(model);
  } catch (caught) {
    error = safeError(caught);
  }
  return { resolved, error, calls, elapsed_ms: () => Math.round(performance.now() - started) };
}

/**
 * One trial: the kernel's resolver on one case, through `structuredOutput` (the production adapter, or a test's), with
 * only model metadata recorded per call. A trial that throws is kept as its safe error and passes nothing.
 */
export async function runTrial(caseDefinition, trial, structuredOutput, generation, document, options) {
  const { resolved, error, calls, elapsed_ms: elapsed } = await resolvedTrial(structuredOutput, (model) => resolveAgenticFollowUpOnceV1({
    model, generation, previous: caseDefinition.previous, question: caseDefinition.question, today: document.today, time_zone: document.time_zone,
    signal: AbortSignal.timeout(options.timeoutMs),
  }));
  const resolution = resolved?.resolution ?? null;
  const grade = gradeTrial(caseDefinition, resolution, resolved?.fallback === true);
  return Object.freeze({
    case_id: caseDefinition.id, group: caseDefinition.group, trial,
    resolution: resolution?.resolution ?? null,
    // Synthetic case text only: what the resolver asked research to answer, the sources (from 1) it pointed to, and its choices.
    ...(resolution?.resolution === "resolved" ? { question: resolution.question, about: Object.freeze(resolution.about.map((index) => index + 1)) } : {}),
    ...(resolution?.resolution === "clarify" ? { choices: resolution.choices } : {}),
    fallback: resolved?.fallback ?? null,
    calls: resolved?.calls ?? calls.length,
    repairs: resolved?.repairs ?? null,
    passed: grade.passed, clarify: grade.clarify,
    elapsed_ms: elapsed(),
    model_calls: Object.freeze(calls),
    ...(error === null ? {} : { error }),
  });
}

/** What a report keeps of a placement: the place, and the thread numbers (from 1, as the resolver was shown them) it names and merges. */
function placementKept(placement) {
  const numbers = (indexes) => Object.freeze(indexes.map((index) => index + 1));
  const merge = (indexes) => (indexes.length === 0 ? {} : { merge: numbers(indexes) });
  if (placement === null) return { thread: null };
  switch (placement.thread) {
    // The open thread's resolution names nothing but what it is: its rewritten question and choices are graded by the follow-up set.
    case "open": return { thread: "open", resolution: placement.resolution.resolution, ...merge(placement.merge) };
    case "new": return { thread: "new" };
    case "other": return { thread: "other", threads: numbers(placement.threads), ...merge(placement.merge) };
    default: throw new Error("a placement is the open thread, a new one, or other threads");
  }
}

/**
 * One thread trial (ADR-0056): the kernel's thread resolver, the function the product's Ask calls, on one case's open
 * thread, other threads and question. A trial that throws is kept as its safe error and passes nothing.
 */
export async function runThreadTrial(caseDefinition, trial, structuredOutput, generation, document, options) {
  const { resolved, error, calls, elapsed_ms: elapsed } = await resolvedTrial(structuredOutput, (model) => resolveAgenticThreadOnceV1({
    model, generation, ...(caseDefinition.previous === undefined ? {} : { previous: caseDefinition.previous }), threads: caseDefinition.threads,
    question: caseDefinition.question, today: document.today, time_zone: document.time_zone, signal: AbortSignal.timeout(options.timeoutMs),
  }));
  const placement = resolved?.placement ?? null;
  const grade = gradeThreadTrial(caseDefinition, placement, resolved?.fallback === true);
  return Object.freeze({
    case_id: caseDefinition.id, group: caseDefinition.group, trial,
    ...placementKept(placement),
    fallback: resolved?.fallback ?? null,
    calls: resolved?.calls ?? calls.length,
    repairs: resolved?.repairs ?? null,
    passed: grade.passed, named_all: grade.named_all, merged: grade.merged,
    elapsed_ms: elapsed(),
    model_calls: Object.freeze(calls),
    ...(error === null ? {} : { error }),
  });
}

/** Runs every selected case of the run's set `trials` times and writes the report. `dependencies` replaces the production bundle in tests. */
export async function run(options, dependencies = {}) {
  const set = setOf(options);
  const document = set.load();
  const selected = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const codeFiles = [...CODE_FILES, set.cases_path];
  const identityBefore = codeIdentity(ROOT, codeFiles);
  const loaded = dependencies.loaded ?? createOpenRouterAnswerCompositionGenerationBundleV1({ credential_file: options.credentialFile }).load();
  const results = [];
  for (const caseDefinition of selected) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await set.trial(caseDefinition, trial, loaded.structured_output, loaded.generation, document, options);
      results.push(result);
      (dependencies.progress ?? ((line) => process.stderr.write(line)))(`${JSON.stringify({ kind: set.progress_kind, case_id: result.case_id, trial, ...set.progress(result), passed: result.passed })}\n`);
    }
  }
  const identityAfter = codeIdentity(ROOT, codeFiles);
  const summary = set.summarize(results, document);
  const report = Object.freeze({
    kind: set.report_kind,
    observed_at: new Date().toISOString(),
    synthetic_only: true,
    // Only the whole pre-registered set, three trials each, decides. The thread set's grader says whether the trials
    // are that run, case by case (a case run twice is not); the follow-up set's is its selection, as it was.
    complete: summary.complete ?? (selected.length === caseCount(set) && options.trials === MAX_TRIALS),
    cases_sha256: sha256(readFileSync(set.cases_file)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model: Object.freeze({ adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
    limits: Object.freeze({ cases: selected.length, trials: options.trials, timeout_ms: options.timeoutMs, max_total_model_calls: maxModelCalls(set) }),
    ...summary,
    groups: Object.freeze(Object.fromEntries(Object.keys(set.groups).map((group) => [group, set.group(results.filter((entry) => entry.group === group))]))),
    results: Object.freeze(results),
  });
  const reportPath = join(options.out, `${set.report_prefix}-${report.observed_at.replace(/[:.]/gu, "-")}.json`);
  writeFileSync(reportPath, json(report), { mode: 0o600, flag: "wx" });
  return Object.freeze({ reportPath, report });
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const { reportPath, report } = await run(options);
      const { ships } = setOf(options);
      const rules = Object.fromEntries(Object.entries(report.rules).map(([name, rule]) => [name, rule.passed ?? null]));
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, complete: report.complete, [ships]: report[ships], founder_review: report.founder_review, rules })}\n`);
      if (!qualifies(report, options)) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "resolution evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
