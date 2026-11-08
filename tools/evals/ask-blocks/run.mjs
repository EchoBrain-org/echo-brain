#!/usr/bin/env node
/**
 * Opt-in real-model gate on Ask's built writer (README.md, pre-registered). For each case of a case set, Ask runs as the
 * kernel runs it, its answer in blocks (answer layout v2, ADR-0051), over a scripted desk: a writer that answers nothing
 * first records the writer's exact prompts with no network call, then each trial runs Ask through the kernel end to end,
 * only the writer's call going to the model through the shipped generation bundle (or the personal Claude account
 * writer). The answer the kernel releases is graded deterministically: the block cases (cases.json) by grade.mjs, rules
 * 1 to 5, and the wording cases (wording-cases.json) by wording.mjs, its three rules. The report keeps full traces: all
 * data is synthetic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { personAnswerCitationKeyV8 } from "@echo-brain/organization-api";
import { caseAsk, caseItems, deskItem as releasedItem, scriptedModel } from "../shared/ask-cases.mjs";
import { assertExplicitRun, assertWriterRoute, boundedInteger, codeIdentity, generationMetadata, importedModules, json, observedGeneration, outputDirectory, pooled, readFlags, safeError, sha256, writerFlags, writerRoute } from "../shared/runner.mjs";
import { CASES_FILE, CASE_COUNT, TRIALS, decideGate, evidenceOf, gradeTrial, loadCases, readReleased, summarize } from "./grade.mjs";
import { CASES_FILE as WORDING_CASES_FILE, GROUPS, gradeTrial as gradeWording, loadCases as loadWordingCases, summarizeRules } from "./wording.mjs";

export { researchStep } from "../shared/ask-cases.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");

/**
 * The two pre-registered case sets (README.md): the cases a run loads, the fixture names their desk items carry, when
 * they are asked, the per-trial timeout (default and most), whether the report keeps full traces, how a trial is graded
 * and a run summarized and decided, and whether a run that does not pass exits 1.
 *
 * The block cases (`main`) keep full traces of every synthetic prompt and reply, from one capture of each case's writer
 * prompts. The wording cases keep, as their own evaluation did, case ids, each trial's statements, lead and grade, the
 * writer prompt's SHA-256 and model metadata: never a prompt or a raw reply, so they need no capture.
 */
export const CASE_SETS = Object.freeze({
  main: Object.freeze({ file: CASES_FILE, count: CASE_COUNT, load: loadCases, fixture: "blocks", askedAt: (document) => document.asked_at,
    timeoutMs: 120_000, maxTimeoutMs: 180_000, traces: true, exitsOnFailure: false,
    grade: (caseDefinition, { read, evidence }) => gradeTrial(caseDefinition, read ?? { valid: false }, evidence), summarize: (trials) => summarize(trials), decide: decideGate }),
  // The wording cases are asked mid-morning of their today, in their time zone; their wording ships only from a complete run.
  wording: Object.freeze({ file: WORDING_CASES_FILE, count: Object.values(GROUPS).reduce((total, count) => total + count, 0), load: loadWordingCases, fixture: "wording",
    askedAt: () => "2026-10-26T17:00:00.000Z", timeoutMs: 60_000, maxTimeoutMs: 85_000, traces: false, exitsOnFailure: true,
    grade: (caseDefinition, { response }) => gradeWording(caseDefinition, response),
    summarize: (trials, complete) => { const summary = summarizeRules(trials); return Object.freeze({ ...summary, wording_ships: complete && summary.wording_ships }); },
    decide: (summary, complete) => Object.freeze({ complete, passes: complete ? summary.wording_ships : null, rules: summary.rules }) }),
});
/** A trial makes at most two writer calls: its reply and the kernel's one repair or retry. */
const maxModelCalls = (set) => set.count * TRIALS * 2;

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --case-set SET      main (default: the ${CASE_SETS.main.count} block cases, rules 1 to 5) or wording (the ${CASE_SETS.wording.count} wording cases, its three rules).`,
    "  --cases id,id       Select cases of the set (default: all).",
    `  --trials N          Trials per case, 1 through ${TRIALS} (default: ${TRIALS}).`,
    "  --concurrency N     Model calls at once, 1 through 6 (default: 4).",
    "  --timeout-ms N      Per-trial timeout of the whole Ask, 15000 through 180000 (default: 120000); for wording 15000",
    "                      through 85000 (default: 60000).",
    "  --writer ROUTE      openrouter (default) or claude-account: the product's personal Claude account writer, the",
    "                      same model through the Claude Agent SDK and your own signed-in claude binary.",
    "  --claude-executable PATH  With --writer claude-account: the signed-in claude binary.",
    "  --help              Show this text without reading a credential or making a request.",
    "",
    "Each trial asks one synthetic question through the kernel, its answer in blocks (answer layout v2) as every Ask's is;",
    "only the writer's call goes to the model. Only a complete run decides its set's gate: every case, three trials.",
    "A smaller run is a diagnostic.",
    "--out must be outside the repository and private; the report is written there with mode 0600. A block run keeps",
    "full traces of every synthetic prompt and reply; a wording run keeps case ids, each trial's statements, lead and",
    "grade, the writer prompt's digest and model metadata, never prompts or raw replies. Neither keeps a credential.",
    "A wording run exits 0 when a complete run passes all three rules (the wording ships) and 1 otherwise; a block run",
    "exits 0 when it completes. A usage error exits 2.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseSet: "main", caseIds: null, trials: TRIALS, concurrency: 4, timeoutMs: null, writer: "openrouter", claudeExecutable: null };
  const list = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--case-set": (value) => { if (!Object.hasOwn(CASE_SETS, value)) throw new Error("--case-set must be main or wording"); options.caseSet = value; },
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
  const set = CASE_SETS[options.caseSet];
  options.timeoutMs = boundedInteger(options.timeoutMs ?? set.timeoutMs, "--timeout-ms", 15_000, set.maxTimeoutMs);
  const known = new Set(set.load().cases.map((entry) => entry.id));
  if (options.caseIds !== null && (options.caseIds.length === 0 || new Set(options.caseIds).size !== options.caseIds.length || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/**
 * The files a report fingerprints, beside the commit and its uncommitted changes: both case sets, the pre-registration
 * and every module the evaluation loads (its own, the kernel's writer, checks and shared modules, the answer contract and
 * the writer routes), found by following its imports.
 */
const codeFiles = () => Object.freeze(["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/wording-cases.json", "tools/evals/ask-blocks/README.md",
  ...importedModules(ROOT, ["tools/evals/ask-blocks/run.mjs"])]);

/** One block case item as the desk releases it, with this evaluation's ids and fixtures (shared/ask-cases.mjs). */
export const deskItem = (caseId, index, item) => releasedItem("blocks", caseId, index, item);

/**
 * The evidence id of each of an answer's citations, as the writer saw it: the case item the citation cites, found by its
 * citation key, is `E1` to `En` in the order research opened the items (researchStep). A citation of no case item is
 * named as one, so grading finds it among nothing the writer was given.
 */
export function evidenceIdsOf(citations, items) {
  const byKey = new Map(items.map((item, at) => [personAnswerCitationKeyV8(item.citation), `E${at + 1}`]));
  return Object.freeze(citations.map((entry, at) => byKey.get(personAnswerCitationKeyV8(entry.citation)) ?? `citation ${at + 1}`));
}

/** The writer's prompts and reply schema for one block case, recorded through the kernel with a writer that answers nothing. */
export async function captureWriterPrompts(caseDefinition, document, generation, set = CASE_SETS.main) {
  let captured = null;
  const { model } = scriptedModel(caseDefinition, (input) => {
    captured ??= Object.freeze({ system_prompt: input.system_prompt, user_prompt: input.user_prompt, schema: input.schema });
    // A reply that says nothing, in layout v2's shape.
    return { value: { lists: [], blocks: [], not_found: [caseDefinition.research.need] }, finish_reason: "stop", usage: null, provider_latency_ms: null };
  }, "the capture runs only research and the Ask writer");
  await caseAsk(caseItems(set.fixture, caseDefinition), document, set.askedAt(document), model, generation).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(30_000) });
  if (captured === null) throw new Error(`case ${caseDefinition.id}: research never reached the writer`);
  return captured;
}

/**
 * One trial (README.md, "Procedure"): Ask on one case of `set` through the kernel end to end with answer layout v2,
 * research scripted and each writer call sent to the route. The kernel reads, checks, repairs and releases; the harness
 * adds no repair, keeps each call's usage and its system prompt's digest, reads the released answer's blocks and grades
 * it as `set` does: a block case against `evidence`, what the writer was given. A block trial also keeps each call's raw
 * reply and prompts (those `prompts` recorded, or its own when the kernel asked with others, as for a repair) and the
 * released answer; a wording trial keeps only its outcome and gaps beside its grade (`prompts` is null).
 */
export async function runTrial(set, caseDefinition, trial, prompts, evidence, document, structuredOutput, generation, options) {
  const items = caseItems(set.fixture, caseDefinition);
  const attempts = [];
  const recorded = prompts === null ? null : sha256(prompts.system_prompt);
  const { model } = scriptedModel(caseDefinition, async (input) => {
    const attempt = attempts.length + 1;
    // A repair names what the kernel found wrong with the reply before it; a retry repeats a call that failed.
    const problem = JSON.parse(input.user_prompt).validation_error;
    if (set.traces && typeof problem === "string" && attempts.length > 0) attempts.at(-1).problems = [problem];
    const systemPromptSha256 = sha256(input.system_prompt);
    const asked = { attempt, kind: attempt === 1 ? "first" : typeof problem === "string" ? "repair" : "retry", system_prompt_sha256: systemPromptSha256,
      ...(!set.traces || systemPromptSha256 === recorded ? {} : { system_prompt: input.system_prompt }),
      ...(!set.traces || input.user_prompt === prompts.user_prompt ? {} : { user_prompt: input.user_prompt }), max_output_tokens: input.max_output_tokens };
    const started = performance.now();
    try {
      const observed = await observedGeneration(structuredOutput, input);
      // A wording trial keeps only provider metadata: `observed.value` is never copied.
      attempts.push({ ...asked, ...(set.traces ? { value: observed.value } : {}), ...generationMetadata(observed), elapsed_ms: Math.round(performance.now() - started) });
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
    response = await caseAsk(items, document, set.askedAt(document), model, generation).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (caught) {
    error = safeError(caught);
  }
  // Only a release that follows a writer's reply is read: one with no reply is code's fallback, not the writer's answer.
  const read = response === null || !attempts.some((entry) => entry.error === undefined) ? null : readReleased(response, evidenceIdsOf(response.citations, items));
  for (const [at, entry] of attempts.entries()) {
    const last = at === attempts.length - 1;
    entry.valid = last && read?.valid === true;
    if (set.traces && last && entry.error === undefined && read !== null && !read.valid) entry.problems = read.problems;
  }
  const grade = set.grade(caseDefinition, { read, response, evidence });
  const kept = set.traces ? { attempts, read, response }
    : { outcome: response?.outcome ?? null, gaps: Object.freeze((response?.parts ?? []).flatMap((part) => (part.gap === undefined ? [] : [part.gap]))), attempts };
  return Object.freeze({ case_id: caseDefinition.id, ...(caseDefinition.group === undefined ? {} : { group: caseDefinition.group }), trial, ...kept,
    ...(error === undefined ? {} : { error }), grade });
}

/** A trial whose writer gave no reply the kernel released from: the Ask failed, or every writer call did. */
const withoutReply = (trial) => trial.error !== undefined || !trial.attempts.some((attempt) => attempt.error === undefined);

/** Runs the selected cases of the case set and writes the report. */
export async function run(options, dependencies = {}) {
  const caseSet = options.caseSet ?? "main";
  const set = CASE_SETS[caseSet];
  const document = set.load();
  const cases = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const identityBefore = codeIdentity(ROOT, codeFiles());
  const { route, loaded } = writerRoute(options, dependencies.loaded);
  const model = Object.freeze({ route, adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model });
  const progress = dependencies.progress ?? ((line) => process.stderr.write(line));
  // For a block run, the writer's prompts, from one capture a case, and the evidence each case's answers are graded against.
  const prompts = new Map();
  if (set.traces) for (const caseDefinition of cases) prompts.set(caseDefinition.id, await captureWriterPrompts(caseDefinition, document, loaded.generation, set));

  // Trials interleave cases, so a slow route slows every case alike.
  const tasks = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    for (const caseDefinition of cases) {
      tasks.push(async () => {
        const own = prompts.get(caseDefinition.id) ?? null;
        const result = await runTrial(set, caseDefinition, trial, own, own === null ? null : evidenceOf(own.user_prompt), document, loaded.structured_output, loaded.generation, options);
        progress(`${JSON.stringify(set.traces
          ? { kind: "echo-ask-blocks-evaluation-progress-v1", case_id: result.case_id, catalog: "built", trial, valid: result.grade.valid, grounded: result.grade.grounded,
            nothing_lost: result.grade.nothing_lost, fit: result.grade.fit, attempts: result.attempts.length }
          : { kind: "echo-ask-wording-evaluation-progress-v1", case_id: result.case_id, trial, outcome: result.outcome, rules: result.grade.rules })}\n`);
        return result;
      });
    }
  }
  const trials = await pooled(tasks, options.concurrency);

  const identityAfter = codeIdentity(ROOT, codeFiles());
  // Only every case of the set, three trials each, decides its gate.
  const complete = cases.length === set.count && options.trials === TRIALS;
  const summary = set.summarize(trials, complete);
  const observedAt = new Date().toISOString();
  // A block run's prompts, by digest, and the block catalog and schema the kernel's writer was given; a wording run's
  // writer prompt digests alone.
  const systemPrompts = {};
  const casePrompts = Object.fromEntries([...prompts].map(([caseId, entry]) => {
    const hash = sha256(entry.system_prompt);
    systemPrompts[hash] = entry.system_prompt;
    return [caseId, { system_prompt_sha256: hash, user_prompt: entry.user_prompt }];
  }));
  const writer = prompts.get(cases[0].id);
  const traces = set.traces
    ? { writer: Object.freeze({ block_catalog: JSON.parse(writer.user_prompt).block_catalog ?? null, schema: writer.schema }) }
    : { writer_prompt_sha256: Object.freeze([...new Set(trials.flatMap((trial) => trial.attempts.map((attempt) => attempt.system_prompt_sha256)))]) };
  const report = Object.freeze({
    kind: "echo-ask-blocks-evaluation-v1",
    observed_at: observedAt,
    synthetic_only: true,
    complete,
    case_set: caseSet,
    cases_sha256: sha256(readFileSync(set.file)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model,
    errors: Object.freeze({ writer_calls: trials.reduce((sum, trial) => sum + trial.attempts.filter((attempt) => attempt.error !== undefined).length, 0),
      trials_without_reply: trials.filter(withoutReply).length }),
    limits: Object.freeze({ cases: cases.length, trials: options.trials, timeout_ms: options.timeoutMs, concurrency: options.concurrency, max_total_model_calls: maxModelCalls(set) }),
    ...traces,
    summary,
    decision: set.decide(summary, complete),
    ...(set.traces ? { system_prompts: systemPrompts, prompts: casePrompts } : {}),
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
      process.stdout.write(`${JSON.stringify(report.case_set === "wording"
        ? { report_path: reportPath, route: report.model.route, complete: report.complete, wording_ships: s.wording_ships,
          rules: Object.fromEntries(Object.entries(s.rules).map(([name, rule]) => [name, `${rule.passed_trials}/${rule.trials}`])), measures: s.measures }
        : { report_path: reportPath, route: report.model.route, complete: report.complete, summary: { valid: `${s.valid}/${s.trials}`, grounded: `${s.grounded}/${s.trials}`,
          nothing_lost: `${s.nothing_lost}/${s.trials}`, fit: `${s.fit}/${s.trials}`, stable: `${s.stable}/${s.cases}`, valid_at_once: s.valid_at_once, repairs: s.repairs,
          output_tokens: s.output_tokens }, decision: report.decision })}\n`);
      // A wording run that does not ship its wording exits 1, as its own evaluation did; a block run exits 0.
      if (CASE_SETS[report.case_set].exitsOnFailure && report.decision.passes !== true) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "block evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
