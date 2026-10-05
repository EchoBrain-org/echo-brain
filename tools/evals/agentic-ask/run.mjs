#!/usr/bin/env node
/**
 * Opt-in real-model evaluation for the generic Ask research loop.
 *
 * It uses only the synthetic desk in fixtures.mjs. The only network operation
 * is a structured-generation request made by the shipped OpenRouter bundle
 * after the caller explicitly supplies --run and --credential-file.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivateAuthorityCredential } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { createAgenticAskV1, createAgenticAskV2 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { createOpenRouterStructuredGenerationAdapter } from "../../../providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js";
import { CASES, createFixtureDesk, fixtureSha256, sourceForCitation } from "./fixtures.mjs";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIRECTORY, "../../..");
const MAX_CASES = CASES.length;
const MAX_TRIALS = 3;
const MAX_MODEL_CALLS_PER_CASE = 12;
const MAX_TOTAL_MODEL_CALLS = 72;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 85_000;
const PROVIDER_ROUTE_NAMES = Object.freeze({ friendli: "Friendli", baidu: "Baidu" });

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function usage(value) {
  if (value === null || typeof value !== "object") return null;
  const integer = (entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  return Object.freeze({
    input_tokens: integer(value.input_tokens),
    output_tokens: integer(value.output_tokens),
    total_tokens: integer(value.total_tokens),
  });
}

function safeError(error) {
  const detail = error !== null && typeof error === "object" && !Array.isArray(error) ? error : null;
  const diagnostic = detail?.diagnostic;
  const generationObservation = detail?.generation_observation;
  return Object.freeze({
    name: error instanceof Error ? error.name : "Error",
    failure_class: diagnostic !== null && typeof diagnostic === "object" && typeof diagnostic.failure_class === "string" ? diagnostic.failure_class : null,
    http_status: diagnostic !== null && typeof diagnostic === "object" && Number.isSafeInteger(diagnostic.http_status) ? diagnostic.http_status : null,
    finish_reason: diagnostic !== null && typeof diagnostic === "object" && typeof diagnostic.finish_reason === "string" ? diagnostic.finish_reason : null,
    usage: usage(generationObservation?.usage),
    provider_latency_ms: typeof generationObservation?.provider_latency_ms === "number" && Number.isSafeInteger(generationObservation.provider_latency_ms) && generationObservation.provider_latency_ms >= 0 ? generationObservation.provider_latency_ms : null,
  });
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function help() {
  return [
    "Usage:",
    "  npm run build:workspaces",
    "  npm run eval:agentic-ask -- --run --credential-file /absolute/private/credential-file [options]",
    "",
    "Options:",
    `  --cases id,id              Select up to ${MAX_CASES} synthetic cases (default: all).`,
    "  --trials N                 Repeat every case, 1 through 3 (default: 1).",
    "  --max-model-calls N        Per-case generation cap, 1 through 12 (default: 6).",
    "  --timeout-ms N             Per-case timeout, 15000 through 85000 (default: 60000).",
    "  --provider-route name      Optional diagnostic route: friendli or baidu.",
    "  --out-dir /private/path    Directory for a mode-0600 report (default: fresh private temp directory).",
    "  --help                     Show this text without reading a credential or making a request.",
    "",
    "The runner never calls Jira, Slack, or any other work tool. It only sends synthetic",
    "fixtures to the configured model through the production OpenRouter generation bundle.",
    "Reports retain case ids, hashes, model metadata, operation counts, and failed safe traces;",
    "they do not retain prompts, raw model replies, credentials, provider payloads, or opaque handles.",
    "Synthetic final statement and gap text is retained for reader-visible review.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { run: false, credentialFile: null, caseIds: CASES.map((entry) => entry.id), trials: 1, maxModelCalls: 6, timeoutMs: 60_000, outDir: null, providerRoute: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (flag === "--run") { options.run = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--credential-file") options.credentialFile = value;
    else if (flag === "--cases") options.caseIds = value.split(",").map((part) => part.trim()).filter(Boolean);
    else if (flag === "--trials") options.trials = Number(value);
    else if (flag === "--max-model-calls") options.maxModelCalls = Number(value);
    else if (flag === "--timeout-ms") options.timeoutMs = Number(value);
    else if (flag === "--out-dir") options.outDir = value;
    else if (flag === "--provider-route") options.providerRoute = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.run) throw new Error("this evaluator makes no network request unless --run is explicit");
  if (typeof options.credentialFile !== "string" || !isAbsolute(options.credentialFile)) throw new Error("--credential-file must be an absolute private file path");
  // stat verifies that the supplied path exists without reading its contents.
  const credentialStat = statSync(options.credentialFile);
  if (!credentialStat.isFile()) throw new Error("--credential-file must name a file");
  if ((credentialStat.mode & 0o077) !== 0) throw new Error("--credential-file must not be readable by group or other users");
  options.trials = boundedInteger(options.trials, "--trials", 1, MAX_TRIALS);
  options.maxModelCalls = boundedInteger(options.maxModelCalls, "--max-model-calls", 1, MAX_MODEL_CALLS_PER_CASE);
  options.timeoutMs = boundedInteger(options.timeoutMs, "--timeout-ms", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const allowed = new Set(CASES.map((entry) => entry.id));
  if (options.caseIds.length === 0 || options.caseIds.length > MAX_CASES || options.caseIds.some((id) => !allowed.has(id))) {
    throw new Error(`--cases must select one to ${MAX_CASES} known cases`);
  }
  if (options.caseIds.length * options.trials * options.maxModelCalls > MAX_TOTAL_MODEL_CALLS) {
    throw new Error(`requested model-call budget exceeds ${MAX_TOTAL_MODEL_CALLS}; reduce cases, trials, or --max-model-calls`);
  }
  if (options.outDir !== null && !isAbsolute(options.outDir)) throw new Error("--out-dir must be an absolute private directory path");
  if (options.providerRoute !== null && !Object.hasOwn(PROVIDER_ROUTE_NAMES, options.providerRoute)) throw new Error("--provider-route must be friendli or baidu");
  return Object.freeze(options);
}

function safeObservedProvider(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9 _.-]{0,79}$/u.test(value) ? value : null;
}

/**
 * The normal path uses the unmodified production bundle. Route diagnosis uses
 * this local adapter only because that bundle intentionally does not expose a
 * fetch hook. It keeps the same private-file resolver and never logs headers,
 * authorization, request bodies, or response bodies.
 */
function routeDiagnosticAdapter(credentialFile, requestedRoute, observedProviders) {
  const credentialReference = `file:${credentialFile}`;
  const credential = readPrivateAuthorityCredential(credentialReference);
  return createOpenRouterStructuredGenerationAdapter({
    credential_ref: credentialReference,
    credential_resolver: (reference) => reference === credentialReference ? credential : undefined,
    fetch_impl: async (url, init) => {
      const request = JSON.parse(String(init?.body));
      request.provider = { ...request.provider, only: [requestedRoute], allow_fallbacks: false };
      const response = await fetch(url, { ...init, body: JSON.stringify(request) });
      try {
        const payload = await response.clone().json();
        const provider = safeObservedProvider(payload?.provider);
        if (provider !== null) observedProviders.add(provider);
      } catch {
        // Provider metadata is diagnostic only. Do not retain malformed payloads.
      }
      return response;
    },
  });
}

function codeIdentity() {
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const files = [
    "tools/evals/agentic-ask/run.mjs",
    "tools/evals/agentic-ask/fixtures.mjs",
    "packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1.js",
    "packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js",
    "packages/organization-authority-kernel/dist/answer-composition/agentic-ask-research-state-v1.js",
    "packages/organization-authority-kernel/dist/adapters/security/private-file-credentials.js",
    "providers/openrouter/dist/openrouter-answer-composition-generation-bundle-v1.js",
    "providers/openrouter/dist/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js",
  ];
  const trackedPatch = sha256(execFileSync("git", ["diff", "--binary"], { cwd: ROOT }));
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).sort();
  const untrackedFiles = Object.freeze(Object.fromEntries(untracked.map((file) => [file, sha256(readFileSync(join(ROOT, file)))])));
  return Object.freeze({
    source_sha: git(["rev-parse", "HEAD"]),
    patch_sha256: sha256(JSON.stringify({ tracked_patch_sha256: trackedPatch, untracked_files_sha256: untrackedFiles })),
    tracked_patch_sha256: trackedPatch,
    untracked_files_sha256: untrackedFiles,
    files_sha256: Object.freeze(Object.fromEntries(files.map((file) => {
      return [file, sha256(readFileSync(join(ROOT, file)))];
    }))),
  });
}

/** Synthetic final-answer summary for human review. Planner and provider replies stay omitted. */
function renderedAnswer(answer) {
  return Object.freeze({
    parts: Object.freeze((answer?.parts ?? []).map((part) => Object.freeze({
      status: typeof part.status === "string" ? part.status : null,
      statements: Object.freeze((part.statements ?? []).map((statement) => String(statement.text))),
      gap: typeof part.gap === "string" ? part.gap : null,
    }))),
  });
}

function containsAny(text, alternatives) {
  return alternatives.some((term) => text.includes(term));
}

/** Remove only response-layout prefixes owned by the controller, never factual gap text. */
function substantiveGapText(value) {
  return value
    .replace(/^i couldn't complete the search\.\s*(?:please try again\.\s*)?missing context:\s*/iu, "")
    .replace(/^missing context:\s*/iu, "")
    .replace(/^not found:\s*/iu, "")
    .trim();
}

/**
 * A content-free view of a successful research reply. This is deliberately
 * derived at the adapter boundary so diagnosis can separate a planner that
 * keeps searching from a planner that selects finish. It never retains a
 * query, item id, need text, note, prompt, or response body.
 */
export function researchStepDiagnostic(value) {
  const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const parts = Array.isArray(object?.parts) ? object.parts : [];
  const actions = Array.isArray(object?.actions) ? object.actions : [];
  const needStatuses = { open: 0, found: 0, not_found: 0, other: 0 };
  for (const part of parts) {
    const needs = part !== null && typeof part === "object" && Array.isArray(part.needs) ? part.needs : [];
    for (const need of needs) {
      const status = need !== null && typeof need === "object" && typeof need.status === "string" ? need.status.trim().toLocaleLowerCase() : "other";
      if (status === "open" || status === "found" || status === "not_found") needStatuses[status] += 1;
      else needStatuses.other += 1;
    }
  }
  const actionNames = actions.map((action) => {
    const candidate = action !== null && typeof action === "object" && typeof action.tool === "string" ? action.tool.trim().toLocaleLowerCase() : "unknown";
    return ["search", "open", "list", "finish"].includes(candidate) ? candidate : "unknown";
  });
  const hasReads = actionNames.some((name) => name === "search" || name === "open" || name === "list");
  return Object.freeze({
    part_count: parts.length,
    need_status_counts: Object.freeze(needStatuses),
    action_names: Object.freeze(actionNames),
    finish_only: actionNames.length === 1 && actionNames[0] === "finish",
    has_read_action: hasReads,
  });
}

export function grade(caseDefinition, answer, operations, error) {
  const responseSources = new Set(answer?.citations?.map((entry) => sourceForCitation(entry.citation)) ?? []);
  const opened = operations.filter((entry) => entry.tool === "open");
  const discovered = operations.filter((entry) => entry.tool === "search" || entry.tool === "list");
  const checks = [];
  const check = (name, passed, detail) => checks.push(Object.freeze({ name, passed: Boolean(passed), detail }));
  check("request_completed", error === null, error === null ? "Ask returned a response" : "Ask failed before a response");
  for (const source of caseDefinition.expected.sources) {
    check(`citation_covers_${source}`, responseSources.has(source), `expected a cited ${source} source`);
  }
  if (caseDefinition.expected.discovery) check("discovery_before_evidence", discovered.length > 0, "expected at least one search or list operation");
  if (caseDefinition.expected.open) check("opened_discovered_item", opened.some((entry) => entry.known_before_open === true), "expected an open of a previously discovered item");
  check("no_open_before_discovery", opened.every((entry) => entry.known_before_open === true), "the desk must never open an undiscovered handle");
  if (caseDefinition.expected.complete) {
    check("complete_outcome", answer?.outcome === "answered", "expected a complete cited answer");
  } else if (caseDefinition.expected.empty) {
    check("empty_source_was_read", discovered.length > 0, "expected at least one successful empty search or list operation");
    check("honest_empty_outcome", answer?.outcome === "not_found" && (answer?.citations?.length ?? 0) === 0, "expected no evidence-backed claim for an empty source");
  } else {
    check("honest_incomplete_outcome", answer?.outcome !== "answered", "missing ticket context must not be presented as complete");
  }
  if (caseDefinition.expected.later_page) check("later_page_seen", operations.some((entry) => entry.tool === "list" && entry.page === 2), "expected a second list page before answering");
  const reader = caseDefinition.expected.reader_visible;
  if (reader !== undefined) {
    const visible = renderedAnswer(answer);
    const statements = visible.parts.flatMap((part) => part.statements).join(" ").toLocaleLowerCase();
    const gaps = visible.parts.map((part) => part.gap === null ? "" : substantiveGapText(part.gap)).filter(Boolean).join(" ").toLocaleLowerCase();
    for (const alternatives of reader.required_any ?? []) {
      check(`reader_visible_fact_${alternatives.join("_")}`, containsAny(statements, alternatives), "expected the synthetic answer to state the requested decision");
    }
    if (reader.no_gap === true) check("reader_visible_no_gap", visible.parts.every((part) => part.gap === null), "the approved record fully answers this question");
    for (const term of reader.required_gap_terms ?? []) check(`reader_visible_gap_${term}`, gaps.includes(term), `expected the missing ${term} to be named`);
    for (const alternatives of reader.required_gap_any ?? []) check(`reader_visible_gap_${alternatives.join("_")}`, containsAny(gaps, alternatives), "expected the missing fact to be named");
    for (const term of reader.forbidden_gap_terms ?? []) check(`reader_visible_no_gap_${term}`, !gaps.includes(term), `the answer must not add unrequested missing ${term}`);
    if (reader.outcome !== undefined) check("reader_visible_outcome", answer?.outcome === reader.outcome, `expected ${reader.outcome} when only some requested facts are supported`);
  }
  return Object.freeze({ passed: checks.every((entry) => entry.passed), checks: Object.freeze(checks) });
}

function safeTrace(caseDefinition, operations, modelCalls, modelAttempts, answer, error) {
  return Object.freeze({
    case_id: caseDefinition.id,
    operation_trace: Object.freeze(operations.map((entry) => Object.freeze({
      tool: entry.tool,
      source: entry.source,
      result_count: entry.result_count,
      ...(entry.discovered_count === undefined ? {} : { discovered_count: entry.discovered_count }),
      ...(entry.known_before_open === undefined ? {} : { known_before_open: entry.known_before_open }),
      ...(entry.page === undefined ? {} : { page: entry.page }),
      ...(entry.more === undefined ? {} : { more: entry.more }),
    }))),
    model_calls: Object.freeze(modelCalls),
    admitted_model_attempts: modelAttempts,
    outcome: answer?.outcome ?? null,
    rendered_answer: renderedAnswer(answer),
    citation_sources: Object.freeze((answer?.citations ?? []).map((entry) => sourceForCitation(entry.citation))),
    error,
  });
}

export async function runTrial(caseDefinition, trial, structuredOutput, generation, options) {
  const { desk, trace } = createFixtureDesk(caseDefinition);
  const modelCalls = [];
  let attemptIndex = 0;
  let admittedModelAttempts = 0;
  const model = Object.freeze({
    async generate(input) {
      return (await this.generate_with_observation(input)).value;
    },
    async generate_with_observation(input) {
      attemptIndex += 1;
      const role = input.system_prompt.startsWith("You write") ? "answer" : "research";
      if (attemptIndex > options.maxModelCalls) {
        const error = new Error("evaluation model-call budget exhausted");
        error.name = "EvaluationModelCallBudgetError";
        modelCalls.push(Object.freeze({ attempt: attemptIndex, role, result: "rejected", error: safeError(error) }));
        throw error;
      }
      admittedModelAttempts += 1;
      try {
        const observed = await structuredOutput.generate_with_observation(input);
        // Deliberately record only provider metadata. `observed.value` is never copied.
        modelCalls.push(Object.freeze({
          attempt: attemptIndex,
          role,
          result: "succeeded",
          finish_reason: observed.finish_reason,
          usage: usage(observed.usage),
          provider_latency_ms: typeof observed.provider_latency_ms === "number" ? observed.provider_latency_ms : null,
          ...(role === "research" ? { research_step: researchStepDiagnostic(observed.value) } : {}),
        }));
        return observed;
      } catch (error) {
        modelCalls.push(Object.freeze({ attempt: attemptIndex, role, result: "rejected", error: safeError(error) }));
        throw error;
      }
    },
  });
  const audits = [];
  const create = caseDefinition.mode === "v1" ? createAgenticAskV1 : createAgenticAskV2;
  const ask = create({
    desk,
    model,
    generation,
    asker: { display_name: "Synthetic evaluator" },
    audit: { append: (entry) => { audits.push(Object.freeze({
      outcome: entry.outcome,
      rounds: entry.rounds,
      model_calls: entry.model_calls,
      citation_count: entry.citation_count,
      repairs: entry.repairs,
      fallbacks: entry.fallbacks,
      generation_usage: usage(entry.generation_usage),
      finish_reason_counts: entry.finish_reason_counts,
    })); } },
  });
  let answer = null;
  let error = null;
  const started = performance.now();
  try {
    answer = await ask.answer({ question: caseDefinition.question, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (caught) {
    error = safeError(caught);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const gradeResult = grade(caseDefinition, answer, trace, error);
  return Object.freeze({
    case_id: caseDefinition.id,
    trial,
    passed: gradeResult.passed,
    elapsed_ms: elapsedMs,
    outcome: answer?.outcome ?? null,
    citation_count: answer?.citations?.length ?? 0,
    admitted_model_attempts: admittedModelAttempts,
    citation_sources: Object.freeze((answer?.citations ?? []).map((entry) => sourceForCitation(entry.citation))),
    rendered_answer: renderedAnswer(answer),
    research_steps: Object.freeze(modelCalls.filter((entry) => entry.role === "research" && entry.result === "succeeded").map((entry) => entry.research_step)),
    audit: audits[0] ?? null,
    checks: gradeResult.checks,
    ...(gradeResult.passed ? {} : { failure_trace: safeTrace(caseDefinition, trace, modelCalls, admittedModelAttempts, answer, error) }),
  });
}

function outputDirectory(value) {
  const directory = value === null
    ? mkdtempSync(join(tmpdir(), "echo-agentic-ask-eval-"), { encoding: "utf8" })
    : value;
  if (value !== null) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error("--out-dir must not be readable by group or other users");
  return directory;
}

export async function run(options) {
  const selected = options.caseIds.map((id) => CASES.find((entry) => entry.id === id));
  const identityBefore = codeIdentity();
  const loaded = createOpenRouterAnswerCompositionGenerationBundleV1({ credential_file: options.credentialFile }).load();
  const observedProviders = new Set();
  const structuredOutput = options.providerRoute === null
    ? loaded.structured_output
    : routeDiagnosticAdapter(options.credentialFile, options.providerRoute, observedProviders);
  const outputDir = outputDirectory(options.outDir);
  const results = [];
  for (const caseDefinition of selected) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      const result = await runTrial(caseDefinition, trial, structuredOutput, loaded.generation, options);
      results.push(result);
      process.stderr.write(`${JSON.stringify({ kind: "echo-agentic-ask-evaluation-progress-v1", case_id: result.case_id, trial: result.trial, passed: result.passed, outcome: result.outcome, elapsed_ms: result.elapsed_ms, admitted_model_attempts: result.admitted_model_attempts })}\n`);
    }
  }
  const failed = results.filter((entry) => !entry.passed);
  const identityAfter = codeIdentity();
  const report = Object.freeze({
    kind: "echo-agentic-ask-synthetic-evaluation-v1",
    observed_at: new Date().toISOString(),
    synthetic_only: true,
    provider_tool_reads: 0,
    provider_tool_writes: 0,
    fixture_sha256: fixtureSha256(),
    code: Object.freeze({
      before: identityBefore,
      after: identityAfter,
      unchanged: sha256(JSON.stringify(identityBefore)) === sha256(JSON.stringify(identityAfter)),
    }),
    model: Object.freeze({
      adapter_id: loaded.generation.generation_adapter_id,
      planner_model: loaded.generation.planner_model,
      answer_model: loaded.generation.answer_model,
      adapter_mode: options.providerRoute === null ? "production_bundle" : "local_route_diagnostic",
      provider_route_requested: options.providerRoute,
      provider_routes_observed: Object.freeze([...observedProviders].sort()),
    }),
    limits: Object.freeze({ cases: selected.length, trials: options.trials, max_model_calls_per_case: options.maxModelCalls, max_total_model_calls: MAX_TOTAL_MODEL_CALLS, timeout_ms: options.timeoutMs }),
    results: Object.freeze(results),
    summary: Object.freeze({ passed: results.length - failed.length, failed: failed.length, total: results.length }),
  });
  const reportPath = join(outputDir, "agentic-ask-evaluation.json");
  writeFileSync(reportPath, json(report), { mode: 0o600, flag: "wx" });
  return Object.freeze({ reportPath, report });
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const result = await run(options);
      process.stdout.write(`${JSON.stringify({ report_path: result.reportPath, ...result.report.summary })}\n`);
      if (result.report.summary.failed > 0) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "agentic Ask evaluation failed"}\n${help()}\n`);
    process.exitCode = 2;
  }
}

export { parseArgs };
