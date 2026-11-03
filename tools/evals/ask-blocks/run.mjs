#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of Ask block catalogs (README.md, pre-registered).
 *
 * For each case in cases.json, Ask runs as the kernel runs it for a client that asks for answer layout v1 (ADR-0045),
 * over a scripted desk, with a writer that answers nothing: that records production's exact writer prompts with no
 * network call. Then each catalog in catalogs.mjs writes every case three times through the shipped OpenRouter bundle and
 * its answer model, with one repair for a reply its catalog refuses, and grade.mjs grades every trial. A model judge on
 * the same route ranks each case's trial-1 answers twice. The arm `built` grades the shipped writer instead (README.md,
 * "Gate on the built writer"): each of its trials runs Ask through the kernel end to end with answer layout v2
 * (ADR-0051), only the writer's call going to the model, and grade.mjs grades the answer the kernel releases. The report
 * keeps full traces: all data is synthetic.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { personAnswerCitationKeyV8 } from "@echo-brain/organization-api";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { repairInput } from "../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { caseAsk, caseItems, deskItem as releasedItem, scriptedModel } from "../shared/ask-cases.mjs";
import { assertExplicitRun, assertWriterRoute, boundedInteger, codeIdentity, generationMetadata, importedModules, json, observedGeneration, outputDirectory, pooled, readFlags, safeError, sha256, writerFlags, writerRoute } from "../shared/runner.mjs";
import { ARMS, ARM_IDS, BUILT, CATALOGS, CATALOG_IDS, readReleased, readReply, writerPrompts } from "./catalogs.mjs";
import { CASES_FILE, CASE_COUNT, HELD_OUT_COUNT, HELD_OUT_FILE, TRIALS, caseOrder, decide, decideGate, evidenceOf, gradeTrial, loadCases, summarizeCatalogs, summarizeRanks } from "./grade.mjs";
import { JUDGE_SYSTEM_PROMPT, judgeInput, judgeSchema, readJudge } from "./judge.mjs";

export { researchStep } from "../shared/ask-cases.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
/** Every catalog's writer gets this many output tokens (README.md, "Catalogs"); the built writer gets the kernel's. */
const WRITER_OUTPUT_TOKENS = 3_000;
const JUDGE_OUTPUT_TOKENS = 1_500;
/** A trial makes at most two writer calls (its reply and one repair or retry); a case's judge at most two per order. */
const MAX_TOTAL_MODEL_CALLS = CATALOG_IDS.length * CASE_COUNT * TRIALS * 2 + CASE_COUNT * 2 * 2;
/** The case sets a run may take: the pre-registered 15, or the quick-lead check's held-out questions (README.md, "Quick lead check"). */
const CASE_SETS = Object.freeze({ main: Object.freeze({ file: CASES_FILE, count: CASE_COUNT }), "held-out": Object.freeze({ file: HELD_OUT_FILE, count: HELD_OUT_COUNT }) });

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id       Select cases (default: all ${CASE_COUNT}).`,
    `  --catalogs id,id    Select catalogs (default: ${CATALOG_IDS.join(",")}), or ${BUILT.id}: the shipped writer,`,
    "                      Ask through the kernel with answer layout v2, graded on the answer it releases.",
    `  --trials N          Trials per case and catalog, 1 through ${TRIALS} (default: ${TRIALS}).`,
    `  --judge on|off      Run the model judge on the four catalogs (default: on; --catalogs ${BUILT.id} alone needs off).`,
    `  --case-set SET      main (default: the ${CASE_COUNT} pre-registered cases) or held-out: the quick-lead check's ${HELD_OUT_COUNT}`,
    `                      held-out questions, for --catalogs ${BUILT.id} --judge off only; such a run decides nothing alone.`,
    "  --concurrency N     Model calls at once, 1 through 6 (default: 4).",
    "  --timeout-ms N      Per-call timeout, 15000 through 180000 (default: 120000); a built trial's whole Ask.",
    "  --resume PATH       Carry every call of an earlier report that got a reply; make only the calls it lacks.",
    "  --writer ROUTE      openrouter (default) or claude-account: the product's personal Claude account writer, the",
    "                      same model through the Claude Agent SDK and your own signed-in claude binary.",
    "  --claude-executable PATH  With --writer claude-account: the signed-in claude binary.",
    "  --help              Show this text without reading a credential or making a request.",
    "",
    "Only a whole pre-registered set decides anything: every case and catalog, three trials, the judge on; or the gate on",
    `the built writer, --catalogs ${BUILT.id} --judge off with every case and three trials. A smaller run is a diagnostic.`,
    "--out must be outside the repository and private; the report is written there with mode 0600, with full traces of",
    "every synthetic prompt and reply, never a credential.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, catalogIds: null, trials: TRIALS, judge: true, concurrency: 4, timeoutMs: 120_000, resume: null, writer: "openrouter", claudeExecutable: null, caseSet: "main" };
  const list = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--cases": (value) => { options.caseIds = list(value); },
    "--catalogs": (value) => { options.catalogIds = list(value); },
    "--trials": (value) => { options.trials = Number(value); },
    "--judge": (value) => { if (value !== "on" && value !== "off") throw new Error("--judge must be on or off"); options.judge = value === "on"; },
    "--concurrency": (value) => { options.concurrency = Number(value); },
    "--timeout-ms": (value) => { options.timeoutMs = Number(value); },
    "--resume": (value) => { options.resume = value; },
    "--case-set": (value) => { if (!Object.hasOwn(CASE_SETS, value)) throw new Error("--case-set must be main or held-out"); options.caseSet = value; },
    ...writerFlags(options),
  })) return { help: true };
  if (options.resume !== null && (!isAbsolute(options.resume) || !existsSync(options.resume))) throw new Error("--resume must be the absolute path of an earlier report");
  assertWriterRoute(options);
  assertExplicitRun(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, TRIALS);
  options.concurrency = boundedInteger(options.concurrency, "--concurrency", 1, 6);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", 15_000, 180_000);
  const set = CASE_SETS[options.caseSet];
  // The held-out questions grade the built writer alone: the catalogs' comparison and its judge are the 15 cases'.
  if (options.caseSet === "held-out" && (options.judge || options.catalogIds === null || options.catalogIds.join() !== BUILT.id)) throw new Error(`--case-set held-out runs --catalogs ${BUILT.id} --judge off only`);
  const known = new Set(loadCases(set.file, set.count).cases.map((entry) => entry.id));
  const once = (values) => new Set(values).size === values.length;
  if (options.caseIds !== null && (options.caseIds.length === 0 || !once(options.caseIds) || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  if (options.catalogIds !== null && (options.catalogIds.length === 0 || !once(options.catalogIds) || options.catalogIds.some((id) => !ARM_IDS.includes(id)))) throw new Error("--catalogs must select known catalogs, each once");
  // The judge ranks the four catalogs' answers, never the built writer's.
  if (options.judge && options.catalogIds?.every((id) => id === BUILT.id)) throw new Error(`--catalogs ${BUILT.id} has nothing for the judge to rank: add --judge off`);
  const calls = (options.caseIds?.length ?? known.size) * ((options.catalogIds?.length ?? CATALOG_IDS.length) * options.trials * 2 + (options.judge ? 4 : 0));
  if (calls > MAX_TOTAL_MODEL_CALLS) throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/**
 * The files a report fingerprints, beside the commit and its uncommitted changes: the cases, the pre-registration and
 * every module the evaluation loads (its own, the kernel's writer, checks and shared modules, the answer contract and the
 * writer routes), found by following its imports.
 */
const codeFiles = () => Object.freeze(["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/held-out-cases.json", "tools/evals/ask-blocks/README.md", ...importedModules(ROOT, ["tools/evals/ask-blocks/run.mjs"])]);

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

/**
 * Production's writer prompts and reply schema for one case, recorded through the kernel with a writer that answers
 * nothing: for answer layout 1 (ADR-0045), which the four catalogs start from, or 2 (ADR-0051), the built writer's.
 */
export async function captureWriterPrompts(caseDefinition, document, generation, answerLayout) {
  let captured = null;
  const { model } = scriptedModel(caseDefinition, (input) => {
    captured ??= Object.freeze({ system_prompt: input.system_prompt, user_prompt: input.user_prompt, schema: input.schema });
    // A reply that says nothing, in either layout's shape.
    return { value: { lists: [], tables: [], sentences: [], blocks: [], not_found: [caseDefinition.research.need] }, finish_reason: "stop", usage: null, provider_latency_ms: null };
  }, "the capture runs only research and the Ask writer");
  await caseAsk(itemsOf(caseDefinition), document, document.asked_at, model, generation, answerLayout).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(30_000) });
  if (captured === null) throw new Error(`case ${caseDefinition.id}: research never reached the writer`);
  return captured;
}

/** One model call, kept whole: the reply and the provider's metadata, or the safe error. */
async function call(structuredOutput, input) {
  const started = performance.now();
  try {
    const observed = await observedGeneration(structuredOutput, input);
    return { value: observed.value, ...generationMetadata(observed), elapsed_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { error: safeError(error, { withUsage: true }), elapsed_ms: Math.round(performance.now() - started) };
  }
}

/** The repair prompt production's gate sends (repairInput): the original input, then the rejected reply and the reason. */
const repairPrompt = (userPrompt, rejected, reason) => JSON.stringify(repairInput(JSON.parse(userPrompt), rejected, reason));

/**
 * One trial: the catalog's writer on one case, its reply read and checked, one repair for a refused reply or one retry
 * for a failed call, then graded. Every prompt and reply is kept (synthetic). `carried` is an earlier run's calls for
 * this trial that got a reply, in order (README.md, "Resuming"): each is read and checked again, and only the calls it
 * still needs are made.
 */
export async function runTrial(caseDefinition, catalog, trial, prompts, evidence, structuredOutput, generation, options, carried = []) {
  const attempts = [];
  let read = null;
  let userPrompt = prompts.user_prompt;
  const record = (entry) => {
    if (entry.error === undefined) {
      read = readReply(catalog, entry.value);
      Object.assign(entry, { valid: read.valid, problems: read.problems });
      if (!read.valid) userPrompt = repairPrompt(prompts.user_prompt, entry.value, read.problems[0] ?? "the reply could not be read");
    } else {
      Object.assign(entry, { valid: false });
      userPrompt = prompts.user_prompt;
    }
    attempts.push(entry);
  };
  for (const previous of carried) {
    record({ ...previous, carried: true });
    if (attempts.at(-1).valid) break;
  }
  while (attempts.length < 2 && attempts.at(-1)?.valid !== true) {
    const attempt = attempts.length + 1;
    const kind = attempt === 1 ? "first" : attempts[0].error === undefined ? "repair" : "retry";
    const result = await call(structuredOutput, { model: generation.answer_model, system_prompt: prompts.system_prompt, user_prompt: userPrompt, schema: catalog.schema,
      max_output_tokens: WRITER_OUTPUT_TOKENS, timeout_ms: options.timeoutMs });
    record({ attempt, kind, ...(kind === "first" ? {} : { user_prompt: userPrompt }), ...result });
  }
  const final = attempts.at(-1).error === undefined ? read : null;
  const grade = gradeTrial(caseDefinition, catalog, final ?? { valid: false }, evidence);
  return Object.freeze({ case_id: caseDefinition.id, catalog: catalog.id, trial, attempts, read: final, grade });
}

/**
 * One trial of the built writer (README.md, "Gate on the built writer"): Ask on one case through the kernel end to end
 * with answer layout v2, research scripted and each writer call sent to the route. The kernel reads, checks, repairs and
 * releases; the harness adds no repair, keeps each call (its raw reply, usage and prompts: those `prompts` recorded, or
 * its own when the kernel asked with others, as for a repair) and the released answer, and grades that answer's blocks
 * against `evidence`, what the writer was given. `carried` is an earlier run's calls for this trial that got a reply, in
 * order (README.md, "Resuming"): one is handed to the kernel again only when the kernel asks for it with the same prompts,
 * and every other call is made.
 */
export async function runBuiltTrial(caseDefinition, trial, prompts, evidence, document, structuredOutput, generation, options, carried = []) {
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
    const before = carried[attempt - 1];
    if (before !== undefined && before.system_prompt_sha256 === systemPromptSha256 && (before.user_prompt ?? prompts.user_prompt) === input.user_prompt) {
      attempts.push({ ...before, ...asked, carried: true });
      return { value: before.value, finish_reason: before.finish_reason, usage: before.usage, provider_latency_ms: before.provider_latency_ms };
    }
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
  }, "the built arm runs only research and the Ask writer");
  let response = null;
  let error;
  try {
    response = await caseAsk(itemsOf(caseDefinition), document, document.asked_at, model, generation, BUILT.answer_layout).answer({ question: caseDefinition.question, signal: AbortSignal.timeout(options.timeoutMs) });
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
  const grade = gradeTrial(caseDefinition, BUILT, read ?? { valid: false }, evidence);
  return Object.freeze({ case_id: caseDefinition.id, catalog: BUILT.id, trial, attempts, read, response, ...(error === undefined ? {} : { error }), grade });
}

/** An earlier run's calls that got a reply, in order, up to the first that failed. */
const repliedPrefix = (attempts) => {
  const failed = attempts.findIndex((attempt) => attempt.error !== undefined);
  return (failed < 0 ? attempts : attempts.slice(0, failed)).map(({ valid: _valid, problems: _problems, carried: _carried, ...attempt }) => attempt);
};

/**
 * The earlier report a run resumes (README.md, "Resuming"): it must be this evaluation's, over the same cases, with
 * the same writer prompts for every case and catalog it carries; otherwise nothing is carried.
 */
function resumable(previous, cases, catalogs, prompts, casesFile) {
  if (previous.kind !== "echo-ask-blocks-evaluation-v1" || previous.cases_sha256 !== sha256(readFileSync(casesFile))) throw new Error("--resume must name a report of this evaluation over the same cases");
  for (const caseDefinition of cases) {
    for (const catalog of catalogs) {
      const before = previous.prompts?.[caseDefinition.id]?.[catalog.id];
      const now = prompts.get(caseDefinition.id).get(catalog.id);
      if (before === undefined) continue;
      if (before.user_prompt !== now.user_prompt || before.system_prompt_sha256 !== sha256(now.system_prompt)) throw new Error(`--resume: the writer prompts for ${caseDefinition.id} (${catalog.id}) changed since that run`);
    }
  }
}

/** The model judge on one case, in one order, given `userPrompt` (judgeInput's): each catalog's rank, after at most one repair, or its failure. */
async function judgeCase(userPrompt, order, structuredOutput, generation, options) {
  const attempts = [];
  let prompt = userPrompt;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await call(structuredOutput, { model: generation.answer_model, system_prompt: JUDGE_SYSTEM_PROMPT, user_prompt: prompt, schema: judgeSchema,
      max_output_tokens: JUDGE_OUTPUT_TOKENS, timeout_ms: options.timeoutMs });
    const judged = result.error === undefined ? readJudge(result.value, order) : { problem: "the call failed" };
    attempts.push({ attempt, ...(attempt === 1 ? {} : { user_prompt: prompt }), ...result, ...judged });
    if (judged.ranks !== undefined) return { order, user_prompt: userPrompt, attempts, ranks: judged.ranks, reasons: judged.reasons };
    if (result.error === undefined) prompt = repairPrompt(userPrompt, result.value, judged.problem);
  }
  return { order, user_prompt: userPrompt, attempts, ranks: null };
}

/** Runs the selected cases and catalogs, then the judge, and writes the report. */
export async function run(options, dependencies = {}) {
  const set = CASE_SETS[options.caseSet ?? "main"];
  const heldOut = set !== CASE_SETS.main;
  const document = loadCases(set.file, set.count);
  const cases = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const catalogs = options.catalogIds === null ? CATALOGS : ARMS.filter((catalog) => options.catalogIds.includes(catalog.id));
  // The four catalogs the judge and the founder rank; the built writer is graded alone.
  const ranked = catalogs.filter((catalog) => catalog !== BUILT);
  const built = catalogs.includes(BUILT);
  const identityBefore = codeIdentity(ROOT, codeFiles());
  const { route, loaded } = writerRoute(options, "mem_ask-blocks-eval", createOpenRouterAnswerCompositionGenerationBundleV1, dependencies.loaded);
  const progress = dependencies.progress ?? ((line) => process.stderr.write(line));
  // Each arm's writer prompts: the four catalogs' from layout v1's, the built writer's as the kernel asks with layout v2.
  const prompts = new Map();
  for (const caseDefinition of cases) {
    const v1 = ranked.length === 0 ? null : await captureWriterPrompts(caseDefinition, document, loaded.generation, 1);
    const v2 = built ? await captureWriterPrompts(caseDefinition, document, loaded.generation, BUILT.answer_layout) : null;
    prompts.set(caseDefinition.id, new Map(catalogs.map((catalog) => [catalog.id, catalog === BUILT ? v2 : writerPrompts(catalog, v1)])));
  }
  // Every arm is graded against the evidence its writer was given.
  const evidence = new Map(cases.map((caseDefinition) => [caseDefinition.id, new Map(catalogs.map((catalog) => [catalog.id, evidenceOf(prompts.get(caseDefinition.id).get(catalog.id).user_prompt)]))]));
  const previous = options.resume === null || options.resume === undefined ? null : JSON.parse(readFileSync(options.resume, "utf8"));
  if (previous !== null) resumable(previous, cases, catalogs, prompts, set.file);
  const carriedOf = (caseId, catalogId, trial) => repliedPrefix(previous?.trials?.find((entry) => entry.case_id === caseId && entry.catalog === catalogId && entry.trial === trial)?.attempts ?? []);

  // Trials interleave catalogs and cases, so a slow route slows every catalog alike.
  const tasks = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    for (const caseDefinition of cases) {
      for (const catalog of catalogs) {
        tasks.push(async () => {
          const given = evidence.get(caseDefinition.id).get(catalog.id);
          const carried = carriedOf(caseDefinition.id, catalog.id, trial);
          const own = prompts.get(caseDefinition.id).get(catalog.id);
          const result = catalog === BUILT
            ? await runBuiltTrial(caseDefinition, trial, own, given, document, loaded.structured_output, loaded.generation, options, carried)
            : await runTrial(caseDefinition, catalog, trial, own, given, loaded.structured_output, loaded.generation, options, carried);
          progress(`${JSON.stringify({ kind: "echo-ask-blocks-evaluation-progress-v1", case_id: result.case_id, catalog: result.catalog, trial, valid: result.grade.valid,
            grounded: result.grade.grounded, nothing_lost: result.grade.nothing_lost, fit: result.grade.fit, attempts: result.attempts.length })}\n`);
          return result;
        });
      }
    }
  }
  const trials = await pooled(tasks, options.concurrency);

  // The judge ranks each case's trial-1 answers of the four catalogs in the page's order, then reversed.
  const judged = {};
  if (options.judge && ranked.length > 0) {
    const judgeTasks = cases.flatMap((caseDefinition) => {
      const order = caseOrder(caseDefinition.id).filter((catalog) => ranked.some((entry) => entry.id === catalog));
      const reads = Object.fromEntries(order.map((catalog) => [catalog, trials.find((entry) => entry.case_id === caseDefinition.id && entry.catalog === catalog && entry.trial === 1)?.read ?? null]));
      // The judge reads the evidence the catalogs' writers were given.
      const writerEvidence = JSON.parse(prompts.get(caseDefinition.id).get(ranked[0].id).user_prompt).evidence;
      return [order, [...order].reverse()].map((shown) => async () => {
        const userPrompt = judgeInput(caseDefinition.question, writerEvidence, shown, reads);
        // A judged order is carried when its trial-1 answers are the ones it judged: the same input, ranked.
        const before = previous?.judge?.[caseDefinition.id]?.find((entry) => entry.ranks !== null && entry.order.join() === shown.join() && entry.user_prompt === userPrompt);
        if (before !== undefined) return { case_id: caseDefinition.id, ...before, carried: true };
        return { case_id: caseDefinition.id, ...(await judgeCase(userPrompt, shown, loaded.structured_output, loaded.generation, options)) };
      });
    });
    for (const result of await pooled(judgeTasks, options.concurrency)) (judged[result.case_id] ??= []).push(result);
  }
  const judgeRanks = Object.fromEntries(Object.entries(judged).flatMap(([caseId, orders]) => {
    if (orders.some((entry) => entry.ranks === null)) return [];
    return [[caseId, Object.fromEntries(ranked.map((catalog) => [catalog.id, orders.reduce((sum, entry) => sum + entry.ranks[catalog.id], 0) / orders.length]))]];
  }));

  const identityAfter = codeIdentity(ROOT, codeFiles());
  // A complete run is the four-catalog comparison, as pre-registered, or the gate: the built writer alone, judge off.
  const everyTrial = cases.length === set.count && options.trials === TRIALS;
  const gate = built && ranked.length === 0;
  const complete = everyTrial && (gate ? !options.judge : !built && ranked.length === CATALOG_IDS.length && options.judge);
  const summary = summarizeCatalogs(trials, catalogs.map((catalog) => catalog.id));
  const observedAt = new Date().toISOString();
  const systemPrompts = {};
  const casePrompts = Object.fromEntries(cases.map((caseDefinition) => [caseDefinition.id, Object.fromEntries(catalogs.map((catalog) => {
    const entry = prompts.get(caseDefinition.id).get(catalog.id);
    const hash = sha256(entry.system_prompt);
    systemPrompts[hash] = entry.system_prompt;
    return [catalog.id, { system_prompt_sha256: hash, user_prompt: entry.user_prompt }];
  }))]));
  // The built writer's entries and schema are the kernel's, as its writer was given them.
  const builtPrompts = built ? prompts.get(cases[0].id).get(BUILT.id) : null;
  const report = Object.freeze({
    kind: "echo-ask-blocks-evaluation-v1",
    observed_at: observedAt,
    synthetic_only: true,
    complete,
    case_set: heldOut ? "held-out" : "main",
    cases_sha256: sha256(readFileSync(set.file)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model: Object.freeze({ route, adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
    ...(previous === null ? {} : { resumed_from: Object.freeze({ observed_at: previous.observed_at, report_sha256: sha256(readFileSync(options.resume)), code: previous.code,
      carried_calls: trials.reduce((sum, trial) => sum + trial.attempts.filter((attempt) => attempt.carried).length, 0),
      carried_judge_orders: Object.values(judged).flat().filter((entry) => entry.carried).length }) }),
    errors: Object.freeze({ writer_calls: trials.reduce((sum, trial) => sum + trial.attempts.filter((attempt) => attempt.error !== undefined).length, 0),
      trials_without_reply: trials.filter((trial) => trial.read === null).length, judge_orders_without_ranks: Object.values(judged).flat().filter((entry) => entry.ranks === null).length }),
    limits: Object.freeze({ cases: cases.length, catalogs: catalogs.map((catalog) => catalog.id), trials: options.trials, judge: options.judge, writer_output_tokens: WRITER_OUTPUT_TOKENS,
      timeout_ms: options.timeoutMs, concurrency: options.concurrency, max_total_model_calls: MAX_TOTAL_MODEL_CALLS }),
    catalogs: Object.freeze(Object.fromEntries(catalogs.map((catalog) => [catalog.id, catalog === BUILT
      ? { modeled_on: catalog.modeled_on, answer_layout: catalog.answer_layout, catalog_key: catalog.catalog_key, catalog: JSON.parse(builtPrompts.user_prompt)[catalog.catalog_key] ?? null, can_show: catalog.can_show, schema: builtPrompts.schema }
      : { modeled_on: catalog.modeled_on, catalog_key: catalog.catalog_key, catalog: catalog.catalog, can_show: catalog.can_show, schema: catalog.schema }]))),
    summary,
    // The founder's ranks come from the page; until then the comparison's decision waits for them. The gate decides alone.
    judge_ranks: judgeRanks,
    ranks_without_founder: summarizeRanks({}, judgeRanks, ranked.map((catalog) => catalog.id)),
    // The rules' thresholds are over the 15 cases; the held-out questions are reported beside them and decide nothing alone.
    decision: heldOut ? null : gate ? decideGate(summary[BUILT.id], complete) : decide(summary, null),
    case_orders: Object.freeze(Object.fromEntries(cases.map((caseDefinition) => [caseDefinition.id, caseOrder(caseDefinition.id)]))),
    system_prompts: systemPrompts,
    prompts: casePrompts,
    judge_system_prompt: JUDGE_SYSTEM_PROMPT,
    judge: judged,
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
      const brief = Object.fromEntries(Object.entries(report.summary).map(([catalog, entry]) => [catalog, {
        valid: `${entry.valid}/${entry.trials}`, grounded: `${entry.grounded}/${entry.trials}`, nothing_lost: `${entry.nothing_lost}/${entry.trials}`, fit: `${entry.fit}/${entry.trials}`,
        stable: `${entry.stable}/${entry.cases}`, valid_at_once: entry.valid_at_once, repairs: entry.repairs, output_tokens: entry.output_tokens,
      }]));
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, route: report.model.route, complete: report.complete, summary: brief, judge_mean_rank: report.ranks_without_founder.judge_mean_rank, decision: report.decision })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "block evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
