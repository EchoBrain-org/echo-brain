import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { caseAsk, caseItems, scriptedModel } from "../../shared/ask-cases.mjs";
import { CASE_IDS, PASS, caseProblems, decide, gradeTrial, loadCases, placedLists, releasedLists, summarize } from "../lists.mjs";
import { run } from "../run.mjs";

const generation = { generation_adapter_id: "fixture", planner_model: "fixture-model", answer_model: "fixture-model", timeout_ms: 30_000, context_tokens: 131_072 };
const document = loadCases();
const caseOf = (id) => document.cases.find((entry) => entry.id === id);
const whichItems = caseOf("which-items");
const byMeaning = caseOf("part-by-meaning");
const ids = (count) => Array.from({ length: count }, (_, at) => `E${at + 1}`);

/** A writer's reply: one sentence citing E1, then `blocks`. */
const replyWith = (...blocks) => ({ blocks: [{ block: "answer", sentences: [{ text: "THERM-601 needs a second probe tip supplier.", evidence: ["E1"] }] }, ...blocks], not_found: [] });
const wholeReply = replyWith({ block: "list", list: "L1" });
/** A released answer read as blocks: an answer that says `lead`, then one table captioned `caption` whose rows cite `rows`. */
const readWith = (caption, rows, lead = "THERM-601 needs a second probe tip supplier.") => ({ valid: true, problems: [], blocks: [
  { kind: "answer", claims: [{ text: lead, evidence: ["E1"] }] },
  { kind: "table", caption, columns: ["Ticket", "Status", "Owner"], rows: rows.map((id) => ({ cells: [`${id} title`, "To Do", "Dana Lee"], evidence: [id] })) },
] });
const wholeRead = readWith("5 Jira tickets created on October 4, 2026", ids(5));
const response = { outcome: "answered", parts: [{ status: "answered" }] };

test("holds the pre-registered set: seven cases, each a scripted list research the kernel accepts", async () => {
  assert.deepEqual(document.cases.map((entry) => entry.id), [...CASE_IDS]);
  assert.deepEqual(caseProblems(document), []);
  const writer = () => ({ value: replyWith(), finish_reason: "stop", usage: null, provider_latency_ms: null });
  for (const entry of document.cases) {
    const items = caseItems("lists", entry);
    const listed = items.filter((_, at) => entry.items[at].listed === true);
    const ask = caseAsk(items, document, document.asked_at, scriptedModel(entry, writer, "refused").model, generation, undefined, { listed });
    const { research } = await ask.answerWithResearch({ question: entry.question });
    assert.deepEqual(research.rounds.flatMap((round) => round.rejected), [], entry.id);
    assert.equal(research.stop.completed, true, entry.id);
    assert.deepEqual(research.lists.map((list) => [list.id, list.members, list.complete]), [["L1", ids(listed.length), true]], entry.id);
  }
});

test("refuses a set that is not the registered one", () => {
  const reordered = { ...document, cases: [document.cases[1], document.cases[0], ...document.cases.slice(2)] };
  assert.match(caseProblems(reordered)[0], /^the cases are part-by-fact, which-items/u);
  const unlisted = structuredClone(document);
  unlisted.cases[0].items[0].listed = false;
  assert.deepEqual(caseProblems(unlisted), ["case which-items: the list must be two or more tickets, first among the items"]);
  const wrongCount = structuredClone(document);
  wrongCount.cases[6].expect.count = 8;
  assert.deepEqual(caseProblems(wrongCount), ["case how-many: count is the whole list's, with its noun"]);
});

test("reads a placed list from a list block and from the reply shape before ADR-0054", () => {
  assert.deepEqual(placedLists({ blocks: [{ block: "list", list: "L1", where: { field: "status", value: "open" } }] }), [{ list: "L1", where: { field: "status", value: "open" } }]);
  assert.deepEqual(placedLists({ lists: [{ id: "L1", members: ["E2"] }], blocks: [] }), [{ list: "L1", members: ["E2"] }]);
  assert.deepEqual([placedLists(null), placedLists({ blocks: [{ block: "answer", sentences: [] }], not_found: [] })], [[], []]);
  // A caption says how many it shows of how many, after fitting too.
  assert.deepEqual(releasedLists(readWith("3 of the 9 Jira tickets created on October 4, 2026 (first 2 shown)", ["E1", "E3"])).map(({ shown, total }) => [shown, total]), [[2, 9]]);
  assert.deepEqual(releasedLists(readWith("At least 12 Jira tickets created on October 4, 2026", ["E1"])).map(({ shown, total }) => [shown, total]), [[12, 12]]);
});

test("fails a trial whose release came from the fallback, whatever the answer shows", () => {
  const grade = gradeTrial(whichItems, { reply: wholeReply, read: wholeRead, response, fallbacks: 1 });
  assert.equal(grade.checks.own_reply, false);
  assert.equal(grade.passed, false);
  // With no reply at all, the same.
  assert.equal(gradeTrial(whichItems, { reply: null, read: wholeRead, response, fallbacks: 0 }).checks.own_reply, false);
});

test("passes which-items only when the reply places the list and the answer shows every member", () => {
  assert.deepEqual(gradeTrial(whichItems, { reply: wholeReply, read: wholeRead, response, fallbacks: 0 }).checks, { released: true, own_reply: true, placed: true, shown: true });
  // Hand-picking every member is the whole list; the old reply shape is read the same way.
  assert.equal(gradeTrial(whichItems, { reply: replyWith({ block: "list", list: "l1", members: ids(5).reverse() }), read: wholeRead, response, fallbacks: 0 }).checks.placed, true);
  assert.equal(gradeTrial(whichItems, { reply: { ...replyWith(), lists: [{ id: "L1" }] }, read: wholeRead, response, fallbacks: 0 }).checks.placed, true);
  // Code's list in the answer does not make the writer's choice: a reply with no list fails `placed`.
  const unplaced = gradeTrial(whichItems, { reply: replyWith(), read: wholeRead, response, fallbacks: 0 });
  assert.deepEqual([unplaced.checks.placed, unplaced.checks.shown, unplaced.passed], [false, true, false]);
  // A table that lacks a row, or a caption that is not the list's count, fails `shown`.
  assert.equal(gradeTrial(whichItems, { reply: wholeReply, read: readWith("5 Jira tickets created on October 4, 2026", ids(4)), response, fallbacks: 0 }).checks.shown, false);
  assert.equal(gradeTrial(whichItems, { reply: wholeReply, read: readWith("4 Jira tickets created on October 4, 2026", ids(5)), response, fallbacks: 0 }).checks.shown, false);
  assert.equal(gradeTrial(whichItems, { reply: wholeReply, read: { valid: false, problems: ["x"], blocks: [] }, response, fallbacks: 0 }).checks.released, false);
});

test("passes a part only on exactly its members and a caption that says shown of total", () => {
  const reply = replyWith({ block: "list", list: "L1", members: ["E1", "E3", "E6"] });
  const lead = "Only 6 of the 9 tickets were read in full; these mention the probe recall.";
  const passing = gradeTrial(byMeaning, { reply, read: readWith("3 of the 9 Jira tickets created on October 4, 2026", ["E1", "E3", "E6"], lead), response, fallbacks: 0 });
  assert.deepEqual([passing.checks, passing.passed], [{ released: true, own_reply: true, placed: true, shown: true, says: true }, true]);
  // The whole list captioned with its count, or a part with another member, does not show the part.
  assert.equal(gradeTrial(byMeaning, { reply, read: readWith("9 Jira tickets created on October 4, 2026", ["E1", "E3", "E6"], lead), response, fallbacks: 0 }).checks.shown, false);
  assert.equal(gradeTrial(byMeaning, { reply, read: readWith("3 of the 9 Jira tickets created on October 4, 2026", ["E1", "E3", "E7"], lead), response, fallbacks: 0 }).checks.shown, false);
  // A whole list placed is not a part; an answer that does not say how many were read fails `says`.
  assert.equal(gradeTrial(byMeaning, { reply: wholeReply, read: readWith("3 of the 9 Jira tickets", ["E1", "E3", "E6"], lead), response, fallbacks: 0 }).checks.placed, false);
  assert.equal(gradeTrial(byMeaning, { reply, read: readWith("3 of the 9 Jira tickets", ["E1", "E3", "E6"]), response, fallbacks: 0 }).checks.says, false);
});

test("grades what the answer says it did not find, a count, and an answer that places no list", () => {
  const notFound = caseOf("note-not-found");
  const said = { valid: true, problems: [], blocks: [{ kind: "answer", claims: [{ text: "The probe recall goes ahead on October 13, 2026.", evidence: ["E5"] }] }] };
  const missing = { outcome: "partial", parts: [{ status: "partial", gap: "Not found: who approved the probe recall." }] };
  const reply = { ...replyWith(), not_found: ["who approved the probe recall"] };
  assert.deepEqual(gradeTrial(notFound, { reply, read: said, response: missing, fallbacks: 0 }).checks, { released: true, own_reply: true, says: true, not_found_mentions: true });
  // Only the reply, or only the release, saying so is not enough.
  assert.equal(gradeTrial(notFound, { reply: replyWith(), read: said, response: missing, fallbacks: 0 }).checks.not_found_mentions, false);
  assert.equal(gradeTrial(notFound, { reply, read: said, response, fallbacks: 0 }).checks.not_found_mentions, false);
  // A note that disagrees with an opened item: the answer follows the item and never calls its fact not found.
  const disagrees = caseOf("note-disagrees");
  const signed = { valid: true, problems: [], blocks: [{ kind: "answer", claims: [{ text: "Ana Silva signed it off on October 6.", evidence: ["E2"] }] }] };
  assert.equal(gradeTrial(disagrees, { reply: replyWith(), read: signed, response, fallbacks: 0 }).passed, true);
  const typed = { outcome: "partial", parts: [{ status: "partial", gap_details: { not_found: "Who signed off the seal re-test." } }] };
  assert.equal(gradeTrial(disagrees, { reply: replyWith(), read: signed, response: typed, fallbacks: 0 }).checks.not_found_never_mentions, false);
  // How many: the caption's count is the list's, and no sentence counts the tickets otherwise.
  const howMany = caseOf("how-many");
  const counted = (lead) => gradeTrial(howMany, { reply: wholeReply, read: readWith("7 Jira tickets created on October 4, 2026", ids(7), lead), response, fallbacks: 0 }).checks.count;
  assert.deepEqual([counted("Seven tickets were created."), counted("7 tickets were created."), counted("8 Jira tickets were created."), counted("6 tickets were created.")], [true, true, false, false]);
  // One named item: a list placed, or a captioned table shown, fails.
  const named = caseOf("one-named-item");
  const owner = { valid: true, problems: [], blocks: [{ kind: "answer", claims: [{ text: "Ana Silva owns THERM-633.", evidence: ["E3"] }] }] };
  assert.equal(gradeTrial(named, { reply: replyWith(), read: owner, response, fallbacks: 0 }).passed, true);
  assert.deepEqual(Object.values(gradeTrial(named, { reply: wholeReply, read: wholeRead, response, fallbacks: 0 }).checks).slice(2, 4), [false, false]);
});

/** Graded trials of every case, three each, `passed` of them passing: one case passes `worstCase`, others fail one each. */
function trialsPassing(passed, { worstCase = 3 } = {}) {
  let failures = CASE_IDS.length * 3 - passed;
  const failing = new Map(CASE_IDS.map((id) => [id, 0]));
  failing.set(CASE_IDS[0], 3 - worstCase);
  failures -= 3 - worstCase;
  for (const id of CASE_IDS.slice(1)) if (failures > 0) { failing.set(id, 1); failures -= 1; }
  return CASE_IDS.flatMap((id) => [1, 2, 3].map((trial) => ({ case_id: id, trial, grade: { checks: { released: trial > failing.get(id) }, passed: trial > failing.get(id) } })));
}

test("decides on 19 of 21 trials and 2 of 3 in every case, only for a complete run", () => {
  assert.deepEqual(PASS, { trials: 19, per_case: 2 });
  assert.equal(summarize(trialsPassing(19, { worstCase: 2 })).passed, 19);
  assert.equal(decide(summarize(trialsPassing(19, { worstCase: 2 })), true).passes, true);
  assert.equal(decide(summarize(trialsPassing(19, { worstCase: 1 })), true).passes, false);
  assert.equal(decide(summarize(trialsPassing(18, { worstCase: 2 })), true).passes, false);
  assert.equal(decide(summarize(trialsPassing(21)), false).passes, null);
});

test("runs a list case through the kernel and grades it from the writer's reply and the released answer", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "ask-blocks-lists-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // The reply places L1 as a list block, the only shape the kernel reads (ADR-0054).
  const route = { inputs: [], async generate_with_observation(input) {
    route.inputs.push(input);
    return { value: wholeReply, finish_reason: "stop", usage: null, provider_latency_ms: 1 };
  } };
  const options = { run: true, credentialFile: null, out, caseSet: "lists", caseIds: ["which-items"], trials: 1, concurrency: 1, timeoutMs: 20_000 };
  const { report } = await run(options, { loaded: { structured_output: route, generation }, progress: () => undefined });
  assert.deepEqual([report.case_set, report.complete, report.decision.passes, report.summary.passed], ["lists", false, null, 1]);
  const [trial] = report.trials;
  assert.deepEqual(trial.grade.checks, { released: true, own_reply: true, placed: true, shown: true });
  assert.deepEqual(trial.grade.released_lists, [{ caption: "5 Jira tickets created on October 4, 2026", shown: 5, total: 5 }]);
  // The trial keeps full traces: the writer's raw reply and the released answer.
  assert.deepEqual([trial.attempts.length, trial.attempts[0].value.blocks.at(-1), trial.response.outcome], [1, wholeReply.blocks.at(-1), "answered"]);
});
