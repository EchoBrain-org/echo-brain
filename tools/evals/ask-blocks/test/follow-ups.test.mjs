import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ANSWER_FOLLOW_UPS_PROMPT, answerBlocksFollowUpsSchema } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { CASES_FILE, CASE_IDS, caseProblems, gradeTrial, loadCases, summarize } from "../follow-ups.mjs";
import { parseArgs, run } from "../run.mjs";

const document = loadCases();
const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072, max_output_tokens: 16_000 };
const caseOf = (id) => document.cases.find((entry) => entry.id === id);

test("holds the pre-registered set: a clear request, an implied task, an ordinary question, an unknown owner and a relative date", () => {
  assert.deepEqual(caseProblems(document), []);
  assert.deepEqual(document.cases.map((entry) => entry.id), CASE_IDS);
  // The relative days are pinned to the cases' today, a Wednesday: Friday is the 20th, Monday the 23rd.
  assert.equal(new Date(`${document.today}T12:00:00Z`).getUTCDay(), 3);
  assert.deepEqual([caseOf("clear-request").expect.due_on, caseOf("relative-date").expect.due_on], ["2026-11-20", "2026-11-23"]);
});

test("refuses a set that is not the registered one", () => {
  const changed = (edit) => { const copy = JSON.parse(readFileSync(CASES_FILE, "utf8")); edit(copy.cases); return caseProblems(copy); };
  assert.match(changed((cases) => cases.pop()).join(), /not clear-request/u);
  assert.match(changed((cases) => { cases[0].expect.owner = "Ada Lovelace"; }).join(), /does not name Ada Lovelace/u);
  assert.match(changed((cases) => { cases[2].expect.owner = null; }).join(), /expects nothing else/u);
  assert.match(changed((cases) => { cases[1].expect.drafts = 2; }).join(), /must be 0 or 1/u);
});

test("grades what the release saved against the case, and the answer's ids against what was saved", () => {
  const clear = caseOf("clear-request");
  const draft = { item_id: "itm_00000000000000000000000000000001", task: "Get a second fixture quote", owner_name: "Sam Lee", due_on: "2026-11-20" };
  const response = { follow_ups: [draft.item_id] };
  assert.deepEqual(gradeTrial(clear, response, [draft]).checks, { released: true, listed: true, count: true, owner: true, due_on: true, task: true });
  assert.equal(gradeTrial(clear, response, [draft]).passed, true);
  assert.deepEqual(gradeTrial(clear, { follow_ups: [draft.item_id] }, [{ ...draft, due_on: "2026-11-27" }]).checks.due_on, false);
  assert.deepEqual(gradeTrial(clear, {}, [draft]).checks.listed, false);
  // An ordinary question passes only with nothing drafted and nothing listed.
  assert.equal(gradeTrial(caseOf("ordinary-question"), {}, []).passed, true);
  assert.equal(gradeTrial(caseOf("ordinary-question"), response, [draft]).passed, false);
  // An unknown owner passes only with no owner.
  assert.equal(gradeTrial(caseOf("unknown-owner"), response, [{ ...draft, task: "Send the calibration report" }]).checks.owner, false);
  assert.equal(gradeTrial(caseOf("unknown-owner"), response, [{ item_id: draft.item_id, task: "Send the calibration report" }]).passed, true);
  assert.equal(gradeTrial(clear, null, []).passed, false);
});

/** A writer that drafts what each case expects, and nothing for the ordinary question; it never sees a credential. */
function drafting(inputs = []) {
  return { inputs, async generate_with_observation(input) {
    inputs.push(input);
    const shown = JSON.parse(input.user_prompt);
    const entry = document.cases.find((value) => value.question === shown.question);
    const expect = entry.expect;
    const follow_ups = expect.drafts === 0 ? [] : [{ task: `Handle the ${expect.task_mentions.join(" and ")}`,
      ...(typeof expect.owner === "string" ? { owner: expect.owner } : {}), ...(expect.due_on === undefined ? {} : { due_on: expect.due_on }) }];
    return { value: { blocks: [{ block: "answer", sentences: [{ text: "The review approved it.", evidence: [shown.evidence[0].id] }] }], not_found: [], follow_ups },
      finish_reason: "stop", usage: null, provider_latency_ms: 1 };
  } };
}

test("runs the follow-up cases through the kernel, the writer told to draft, and decides only on every case three times", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ask-follow-ups-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "credential"), "not read", { mode: 0o600 });
  assert.equal(parseArgs(["--run", "--credential-file", join(root, "credential"), "--out", join(root, "out"), "--case-set", "follow_ups"]).caseSet, "follow_ups");
  const options = { run: true, credentialFile: null, out: root, caseSet: "follow_ups", caseIds: null, trials: 3, concurrency: 2, timeoutMs: 20_000 };
  const writer = drafting();
  const { report } = await run(options, { loaded: { structured_output: writer, generation }, progress: () => undefined });
  assert.ok(writer.inputs.every((input) => input.system_prompt.endsWith(ANSWER_FOLLOW_UPS_PROMPT)));
  assert.deepEqual(writer.inputs[0].schema, answerBlocksFollowUpsSchema);
  assert.deepEqual([report.case_set, report.complete, report.summary.passed, report.summary.trials, report.decision.passes, report.decision.drafted_on_ordinary_question], ["follow_ups", true, 15, 15, true, 0]);
  assert.ok(!JSON.stringify(report).includes("You write Echo's final answer"), "no prompt text is kept");
  // A writer that drafts on the ordinary question fails that case.
  const eager = { inputs: [], async generate_with_observation(input) {
    const reply = await drafting().generate_with_observation(input);
    const follow_ups = reply.value.follow_ups.length === 0 ? [{ task: "Review the fan curve" }] : reply.value.follow_ups;
    return { ...reply, value: { ...reply.value, follow_ups } };
  } };
  const failing = (await run(options, { loaded: { structured_output: eager, generation }, progress: () => undefined })).report;
  assert.deepEqual([failing.summary.cases["ordinary-question"].passed, failing.summary.drafted_on_ordinary_question, failing.decision.passes], [0, 3, false]);
  assert.equal(summarize([]).passes, false);
});
