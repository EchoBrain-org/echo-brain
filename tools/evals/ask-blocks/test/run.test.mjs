import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANSWER_LAYOUT_PROMPT } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { parseArgs, researchStep, run } from "../run.mjs";
import { loadCases } from "../grade.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072 };
const document = loadCases();
const OWNS = "Priya Raman owns it.";
/** The reply to each call, by the field its schema asks for (schemaOf): the judge's ranks, or the catalog's answer that Priya Raman owns it. */
const REPLY = Object.freeze({
  ranks: { ranks: ["A", "B", "C", "D"].map((answer, at) => ({ answer, rank: at + 1, reason: "fixture" })) },
  sentences: { lists: [], tables: [], sentences: [{ text: OWNS, evidence: ["E1"], form: "lead" }], not_found: [] },
  template: { template: { name: "fact", answer: [{ text: OWNS, evidence: ["E1"] }] }, not_found: [] },
  blocks: { blocks: [{ block: "answer", sentences: [{ text: OWNS, evidence: ["E1"] }] }], not_found: [] },
  root: { root: "main", components: [{ id: "main", component: "Column", children: ["a"] }, { id: "a", component: "Text", variant: "body", text: OWNS, evidence: ["E1"] }], not_found: [] },
});
/** A balanced reply that opens with prose, which the catalog refuses. */
const PROSE_FIRST = Object.freeze({ blocks: [{ block: "text", sentences: [{ text: OWNS, evidence: ["E1"] }] }], not_found: [] });
/** The field a call's schema asks for: the judge's ranks, today's sentences, a template, balanced's blocks, or else the primitives' root. */
const schemaOf = (input) => ["ranks", "sentences", "template", "blocks"].find((field) => Object.hasOwn(input.schema.properties ?? {}, field)) ?? "root";
/** A run over soak-owner, one trial of every catalog with the judge on, with `fields` changed. */
const options = (out, fields = {}) => ({ run: true, credentialFile: null, out, caseIds: ["soak-owner"], catalogIds: null, trials: 1, judge: true, concurrency: 1, timeoutMs: 20_000, ...fields });
/** A route that answers each call with its schema's reply (REPLY), keeping every input. */
const answering = (inputs = []) => ({ inputs, async generate_with_observation(input) {
  inputs.push(input);
  return { value: REPLY[schemaOf(input)], finish_reason: "stop", usage: null, provider_latency_ms: 1 };
} });

/** Every repository module Node loads for the module `entry`, as a hook on its loader sees them, relative to the repository. */
function loadedModules(entry) {
  const script = [
    'import { registerHooks } from "node:module";',
    "const loaded = [];",
    "registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
    `await import(${JSON.stringify(pathToFileURL(join(ROOT, entry)).href)});`,
    "process.stdout.write(JSON.stringify(loaded));",
  ].join("\n");
  const root = realpathSync(ROOT);
  const files = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
    .filter((url) => url.startsWith("file:")).map((url) => realpathSync(fileURLToPath(url)));
  return [...new Set(files)].filter((file) => file.startsWith(`${root}${sep}`) && !file.includes(`${sep}node_modules${sep}`)).map((file) => relative(root, file).split(sep).join("/")).sort();
}

test("makes no request without an explicit run and a private credential file, and keeps its budget", () => {
  assert.throws(() => parseArgs(["--out", "/tmp/x"]), /no network request unless --run/u);
  const directory = mkdtempSync(join(tmpdir(), "ask-blocks-args-"));
  const credential = join(directory, "credential");
  writeFileSync(credential, "not read", { mode: 0o600 });
  const base = ["--run", "--credential-file", credential, "--out", join(directory, "out")];
  assert.throws(() => parseArgs([...base, "--catalogs", "today,today"]), /--catalogs must select known catalogs, each once/u);
  assert.throws(() => parseArgs([...base, "--cases", "no-such-case"]), /--cases must select known cases/u);
  assert.throws(() => parseArgs([...base, "--judge", "maybe"]), /--judge must be on or off/u);
  const parsed = parseArgs([...base, "--cases", "soak-owner", "--trials", "1"]);
  assert.deepEqual([parsed.trials, parsed.judge, parsed.concurrency], [1, true, 4]);
});

test("scripts research as one search, every item opened, then finish", () => {
  const steps = document.cases.find((entry) => entry.id === "ship-steps");
  assert.deepEqual(researchStep(steps, 1).actions, [{ tool: "search", args: { query: steps.research.query } }]);
  assert.equal(researchStep(steps, 2).actions.length, steps.items.length);
  assert.deepEqual(researchStep(steps, 3).actions, [{ tool: "finish", args: {} }]);
});

test("runs every catalog with one repair or retry, judges both orders, and keeps full traces", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-run-"));
  const inputs = [];
  const structured = { async generate_with_observation(input) {
    inputs.push(input);
    const schema = schemaOf(input);
    const seen = inputs.filter((entry) => schemaOf(entry) === schema).length;
    // Balanced's first reply opens with prose, so the repair answers; primitives' first call fails, so the retry does.
    if (schema === "root" && seen === 1) throw new Error("fixture outage");
    return { value: schema === "blocks" && seen === 1 ? PROSE_FIRST : REPLY[schema], finish_reason: "stop", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 }, provider_latency_ms: 2 };
  } };
  const { reportPath, report } = await run(options(out), { loaded: { structured_output: structured, generation }, progress: () => undefined });

  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(report.complete, false);
  assert.deepEqual(Object.fromEntries(report.trials.map((trial) => [trial.catalog, trial.attempts.map((attempt) => attempt.kind)])),
    { today: ["first"], templates: ["first"], balanced: ["first", "repair"], primitives: ["first", "retry"] });
  assert.ok(report.trials.every((trial) => trial.grade.valid && trial.grade.grounded && trial.grade.fit));
  const repair = report.trials.find((trial) => trial.catalog === "balanced").attempts[1];
  assert.match(JSON.parse(repair.user_prompt).validation_error, /blocks\[0\] must be the answer block/u);
  assert.equal(report.summary.balanced.repairs, 1);
  // The judge saw both orders; its rank is their mean, so A-to-D then D-to-A gives every catalog 2.5.
  assert.equal(report.judge["soak-owner"].length, 2);
  assert.deepEqual(Object.values(report.judge_ranks["soak-owner"]), [2.5, 2.5, 2.5, 2.5]);
  // Every writer call kept the catalog's own schema and output tokens; the prompts are in the report.
  assert.ok(inputs.filter((input) => !Object.hasOwn(input.schema.properties, "ranks")).every((input) => input.max_output_tokens === 3_000));
  const prompts = report.prompts["soak-owner"];
  assert.ok(JSON.parse(prompts.balanced.user_prompt).block_catalog.length === 7);
  assert.ok(report.system_prompts[prompts.today.system_prompt_sha256].endsWith(`\n\n${ANSWER_LAYOUT_PROMPT}`));
  assert.ok(!report.system_prompts[prompts.balanced.system_prompt_sha256].includes(ANSWER_LAYOUT_PROMPT));
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).kind, "echo-ask-blocks-evaluation-v1");
});

test("writes through the personal Claude account port, admitting each request and adding up its usage", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-account-"));
  const admittedRequests = [];
  const port = {
    async generate() { throw new Error("Native structured generation requires per-request admission"); },
    async generate_with_admission(input, admit) {
      // A native session may make more than one model request for one answer.
      for (const operation of ["count_tokens", "messages"]) {
        await admit({ model: input.model, operation, signal: AbortSignal.timeout(5_000) }, async () => { admittedRequests.push(operation); return { value: null, usage: { input_tokens: 10, output_tokens: operation === "messages" ? 7 : 0 } }; });
      }
      return REPLY.sentences;
    },
  };
  const accountGeneration = { ...generation, generation_adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" };
  const { report } = await run(options(out, { catalogIds: ["today"], judge: false, writer: "claude-account" }), { loaded: { personal_research: { structured_output: port, generation: accountGeneration } }, progress: () => undefined });
  assert.deepEqual(report.model, { route: "claude-account", adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" });
  assert.deepEqual(admittedRequests, ["count_tokens", "messages"]);
  assert.deepEqual(report.trials[0].attempts[0].usage, { input_tokens: 20, output_tokens: 7, total_tokens: 27 });
  assert.equal(report.trials[0].grade.valid, true);
});

test("resumes an earlier report: carries every call that got a reply and makes only the calls it lacks", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-resume-"));
  // In the outage the judge, balanced's repair and every primitives call fail, and balanced's first reply opens with prose.
  const fake = (outage, inputs) => ({ async generate_with_observation(input) {
    inputs.push(input);
    const schema = schemaOf(input);
    if (outage && (schema === "ranks" || schema === "root" || (schema === "blocks" && JSON.parse(input.user_prompt).validation_error !== undefined))) throw new Error("402");
    return { value: outage && schema === "blocks" ? PROSE_FIRST : REPLY[schema], finish_reason: "stop", usage: null, provider_latency_ms: 1 };
  } });
  const first = await run(options(out), { loaded: { structured_output: fake(true, []), generation }, progress: () => undefined });
  // Balanced's repair and both primitives calls failed, so neither trial ends with a reply.
  assert.deepEqual(first.report.errors, { writer_calls: 3, trials_without_reply: 2, judge_orders_without_ranks: 2 });

  const inputs = [];
  const { report } = await run(options(out, { resume: first.reportPath }), { loaded: { structured_output: fake(false, inputs), generation }, progress: () => undefined });
  // Only the balanced repair, the primitives call and the two judge orders were made again.
  assert.equal(inputs.length, 4);
  assert.deepEqual(Object.fromEntries(report.trials.map((trial) => [trial.catalog, trial.attempts.map((attempt) => `${attempt.kind}${attempt.carried ? " (carried)" : ""}`)])),
    { today: ["first (carried)"], templates: ["first (carried)"], balanced: ["first (carried)", "repair"], primitives: ["first"] });
  assert.ok(report.trials.every((trial) => trial.grade.valid));
  assert.deepEqual([report.resumed_from.carried_calls, report.resumed_from.carried_judge_orders], [3, 0]);
  assert.deepEqual(report.errors, { writer_calls: 0, trials_without_reply: 0, judge_orders_without_ranks: 0 });
});

test("fingerprints its cases, its pre-registration and every module the run loads", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-code-"));
  const { report } = await run(options(out, { catalogIds: ["today"], judge: false }), { loaded: { structured_output: answering(), generation }, progress: () => undefined });
  const fingerprinted = Object.keys(report.code.before.files_sha256);
  assert.deepEqual(fingerprinted, ["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/README.md", ...loadedModules("tools/evals/ask-blocks/run.mjs")]);
  // Among them layout v2's checks and title bound, and the kernel's shared modules on the writer's path.
  for (const file of ["packages/organization-api/dist/person-answer-layout-checks.js", "packages/organization-api/dist/person-answer-layout-v1.js",
    "packages/organization-authority-kernel/dist/shared/core-runtime-observation-v1.js", "packages/organization-authority-kernel/dist/shared/evidence-desk-v2.js"]) assert.ok(fingerprinted.includes(file), file);
  assert.equal(report.code.unchanged, true);
});
