#!/usr/bin/env node
/**
 * Opt-in real-model evaluation of Ask's follow-up resolution (ADR-0047; Ask
 * timeline v1, "Follow-up resolution eval (pre-registered)").
 *
 * Each case in cases.json is a previous turn and a new question. The kernel's
 * resolver runs on it directly, with the product's model route (the shipped
 * OpenRouter bundle and its answer model, ADR-0037), three times, and
 * grade.mjs grades every trial deterministically. The only network operation
 * is the structured-generation request that bundle makes, after the caller
 * explicitly supplies --run and --credential-file. The bundle reads the
 * credential file; this runner only checks that it is a private file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgenticFollowUpOnceV1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { assertExplicitRun, boundedInteger, codeIdentity, json, outputDirectory, readFlags, safeError, sha256, usage } from "../shared/runner.mjs";
import { CASES_FILE, GROUPS, gradeTrial, loadCases, summarizeRules } from "./grade.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
const MAX_TRIALS = 3;
const ALL_CASES = Object.values(GROUPS).reduce((total, count) => total + count, 0);
/** One call and its one repair per trial. */
const MAX_TOTAL_MODEL_CALLS = ALL_CASES * MAX_TRIALS * 2;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 85_000;

export function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  npm run eval:ask-follow-up -- --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory [options]",
    "",
    "Options:",
    `  --cases id,id     Select cases (default: all ${ALL_CASES}); only the whole set decides whether follow-ups ship.`,
    `  --trials N        Trials per case, 1 through ${MAX_TRIALS} (default: ${MAX_TRIALS}, as pre-registered).`,
    "  --timeout-ms N    Per-trial timeout, 15000 through 85000 (default: 60000).",
    "  --help            Show this text without reading a credential or making a request.",
    "",
    "Each trial runs the kernel's follow-up resolver once (one call and at most one repair) on a synthetic previous",
    "turn and question, through the production OpenRouter generation bundle; nothing is read from any tool. --out must",
    "be outside the repository and private; the report is written there with mode 0600. It keeps case ids, each trial's",
    "resolution, resolved question, source numbers and choices (synthetic text), its grade, and model metadata; never",
    "prompts, raw replies, credentials or provider payloads.",
    "",
    "Exit 0 when rules 1 and 2 pass (follow-ups may ship), 1 when either fails, 2 on a usage error.",
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
  if (options.caseIds !== null && (options.caseIds.length === 0 || options.caseIds.some((id) => !known.has(id)))) throw new Error("--cases must select known cases");
  if ((options.caseIds?.length ?? known.size) * options.trials * 2 > MAX_TOTAL_MODEL_CALLS) throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}`);
  options.out = outputDirectory(ROOT, options.out);
  return Object.freeze(options);
}

/** The files a report fingerprints, beside the commit and its uncommitted changes. */
const CODE_FILES = Object.freeze([
  "tools/evals/ask-follow-up/run.mjs",
  "tools/evals/shared/runner.mjs",
  "tools/evals/ask-follow-up/grade.mjs",
  "tools/evals/ask-follow-up/cases.json",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-follow-up-resolver-v1.js",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-model-gate-v1.js",
  "packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js",
  "providers/openrouter/dist/openrouter-answer-composition-generation-bundle-v1.js",
  "providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
]);

/**
 * One trial: the kernel's resolver on one case, through `structuredOutput` (the production adapter, or a test's), with
 * only model metadata recorded per call. A trial that throws is kept as its safe error and passes nothing.
 */
export async function runTrial(caseDefinition, trial, structuredOutput, generation, document, options) {
  const calls = [];
  const model = Object.freeze({
    async generate(input) { return (await this.generate_with_observation(input)).value; },
    async generate_with_observation(input) {
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
  const started = performance.now();
  let resolved = null;
  let error = null;
  try {
    resolved = await resolveAgenticFollowUpOnceV1({
      model, generation, previous: caseDefinition.previous, question: caseDefinition.question, today: document.today, time_zone: document.time_zone,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (caught) {
    error = safeError(caught);
  }
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
      (dependencies.progress ?? ((line) => process.stderr.write(line)))(`${JSON.stringify({ kind: "echo-ask-follow-up-evaluation-progress-v1", case_id: result.case_id, trial, resolution: result.resolution, passed: result.passed })}\n`);
    }
  }
  const identityAfter = codeIdentity(ROOT, CODE_FILES);
  const summary = summarizeRules(results);
  const report = Object.freeze({
    kind: "echo-ask-follow-up-evaluation-v1",
    observed_at: new Date().toISOString(),
    synthetic_only: true,
    // Only the whole pre-registered set, three trials each, decides whether follow-ups ship.
    complete: selected.length === ALL_CASES && options.trials === MAX_TRIALS,
    cases_sha256: sha256(readFileSync(CASES_FILE)),
    code: Object.freeze({ before: identityBefore, after: identityAfter, unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)) }),
    model: Object.freeze({ adapter_id: loaded.generation.generation_adapter_id, answer_model: loaded.generation.answer_model }),
    limits: Object.freeze({ cases: selected.length, trials: options.trials, timeout_ms: options.timeoutMs, max_total_model_calls: MAX_TOTAL_MODEL_CALLS }),
    ...summary,
    groups: Object.freeze(Object.fromEntries(Object.keys(GROUPS).map((group) => {
      const trials = results.filter((entry) => entry.group === group);
      return [group, Object.freeze({ trials: trials.length, passed: trials.filter((entry) => entry.passed).length, clarify: trials.filter((entry) => entry.clarify).length,
        fallback: trials.filter((entry) => entry.fallback === true).length, errors: trials.filter((entry) => entry.error !== undefined).length })];
    }))),
    results: Object.freeze(results),
  });
  const reportPath = join(options.out, `ask-follow-up-evaluation-${report.observed_at.replace(/[:.]/gu, "-")}.json`);
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
      const rules = Object.fromEntries(Object.entries(report.rules).map(([name, rule]) => [name, rule.passed]));
      process.stdout.write(`${JSON.stringify({ report_path: reportPath, complete: report.complete, follow_ups_ship: report.follow_ups_ship, founder_review: report.founder_review, rules })}\n`);
      if (!report.follow_ups_ship) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "follow-up evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}
