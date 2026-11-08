#!/usr/bin/env node
/**
 * Opt-in real-model gate on Ask's built writer (README.md, pre-registered). For each case in cases.json, Ask runs as the
 * kernel runs it, its answer in blocks (answer layout v2, ADR-0051), over a scripted desk: a writer that answers nothing
 * first records the writer's exact prompts with no network call, then each trial runs Ask through the kernel end to end,
 * only the writer's call going to the model through the shipped generation bundle (or the personal Claude account
 * writer), and grade.mjs grades the answer the kernel releases. The report keeps full traces: all data is synthetic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { personAnswerCitationKeyV8 } from "@echo-brain/organization-api";
import { caseAsk, caseItems, deskItem as releasedItem, scriptedModel } from "../shared/ask-cases.mjs";
import { assertExplicitRun, assertWriterRoute, boundedInteger, codeIdentity, generationMetadata, importedModules, json, observedGeneration, outputDirectory, pooled, readFlags, safeError, sha256, writerFlags, writerRoute } from "../shared/runner.mjs";
import { CASES_FILE, CASE_COUNT, TRIALS, decideGate, evidenceOf, gradeTrial, loadCases, readReleased, summarize } from "./grade.mjs";

export { researchStep } from "../shared/ask-cases.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
/** A trial makes at most two writer calls: its reply and the kernel's one repair or retry. */
const MAX_TOTAL_MODEL_CALLS = CASE_COUNT * TRIALS * 2;

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id       Select cases (default: all ${CASE_COUNT}).`,
    `  --trials N          Trials per case, 1 through ${TRIALS} (default: ${TRIALS}).`,
    "  --concurrency N     Model calls at once, 1 through 6 (default: 4).",
    "  --timeout-ms N      Per-trial timeout of the whole Ask, 15000 through 180000 (default: 120000).",
    "  --writer ROUTE      openrouter (default) or claude-account: the product's personal Claude account writer, the",
    "                      same model through the Claude Agent SDK and your own signed-in claude binary.",
    "  --claude-executable PATH  With --writer claude-account: the signed-in claude binary.",
    "  --help              Show this text without reading a credential or making a request.",
    "",
    "Only a complete run decides the gate: every case, three trials. A smaller run is a diagnostic.",
    "--out must be outside the repository and private; the report is written there with mode 0600, with full traces of",
    "every synthetic prompt and reply, never a credential.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, trials: TRIALS, concurrency: 4, timeoutMs: 120_000, writer: "openrouter", claudeExecutable: null };
  const list = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--cases": (value) => { options.caseIds = list(value); },
    "--trials": (value) => { options.trials = Number(value); },
    "--concurrency": (value) => { options.concurrency = Number(value); },
    "--timeout-ms": (value) => { options.timeoutMs = Number(value); },
    ...writerFlags(options),
  })) return { help: true };
  assertWriterRoute(options);
  assertExplicitRun(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, TRIALS);
  options.concurrency = boundedInteger(options.concurrency, "--concurrency", 1, 6);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", 15_000, 180_000);
  const known = new Set(loadCases().cases.map((entry) => entry.id));
  if (options.caseIds !== null && (options.caseIds.length === 0 || new Set(options.caseIds).size !== options.caseIds.length || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/**
 * The files a report fingerprints, beside the commit and its uncommitted changes: the cases, the pre-registration and
 * every module the evaluation loads (its own, the kernel's writer, checks and shared modules, the answer contract and the
 * writer routes), found by following its imports.
 */
const codeFiles = () => Object.freeze(["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/README.md", ...importedModules(ROOT, ["tools/evals/ask-blocks/run.mjs"])]);

/** One case item as the desk releases it, with this evaluation's ids and fixtures (shared/ask-cases.mjs). */
export const deskItem = (caseId, index, item) => releasedItem("blocks", caseId, index, item);
/** One case's items as the desk releases them, in the case's order: the order search finds them and research opens them. */
const itemsOf = (caseDefinition) => caseItems("blocks", caseDefinition);

/**
 * The evidence id of each of an answer's citations, as the writer saw it: the case item the citation cites, found by its
 * citation key, is `E1` to `En` in the order research opened the items (researchStep). A citation of no case item is
 * named as one, so grading finds it among nothing the writer was given.
 */
export function evidenceIdsOf(citations, items) {
  const byKey = new Map(items.map((item, at) => [personAnswerCitationKeyV8(item.citation), `E${at + 1}`]));
  return Object.freeze(citations.map((entry, at) => byKey.get(personAnswerCitationKeyV8(entry.citation)) ?? `citation ${at + 1}`));
}

/** The writer's prompts and reply schema for one case, recorded through the kernel with a writer that answers nothing. */
export async function captureWriterPrompts(caseDefinition, document, generation) {
  let captured = null;
  const { model } = scriptedModel(caseDefinition, (input) => {
    captured ??= Object.freeze({ system_prompt: input.system_prompt, user_prompt: input.user_prompt, schema: input.schema });
    // A reply that says nothing, in layout v2's shape.
    return { value: { lists: [], blocks: [], not_found: [caseDefinition.research.need] }, finish_reason: "stop", usage: null, provider_latency_ms: null };
  }, "the capture runs only research and the Ask writer");
  await caseAsk(itemsOf(caseDefinition), document, document.asked_at, model, generation).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(30_000) });
  if (captured === null) throw new Error(`case ${caseDefinition.id}: research never reached the writer`);
  return captured;
}

/**
 * One trial (README.md, "Procedure"): Ask on one case through the kernel end to end with answer layout v2, research
 * scripted and each writer call sent to the route. The kernel reads, checks, repairs and releases; the harness adds no
 * repair, keeps each call (its raw reply, usage and prompts: those `prompts` recorded, or its own when the kernel asked
 * with others, as for a repair) and the released answer, and grades that answer's blocks against `evidence`, what the
 * writer was given.
 */
export async function runTrial(caseDefinition, trial, prompts, evidence, document, structuredOutput, generation, options) {
  const attempts = [];
  const recorded = sha256(prompts.system_prompt);
  const { model } = scriptedModel(caseDefinition, async (input) => {
    const attempt = attempts.length + 1;
    // A repair names what the kernel found wrong with the reply before it; a retry repeats a call that failed.
    const problem = JSON.parse(input.user_prompt).validation_error;
    if (typeof problem === "string" && attempts.length > 0) attempts.at(-1).problems = [problem];
    const systemPromptSha256 = sha256(input.system_prompt);
    const asked = { attempt, kind: attempt === 1 ? "first" : typeof problem === "string" ? "repair" : "retry", system_prompt_sha256: systemPromptSha256,
      ...(systemPromptSha256 === recorded ? {} : { system_prompt: input.system_prompt }), ...(input.user_prompt === prompts.user_prompt ? {} : { user_prompt: input.user_prompt }),
      max_output_tokens: input.max_output_tokens };
    const started = performance.now();
    try {
      const observed = await observedGeneration(structuredOutput, input);
      attempts.push({ ...asked, value: observed.value, ...generationMetadata(observed), elapsed_ms: Math.round(performance.now() - started) });
      return observed;
    } catch (error) {
      // The kernel meets the route's failure as it would in production: it retries, falls back or stops.
      attempts.push({ ...asked, error: safeError(error, { withUsage: true }), elapsed_ms: Math.round(performance.now() - started) });
      throw error;
    }
  }, "the gate runs only research and the Ask writer");
  let response = null;
  let error;
  try {
    response = await caseAsk(itemsOf(caseDefinition), document, document.asked_at, model, generation).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (caught) {
    error = safeError(caught);
  }
  // Only a release that follows a writer's reply is read: one with no reply is code's fallback, not the writer's answer.
  const read = response === null || !attempts.some((entry) => entry.error === undefined) ? null : readReleased(response, evidenceIdsOf(response.citations, itemsOf(caseDefinition)));
  for (const [at, entry] of attempts.entries()) {
    const last = at === attempts.length - 1;
    entry.valid = last && read?.valid === true;
    if (last && entry.error === undefined && read !== null && !read.valid) entry.problems = read.problems;
  }
  const grade = gradeTrial(caseDefinition, read ?? { valid: false }, evidence);
  return Object.freeze({ case_id: caseDefinition.id, trial, attempts, read, response, ...(error === undefined ? {} : { error }), grade });
}

/** Runs the selected cases and writes the report. */
export async function run(options, dependencies = {}) {
  const document = loadCases();
  const cases = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const identityBefore = codeIdentity(ROOT, codeFiles());
  const { route, loaded } = writerRoute(options, dependencies.loaded);
  const model = Object.freeze({ route, adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model });
  const progress = dependencies.progress ?? ((line) => process.stderr.write(line));
  // The writer's prompts, from one capture a case, and the evidence each case's answers are graded against.
  const prompts = new Map();
  for (const caseDefinition of cases) prompts.set(caseDefinition.id, await captureWriterPrompts(caseDefinition, document, loaded.generation));

  // Trials interleave cases, so a slow route slows every case alike.
  const tasks = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    for (const caseDefinition of cases) {
      tasks.push(async () => {
        const own = prompts.get(caseDefinition.id);
        const result = await runTrial(caseDefinition, trial, own, evidenceOf(own.user_prompt), document, loaded.structured_output, loaded.generation, options);
        progress(`${JSON.stringify({ kind: "echo-ask-blocks-evaluation-progress-v1", case_id: result.case_id, trial, valid: result.grade.valid,
          grounded: result.grade.grounded, nothing_lost: result.grade.nothing_lost, fit: result.grade.fit, attempts: result.attempts.length })}\n`);
        return result;
      });
    }
  }
  const trials = await pooled(tasks, options.concurrency);

  const identityAfter = codeIdentity(ROOT, codeFiles());
  // Only every case, three trials each, decides the gate.
  const complete = cases.length === CASE_COUNT && options.trials === TRIALS;
  const summary = summarize(trials);
  const observedAt = new Date().toISOString();
  const systemPrompts = {};
  const casePrompts = Object.fromEntries(cases.map((caseDefinition) => {
    const entry = prompts.get(caseDefinition.id);
    const hash = sha256(entry.system_prompt);
    systemPrompts[hash] = entry.system_prompt;
    return [caseDefinition.id, { system_prompt_sha256: hash, user_prompt: entry.user_prompt }];
  }));
  // The block catalog and schema are the kernel's, as its writer was given them.
  const writer = prompts.get(cases[0].id);
  const report = Object.freeze({
    kind: "echo-ask-blocks-evaluation-v1",
    observed_at: observedAt,
    synthetic_only: true,
    complete,
    cases_sha256: sha256(readFileSync(CASES_FILE)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model,
    errors: Object.freeze({ writer_calls: trials.reduce((sum, trial) => sum + trial.attempts.filter((attempt) => attempt.error !== undefined).length, 0),
      trials_without_reply: trials.filter((trial) => trial.read === null).length }),
    limits: Object.freeze({ cases: cases.length, trials: options.trials, timeout_ms: options.timeoutMs, concurrency: options.concurrency, max_total_model_calls: MAX_TOTAL_MODEL_CALLS }),
    writer: Object.freeze({ block_catalog: JSON.parse(writer.user_prompt).block_catalog ?? null, schema: writer.schema }),
    summary,
    decision: decideGate(summary, complete),
    system_prompts: systemPrompts,
    prompts: casePrompts,
    trials,
  });
  const stamp = observedAt.replace(/[:.]/gu, "-");
  const reportPath = join(options.out, `ask-blocks-evaluation-${stamp}.json`);
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
      const s = report.summary;
      const summary = { valid: `${s.valid}/${s.trials}`, grounded: `${s.grounded}/${s.trials}`, nothing_lost: `${s.nothing_lost}/${s.trials}`, fit: `${s.fit}/${s.trials}`,
        stable: `${s.stable}/${s.cases}`, valid_at_once: s.valid_at_once, repairs: s.repairs, output_tokens: s.output_tokens };
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, route: report.model.route, complete: report.complete, summary, decision: report.decision })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "block evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
