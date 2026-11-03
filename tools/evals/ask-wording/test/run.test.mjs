import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER_BLOCK_CATALOG, ANSWER_BLOCKS_PROMPT, answerBlocksSchema } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { loadCases } from "../grade.mjs";
import { decides, help, parseArgs, run, runTrial, writerLayout } from "../run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const document = loadCases();
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000 };
const founder = document.cases.find((entry) => entry.id === "follow-up-owner-quoted-title");

function privateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "echo-ask-wording-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, "credential");
  writeFileSync(credential, "not a real credential", { mode: 0o600 });
  return { root, credential };
}

/** A layout v2 reply: one answer block whose sentence cites `evidence`. */
const answerBlock = (text, evidence) => ({ lists: [], blocks: [{ block: "answer", sentences: [{ text, evidence }] }], not_found: [] });

/**
 * A writer that answers with `lead(case)` (by default every required fact, briefly) as its answer block and cites
 * everything it was shown; it never sees a credential.
 */
function writer(lead = (entry) => `It is ${entry.expect.facts.map((alternatives) => alternatives.at(-1)).join(", ")}.`) {
  const inputs = [];
  return {
    inputs,
    async generate_with_observation(input) {
      inputs.push(input);
      const shown = JSON.parse(input.user_prompt);
      const entry = document.cases.find((value) => value.question === shown.question);
      return { value: answerBlock(lead(entry), shown.evidence.map((item) => item.id)),
        finish_reason: "stop", usage: { input_tokens: 4000, output_tokens: 60, total_tokens: 4060 }, provider_latency_ms: 900 };
    },
  };
}

test("makes no request, and reads no credential, unless asked to run with a private credential file and a private report directory", (t) => {
  const { root, credential } = privateRoot(t);
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.match(help(), /--credential-file/u);
  assert.match(help(), /answer layout v2/u);
  assert.throws(() => parseArgs(["--credential-file", credential, "--out", join(root, "out")]), /unless --run is explicit/u);
  chmodSync(credential, 0o644);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]), /not be readable by group or other/u);
  chmodSync(credential, 0o600);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(ROOT, "tools", "evals", "ask-wording")]), /outside the repository/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--cases", "no-such-case"]), /known cases/u);
  // One case named ten times is not the ten registered cases.
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--cases", "owner-plain,owner-plain"]), /each once/u);
  const options = parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]);
  assert.deepEqual({ trials: options.trials, caseIds: options.caseIds, timeoutMs: options.timeoutMs, writer: options.writer }, { trials: 3, caseIds: null, timeoutMs: 60_000, writer: "openrouter" });
  assert.equal(statSync(options.out).mode & 0o777, 0o700);
  assert.equal(readFileSync(credential, "utf8"), "not a real credential");
});

test("writes through the personal Claude account only with the signed-in claude binary named", (t) => {
  const { root, credential } = privateRoot(t);
  const base = ["--run", "--credential-file", credential, "--out", join(root, "out")];
  assert.throws(() => parseArgs([...base, "--writer", "anthropic"]), /--writer must be openrouter or claude-account/u);
  assert.throws(() => parseArgs([...base, "--writer", "claude-account"]), /needs --claude-executable/u);
  assert.throws(() => parseArgs([...base, "--writer", "claude-account", "--claude-executable", "claude"]), /needs --claude-executable/u);
  assert.throws(() => parseArgs([...base, "--writer", "claude-account", "--claude-executable", join(root, "missing")]), /needs --claude-executable/u);
  const executable = join(root, "claude");
  writeFileSync(executable, "", { mode: 0o700 });
  const options = parseArgs([...base, "--writer", "claude-account", "--claude-executable", executable]);
  assert.deepEqual([options.writer, options.claudeExecutable], ["claude-account", executable]);
});

test("runs Ask with answer layout v2 over scripted research, sending only the writer to the model, and keeps no prompt", async () => {
  const structured = writer();
  const result = await runTrial(founder, 1, structured, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([result.outcome, result.research_rounds, result.writer_calls, result.writer_layout, result.grade.rules], ["answered", 3, 1, 2, { no_restating: true, long_ids_once: true, nothing_lost: true }]);
  // The writer read the v2 Ask's prompt, block catalog and schema, and both items, the follow-up first, as the asker sees them.
  const [input] = structured.inputs;
  const shown = JSON.parse(input.user_prompt);
  assert.ok(input.system_prompt.startsWith("You write Echo's final answer") && input.system_prompt.endsWith(`\n\n${ANSWER_BLOCKS_PROMPT}`));
  assert.deepEqual([shown.block_catalog, input.schema], [ANSWER_BLOCK_CATALOG, answerBlocksSchema]);
  assert.deepEqual([shown.asked_by, shown.today, shown.evidence.map((item) => item.kind)], ["Noor Haddad", "2026-10-26", ["follow_up", "decision"]]);
  // The lead is the answer block's statement.
  assert.equal(result.grade.lead, "It is Noor Haddad.");
  assert.equal(result.writer_prompt_sha256.length, 1);
  assert.ok(!JSON.stringify(result).includes("You write Echo's final answer"), "no prompt text is kept");
  // A writer that cannot be reached keeps its safe error class only; code's fallback writes no statement, so it passes nothing.
  const broken = { async generate_with_observation() { throw Object.assign(new Error("secret provider detail"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } }); } };
  const refused = await runTrial(founder, 2, broken, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([refused.grade.statements, refused.grade.rules, refused.writer_layout], [[], { no_restating: false, long_ids_once: false, nothing_lost: false }, 2]);
  assert.deepEqual(refused.model_calls[0], { attempt: 1, result: "rejected", error: { name: "Error", failure_class: "adapter_http", http_status: 401, finish_reason: null } });
  assert.ok(!JSON.stringify(refused).includes("secret provider detail"));
});

test("tells the layout a writer was given from its input: the block catalog, layout v1's tables, or none", () => {
  const input = (user, properties) => ({ user_prompt: JSON.stringify(user), schema: { type: "object", properties } });
  assert.equal(writerLayout(input({ source_catalog: [], block_catalog: [], evidence: [] }, { lists: {}, blocks: {}, not_found: {} })), 2);
  assert.equal(writerLayout(input({ source_catalog: [], evidence: [] }, { lists: {}, tables: {}, sentences: {}, not_found: {} })), 1);
  assert.equal(writerLayout(input({ source_catalog: [], evidence: [] }, { lists: {}, sentences: {}, not_found: {} })), null);
});

test("decides only on every registered case three times, each trial's writer given the block catalog", () => {
  const results = document.cases.flatMap((entry) => [1, 2, 3].map((trial) => ({ case_id: entry.id, trial, writer_layout: 2 })));
  assert.equal(decides(results), true);
  assert.equal(decides(results.slice(1)), false);
  assert.equal(decides([...results.slice(1), results[3]]), false);
  for (const layout of [1, null]) assert.equal(decides(results.map((entry, at) => (at === 7 ? { ...entry, writer_layout: layout } : entry))), false);
});

test("writes a private report outside the repository that applies the three pre-registered rules", async (t) => {
  const { root } = privateRoot(t);
  const out = join(root, "report");
  const options = { ...parseArgs(["--run", "--credential-file", join(root, "credential"), "--out", out]) };
  const passing = await run(options, { loaded: { structured_output: writer(), generation }, progress: () => undefined });
  assert.equal(statSync(passing.reportPath).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(passing.reportPath, "utf8"));
  assert.deepEqual([report.kind, report.complete, report.wording_ships, report.results.length], ["echo-ask-wording-evaluation-v1", true, true, 30]);
  assert.deepEqual([report.answer_layout, report.model, new Set(report.results.map((entry) => entry.writer_layout))], [2, { route: "openrouter", adapter_id: "fixture", answer_model: "fixture-model" }, new Set([2])]);
  assert.deepEqual(report.groups.names_long_id, { trials: 18, no_restating: 18, long_ids_once: 18, nothing_lost: 18, errors: 0 });
  // The report fingerprints the kernel's compiled layout v2 module, whatever else the build holds.
  assert.ok(Object.hasOwn(report.code.before.files_sha256, "packages/organization-authority-kernel/dist/answer-composition/renderers/ask-layout-v2.js"));
  // Restating the question, as the founder's staging answer did, keeps the wording from shipping.
  const restating = await run({ ...options, caseIds: [founder.id, "owner-plain"], trials: 1 },
    { loaded: { structured_output: writer((entry) => `${entry.expect.facts[0].at(-1)} answers: ${entry.question}`), generation }, progress: () => undefined });
  assert.deepEqual([restating.report.complete, restating.report.rules.no_restating.passed_trials, restating.report.wording_ships], [false, 0, false]);
  // A smaller run that passes every rule keeps its scores, and still never ships the wording.
  const diagnostic = await run({ ...options, caseIds: ["owner-plain"], trials: 1 }, { loaded: { structured_output: writer(), generation }, progress: () => undefined });
  assert.deepEqual([diagnostic.report.complete, Object.values(diagnostic.report.rules).map((rule) => rule.passed), diagnostic.report.wording_ships], [false, [true, true, true], false]);
  assert.equal(readdirSync(out).length, 3);
});

test("writes through the personal Claude account port, admitting each request and adding up its usage", async (t) => {
  const { root } = privateRoot(t);
  const admittedRequests = [];
  const port = {
    async generate() { throw new Error("Native structured generation requires per-request admission"); },
    async generate_with_admission(input, admit) {
      // A native session may make more than one model request for one answer.
      for (const operation of ["count_tokens", "messages"]) {
        await admit({ model: input.model, operation, signal: AbortSignal.timeout(5_000) }, async () => {
          admittedRequests.push(operation);
          return { value: null, usage: { input_tokens: 10, output_tokens: operation === "messages" ? 7 : 0 }, ...(operation === "messages" ? { finish_reason: "stop" } : {}) };
        });
      }
      return answerBlock("You own it.", JSON.parse(input.user_prompt).evidence.map((item) => item.id));
    },
  };
  const accountGeneration = { ...generation, generation_adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" };
  const options = { ...parseArgs(["--run", "--credential-file", join(root, "credential"), "--out", join(root, "report"), "--cases", founder.id, "--trials", "1"]), writer: "claude-account" };
  const { report } = await run(options, { loaded: { personal_research: { structured_output: port, generation: accountGeneration } }, progress: () => undefined });
  assert.deepEqual(report.model, { route: "claude-account", adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" });
  assert.deepEqual(admittedRequests, ["count_tokens", "messages"]);
  assert.deepEqual(report.results[0].model_calls, [{ attempt: 1, result: "succeeded", finish_reason: "stop", usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 }, provider_latency_ms: null }]);
  assert.deepEqual([report.results[0].grade.lead, report.results[0].grade.rules], ["You own it.", { no_restating: true, long_ids_once: true, nothing_lost: true }]);
});
