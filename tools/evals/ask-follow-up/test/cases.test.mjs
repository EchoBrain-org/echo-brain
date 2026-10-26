import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CASES_FILE, GROUPS, caseProblems, loadCases } from "../grade.mjs";

const document = loadCases();
const lower = (text) => text.toLocaleLowerCase("en-US");
/** Everything the resolver is shown of a case's previous turn. */
const shown = (entry) => lower([entry.previous.question, ...entry.previous.statements.map((statement) => statement.text), ...entry.previous.citations.map((citation) => citation.label)].join(" "));

test("the pre-registered set: 30 cases in the design's four groups, each a valid Ask with its previous turn", () => {
  assert.equal(document.cases.length, 30);
  for (const [group, count] of Object.entries(GROUPS)) assert.equal(document.cases.filter((entry) => entry.group === group).length, count, group);
  assert.deepEqual(caseProblems(document), []);
  assert.equal(new Set(document.cases.map((entry) => entry.id)).size, 30);
});

test("carries the founder's example: the DVT gate blocked by one bug ticket, then the details on that ticket", () => {
  const founder = document.cases.find((entry) => entry.id === "one-dvt-gate-ticket");
  assert.equal(founder.group, "one_referent");
  assert.equal(founder.previous.question, "What's blocking the DVT gate?");
  assert.equal(founder.question, "what are the details on that ticket?");
  assert.deepEqual(founder.previous.citations.map((citation) => citation.kind), ["ticket"]);
  assert.deepEqual(founder.expect, { about: [1], names: ["THERM-482"] });
});

test("grounds every expectation in what the resolver is shown", () => {
  for (const entry of document.cases) {
    const text = shown(entry);
    if (entry.group === "one_referent") {
      assert.ok(entry.expect.names.some((name) => text.includes(lower(name))), `${entry.id}: its referent is named in the previous turn`);
      const [source] = entry.expect.about;
      assert.ok(entry.previous.statements.some((statement) => statement.citation_indexes.includes(source - 1)), `${entry.id}: its expected source is cited`);
    }
    if (entry.group === "several_referents") {
      for (const candidate of entry.expect.candidates) assert.ok(candidate.some((name) => text.includes(lower(name))), `${entry.id}: candidate ${candidate[0]} is named`);
    }
  }
});

test("refuses a set that is not the registered one", () => {
  const altered = (change) => { const copy = JSON.parse(readFileSync(CASES_FILE, "utf8")); change(copy); return caseProblems(copy); };
  assert.match(altered((copy) => { copy.cases.pop(); }).join(), /standalone has 4 cases/u);
  assert.match(altered((copy) => { copy.cases[0].expect.about = [2]; }).join(), /about must name sources 1 to 1/u);
  assert.match(altered((copy) => { copy.cases[0].previous.statements[0].citation_indexes = [3]; }).join(), /not a valid Ask with its previous turn/u);
  assert.match(altered((copy) => { copy.cases[10].expect.candidates = [["only one"]]; }).join(), /2 to 4 candidates/u);
  assert.match(altered((copy) => { copy.cases[20].expect.terms = ["absent term"]; }).join(), /must carry its terms/u);
  assert.match(altered((copy) => { copy.cases[1].id = copy.cases[0].id; }).join(), /missing or repeated/u);
  assert.deepEqual(altered((copy) => { copy.kind = "other"; }), ["the cases document kind is invalid"]);
});
