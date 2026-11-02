#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of Ask block catalogs (README.md, pre-registered).
 *
 * For each case in cases.json, Ask runs as the kernel runs it for a client that asks for answer layout v1 (ADR-0045),
 * over a scripted desk, with a writer that answers nothing: that records production's exact writer prompts with no
 * network call. Then each catalog in catalogs.mjs writes every case three times through the shipped OpenRouter bundle and
 * its answer model, with one repair for a reply its catalog refuses, and grade.mjs grades every trial. A model judge on
 * the same route ranks each case's trial-1 answers twice. The report keeps full traces: all data is synthetic.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import { validatePersonFollowUpEvidenceV1 } from "@echo-brain/organization-api";
import { createAgenticAskV5 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { FOLLOW_UPS_SOURCE_DESCRIPTOR_V1, followUpDeskFieldsV1 } from "@echo-brain/organization-authority-kernel/shared/follow-up-evidence-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { repairInstruction } from "../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { assertExplicitRun, boundedInteger, codeIdentity, json, outputDirectory, readFlags, safeError, sha256, usage } from "../shared/runner.mjs";
import { CATALOGS, CATALOG_IDS, readReply, writerPrompts } from "./catalogs.mjs";
import { CASES_FILE, CASE_COUNT, TRIALS, caseOrder, decide, evidenceOf, gradeTrial, loadCases, summarizeCatalogs, summarizeRanks } from "./grade.mjs";
import { JUDGE_SYSTEM_PROMPT, judgeInput, judgeSchema, readJudge } from "./judge.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
/** Every catalog's writer gets this many output tokens (README.md, "Catalogs"). */
const WRITER_OUTPUT_TOKENS = 3_000;
const JUDGE_OUTPUT_TOKENS = 1_500;
/** A trial makes at most two writer calls (its reply and one repair or retry); a case's judge at most two per order. */
const MAX_TOTAL_MODEL_CALLS = CATALOG_IDS.length * CASE_COUNT * TRIALS * 2 + CASE_COUNT * 2 * 2;
const RESEARCH_PROMPT = "You are Echo's research agent";
const WRITER_PROMPT = "You write Echo's final answer";
const TICKETS_SOURCE = Object.freeze({
  source_id: "jira", kind: "ticket", selector: "tickets", description: "Jira issues the asker can read through their own connection.", metadata_only_list: true, tool_id: "jira",
});

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id       Select cases (default: all ${CASE_COUNT}).`,
    `  --catalogs id,id    Select catalogs (default: ${CATALOG_IDS.join(",")}).`,
    `  --trials N          Trials per case and catalog, 1 through ${TRIALS} (default: ${TRIALS}).`,
    "  --judge on|off      Run the model judge (default: on).",
    "  --concurrency N     Model calls at once, 1 through 6 (default: 4).",
    "  --timeout-ms N      Per-call timeout, 15000 through 180000 (default: 120000).",
    "  --help              Show this text without reading a credential or making a request.",
    "",
    "Only the whole pre-registered set (every case and catalog, three trials, the judge on) decides anything; a smaller",
    "run is a diagnostic. --out must be outside the repository and private; the report and the page's data are written",
    "there with mode 0600, with full traces of every synthetic prompt and reply, never a credential.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, catalogIds: null, trials: TRIALS, judge: true, concurrency: 4, timeoutMs: 120_000 };
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
  })) return { help: true };
  assertExplicitRun(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, TRIALS);
  options.concurrency = boundedInteger(options.concurrency, "--concurrency", 1, 6);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", 15_000, 180_000);
  const known = new Set(loadCases().cases.map((entry) => entry.id));
  const once = (values) => new Set(values).size === values.length;
  if (options.caseIds !== null && (options.caseIds.length === 0 || !once(options.caseIds) || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  if (options.catalogIds !== null && (options.catalogIds.length === 0 || !once(options.catalogIds) || options.catalogIds.some((id) => !CATALOG_IDS.includes(id)))) throw new Error("--catalogs must select known catalogs, each once");
  const calls = (options.caseIds?.length ?? known.size) * ((options.catalogIds?.length ?? CATALOG_IDS.length) * options.trials * 2 + (options.judge ? 4 : 0));
  if (calls > MAX_TOTAL_MODEL_CALLS) throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

const COMPOSITION = "packages/organization-authority-kernel/dist/answer-composition";
/** The files a report fingerprints, beside the commit and its uncommitted changes. */
const CODE_FILES = Object.freeze([
  "tools/evals/ask-blocks/run.mjs", "tools/evals/ask-blocks/catalogs.mjs", "tools/evals/ask-blocks/grade.mjs", "tools/evals/ask-blocks/judge.mjs",
  "tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/README.md", "tools/evals/shared/runner.mjs",
  `${COMPOSITION}/agentic-ask-v1-model-protocol.js`, `${COMPOSITION}/agentic-ask-v1.js`, `${COMPOSITION}/renderers/ask-renderer-v1.js`, `${COMPOSITION}/renderers/ask-layout-v1.js`,
  "providers/openrouter/dist/openrouter-answer-composition-generation-bundle-v1.js",
  "providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fields = (item, names) => Object.fromEntries(names.filter((name) => Object.hasOwn(item, name)).map((name) => [name, item[name]]));

/**
 * One case item as the desk releases it: a follow-up through the product's own projection, an approved decision record,
 * or a Jira issue the asker reads through their own connection, created on its `created` day. Every value is synthetic.
 */
export function deskItem(caseId, index, item) {
  const key = `${caseId}:${index}`;
  const id = `blocks-${digest(key).slice(0, 24)}`;
  const receipt_sha256 = canonicalSha256({ fixture: "ask-blocks-release", key });
  if (item.kind === "follow_up") {
    const evidence = validatePersonFollowUpEvidenceV1({
      item_id: `itm_${digest(key).slice(0, 24)}`, kind: item.on, title: item.title, owner: item.owner, status: item.status,
      ...fields(item, ["created_at", "sent_at", "reassigned_at", "due_at", "check", "expected"]),
      ...(item.decision === undefined ? {} : { decision: { ...item.decision, ref: `meeting:${canonicalSha256({ fixture: "ask-blocks-decision", key })}` } }),
    });
    return Object.freeze({ id, ...followUpDeskFieldsV1(evidence), visibility: "team", receipt_sha256 });
  }
  if (item.kind === "decision") {
    return Object.freeze({
      id, kind: "decision", label: item.label, text: item.text, visibility: "team", occurred_at: item.occurred_at, receipt_sha256,
      citation: Object.freeze({ kind: "approved_record", atom_id: canonicalSha256({ fixture: "ask-blocks-atom", key }), record_sha256: canonicalSha256({ fixture: "ask-blocks-record", key }), policy_id: "project-members-readable-person-v1" }),
    });
  }
  return Object.freeze({
    id, kind: "ticket", label: `${item.key}: ${item.title}`, text: item.text, visibility: "only_me",
    attributes: Object.freeze({ status: item.status, owner: item.owner, ...(item.priority === undefined ? {} : { priority: item.priority }) }),
    occurred_at: item.created ?? "2026-10-19", date_kind: "created", receipt_sha256,
    citation: Object.freeze({ kind: "ticket", tool_id: "jira", external_scope_id: "synthetic-cloud", ticket_id: item.key.replace(/\D/gu, ""), permalink: `https://synthetic.example.test/browse/${item.key}`, text_sha256: sha256Digest(item.text) }),
  });
}

/** A desk over one case's items, in a global Ask with Jira and follow-ups bound: any search finds them all, in order. */
function caseDesk(caseDefinition, document) {
  const items = caseDefinition.items.map((item, index) => deskItem(caseDefinition.id, index, item));
  const result = (values) => Object.freeze({ items: Object.freeze(values), truncated: false, receipt_digests: Object.freeze(values.map((value) => value.receipt_sha256)) });
  return Object.freeze({
    scope: Object.freeze({ kind: "global" }),
    live_sources: Object.freeze([TICKETS_SOURCE, FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]),
    async search() { return result(items); },
    async open(input) { return result(items.filter((item) => item.id === input.item)); },
    async list() { return result([]); },
    async revalidate() { return Object.freeze({ checked_at: document.asked_at }); },
  });
}

/** The scripted research step for `round` (from 1): search, then open every item found, then finish citing them all. */
export function researchStep(caseDefinition, round) {
  const ids = Array.from({ length: caseDefinition.items.length }, (_, index) => `E${index + 1}`);
  const need = (status) => ({ ...(round === 1 ? {} : { id: "N1" }), need: caseDefinition.research.need, kind: "content", status, evidence: status === "found" ? ids : [] });
  const part = (status, notes) => [{ question: caseDefinition.question, needs: [need(status)], notes }];
  if (round === 1) return { parts: part("open", ""), actions: [{ tool: "search", args: { query: caseDefinition.research.query } }] };
  if (round === 2) return { parts: part("open", `${ids.join(", ")} match.`), actions: ids.map((id) => ({ tool: "open", args: { id } })) };
  return { parts: part("found", `${ids.join(", ")} read in full.`), actions: [{ tool: "finish", args: {} }] };
}

/** Production's writer prompts for one case, recorded through the kernel with a writer that answers nothing. */
export async function captureWriterPrompts(caseDefinition, document, generation) {
  let round = 0;
  let captured = null;
  const model = Object.freeze({
    async generate(input) { return (await this.generate_with_observation(input)).value; },
    async generate_with_observation(input) {
      if (input.system_prompt.startsWith(RESEARCH_PROMPT)) {
        round += 1;
        return { value: researchStep(caseDefinition, round), finish_reason: "stop", usage: null, provider_latency_ms: null };
      }
      if (!input.system_prompt.startsWith(WRITER_PROMPT)) throw new Error("the capture runs only research and the Ask writer");
      captured ??= Object.freeze({ system_prompt: input.system_prompt, user_prompt: input.user_prompt });
      return { value: { lists: [], tables: [], sentences: [], not_found: [caseDefinition.research.need] }, finish_reason: "stop", usage: null, provider_latency_ms: null };
    },
  });
  const ask = createAgenticAskV5({
    desk: caseDesk(caseDefinition, document), model, generation, audit: { append: () => undefined }, answer_layout: true,
    asker: { display_name: document.asker }, time_context: { now: document.asked_at, time_zone: document.time_zone },
    today: () => document.today, wall_ms: () => Date.parse(document.asked_at),
  });
  await ask.answer({ question: caseDefinition.question, signal: AbortSignal.timeout(30_000) });
  if (captured === null) throw new Error(`case ${caseDefinition.id}: research never reached the writer`);
  return captured;
}

/** One model call, kept whole: the reply and the provider's metadata, or the safe error. */
async function call(structuredOutput, input) {
  const started = performance.now();
  try {
    const observed = typeof structuredOutput.generate_with_observation === "function"
      ? await structuredOutput.generate_with_observation(input)
      : { value: await structuredOutput.generate(input), finish_reason: null, usage: null, provider_latency_ms: null };
    return { value: observed.value, finish_reason: observed.finish_reason ?? null, usage: usage(observed.usage),
      provider_latency_ms: Number.isSafeInteger(observed.provider_latency_ms) ? observed.provider_latency_ms : null, elapsed_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { error: safeError(error, { withUsage: true }), elapsed_ms: Math.round(performance.now() - started) };
  }
}

/** The repair input production sends (agentic-model-gate-v1): the rejected reply and the reason, beside the original input. */
function repairPrompt(userPrompt, rejected, reason) {
  return JSON.stringify({ ...JSON.parse(userPrompt), rejected_response: JSON.stringify(rejected).slice(0, 4_000), validation_error: repairInstruction(reason) });
}

/**
 * One trial: the catalog's writer on one case, its reply read and checked, one repair for a refused reply or one retry
 * for a failed call, then graded. Every prompt and reply is kept (synthetic).
 */
export async function runTrial(caseDefinition, catalog, trial, prompts, evidence, structuredOutput, generation, options) {
  const attempts = [];
  let read = null;
  let userPrompt = prompts.user_prompt;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const kind = attempt === 1 ? "first" : attempts[0].error === undefined ? "repair" : "retry";
    const result = await call(structuredOutput, { model: generation.answer_model, system_prompt: prompts.system_prompt, user_prompt: userPrompt, schema: catalog.schema,
      max_output_tokens: WRITER_OUTPUT_TOKENS, timeout_ms: options.timeoutMs });
    const record = { attempt, kind, ...(kind === "first" ? {} : { user_prompt: userPrompt }), ...result };
    if (result.error === undefined) {
      read = readReply(catalog, result.value);
      record.valid = read.valid;
      record.problems = read.problems;
    } else {
      record.valid = false;
    }
    attempts.push(record);
    if (record.valid) break;
    if (attempt === 1) userPrompt = result.error === undefined ? repairPrompt(prompts.user_prompt, result.value, read.problems[0] ?? "the reply could not be read") : prompts.user_prompt;
  }
  const final = attempts.at(-1).error === undefined ? read : null;
  const grade = gradeTrial(caseDefinition, catalog, final ?? { valid: false }, evidence);
  return Object.freeze({ case_id: caseDefinition.id, catalog: catalog.id, trial, attempts, read: final, grade });
}

/** The model judge on one case, in one order: each catalog's rank, after at most one repair, or its failure. */
async function judgeCase(caseDefinition, prompts, reads, order, structuredOutput, generation, options) {
  const evidence = JSON.parse(prompts.user_prompt).evidence;
  const userPrompt = judgeInput(caseDefinition.question, evidence, order, reads);
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

/** Runs `tasks` (functions returning promises) `limit` at a time, keeping their order in the results. */
async function pooled(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const at = next;
      next += 1;
      results[at] = await tasks[at]();
    }
  }));
  return results;
}

/** Runs the selected cases and catalogs, then the judge, and writes the report and the page's data. */
export async function run(options, dependencies = {}) {
  const document = loadCases();
  const cases = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const catalogs = options.catalogIds === null ? CATALOGS : CATALOGS.filter((catalog) => options.catalogIds.includes(catalog.id));
  const identityBefore = codeIdentity(ROOT, CODE_FILES);
  const loaded = dependencies.loaded ?? createOpenRouterAnswerCompositionGenerationBundleV1({ credential_file: options.credentialFile }).load();
  const progress = dependencies.progress ?? ((line) => process.stderr.write(line));
  const captured = new Map();
  for (const caseDefinition of cases) captured.set(caseDefinition.id, await captureWriterPrompts(caseDefinition, document, loaded.generation));
  const prompts = new Map(cases.map((caseDefinition) => [caseDefinition.id, new Map(catalogs.map((catalog) => [catalog.id, writerPrompts(catalog, captured.get(caseDefinition.id))]))]));
  const evidence = new Map(cases.map((caseDefinition) => [caseDefinition.id, evidenceOf(captured.get(caseDefinition.id).user_prompt)]));

  // Trials interleave catalogs and cases, so a slow route slows every catalog alike.
  const tasks = [];
  for (let trial = 1; trial <= options.trials; trial += 1) {
    for (const caseDefinition of cases) {
      for (const catalog of catalogs) {
        tasks.push(async () => {
          const result = await runTrial(caseDefinition, catalog, trial, prompts.get(caseDefinition.id).get(catalog.id), evidence.get(caseDefinition.id), loaded.structured_output, loaded.generation, options);
          progress(`${JSON.stringify({ kind: "echo-ask-blocks-evaluation-progress-v1", case_id: result.case_id, catalog: result.catalog, trial, valid: result.grade.valid,
            grounded: result.grade.grounded, nothing_lost: result.grade.nothing_lost, fit: result.grade.fit, attempts: result.attempts.length })}\n`);
          return result;
        });
      }
    }
  }
  const trials = await pooled(tasks, options.concurrency);

  // The judge ranks each case's trial-1 answers in the page's order, then reversed.
  const judged = {};
  if (options.judge) {
    const judgeTasks = cases.flatMap((caseDefinition) => {
      const order = caseOrder(caseDefinition.id).filter((catalog) => catalogs.some((entry) => entry.id === catalog));
      const reads = Object.fromEntries(order.map((catalog) => [catalog, trials.find((entry) => entry.case_id === caseDefinition.id && entry.catalog === catalog && entry.trial === 1)?.read ?? null]));
      const casePrompts = prompts.get(caseDefinition.id).get(catalogs[0].id);
      return [order, [...order].reverse()].map((shown) => async () => ({ case_id: caseDefinition.id, ...(await judgeCase(caseDefinition, casePrompts, reads, shown, loaded.structured_output, loaded.generation, options)) }));
    });
    for (const result of await pooled(judgeTasks, options.concurrency)) (judged[result.case_id] ??= []).push(result);
  }
  const judgeRanks = Object.fromEntries(Object.entries(judged).flatMap(([caseId, orders]) => {
    if (orders.some((entry) => entry.ranks === null)) return [];
    return [[caseId, Object.fromEntries(catalogs.map((catalog) => [catalog.id, orders.reduce((sum, entry) => sum + entry.ranks[catalog.id], 0) / orders.length]))]];
  }));

  const identityAfter = codeIdentity(ROOT, CODE_FILES);
  const complete = cases.length === CASE_COUNT && catalogs.length === CATALOG_IDS.length && options.trials === TRIALS && options.judge;
  const summary = summarizeCatalogs(trials, catalogs.map((catalog) => catalog.id));
  const observedAt = new Date().toISOString();
  const systemPrompts = {};
  const casePrompts = Object.fromEntries(cases.map((caseDefinition) => [caseDefinition.id, Object.fromEntries(catalogs.map((catalog) => {
    const entry = prompts.get(caseDefinition.id).get(catalog.id);
    const hash = sha256(entry.system_prompt);
    systemPrompts[hash] = entry.system_prompt;
    return [catalog.id, { system_prompt_sha256: hash, user_prompt: entry.user_prompt }];
  }))]));
  const report = Object.freeze({
    kind: "echo-ask-blocks-evaluation-v1",
    observed_at: observedAt,
    synthetic_only: true,
    complete,
    cases_sha256: sha256(readFileSync(CASES_FILE)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model: Object.freeze({ adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
    limits: Object.freeze({ cases: cases.length, catalogs: catalogs.map((catalog) => catalog.id), trials: options.trials, judge: options.judge, writer_output_tokens: WRITER_OUTPUT_TOKENS,
      timeout_ms: options.timeoutMs, concurrency: options.concurrency, max_total_model_calls: MAX_TOTAL_MODEL_CALLS }),
    catalogs: Object.freeze(Object.fromEntries(catalogs.map((catalog) => [catalog.id, { modeled_on: catalog.modeled_on, catalog_key: catalog.catalog_key, catalog: catalog.catalog, can_show: catalog.can_show, schema: catalog.schema }]))),
    summary,
    // The founder's ranks come from the page; until then the decision waits for them.
    judge_ranks: judgeRanks,
    ranks_without_founder: summarizeRanks({}, judgeRanks, catalogs.map((catalog) => catalog.id)),
    decision: decide(summary, null),
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
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, complete: report.complete, summary: brief, judge_mean_rank: report.ranks_without_founder.judge_mean_rank })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "block evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
