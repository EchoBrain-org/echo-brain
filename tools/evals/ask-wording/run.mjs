#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of how Ask's writer words a laid-out answer (README.md, pre-registered).
 *
 * Each case in cases.json is a question and the synthetic items that answer it. Ask runs as the kernel runs it for a
 * client that asks for answer layout v2 (ADR-0051), as every desktop does, over a synthetic desk. Research is scripted,
 * since this eval measures only the writer: one search returns the case's items, research opens them and finishes citing
 * them all. The writer is the product's: its prompt and schema, through the shipped generation bundle (its OpenRouter
 * answer model, ADR-0037, or the personal Claude account writer), three times per case, and grade.mjs grades every trial
 * deterministically. The only network operation is the writer's structured-generation request, after the caller
 * explicitly supplies --run and --credential-file. The bundle reads the credential file; this runner only checks that it
 * is a private file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { caseAsk, caseItems, scriptedModel } from "../shared/ask-cases.mjs";
import { assertExplicitRun, assertWriterRoute, boundedInteger, codeIdentity, generationMetadata, importedModules, json, observedGeneration, outputDirectory, readFlags, safeError, sha256, writerFlags, writerRoute } from "../shared/runner.mjs";
import { CASES_FILE, GROUPS, gradeTrial, loadCases, summarizeRules } from "./grade.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
const MAX_TRIALS = 3;
const ALL_CASES = Object.values(GROUPS).reduce((total, count) => total + count, 0);
/** The answer layout every trial asks for: v2, the model-arranged blocks every desktop asks for (ADR-0051). */
const ANSWER_LAYOUT = 2;
/** The writer's call and its one repair per trial; research is scripted and calls no model. */
const MAX_TOTAL_MODEL_CALLS = ALL_CASES * MAX_TRIALS * 2;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 85_000;
/** When every trial is asked: the cases' today, mid-morning in their time zone. */
const ASKED_AT = "2026-10-26T17:00:00.000Z";

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  npm run eval:ask-wording -- --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id     Select cases (default: all ${ALL_CASES}); only the whole set decides whether the wording ships.`,
    `  --trials N        Trials per case, 1 through ${MAX_TRIALS} (default: ${MAX_TRIALS}, as pre-registered).`,
    "  --timeout-ms N    Per-trial timeout, 15000 through 85000 (default: 60000).",
    "  --writer ROUTE    openrouter (default) or claude-account: the product's personal Claude account writer, the",
    "                    same model through the Claude Agent SDK and your own signed-in claude binary.",
    "  --claude-executable PATH  With --writer claude-account: the signed-in claude binary.",
    "  --help            Show this text without reading a credential or making a request.",
    "",
    "Each trial asks one synthetic question with answer layout v2, as every desktop does. Research is scripted over the",
    "case's synthetic items; the writer runs through the production generation bundle; nothing is read from any tool.",
    "--out must be outside the repository and private; the report is written there with mode 0600. It keeps case ids,",
    "each trial's statements, lead and grade (synthetic text), the writer prompt's digest, the layout the writer was given",
    "and model metadata; never prompts, raw replies, credentials or provider payloads.",
    "",
    "Exit 0 when a complete run (every case, three trials, every writer given the block catalog) passes all three rules",
    "(the wording ships); 1 when any rule fails or the run is not complete, which never ships; 2 on a usage error.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, trials: MAX_TRIALS, timeoutMs: 60_000, writer: "openrouter", claudeExecutable: null };
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--cases": (value) => { options.caseIds = value.split(",").map((part) => part.trim()).filter(Boolean); },
    "--trials": (value) => { options.trials = Number(value); },
    "--timeout-ms": (value) => { options.timeoutMs = Number(value); },
    ...writerFlags(options),
  })) return { help: true };
  assertWriterRoute(options);
  assertExplicitRun(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, MAX_TRIALS);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const known = new Set(loadCases().cases.map((entry) => entry.id));
  if (options.caseIds !== null && (options.caseIds.length === 0 || new Set(options.caseIds).size < options.caseIds.length || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  if ((options.caseIds?.length ?? known.size) * options.trials * 2 > MAX_TOTAL_MODEL_CALLS) throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/**
 * The files a report fingerprints, beside the commit and its uncommitted changes: the cases and every module the eval
 * loads (its own, the kernel's writer, checks and shared modules, the answer contract and the writer routes), found by
 * following its imports.
 */
const codeFiles = () => Object.freeze(["tools/evals/ask-wording/cases.json", ...importedModules(ROOT, ["tools/evals/ask-wording/run.mjs"])]);

/**
 * The answer layout the writer was given, from its input: 2 when it carries the block catalog (ADR-0051), 1 when its
 * reply schema declares tables (ADR-0045), else none.
 */
export function writerLayout(input) {
  if (Object.hasOwn(JSON.parse(input.user_prompt), "block_catalog")) return 2;
  return Object.hasOwn(input.schema?.properties ?? {}, "tables") ? 1 : null;
}

/**
 * Whether a run decides (README.md, "Layout v2"): every registered case, three trials each, and every trial's writer
 * given the block catalog. Any other run keeps its scores and never ships the wording.
 */
export function decides(results) {
  const trials = new Map();
  for (const result of results) trials.set(result.case_id, (trials.get(result.case_id) ?? 0) + 1);
  return trials.size === ALL_CASES && [...trials.values()].every((count) => count === MAX_TRIALS) && results.every((result) => result.writer_layout === ANSWER_LAYOUT);
}

/**
 * One trial: Ask on one case with answer layout v2, research scripted and the writer through `structuredOutput` (the
 * production route, or a test's), with only model metadata, the writer prompt's digest and the layout the writer was given
 * recorded. A trial that throws is kept as its safe error and passes nothing.
 */
export async function runTrial(caseDefinition, trial, structuredOutput, generation, document, options) {
  const calls = [];
  const writerPrompts = new Set();
  // The layout the first writer call was given; undefined until there is one.
  let layout;
  const script = scriptedModel(caseDefinition, async (input) => {
    writerPrompts.add(sha256(input.system_prompt));
    if (layout === undefined) layout = writerLayout(input);
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
  }, "the eval runs only research and the Ask writer");
  const ask = caseAsk(caseItems("wording", caseDefinition), document, ASKED_AT, script.model, generation, ANSWER_LAYOUT);
  const started = performance.now();
  let response = null;
  let error = null;
  try {
    response = await ask.answer({ question: caseDefinition.question, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (caught) {
    error = safeError(caught);
  }
  const grade = gradeTrial(caseDefinition, response);
  return Object.freeze({
    case_id: caseDefinition.id, group: caseDefinition.group, trial,
    outcome: response?.outcome ?? null,
    // Synthetic case text only: what the answer says, its lead and each part's gap.
    grade, gaps: Object.freeze((response?.parts ?? []).flatMap((part) => (part.gap === undefined ? [] : [part.gap]))),
    research_rounds: script.rounds(), writer_calls: calls.length,
    writer_prompt_sha256: Object.freeze([...writerPrompts]),
    // The layout the writer was given: one run's calls are asked alike, so the first call's stands for the trial.
    writer_layout: layout ?? null,
    elapsed_ms: Math.round(performance.now() - started),
    model_calls: Object.freeze(calls),
    ...(error === null ? {} : { error }),
  });
}

/** Runs every selected case `trials` times and writes the report. `dependencies` replaces the production bundle in tests. */
export async function run(options, dependencies = {}) {
  const document = loadCases();
  const selected = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const identityBefore = codeIdentity(ROOT, codeFiles());
  const { route, loaded } = writerRoute(options, "mem_ask-wording-eval", createOpenRouterAnswerCompositionGenerationBundleV1, dependencies.loaded);
  const results = [];
  for (const caseDefinition of selected) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await runTrial(caseDefinition, trial, loaded.structured_output, loaded.generation, document, options);
      results.push(result);
      (dependencies.progress ?? ((line) => process.stderr.write(line)))(`${JSON.stringify({ kind: "echo-ask-wording-evaluation-progress-v1", case_id: result.case_id, trial, outcome: result.outcome, writer_layout: result.writer_layout, rules: result.grade.rules })}\n`);
    }
  }
  const identityAfter = codeIdentity(ROOT, codeFiles());
  // Only the whole pre-registered set, each case three times on the v2 writer, decides whether the wording ships.
  const complete = decides(results);
  const summary = summarizeRules(results);
  const report = Object.freeze({
    kind: "echo-ask-wording-evaluation-v1",
    observed_at: new Date().toISOString(),
    synthetic_only: true,
    complete,
    cases_sha256: sha256(readFileSync(CASES_FILE)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    writer_prompt_sha256: Object.freeze([...new Set(results.flatMap((result) => result.writer_prompt_sha256))]),
    answer_layout: ANSWER_LAYOUT,
    model: Object.freeze({ route, adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
    limits: Object.freeze({ cases: selected.length, trials: options.trials, timeout_ms: options.timeoutMs, max_total_model_calls: MAX_TOTAL_MODEL_CALLS }),
    // A smaller diagnostic run keeps its rule scores, and never ships the wording.
    ...summary, wording_ships: complete && summary.wording_ships,
    groups: Object.freeze(Object.fromEntries(Object.keys(GROUPS).map((group) => {
      const trials = results.filter((entry) => entry.group === group);
      const count = (name) => trials.filter((entry) => entry.grade.rules[name]).length;
      return [group, Object.freeze({ trials: trials.length, no_restating: count("no_restating"), long_ids_once: count("long_ids_once"), nothing_lost: count("nothing_lost"),
        errors: trials.filter((entry) => entry.error !== undefined).length })];
    }))),
    results: Object.freeze(results),
  });
  const reportPath = join(options.out, `ask-wording-evaluation-${report.observed_at.replace(/[:.]/gu, "-")}.json`);
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
      const rules = Object.fromEntries(Object.entries(report.rules).map(([name, rule]) => [name, `${rule.passed_trials}/${rule.trials}`]));
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, route: report.model.route, complete: report.complete, wording_ships: report.wording_ships, rules, measures: report.measures })}\n`);
      if (!report.wording_ships) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "wording evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
