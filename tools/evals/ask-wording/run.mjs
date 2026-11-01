#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of how Ask's writer words a laid-out answer (README.md, pre-registered).
 *
 * Each case in cases.json is a question and the synthetic items that answer it. Ask runs as the kernel runs it for a
 * client that asks for answer layout v1 (ADR-0045), over a synthetic desk. Research is scripted, since this eval measures
 * only the writer: one search returns the case's items, research opens them and finishes citing them all. The writer is
 * the product's: its prompt and schema, through the shipped OpenRouter bundle and its answer model (ADR-0037), three
 * times per case, and grade.mjs grades every trial deterministically. The only network operation is the writer's
 * structured-generation request, after the caller explicitly supplies --run and --credential-file. The bundle reads the
 * credential file; this runner only checks that it is a private file.
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
import { assertExplicitRun, boundedInteger, codeIdentity, json, outputDirectory, readFlags, safeError, sha256, usage } from "../shared/runner.mjs";
import { CASES_FILE, GROUPS, gradeTrial, loadCases, summarizeRules } from "./grade.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
const MAX_TRIALS = 3;
const ALL_CASES = Object.values(GROUPS).reduce((total, count) => total + count, 0);
/** The writer's call and its one repair per trial; research is scripted and calls no model. */
const MAX_TOTAL_MODEL_CALLS = ALL_CASES * MAX_TRIALS * 2;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 85_000;
/** When every trial is asked: the cases' today, mid-morning in their time zone. */
const ASKED_AT = "2026-10-26T17:00:00.000Z";
const RESEARCH_PROMPT = "You are Echo's research agent";
const WRITER_PROMPT = "You write Echo's final answer";
/** A connected Jira as the desk advertises it, so the writer is told what it is told for a person with Jira connected. */
const TICKETS_SOURCE = Object.freeze({
  source_id: "jira", kind: "ticket", selector: "tickets", description: "Jira issues the asker can read through their own connection.", metadata_only_list: true, tool_id: "jira",
});

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
    "  --help            Show this text without reading a credential or making a request.",
    "",
    "Each trial asks one synthetic question with answer layout v1. Research is scripted over the case's synthetic items;",
    "the writer runs through the production OpenRouter generation bundle; nothing is read from any tool. --out must be",
    "outside the repository and private; the report is written there with mode 0600. It keeps case ids, each trial's",
    "statements, lead and grade (synthetic text), the writer prompt's digest and model metadata; never prompts, raw",
    "replies, credentials or provider payloads.",
    "",
    "Exit 0 when a complete run passes all three rules (the wording ships); 1 when any rule fails or the run is smaller,",
    "which never ships; 2 on a usage error.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { run: false, credentialFile: null, out: null, caseIds: null, trials: MAX_TRIALS, timeoutMs: 60_000 };
  if (readFlags(argv, options, {
    "--credential-file": (value) => { options.credentialFile = value; },
    "--out": (value) => { options.out = value; },
    "--cases": (value) => { options.caseIds = value.split(",").map((part) => part.trim()).filter(Boolean); },
    "--trials": (value) => { options.trials = Number(value); },
    "--timeout-ms": (value) => { options.timeoutMs = Number(value); },
  })) return { help: true };
  assertExplicitRun(options);
  options.trials = boundedInteger(options.trials, "--trials", 1, MAX_TRIALS);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const known = new Set(loadCases().cases.map((entry) => entry.id));
  if (options.caseIds !== null && (options.caseIds.length === 0 || new Set(options.caseIds).size < options.caseIds.length || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases, each once");
  if ((options.caseIds?.length ?? known.size) * options.trials * 2 > MAX_TOTAL_MODEL_CALLS) throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

const COMPOSITION = "packages/organization-authority-kernel/dist/answer-composition";
/** The files a report fingerprints, beside the commit and its uncommitted changes. */
const CODE_FILES = Object.freeze([
  "tools/evals/ask-wording/run.mjs",
  "tools/evals/ask-wording/grade.mjs",
  "tools/evals/ask-wording/cases.json",
  "tools/evals/shared/runner.mjs",
  `${COMPOSITION}/agentic-ask-v1-model-protocol.js`,
  `${COMPOSITION}/agentic-ask-v1.js`,
  `${COMPOSITION}/renderers/ask-renderer-v1.js`,
  `${COMPOSITION}/renderers/ask-layout-v1.js`,
  "providers/openrouter/dist/openrouter-answer-composition-generation-bundle-v1.js",
  "providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fields = (item, names) => Object.fromEntries(names.filter((name) => Object.hasOwn(item, name)).map((name) => [name, item[name]]));

/**
 * One case item as the desk releases it: a follow-up through the product's own projection, an approved decision record,
 * or a Jira issue the asker reads through their own connection. Every value is synthetic.
 */
export function deskItem(caseId, index, item) {
  const key = `${caseId}:${index}`;
  const id = `wording-${digest(key).slice(0, 24)}`;
  const receipt_sha256 = canonicalSha256({ fixture: "ask-wording-release", key });
  if (item.kind === "follow_up") {
    const evidence = validatePersonFollowUpEvidenceV1({
      item_id: `itm_${digest(key).slice(0, 24)}`, kind: item.on, title: item.title, owner: item.owner, status: item.status,
      ...fields(item, ["created_at", "sent_at", "reassigned_at", "due_at", "check", "expected"]),
      ...(item.decision === undefined ? {} : { decision: { ...item.decision, ref: `meeting:${canonicalSha256({ fixture: "ask-wording-decision", key })}` } }),
    });
    return Object.freeze({ id, ...followUpDeskFieldsV1(evidence), visibility: "team", receipt_sha256 });
  }
  if (item.kind === "decision") {
    return Object.freeze({
      id, kind: "decision", label: item.label, text: item.text, visibility: "team", occurred_at: item.occurred_at, receipt_sha256,
      citation: Object.freeze({ kind: "approved_record", atom_id: canonicalSha256({ fixture: "ask-wording-atom", key }), record_sha256: canonicalSha256({ fixture: "ask-wording-record", key }), policy_id: "project-members-readable-person-v1" }),
    });
  }
  return Object.freeze({
    id, kind: "ticket", label: `${item.key}: ${item.title}`, text: item.text, visibility: "only_me", attributes: Object.freeze({ status: item.status, owner: item.owner }),
    occurred_at: "2026-10-19", date_kind: "created", receipt_sha256,
    citation: Object.freeze({ kind: "ticket", tool_id: "jira", external_scope_id: "synthetic-cloud", ticket_id: item.key.replace(/\D/gu, ""), permalink: `https://synthetic.example.test/browse/${item.key}`, text_sha256: sha256Digest(item.text) }),
  });
}

/** A desk over one case's items, in a global Ask with Jira and follow-ups bound: any search finds them all, in order. */
function caseDesk(caseDefinition) {
  const items = caseDefinition.items.map((item, index) => deskItem(caseDefinition.id, index, item));
  const result = (values) => Object.freeze({ items: Object.freeze(values), truncated: false, receipt_digests: Object.freeze(values.map((value) => value.receipt_sha256)) });
  return Object.freeze({
    scope: Object.freeze({ kind: "global" }),
    live_sources: Object.freeze([TICKETS_SOURCE, FOLLOW_UPS_SOURCE_DESCRIPTOR_V1]),
    async search() { return result(items); },
    async open(input) { return result(items.filter((item) => item.id === input.item)); },
    async list() { return result([]); },
    async revalidate() { return Object.freeze({ checked_at: ASKED_AT }); },
  });
}

/**
 * The scripted research step for `round` (from 1): search, then open every item found (E1 to En, in the desk's order),
 * then finish with the one need found on all of them. A later round finishes again.
 */
export function researchStep(caseDefinition, round) {
  const count = caseDefinition.items.length;
  const ids = Array.from({ length: count }, (_, index) => `E${index + 1}`);
  const need = (status) => ({ ...(round === 1 ? {} : { id: "N1" }), need: caseDefinition.research.need, kind: "content", status, evidence: status === "found" ? ids : [] });
  const part = (status, notes) => [{ question: caseDefinition.question, needs: [need(status)], notes }];
  if (round === 1) return { parts: part("open", ""), actions: [{ tool: "search", args: { query: caseDefinition.research.query } }] };
  if (round === 2) return { parts: part("open", `${ids.join(", ")} match.`), actions: ids.map((id) => ({ tool: "open", args: { id } })) };
  return { parts: part("found", `${ids.join(", ")} read in full.`), actions: [{ tool: "finish", args: {} }] };
}

/**
 * One trial: Ask on one case with answer layout v1, research scripted and the writer through `structuredOutput` (the
 * production adapter, or a test's), with only model metadata and the writer prompt's digest recorded. A trial that throws
 * is kept as its safe error and passes nothing.
 */
export async function runTrial(caseDefinition, trial, structuredOutput, generation, document, options) {
  const calls = [];
  const writerPrompts = new Set();
  let round = 0;
  const model = Object.freeze({
    async generate(input) { return (await this.generate_with_observation(input)).value; },
    async generate_with_observation(input) {
      if (input.system_prompt.startsWith(RESEARCH_PROMPT)) {
        round += 1;
        return { value: researchStep(caseDefinition, round), finish_reason: "stop", usage: null, provider_latency_ms: null };
      }
      if (!input.system_prompt.startsWith(WRITER_PROMPT)) throw new Error("the eval runs only research and the Ask writer");
      writerPrompts.add(sha256(input.system_prompt));
      const attempt = calls.length + 1;
      try {
        const observed = typeof structuredOutput.generate_with_observation === "function"
          ? await structuredOutput.generate_with_observation(input)
          : { value: await structuredOutput.generate(input), finish_reason: null, usage: null, provider_latency_ms: null };
        // Deliberately only provider metadata: `observed.value` is never copied.
        calls.push(Object.freeze({ attempt, result: "succeeded", finish_reason: observed.finish_reason ?? null, usage: usage(observed.usage),
          provider_latency_ms: Number.isSafeInteger(observed.provider_latency_ms) ? observed.provider_latency_ms : null }));
        return observed;
      } catch (error) {
        calls.push(Object.freeze({ attempt, result: "rejected", error: safeError(error) }));
        throw error;
      }
    },
  });
  const ask = createAgenticAskV5({
    desk: caseDesk(caseDefinition), model, generation, audit: { append: () => undefined }, answer_layout: true,
    asker: { display_name: document.asker }, time_context: { now: ASKED_AT, time_zone: document.time_zone },
    today: () => document.today, wall_ms: () => Date.parse(ASKED_AT),
  });
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
    research_rounds: round, writer_calls: calls.length,
    writer_prompt_sha256: Object.freeze([...writerPrompts]),
    elapsed_ms: Math.round(performance.now() - started),
    model_calls: Object.freeze(calls),
    ...(error === null ? {} : { error }),
  });
}

/** Runs every selected case `trials` times and writes the report. `dependencies` replaces the production bundle in tests. */
export async function run(options, dependencies = {}) {
  const document = loadCases();
  const selected = options.caseIds === null ? document.cases : options.caseIds.map((id) => document.cases.find((entry) => entry.id === id));
  const identityBefore = codeIdentity(ROOT, CODE_FILES);
  const loaded = dependencies.loaded ?? createOpenRouterAnswerCompositionGenerationBundleV1({ credential_file: options.credentialFile }).load();
  const results = [];
  for (const caseDefinition of selected) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await runTrial(caseDefinition, trial, loaded.structured_output, loaded.generation, document, options);
      results.push(result);
      (dependencies.progress ?? ((line) => process.stderr.write(line)))(`${JSON.stringify({ kind: "echo-ask-wording-evaluation-progress-v1", case_id: result.case_id, trial, outcome: result.outcome, rules: result.grade.rules })}\n`);
    }
  }
  const identityAfter = codeIdentity(ROOT, CODE_FILES);
  // Only the whole pre-registered set, each case once and three trials each, decides whether the wording ships.
  const complete = new Set(selected.map((entry) => entry.id)).size === ALL_CASES && options.trials === MAX_TRIALS;
  const summary = summarizeRules(results);
  const report = Object.freeze({
    kind: "echo-ask-wording-evaluation-v1",
    observed_at: new Date().toISOString(),
    synthetic_only: true,
    complete,
    cases_sha256: sha256(readFileSync(CASES_FILE)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    writer_prompt_sha256: Object.freeze([...new Set(results.flatMap((result) => result.writer_prompt_sha256))]),
    model: Object.freeze({ adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
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
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, complete: report.complete, wording_ships: report.wording_ships, rules, measures: report.measures })}\n`);
      if (!report.wording_ships) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "wording evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
