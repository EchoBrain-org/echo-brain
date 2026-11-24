import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCases, loadThreadCases, THREAD_CASES_FILE } from "../grade.mjs";
import { help, parseArgs, qualifies, run, runThreadTrial } from "../run.mjs";
import { sha256 } from "../../shared/runner.mjs";

const document = loadThreadCases();
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 32_768, max_output_tokens: 8_000 };
const byId = (id) => document.cases.find((entry) => entry.id === id);

function privateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "echo-ask-thread-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, "credential");
  writeFileSync(credential, "not a real credential", { mode: 0o600 });
  return { root, credential };
}
const args = (credential, out, ...more) => ["--set", "threads", "--run", "--credential-file", credential, "--out", out, ...more];

/** The reply a case's expectation asks for, in the thread resolver's own shape. */
function expected(entry) {
  switch (entry.expect.thread) {
    case "open": return { thread: "open", resolution: "same", ...(entry.expect.merge === undefined ? {} : { merge: entry.expect.merge }) };
    case "new": return { thread: "new" };
    case "other": return { thread: "other", threads: entry.expect.threads, ...(entry.expect.merge === undefined ? {} : { merge: entry.expect.merge }) };
    default: throw new Error(`unknown expectation ${entry.expect.thread}`);
  }
}

/** A structured output that answers each case as its expectation asks, or as `override` says; it never sees a credential. */
function oracle(override = () => undefined) {
  const prompts = [];
  return {
    prompts,
    async generate_with_observation(input) {
      const shown = JSON.parse(input.user_prompt);
      prompts.push(input);
      const entry = document.cases.find((value) => value.question === shown.question && JSON.stringify(value.threads.map((thread) => thread.questions)) === JSON.stringify(shown.threads.map((thread) => thread.questions)));
      return { value: override(entry) ?? expected(entry), finish_reason: "stop", usage: { input_tokens: 1_200, output_tokens: 30, total_tokens: 1_230 }, provider_latency_ms: 640 };
    },
  };
}

test("the thread set is chosen with --set threads, under the same explicit-run and private-file rules, and leaves the follow-up set its own", (t) => {
  const { root, credential } = privateRoot(t);
  assert.match(help(), /eval:ask-threads/u);
  assert.match(help(), /--set NAME/u);
  assert.deepEqual(parseArgs(["--set", "threads", "--help"]), { help: true });
  assert.throws(() => parseArgs(["--set", "threads", "--credential-file", credential, "--out", join(root, "out")]), /unless --run is explicit/u);
  assert.throws(() => parseArgs(args(credential, join(root, "out"), "--set", "sessions")), /--set must be follow-up or threads/u);
  const options = parseArgs(args(credential, join(root, "out")));
  assert.deepEqual({ set: options.set, trials: options.trials, caseIds: options.caseIds, timeoutMs: options.timeoutMs }, { set: "threads", trials: 3, caseIds: null, timeoutMs: 60_000 });
  // Each set knows only its own cases.
  assert.deepEqual(parseArgs(args(credential, join(root, "out"), "--cases", "several-tooling-quotes")).caseIds, ["several-tooling-quotes"]);
  assert.throws(() => parseArgs(args(credential, join(root, "out"), "--cases", "one-dvt-gate-ticket")), /known cases/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out"), "--cases", "several-tooling-quotes"]), /known cases/u);
  assert.equal(parseArgs(["--run", "--credential-file", credential, "--out", join(root, "out")]).set, "follow-up");
  assert.ok(loadCases().cases.every((entry) => byId(entry.id) === undefined), "no id is in both sets");
});

test("runs the kernel's thread resolver once per trial, through the product's prompt, keeping only metadata and the placement", async () => {
  const several = byId("several-tooling-quotes");
  const structured = oracle();
  const result = await runThreadTrial(several, 1, structured, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual({ ...result, elapsed_ms: 0 }, {
    case_id: "several-tooling-quotes", group: "several_others", trial: 1, thread: "other", threads: [1, 2],
    fallback: false, calls: 1, repairs: 0, passed: true, named_all: true, merged: false, elapsed_ms: 0,
    model_calls: [{ attempt: 1, result: "succeeded", finish_reason: "stop", usage: { input_tokens: 1_200, output_tokens: 30, total_tokens: 1_230 }, provider_latency_ms: 640 }],
  });
  // The resolver was shown the open thread and the other threads numbered from 1, on their days in the cases' time zone.
  const shown = JSON.parse(structured.prompts[0].user_prompt);
  assert.equal(shown.today, "2026-11-23");
  assert.deepEqual(shown.threads.map((thread) => thread.n), [1, 2, 3]);
  assert.equal(shown.threads[0].last_asked_on, "2026-11-22");
  assert.deepEqual(shown.open.turns.map((turn) => turn.question), ["When is the FCC pre-scan booked?"]);
  assert.match(structured.prompts[0].system_prompt, /Never guess a thread\./u);
  assert.ok(!JSON.stringify(result).includes("heater block tooling"), "no prompt text is kept");

  // An open thread with older turns is shown oldest first, and a merge is kept by its thread numbers.
  const twice = byId("twice-the-open-drop-test-thread");
  const merged = oracle();
  const kept = await runThreadTrial(twice, 1, merged, generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([kept.thread, kept.resolution, kept.merge, kept.passed, kept.merged], ["open", "same", [2], true, true]);
  assert.deepEqual(JSON.parse(merged.prompts[0].user_prompt).open.turns.map((turn) => turn.question), ["Why did the drop test fail on MECH-214?", "who owns the retest?"]);
  // A case asked with no thread open shows none.
  const alone = byId("other-therm-482-fix-with-no-thread-open");
  const none = oracle();
  assert.deepEqual([(await runThreadTrial(alone, 1, none, generation, document, { timeoutMs: 15_000 })).threads, "open" in JSON.parse(none.prompts[0].user_prompt)], [[2], false]);
});

test("grades a guess, a wrong merge and a fallback as the product would have acted on them", async () => {
  const several = byId("several-tooling-quotes");
  // Naming one of two candidates is a guess.
  const guessed = await runThreadTrial(several, 1, oracle(() => ({ thread: "other", threads: [1] })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([guessed.threads, guessed.passed, guessed.named_all], [[1], false, false]);
  // A merge beside several candidates is dropped by the product, so the trial names none.
  const dropped = await runThreadTrial(several, 2, oracle(() => ({ thread: "other", threads: [1, 2], merge: [3] })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([dropped.passed, dropped.merged, "merge" in dropped], [true, false, false]);
  // A merge where one other thread is named is the product's to act on: rule 4 sees it.
  const one = byId("other-kestrel-quote-expiry");
  const wrong = await runThreadTrial(one, 1, oracle(() => ({ thread: "other", threads: [1], merge: [2] })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([wrong.passed, wrong.merged, wrong.merge], [true, true, [2]]);
  // A merge beside choices is dropped by the product too: the answer only asks which thing is meant, so the trial names
  // no merge and rule 4 is not failed by it.
  const choices = [{ label: "THERM-482", question: "What are the details on THERM-482?" }, { label: "the DVT gate", question: "What are the details on the DVT gate?" }];
  const asked = await runThreadTrial(byId("open-details-on-that-ticket"), 3, oracle(() => ({ thread: "open", resolution: "clarify", choices, merge: [1] })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([asked.thread, asked.resolution, asked.passed, asked.merged, "merge" in asked], ["open", "clarify", true, false, false]);
  // A reply that says two things (another thread, and choices) is read as neither: after its repair says the same, the
  // product answers where the question was asked, and the trial fails as every fallback does.
  const twoThings = await runThreadTrial(one, 2, oracle(() => ({ thread: "other", threads: [1], resolution: "clarify", choices })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([twoThings.thread, twoThings.fallback, twoThings.calls, twoThings.repairs, twoThings.passed, "threads" in twoThings], ["open", true, 2, 1, false, false]);
  // A reply no repair makes usable is the fallback: the open thread with a previous turn, a new thread without one. It fails
  // its trial in every group, also where the model answering the same would pass.
  const continues = byId("open-details-on-that-ticket");
  const fellBack = await runThreadTrial(continues, 1, oracle(() => ({ thread: "elsewhere" })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([fellBack.thread, fellBack.resolution, fellBack.fallback, fellBack.calls, fellBack.repairs, fellBack.passed], ["open", "same", true, 2, 1, false]);
  const fresh = byId("new-travel-budget-with-no-thread-open");
  const fellNew = await runThreadTrial(fresh, 1, oracle(() => ({ thread: "open", resolution: "same" })), generation, document, { timeoutMs: 15_000 });
  assert.deepEqual([fellNew.thread, fellNew.fallback, fellNew.calls, fellNew.passed], ["new", true, 2, false]);
  assert.equal((await runThreadTrial(fresh, 2, oracle(), generation, document, { timeoutMs: 15_000 })).passed, true);
  // A model that cannot be reached keeps its safe error class only.
  const broken = { async generate_with_observation() { throw Object.assign(new Error("secret provider detail"), { diagnostic: { failure_class: "adapter_http", http_status: 401 } }); } };
  const refused = await runThreadTrial(several, 3, broken, generation, document, { timeoutMs: 15_000 });
  assert.equal(refused.passed, false);
  assert.deepEqual(refused.model_calls, [{ attempt: 1, result: "rejected", error: { name: "Error", failure_class: "adapter_http", http_status: 401, finish_reason: null } }]);
  assert.ok(!JSON.stringify(refused).includes("secret provider detail"));
});

test("writes a private report outside the repository that applies the five pre-registered rules", async (t) => {
  const { root, credential } = privateRoot(t);
  const progress = [];
  const out = parseArgs(args(credential, join(root, "report"))).out;
  const options = (more) => ({ set: "threads", caseIds: null, trials: 3, timeoutMs: 15_000, out, credentialFile: "/unused", ...more });
  const passing = await run(options(), { loaded: { structured_output: oracle(), generation }, progress: (line) => progress.push(line) });
  assert.equal(statSync(passing.reportPath).mode & 0o777, 0o600);
  assert.match(passing.reportPath, /ask-thread-evaluation-/u);
  const report = JSON.parse(readFileSync(passing.reportPath, "utf8"));
  assert.deepEqual([report.kind, report.complete, report.echo_picks_threads, report.founder_review], ["echo-ask-thread-evaluation-v1", true, true, false]);
  assert.equal(report.cases_sha256, sha256(readFileSync(THREAD_CASES_FILE)));
  assert.ok(Object.hasOwn(report.code.before.files_sha256, "tools/evals/ask-follow-up/thread-cases.json"));
  assert.equal(report.results.length, 84);
  assert.deepEqual(report.limits, { cases: 28, trials: 3, timeout_ms: 15_000, max_total_model_calls: 168 });
  assert.deepEqual(report.groups.several_others, { trials: 18, passed: 18, named_all: 18, merged: 0, fallback: 0, errors: 0 });
  assert.deepEqual(report.groups.same_subject_twice, { trials: 12, passed: 12, named_all: 0, merged: 12, fallback: 0, errors: 0 });
  assert.deepEqual(Object.keys(report.rules), ["never_guess", "route_the_obvious", "leave_new_subjects_alone", "never_merge_wrongly", "merge_the_obvious"]);
  assert.equal(progress.length, 84);
  assert.deepEqual(JSON.parse(progress[0]), { kind: "echo-ask-thread-evaluation-progress-v1", case_id: document.cases[0].id, trial: 1, thread: "open", passed: true });
  assert.ok(!("follow_ups_ship" in report));

  // One guess on a case with several candidates, and ECHO does not pick threads.
  const guessing = await run(options({ caseIds: ["several-tooling-quotes", "other-kestrel-quote-expiry"], trials: 1 }),
    { loaded: { structured_output: oracle((entry) => entry.group === "several_others" ? { thread: "other", threads: [2] } : undefined), generation }, progress: () => undefined });
  assert.deepEqual([guessing.report.complete, guessing.report.rules.never_guess.passed, guessing.report.echo_picks_threads], [false, false, false]);
  // One merge outside the same-subject-twice group, and ECHO does not pick threads.
  const merging = await run(options({ caseIds: ["several-tooling-quotes", "open-who-is-reviewing-the-fix"], trials: 1 }),
    { loaded: { structured_output: oracle((entry) => entry.group === "continues_open" ? { thread: "open", resolution: "same", merge: [1] } : undefined), generation }, progress: () => undefined });
  assert.deepEqual([merging.report.rules.never_guess.passed, merging.report.rules.never_merge_wrongly, merging.report.echo_picks_threads],
    [true, { rule: 4, merged_trials: 1, trials: 2, passed: false }, false]);
  assert.equal(readdirSync(out).length, 3);
  // The exit status follows the gate, and nothing else.
  assert.deepEqual([qualifies(report, options()), qualifies(guessing.report, options()), qualifies(merging.report, options())], [true, false, false]);
  // Rule 2 decides too: the whole set, never a guess and never a merge, with the open thread never recognised.
  const misrouting = await run(options(), { loaded: { structured_output: oracle((entry) => entry.group === "continues_open" ? { thread: "new" } : undefined), generation }, progress: () => undefined });
  assert.deepEqual([misrouting.report.complete, misrouting.report.rules.never_guess.passed, misrouting.report.rules.never_merge_wrongly.passed, misrouting.report.rules.route_the_obvious.passed],
    [true, true, true, false]);
  assert.deepEqual([misrouting.report.echo_picks_threads, qualifies(misrouting.report, options())], [false, false]);
});

test("partial_or_repeated_cases_cannot_qualify_threads", async (t) => {
  const { root, credential } = privateRoot(t);
  const out = parseArgs(args(credential, join(root, "report"))).out;
  const ids = document.cases.map((entry) => entry.id);
  // Every run below answers every case exactly as registered, so every rule that has trials passes. Only the whole
  // registered run, each case once with three trials, may say ECHO picks threads; nothing else exits as passing.
  const judged = async (more) => {
    const options = { set: "threads", caseIds: null, trials: 3, timeoutMs: 15_000, out, credentialFile: "/unused", ...more };
    const { report } = await run(options, { loaded: { structured_output: oracle(), generation }, progress: () => undefined });
    assert.ok(report.results.every((result) => result.passed), "the oracle answers as registered");
    return { complete: report.complete, picks: report.echo_picks_threads, exits_passing: qualifies(report, options), trials: report.results.length };
  };
  assert.deepEqual(await judged({}), { complete: true, picks: true, exits_passing: true, trials: 84 });
  assert.deepEqual(await judged({ caseIds: ids }), { complete: true, picks: true, exits_passing: true, trials: 84 });
  // One case, one trial: the selection that used to set the gate and exit 0.
  assert.deepEqual(await judged({ caseIds: ["several-tooling-quotes"], trials: 1 }), { complete: false, picks: false, exits_passing: false, trials: 1 });
  // The same case 28 times with three trials: as many trials as the whole set, of one case.
  assert.deepEqual(await judged({ caseIds: ids.map(() => "several-tooling-quotes") }), { complete: false, picks: false, exits_passing: false, trials: 84 });
  // Every case but one, with another run twice in its place.
  assert.deepEqual(await judged({ caseIds: [...ids.slice(1), ids[1]] }), { complete: false, picks: false, exits_passing: false, trials: 84 });
  // Every case, and one of them twice.
  assert.deepEqual(await judged({ caseIds: [...ids, ids[0]] }), { complete: false, picks: false, exits_passing: false, trials: 87 });
  // One group whole, every case but one, and the whole set with fewer trials.
  const several = document.cases.filter((entry) => entry.group === "several_others").map((entry) => entry.id);
  assert.deepEqual(await judged({ caseIds: several }), { complete: false, picks: false, exits_passing: false, trials: 18 });
  assert.deepEqual(await judged({ caseIds: ids.slice(1) }), { complete: false, picks: false, exits_passing: false, trials: 81 });
  assert.deepEqual(await judged({ trials: 2 }), { complete: false, picks: false, exits_passing: false, trials: 56 });
  // The command line refuses a case named twice, in either set, before any request.
  assert.throws(() => parseArgs(args(credential, join(root, "report"), "--cases", "several-tooling-quotes,several-tooling-quotes")), /--cases must select known cases, each once/u);
  assert.throws(() => parseArgs(args(credential, join(root, "report"), "--cases", [...ids, ids[0]].join(","))), /each once/u);
  assert.throws(() => parseArgs(["--run", "--credential-file", credential, "--out", join(root, "report"), "--cases", "one-dvt-gate-ticket,one-dvt-gate-ticket"]), /each once/u);
  // Every case once, in any order, is still the whole set.
  assert.deepEqual(parseArgs(args(credential, join(root, "report"), "--cases", [...ids].reverse().join(","))).caseIds, [...ids].reverse());
  assert.deepEqual(await judged({ caseIds: [...ids].reverse() }), { complete: true, picks: true, exits_passing: true, trials: 84 });
});
