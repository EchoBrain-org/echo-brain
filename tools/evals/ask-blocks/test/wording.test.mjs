import assert from "node:assert/strict";
import test from "node:test";
import { validatePersonAnswerResponseV8 } from "@echo-brain/organization-api";
import { gradeTrial, leadOf, loadCases, mentions, sharedRun, summarizeRules, words } from "../wording.mjs";

const document = loadCases();
const founder = document.cases.find((entry) => entry.id === "follow-up-owner-quoted-title");
const ID = "clean-v1-20261026-ask-timeline-aa79d90";
/** The answer the founder saw on staging on 2026-10-26, as one laid-out part citing the follow-up. */
const SCREENSHOT = `Noor Haddad owns the follow-up "Approve release ${ID} and choose who can read it."`;

/** `statements` as one part in blocks, each citing the first source: the first is the answer block, the rest one text block. */
function answer(statements, { outcome = "answered", kinds = ["follow_up"] } = {}) {
  const rest = statements.slice(1).map((_, index) => index + 1);
  return {
    outcome, citations: kinds.map((kind) => ({ kind })),
    parts: [{ status: "answered", statements: statements.map((text) => ({ text, citation_indexes: [0], private: false })),
      blocks: [{ kind: "answer", statements: [0] }, ...(rest.length === 0 ? [] : [{ kind: "text", statements: rest }])] }],
  };
}

const FOLLOW_UP = "itm_0123456789abcdef01234567";
/** The founder's question answered with layout v2 (ADR-0051): `blocks` over `statements`, each citing the follow-up, as the kernel releases it. */
function blocksAnswer(blocks, statements) {
  return validatePersonAnswerResponseV8({
    schema_version: 8, kind: "echo-clean-person-answer-v8", scope: { kind: "global" }, outcome: "answered",
    citations: [{ citation: { kind: "follow_up", item_id: FOLLOW_UP }, kind: "follow_up", label: `Approve release ${ID} and choose who can read it.`, visibility: "team", ref: `follow_up:${FOLLOW_UP}` }],
    parts: [{ question: founder.question, status: "answered", statements: statements.map((text) => ({ text, citation_indexes: [0], private: false })), blocks }],
  });
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

test("takes the lead from the answer block, or else from the first statement", () => {
  const facts = [{ label: "Status", value: "Open" }, { label: "Owner", value: "You" }];
  const card = (title) => ({ kind: "card", title, entity: "decision", statements: [2, 3], facts });
  const answered = blocksAnswer([{ kind: "answer", statements: [0, 1] }, card("The follow-up")],
    ["You own it.", "It is still open.", "Decision: The follow-up; Status: Open.", "Decision: The follow-up; Owner: You."]);
  assert.equal(leadOf(answered), "You own it. It is still open.");
  assert.deepEqual(gradeTrial(founder, answered).rules, { no_restating: true, long_ids_once: true, nothing_lost: true });
  // With no answer block, the first statement leads, as it does in an answer without layout; with no part, nothing does.
  assert.equal(leadOf(blocksAnswer([{ kind: "points", ordered: false, statements: [0, 1] }], ["You own it.", "It is still open."])), "You own it.");
  assert.equal(leadOf({ parts: [] }), "");
  // The answer's text is its statements, as the audit reads them: a long identifier that titles a card is written in each of its facts.
  const titled = gradeTrial(founder, blocksAnswer([{ kind: "answer", statements: [0, 1] }, card(ID)],
    ["You own it.", "It is still open.", `Decision: ${ID}; Status: Open.`, `Decision: ${ID}; Owner: You.`]));
  assert.deepEqual([titled.id_mentions[ID], titled.rules.long_ids_once], [2, false]);
});

test("passes each rule at 90% of all trials, and ships the wording only when all three pass", () => {
  const trial = (rules) => ({ grade: { ...gradeTrial(founder, answer(["You own it."])), rules } });
  const pass = { no_restating: true, long_ids_once: true, nothing_lost: true };
  const at = (failing) => summarizeRules(Array.from({ length: 30 }, (_, index) => trial(index < failing ? { ...pass, no_restating: false } : pass)));
  assert.deepEqual([at(3).rules.no_restating.passed, at(3).wording_ships], [true, true]);
  assert.deepEqual([at(4).rules.no_restating.passed, at(4).rules.no_restating.passed_trials, at(4).wording_ships], [false, 26, false]);
  assert.deepEqual(at(0).measures, { mean_shared_words: 1, max_shared_words: 1, mean_lead_words: 3, mean_statements: 1, long_id_mentions: 0, leads_naming_a_question_id: 0 });
});
