import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANSWER_BLOCK_CATALOG, ANSWER_BLOCKS_PROMPT, answerBlocksSchema } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { pooled } from "../../shared/runner.mjs";
import { help, parseArgs, researchStep, run } from "../run.mjs";
import { loadCases } from "../grade.mjs";
import { loadCases as loadWordingCases } from "../wording.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072 };
const document = loadCases();
/** The writer's answer that Priya Raman owns it, in blocks. */
const REPLY = Object.freeze({ lists: [], blocks: [{ block: "answer", sentences: [{ text: "Priya Raman owns it.", evidence: ["E1"] }] }], not_found: [] });
/** A run over soak-owner, one trial, with `fields` changed. */
const options = (out, fields = {}) => ({ run: true, credentialFile: null, out, caseIds: ["soak-owner"], trials: 1, concurrency: 1, timeoutMs: 20_000, ...fields });
/** A route that answers each writer call with REPLY, keeping every input. */
const answering = (inputs = []) => ({ inputs, async generate_with_observation(input) {
  inputs.push(input);
  return { value: REPLY, finish_reason: "stop", usage: null, provider_latency_ms: 1 };
} });

const wording = loadWordingCases();
const founder = wording.cases.find((entry) => entry.id === "follow-up-owner-quoted-title");
/** A private directory with a private credential file in it, removed after the test. */
function privateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "echo-ask-blocks-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, "credential");
  writeFileSync(credential, "not a real credential", { mode: 0o600 });
  return { root, credential };
}
/** A layout v2 reply: one answer block whose sentence cites `evidence`. */
const answerBlock = (text, evidence) => ({ lists: [], blocks: [{ block: "answer", sentences: [{ text, evidence }] }], not_found: [] });
/**
 * A writer for the wording cases that answers with `lead(case)` (by default every required fact, briefly) as its answer
 * block and cites everything it was shown; it never sees a credential.
 */
function wordingWriter(lead = (entry) => `It is ${entry.expect.facts.map((alternatives) => alternatives.at(-1)).join(", ")}.`) {
  const inputs = [];
  return {
    inputs,
    async generate_with_observation(input) {
      inputs.push(input);
      const shown = JSON.parse(input.user_prompt);
      const entry = wording.cases.find((value) => value.question === shown.question);
      return { value: answerBlock(lead(entry), shown.evidence.map((item) => item.id)),
        finish_reason: "stop", usage: { input_tokens: 4000, output_tokens: 60, total_tokens: 4060 }, provider_latency_ms: 900 };
    },
  };
}

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
  assert.throws(() => parseArgs([...base, "--cases", "no-such-case"]), /--cases must select known cases/u);
  assert.throws(() => parseArgs([...base, "--cases", "soak-owner,soak-owner"]), /--cases must select known cases, each once/u);
  assert.throws(() => parseArgs([...base, "--trials", "4"]), /--trials must be an integer from 1 to 3/u);
  const parsed = parseArgs([...base, "--cases", "soak-owner", "--trials", "1"]);
  assert.deepEqual([parsed.caseSet, parsed.trials, parsed.concurrency, parsed.timeoutMs, parsed.caseIds], ["main", 1, 4, 120_000, ["soak-owner"]]);
  assert.deepEqual([parseArgs(base).trials, parseArgs(base).caseIds, parseArgs([...base, "--case-set", "main"]).caseSet], [3, null, "main"]);
  // Each case set names its own cases and its own timeout bounds.
  assert.throws(() => parseArgs([...base, "--case-set", "other"]), /--case-set must be main or wording/u);
  assert.throws(() => parseArgs([...base, "--case-set", "wording", "--cases", "soak-owner"]), /--cases must select known cases/u);
  assert.deepEqual([parseArgs([...base, "--case-set", "wording", "--cases", "owner-plain"]).caseIds, parseArgs([...base, "--case-set", "wording"]).timeoutMs], [["owner-plain"], 60_000]);
  assert.equal(parseArgs([...base, "--timeout-ms", "180000"]).timeoutMs, 180_000);
  assert.throws(() => parseArgs([...base, "--timeout-ms", "180001"]), /--timeout-ms must be an integer from 15000 to 180000/u);
  assert.equal(parseArgs([...base, "--case-set", "wording", "--timeout-ms", "85000"]).timeoutMs, 85_000);
  assert.throws(() => parseArgs([...base, "--case-set", "wording", "--timeout-ms", "120000"]), /--timeout-ms must be an integer from 15000 to 85000/u);
});

test("reads no credential and writes nowhere but a private directory outside the repository", (t) => {
  const { root, credential } = privateRoot(t);
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.match(help(), /--credential-file/u);
  assert.match(help(), /answer layout v2/u);
  assert.throws(() => parseArgs(["--credential-file", credential, "--out", join(root, "out")]), /unless --run is explicit/u);
  chmodSync(credential, 0o644);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]), /not be readable by group or other/u);
  chmodSync(credential, 0o600);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(ROOT, "tools", "evals", "ask-blocks")]), /outside the repository/u);
  const options = parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]);
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

test("scripts research as one search, every item opened, then finish", () => {
  const steps = document.cases.find((entry) => entry.id === "ship-steps");
  assert.deepEqual(researchStep(steps, 1).actions, [{ tool: "search", args: { query: steps.research.query } }]);
  assert.equal(researchStep(steps, 2).actions.length, steps.items.length);
  assert.deepEqual(researchStep(steps, 3).actions, [{ tool: "finish", args: {} }]);
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
      return REPLY;
    },
  };
  const accountGeneration = { ...generation, generation_adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" };
  const { report } = await run(options(out, { writer: "claude-account" }), { loaded: { structured_output: port, generation: accountGeneration }, progress: () => undefined });
  assert.deepEqual(report.model, { route: "claude-account", adapter_id: "claude-account-research-writer-v1", answer_model: "claude-sonnet-5-5" });
  assert.deepEqual(admittedRequests, ["count_tokens", "messages"]);
  assert.deepEqual(report.trials[0].attempts[0].usage, { input_tokens: 20, output_tokens: 7, total_tokens: 27 });
  assert.equal(report.trials[0].grade.valid, true);
});

test("fingerprints its cases, its pre-registration and every module the run loads", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-code-"));
  const { report } = await run(options(out), { loaded: { structured_output: answering(), generation }, progress: () => undefined });
  const fingerprinted = Object.keys(report.code.before.files_sha256);
  assert.deepEqual(fingerprinted, ["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/wording-cases.json", "tools/evals/ask-blocks/README.md", ...loadedModules("tools/evals/ask-blocks/run.mjs")]);
  // Among them layout v2's checks and title bound, and the kernel's shared modules on the writer's path.
  for (const file of ["packages/organization-api/dist/person-answer-layout-checks.js", "packages/organization-api/dist/person-answer-layout-v2.js",
    "packages/organization-authority-kernel/dist/shared/core-runtime-observation-v1.js", "packages/organization-authority-kernel/dist/shared/evidence-desk-v2.js"]) assert.ok(fingerprinted.includes(file), file);
  assert.equal(report.code.unchanged, true);
});

test("stops starting tasks once one fails, lets those running finish, then throws the first failure", async () => {
  const events = [];
  let finish;
  const running = new Promise((resolve) => { finish = resolve; });
  const tasks = Array.from({ length: 6 }, (_, at) => async () => {
    events.push(`start ${at}`);
    if (at === 1) throw new Error("task 1 failed");
    await running;
    events.push(`end ${at}`);
    return at;
  });
  const pool = pooled(tasks, 2).then(() => events.push("resolved"), (error) => events.push(`threw: ${error.message}`));
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await pool;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["start 0", "start 1", "end 0", "threw: task 1 failed"]);
  // Without a failure every task runs, `limit` at a time, and the results keep the tasks' order whatever order they end in.
  const order = await pooled([30, 10, 20, 0, 5].map((ms, at) => () => new Promise((resolve) => setTimeout(() => resolve(at), ms))), 3);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  // A pool without a limit of at least 1 could run nothing, so it refuses to start.
  for (const limit of [undefined, 0, 1.5]) await assert.rejects(pooled([async () => 1], limit), /a pool's limit must be a positive integer/u);
});

test("makes no more calls once a trial fails, and writes no report", async () => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-failed-"));
  const route = answering();
  let lines = 0;
  // Nine trials, two at a time; the first trial to end fails, as a fault in the harness would.
  const progress = () => { lines += 1; if (lines === 1) throw new Error("harness fault"); };
  await assert.rejects(run(options(out, { caseIds: ["soak-owner", "notes-due", "gate-blockers"], trials: 3, concurrency: 2 }), { loaded: { structured_output: route, generation }, progress }), /harness fault/u);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Only the two trials running when it failed made their call.
  assert.deepEqual([route.inputs.length, readdirSync(out)], [2, []]);
});

test("writes only its report to --out, as --help says", async () => {
  assert.match(help(), /the report is written there with mode 0600/u);
  assert.doesNotMatch(help(), /page's data/u);
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-out-"));
  const { reportPath } = await run(options(out), { loaded: { structured_output: answering(), generation }, progress: () => undefined });
  assert.deepEqual(readdirSync(out), [basename(reportPath)]);
});

test("runs a wording case through the kernel, only the writer reaching the model, grades its lead and keeps no prompt", async (t) => {
  const { root } = privateRoot(t);
  const options = { run: true, credentialFile: null, out: root, caseSet: "wording", caseIds: [founder.id], trials: 1, concurrency: 1, timeoutMs: 15_000 };
  const structured = wordingWriter();
  const { report } = await run(options, { loaded: { structured_output: structured, generation }, progress: () => undefined });
  const [trial] = report.trials;
  // No capture: the writer was called once, for the trial itself.
  assert.deepEqual([structured.inputs.length, trial.outcome, trial.attempts.length, trial.grade.rules], [1, "answered", 1, { no_restating: true, long_ids_once: true, nothing_lost: true }]);
  // The writer read Ask's prompt, block catalog and schema, and both items, the follow-up first, as the asker sees them.
  const [input] = structured.inputs;
  const shown = JSON.parse(input.user_prompt);
  assert.ok(input.system_prompt.startsWith("You write Echo's final answer") && input.system_prompt.endsWith(`\n\n${ANSWER_BLOCKS_PROMPT}`));
  assert.deepEqual([shown.block_catalog, input.schema], [ANSWER_BLOCK_CATALOG, answerBlocksSchema]);
  assert.deepEqual([shown.asked_by, shown.today, shown.evidence.map((item) => item.kind)], ["Noor Haddad", "2026-10-26", ["follow_up", "decision"]]);
  // The lead is the answer block's statement.
  assert.equal(trial.grade.lead, "It is Noor Haddad.");
  // Only the writer prompt's digest and model metadata are kept: no prompt, raw reply or released answer.
  assert.deepEqual(trial.attempts[0], { attempt: 1, kind: "first", system_prompt_sha256: report.writer_prompt_sha256[0], max_output_tokens: input.max_output_tokens,
    finish_reason: "stop", usage: { input_tokens: 4000, output_tokens: 60, total_tokens: 4060 }, provider_latency_ms: 900, elapsed_ms: trial.attempts[0].elapsed_ms, valid: true });
  assert.equal(report.writer_prompt_sha256.length, 1);
  assert.deepEqual(["prompts", "system_prompts", "writer"].filter((field) => Object.hasOwn(report, field)), []);
  assert.deepEqual(["read", "response"].filter((field) => Object.hasOwn(trial, field)), []);
  assert.ok(!JSON.stringify(report).includes("You write Echo's final answer"), "no prompt text is kept");
  assert.ok(!JSON.stringify(report).includes('"blocks":[{"block"'), "no raw reply is kept");
  // A writer that cannot be reached keeps its safe error class only; code's fallback writes no statement, so it passes nothing.
  const broken = { async generate_with_observation() { throw Object.assign(new Error("secret provider detail"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } }); } };
  const refused = (await run(options, { loaded: { structured_output: broken, generation }, progress: () => undefined })).report;
  assert.deepEqual([refused.trials[0].grade.statements, refused.trials[0].grade.rules], [[], { no_restating: false, long_ids_once: false, nothing_lost: false }]);
  assert.deepEqual(refused.trials[0].attempts[0].error, { name: "Error", failure_class: "adapter_http", http_status: 401, finish_reason: null, usage: null, provider_latency_ms: null });
  assert.deepEqual(refused.errors, { writer_calls: 1, trials_without_reply: 1 });
  assert.ok(!JSON.stringify(refused).includes("secret provider detail"));
});

test("writes a private report that applies the wording cases' three rules, and decides only on every case three times", async (t) => {
  const { root } = privateRoot(t);
  const out = join(root, "report");
  const options = { ...parseArgs(["--run", "--credential-file", join(root, "credential"), "--out", out, "--case-set", "wording"]) };
  const passing = await run(options, { loaded: { structured_output: wordingWriter(), generation }, progress: () => undefined });
  assert.equal(statSync(passing.reportPath).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(passing.reportPath, "utf8"));
  assert.deepEqual([report.kind, report.case_set, report.complete, report.summary.wording_ships, report.decision.passes, report.trials.length], ["echo-ask-blocks-evaluation-v1", "wording", true, true, true, 30]);
  assert.deepEqual(report.model, { route: "openrouter", adapter_id: "fixture", answer_model: "fixture-model" });
  assert.deepEqual(report.summary.groups.names_long_id, { trials: 18, no_restating: 18, long_ids_once: 18, nothing_lost: 18, errors: 0 });
  // Restating the question, as the founder's staging answer did, keeps the wording from shipping.
  const restating = await run({ ...options, caseIds: [founder.id, "owner-plain"], trials: 1 },
    { loaded: { structured_output: wordingWriter((entry) => `${entry.expect.facts[0].at(-1)} answers: ${entry.question}`), generation }, progress: () => undefined });
  assert.deepEqual([restating.report.complete, restating.report.summary.rules.no_restating.passed_trials, restating.report.summary.wording_ships, restating.report.decision.passes], [false, 0, false, null]);
  // A smaller run that passes every rule keeps its scores, and still never ships the wording.
  const diagnostic = await run({ ...options, caseIds: ["owner-plain"], trials: 1 }, { loaded: { structured_output: wordingWriter(), generation }, progress: () => undefined });
  assert.deepEqual([diagnostic.report.complete, Object.values(diagnostic.report.summary.rules).map((rule) => rule.passed), diagnostic.report.summary.wording_ships, diagnostic.report.decision.passes],
    [false, [true, true, true], false, null]);
  assert.equal(readdirSync(out).length, 3);
});

test("runs trials a few at a time and keeps the report's trials in their order: each trial of every case in turn", async (t) => {
  const { root, credential } = privateRoot(t);
  const base = ["--run", "--credential-file", credential, "--out", join(root, "out"), "--case-set", "wording"];
  for (const value of ["0", "7", "two"]) assert.throws(() => parseArgs([...base, "--concurrency", value]), /--concurrency must be an integer from 1 to 6/u);
  const caseIds = ["owner-plain", "rollback-named-id", "blocker-plain"];
  const options = parseArgs([...base, "--cases", caseIds.join(","), "--concurrency", "3"]);
  // A writer whose later cases answer sooner, so trials end out of order; it counts the calls it is in at once.
  const answers = wordingWriter();
  let running = 0;
  const overlapping = { peak: 0, async generate_with_observation(input) {
    running += 1;
    overlapping.peak = Math.max(overlapping.peak, running);
    const at = caseIds.findIndex((id) => wording.cases.find((entry) => entry.id === id).question === JSON.parse(input.user_prompt).question);
    await new Promise((resolve) => setTimeout(resolve, (caseIds.length - at) * 15));
    try { return await answers.generate_with_observation(input); } finally { running -= 1; }
  } };
  const together = await run(options, { loaded: { structured_output: overlapping, generation }, progress: () => undefined });
  const alone = await run({ ...options, concurrency: 1 }, { loaded: { structured_output: wordingWriter(), generation }, progress: () => undefined });
  assert.equal(overlapping.peak, 3);
  assert.deepEqual(together.report.trials.map((entry) => [entry.case_id, entry.trial]), [1, 2, 3].flatMap((trial) => caseIds.map((id) => [id, trial])));
  // Apart from their timings, the trials are the ones a run one trial at a time reports, and the report says how many ran at once.
  const timeless = (trials) => JSON.parse(JSON.stringify(trials, (key, value) => (key === "elapsed_ms" ? undefined : value)));
  assert.deepEqual(timeless(together.report.trials), timeless(alone.report.trials));
  assert.deepEqual([together.report.limits.concurrency, alone.report.limits.concurrency], [3, 1]);
});
