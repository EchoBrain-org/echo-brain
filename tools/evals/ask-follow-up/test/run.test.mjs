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

function privateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "echo-ask-follow-up-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, "credential");
  writeFileSync(credential, "not a real credential", { mode: 0o600 });
  return { root, credential };
}

/** A structured output that answers each case as its expectation asks, or as `override` says; it never sees a credential. */
function oracle(override = () => undefined) {
  const prompts = [];
  return {
    prompts,
    async generate_with_observation(input) {
      const shown = JSON.parse(input.user_prompt);
      prompts.push(input);
      // Two cases may share both questions; their earlier answers tell them apart.
      const entry = document.cases.find((value) => value.question === shown.question && value.previous.question === shown.previous.question &&
        value.previous.statements.map((statement) => statement.text).join(" ") === shown.previous.statements.map((statement) => statement.text).join(" "));
      const reply = override(entry) ?? (entry.group === "one_referent" ? { resolution: "resolved", question: `What about ${entry.expect.names[0]}?`, about: entry.expect.about }
        : entry.group === "several_referents" ? { resolution: "clarify", choices: entry.expect.candidates.map((candidate) => ({ label: candidate[0], question: `What about ${candidate[0]}?` })) }
          : { resolution: "same" });
      return { value: reply, finish_reason: "stop", usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 }, provider_latency_ms: 812 };
    },
  };
}

test("makes no request, and reads no credential, unless asked to run with a private credential file and a private report directory", (t) => {
  const { root, credential } = privateRoot(t);
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.match(help(), /--credential-file/u);
  assert.throws(() => parseArgs(["--credential-file", credential, "--out", join(root, "out")]), /unless --run is explicit/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", "credential", "--out", join(root, "out")]), /absolute private file/u);
  chmodSync(credential, 0o644);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]), /not be readable by group or other/u);
  chmodSync(credential, 0o600);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(ROOT, "tools", "evals", "ask-follow-up")]), /outside the repository/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential]), /--out must be an absolute private directory/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--trials", "4"]), /--trials/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--cases", "no-such-case"]), /known cases/u);
  const options = parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]);
  assert.deepEqual({ trials: options.trials, caseIds: options.caseIds, timeoutMs: options.timeoutMs }, { trials: 3, caseIds: null, timeoutMs: 60_000 });
  assert.equal(statSync(options.out).mode & 0o777, 0o700);
  // The credential is only stat'ed: it is still exactly what the test wrote.
  assert.equal(readFileSync(credential, "utf8"), "not a real credential");
});

test("runs the kernel's resolver once per trial, through the product's prompt, keeping only metadata and the synthetic resolution", async () => {
  const founder = document.cases.find((entry) => entry.id === "one-dvt-gate-ticket");
  const structured = oracle();
  const result = await runTrial(founder, 1, structured, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual({ ...result, elapsed_ms: 0 }, {
    case_id: "one-dvt-gate-ticket", group: "one_referent", trial: 1, resolution: "resolved", question: "What about THERM-482?", about: [1],
    fallback: false, calls: 1, repairs: 0, passed: true, clarify: false, elapsed_ms: 0,
    model_calls: [{ attempt: 1, result: "succeeded", finish_reason: "stop", usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 }, provider_latency_ms: 812 }],
  });
  // The resolver was shown the turn, numbered from 1, on its day in the cases' time zone.
  const shown = JSON.parse(structured.prompts[0].user_prompt);
  assert.equal(shown.today, "2026-10-25");
  assert.equal(shown.previous.asked_on, "2026-10-24");
  assert.deepEqual(shown.previous.sources.map((source) => source.n), [1]);
  assert.ok(!JSON.stringify(result).includes("thermal fixture fails"), "no prompt text is kept");
  // A reply no repair makes usable is the fallback: the question as asked, which fails a one-referent case.
  const failing = await runTrial(founder, 2, oracle(() => ({ resolution: "guess" })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([failing.resolution, failing.fallback, failing.calls, failing.repairs, failing.passed], ["same", true, 2, 1, false]);
  // A model that cannot be reached keeps its safe error class only.
  const broken = { async generate_with_observation() { throw Object.assign(new Error("secret provider detail"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } }); } };
  const refused = await runTrial(founder, 3, broken, generation, document, { timeoutMs: 15_000 });
  assert.equal(refused.passed, false);
  assert.deepEqual(refused.model_calls, [{ attempt: 1, result: "rejected", error: { name: "Error", failure_class: "adapter_http", http_status: 401, finish_reason: null } }]);
  assert.ok(!JSON.stringify(refused).includes("secret provider detail"));
});

test("writes a private report outside the repository that applies the four pre-registered rules", async (t) => {
  const { root } = privateRoot(t);
  const progress = [];
  const out = join(root, "report");
  const passing = await run({ caseIds: null, trials: 3, timeoutMs: 15_000, out: parseOut(out), credentialFile: "/unused" },
    { loaded: { structured_output: oracle(), generation }, progress: (line) => progress.push(line) });
  assert.equal(statSync(passing.reportPath).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(passing.reportPath, "utf8"));
  assert.deepEqual([report.kind, report.complete, report.follow_ups_ship, report.founder_review], ["echo-ask-follow-up-evaluation-v1", true, true, false]);
  assert.equal(report.results.length, 90);
  assert.deepEqual(report.groups.several_referents, { trials: 30, passed: 30, clarify: 30, fallback: 0, errors: 0 });
  assert.equal(progress.length, 90);
  // One guess on a case with several referents keeps follow-ups off.
  const guessing = await run({ caseIds: ["several-dvt-gate-tickets", "one-dvt-gate-ticket"], trials: 1, timeoutMs: 15_000, out: parseOut(out), credentialFile: "/unused" },
    { loaded: { structured_output: oracle((entry) => entry.group === "several_referents" ? { resolution: "resolved", question: "What are the details on THERM-482?", about: [1] } : undefined), generation }, progress: () => undefined });
  assert.deepEqual([guessing.report.complete, guessing.report.rules.never_guess.passed, guessing.report.follow_ups_ship], [false, false, false]);
  assert.equal(readdirSync(out).length, 2);
});

/** The report directory as parseArgs makes it: created private. */
function parseOut(path) {
  const credential = join(dirname(path), "credential");
  return parseArgs(["--run", "--credential-file", credential, "--out", path]).out;
}
