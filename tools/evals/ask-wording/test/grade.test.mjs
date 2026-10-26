import assert from "node:assert/strict";
import test from "node:test";
import { gradeTrial, leadOf, loadCases, mentions, sharedRun, summarizeRules, words } from "../grade.mjs";

const document = loadCases();
const founder = document.cases.find((entry) => entry.id === "follow-up-owner-quoted-title");
const ID = "clean-v1-20261026-ask-timeline-aa79d90";
/** The answer the founder saw on staging on 2026-10-26, as one laid-out part citing the follow-up. */
const SCREENSHOT = `Noor Haddad owns the follow-up "Approve release ${ID} and choose who can read it."`;

function answer(statements, { lead = [0], outcome = "answered", kinds = ["follow_up"] } = {}) {
  return {
    outcome, citations: kinds.map((kind) => ({ kind })),
    parts: [{ status: "answered", statements: statements.map((text) => ({ text, citation_indexes: [0], private: false })),
      layout: lead.length === 0 ? [{ kind: "paragraph", statements: statements.map((_, index) => index) }] : [{ kind: "lead", statements: lead }] }],
  };
}

test("reads words as a reader does: an identifier is one word, quotes and punctuation are none", () => {
  assert.deepEqual(words(`Who owns "Approve release ${ID}"? It's open.`), ["who", "owns", "approve", "release", ID, "it's", "open"]);
  assert.equal(sharedRun(SCREENSHOT, founder.question), 12);
  assert.equal(sharedRun("You own it.", founder.question), 1);
  // Only the whole identifier counts; a short reference to it does not.
  assert.deepEqual([mentions(`${ID} and ${ID.toUpperCase()}`, ID), mentions("release aa79d90", ID)], [2, 0]);
});

test("grades the founder's answer as restating the question and repeating its identifier, with nothing lost", () => {
  const grade = gradeTrial(founder, answer([SCREENSHOT, "It is open."]));
  assert.deepEqual([grade.shared_words, grade.id_mentions[ID], grade.lead_names_question_id], [12, 1, true]);
  assert.deepEqual(grade.rules, { no_restating: false, long_ids_once: false, nothing_lost: true });
  assert.deepEqual(gradeTrial(founder, answer(["You own it.", "It is open, sent today."])).rules, { no_restating: true, long_ids_once: true, nothing_lost: true });
});

test("loses nothing only when the answer is answered, cited, from the expected sources, and says every fact", () => {
  const short = ["You own it."];
  assert.equal(gradeTrial(founder, answer(["It is open."])).rules.nothing_lost, false);
  assert.equal(gradeTrial(founder, answer(short, { outcome: "partial" })).rules.nothing_lost, false);
  assert.equal(gradeTrial(founder, answer(short, { kinds: ["decision"] })).rules.nothing_lost, false);
  const uncited = answer(short);
  uncited.parts[0].statements[0].citation_indexes = [];
  assert.equal(gradeTrial(founder, uncited).rules.nothing_lost, false);
  // An identifier the question does not name may be written once, and twice is once too many.
  const release = document.cases.find((entry) => entry.id === "which-release-plain");
  const named = "clean-v1-20261020-meeting-routing-b62b11b";
  assert.deepEqual(gradeTrial(release, answer([`It approved ${named}.`], { kinds: ["decision"] })).rules, { no_restating: true, long_ids_once: true, nothing_lost: true });
  assert.equal(gradeTrial(release, answer([`It approved ${named}.`, `${named} waits for one check.`], { kinds: ["decision"] })).rules.long_ids_once, false);
  // A trial with no answer passes no rule.
  assert.deepEqual(gradeTrial(founder, null).rules, { no_restating: false, long_ids_once: false, nothing_lost: false });
});

test("takes the lead from the lead block, or else from the first statement", () => {
  assert.equal(leadOf(answer(["First.", "Second."], { lead: [0, 1] })), "First. Second.");
  assert.equal(leadOf(answer(["First.", "Second."], { lead: [] })), "First.");
  assert.equal(leadOf({ parts: [] }), "");
});

test("passes each rule at 90% of all trials, and ships the wording only when all three pass", () => {
  const trial = (rules) => ({ grade: { ...gradeTrial(founder, answer(["You own it."])), rules } });
  const pass = { no_restating: true, long_ids_once: true, nothing_lost: true };
  const at = (failing) => summarizeRules(Array.from({ length: 30 }, (_, index) => trial(index < failing ? { ...pass, no_restating: false } : pass)));
  assert.deepEqual([at(3).rules.no_restating.passed, at(3).wording_ships], [true, true]);
  assert.deepEqual([at(4).rules.no_restating.passed, at(4).rules.no_restating.passed_trials, at(4).wording_ships], [false, 26, false]);
  assert.deepEqual(at(0).measures, { mean_shared_words: 1, max_shared_words: 1, mean_lead_words: 3, mean_statements: 1, long_id_mentions: 0, leads_naming_a_question_id: 0 });
});
