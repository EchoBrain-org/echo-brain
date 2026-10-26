import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ANSWER_LAYOUT_PROMPT } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { CASES_FILE, caseProblems, loadCases } from "../grade.mjs";

const document = loadCases();

test("holds the pre-registered set: six questions naming a long identifier or title, four plain ones", () => {
  assert.deepEqual(caseProblems(document), []);
  assert.deepEqual(Object.groupBy(document.cases, (entry) => entry.group).names_long_id.length, 6);
  assert.equal(document.cases.length, 10);
});

test("refuses a set that is not the registered one", () => {
  const changed = (edit) => { const copy = JSON.parse(readFileSync(CASES_FILE, "utf8")); edit(copy.cases); return caseProblems(copy); };
  assert.match(changed((cases) => cases.pop()).join(), /plain has 3 cases, not 4/u);
  assert.match(changed((cases) => { cases[0].expect.facts = [["Ada Lovelace"]]; }).join(), /no item says Ada Lovelace/u);
  assert.match(changed((cases) => { cases[1].long_ids = ["clean-v1-20990101-never-mentioned-0000000"]; }).join(), /in neither the question nor the items/u);
  assert.match(changed((cases) => { cases[2].expect.cites = ["ticket"]; }).join(), /cites must name item kinds the case has/u);
});

/** The capitalized words of a text past each sentence's first ("Nov", "THERM-482"), and its runs of four words. */
function names(text) {
  return new Set(text.split(/(?<=[.?!:])\s+/u).flatMap((sentence) => sentence.split(/[\s,;()"']+/u).filter(Boolean).slice(1))
    .map((word) => word.replace(/(?:'s|[.?!:])+$/u, "")).filter((word) => /^\p{Lu}/u.test(word)));
}
function phrases(text) {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  return new Set(words.slice(3).map((_, index) => words.slice(index, index + 4).join(" ")));
}

test("asks nothing the layout prompt's examples quote, so the eval measures its rules, not recall of an example", () => {
  // Every quoted example in the layout prompt's rules (not its reply shape): no name and no run of four words of any case question.
  const rules = ANSWER_LAYOUT_PROMPT.split("\n").filter((line) => line.startsWith("- "));
  const examples = rules.flatMap((line) => [...line.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  assert.ok(examples.length > 6);
  const [exampleNames, examplePhrases] = [new Set(examples.flatMap((text) => [...names(text)])), new Set(examples.flatMap((text) => [...phrases(text)]))];
  const shared = document.cases.flatMap(({ id, question }) => [...[...names(question)].filter((name) => exampleNames.has(name)),
    ...[...phrases(question)].filter((phrase) => examplePhrases.has(phrase))].map((overlap) => `${id}: ${overlap}`));
  assert.deepEqual(shared, []);
});
