import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pooled } from "../../shared/runner.mjs";
import { help, parseArgs, researchStep, run } from "../run.mjs";
import { loadCases } from "../grade.mjs";

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
  assert.deepEqual([parsed.trials, parsed.concurrency, parsed.timeoutMs, parsed.caseIds], [1, 4, 120_000, ["soak-owner"]]);
  assert.deepEqual([parseArgs(base).trials, parseArgs(base).caseIds], [3, null]);
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
  assert.deepEqual(fingerprinted, ["tools/evals/ask-blocks/cases.json", "tools/evals/ask-blocks/README.md", ...loadedModules("tools/evals/ask-blocks/run.mjs")]);
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
