import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadCases } from "../grade.mjs";
import { help, parseArgs, run, runTrial } from "../run.mjs";

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

/**
 * A writer that leads with `lead(case)` (by default every required fact, briefly) and cites everything it was shown; it
 * never sees a credential.
 */
function writer(lead = (entry) => `It is ${entry.expect.facts.map((alternatives) => alternatives.at(-1)).join(", ")}.`) {
  const inputs = [];
  return {
    inputs,
    async generate_with_observation(input) {
      inputs.push(input);
      const shown = JSON.parse(input.user_prompt);
      const entry = document.cases.find((value) => value.question === shown.question);
      const evidence = shown.evidence.map((item) => item.id);
      return { value: { lists: [], tables: [], sentences: [{ text: lead(entry), evidence, form: "lead" }], not_found: [] },
        finish_reason: "stop", usage: { input_tokens: 4000, output_tokens: 60, total_tokens: 4060 }, provider_latency_ms: 900 };
    },
  };
}

test("makes no request, and reads no credential, unless asked to run with a private credential file and a private report directory", (t) => {
  const { root, credential } = privateRoot(t);
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.match(help(), /--credential-file/u);
  assert.throws(() => parseArgs(["--credential-file", credential, "--out", join(root, "out")]), /unless --run is explicit/u);
  chmodSync(credential, 0o644);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]), /not be readable by group or other/u);
  chmodSync(credential, 0o600);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(ROOT, "tools", "evals", "ask-wording")]), /outside the repository/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--cases", "no-such-case"]), /known cases/u);
  const options = parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]);
  assert.deepEqual({ trials: options.trials, caseIds: options.caseIds, timeoutMs: options.timeoutMs }, { trials: 3, caseIds: null, timeoutMs: 60_000 });
  assert.equal(statSync(options.out).mode & 0o777, 0o700);
  assert.equal(readFileSync(credential, "utf8"), "not a real credential");
});

test("runs Ask with answer layout over scripted research, sending only the writer to the model, and keeps no prompt", async () => {
  const structured = writer();
  const result = await runTrial(founder, 1, structured, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([result.outcome, result.research_rounds, result.writer_calls, result.grade.rules], ["answered", 3, 1, { no_restating: true, long_ids_once: true, nothing_lost: true }]);
  // The writer read the laid-out Ask's prompt and both items, the follow-up first, as the asker sees them.
  const [input] = structured.inputs;
  const shown = JSON.parse(input.user_prompt);
  assert.match(input.system_prompt, /\nLayout: the person's app sets the answer as a short document/u);
  assert.deepEqual([shown.asked_by, shown.today, shown.evidence.map((item) => item.kind)], ["Noor Haddad", "2026-10-26", ["follow_up", "decision"]]);
  assert.equal(result.writer_prompt_sha256.length, 1);
  assert.ok(!JSON.stringify(result).includes("You write Echo's final answer"), "no prompt text is kept");
  // A writer that cannot be reached keeps its safe error class only; code's fallback writes no statement, so it passes nothing.
  const broken = { async generate_with_observation() { throw Object.assign(new Error("secret provider detail"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } }); } };
  const refused = await runTrial(founder, 2, broken, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([refused.grade.statements, refused.grade.rules], [[], { no_restating: false, long_ids_once: false, nothing_lost: false }]);
  assert.deepEqual(refused.model_calls[0], { attempt: 1, result: "rejected", error: { name: "Error", failure_class: "adapter_http", http_status: 401, finish_reason: null } });
  assert.ok(!JSON.stringify(refused).includes("secret provider detail"));
});

test("writes a private report outside the repository that applies the three pre-registered rules", async (t) => {
  const { root } = privateRoot(t);
  const out = join(root, "report");
  const options = { ...parseArgs(["--run", "--credential-file", join(root, "credential"), "--out", out]) };
  const passing = await run(options, { loaded: { structured_output: writer(), generation }, progress: () => undefined });
  assert.equal(statSync(passing.reportPath).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(passing.reportPath, "utf8"));
  assert.deepEqual([report.kind, report.complete, report.wording_ships, report.results.length], ["echo-ask-wording-evaluation-v1", true, true, 30]);
  assert.deepEqual(report.groups.names_long_id, { trials: 18, no_restating: 18, long_ids_once: 18, nothing_lost: 18, errors: 0 });
  // Restating the question, as the founder's staging answer did, keeps the wording from shipping.
  const restating = await run({ ...options, caseIds: [founder.id, "owner-plain"], trials: 1 },
    { loaded: { structured_output: writer((entry) => `${entry.expect.facts[0].at(-1)} answers: ${entry.question}`), generation }, progress: () => undefined });
  assert.deepEqual([restating.report.complete, restating.report.rules.no_restating.passed_trials, restating.report.wording_ships], [false, 0, false]);
  assert.equal(readdirSync(out).length, 2);
});
