import assert from "node:assert/strict";
import test from "node:test";
import { ANSWER_LAYOUT_PROMPT } from "../../../../packages/organization-authority-kernel/dist/answer-composition/agentic-ask-v1-model-protocol.js";
import { CATALOGS, WORDING_RULES, readReply, writerPrompts } from "../catalogs.mjs";

const catalog = (id) => CATALOGS.find((entry) => entry.id === id);
const captured = {
  system_prompt: `You write Echo's final answer.\n\n${ANSWER_LAYOUT_PROMPT}`,
  user_prompt: JSON.stringify({ question: "Who owns it?", source_catalog: [], research: {}, evidence: [{ id: "E1" }] }),
};

test("keeps production's prompt for today and swaps only the layout part, with the catalog as data beside source_catalog", () => {
  assert.deepEqual(writerPrompts(catalog("today"), captured), captured);
  const balanced = writerPrompts(catalog("balanced"), captured);
  assert.ok(balanced.system_prompt.startsWith("You write Echo's final answer.\n\nLayout: the person's app shows the answer as a short document made of blocks."));
  assert.ok(!balanced.system_prompt.includes(ANSWER_LAYOUT_PROMPT));
  for (const rule of WORDING_RULES) assert.ok(balanced.system_prompt.includes(rule) && ANSWER_LAYOUT_PROMPT.includes(rule));
  assert.deepEqual(Object.keys(JSON.parse(balanced.user_prompt)), ["question", "source_catalog", "block_catalog", "research", "evidence"]);
  assert.throws(() => writerPrompts(catalog("balanced"), { ...captured, system_prompt: "You write Echo's final answer." }), /production layout part/u);
});

test("reads a today reply as production lays it out: the lead, a section's table and bullets", () => {
  const read = readReply(catalog("today"), { lists: [], tables: [{ section: "Owners", columns: ["Action", "Owner"] }], not_found: [], sentences: [
    { text: "Two follow-ups are open.", evidence: ["E1"], form: "lead" },
    { text: "", evidence: ["E1"], form: "row", section: "Owners", cells: ["Approve budget", "Noor Haddad"] },
    { text: "", evidence: ["E2"], form: "row", section: "Owners", cells: ["Update plan", "Priya Raman"] },
    { text: "The budget comes first.", evidence: ["E1"], form: "bullet", section: "Order" },
    { text: "The plan follows.", evidence: ["E2"], form: "bullet", section: "Order" },
  ] });
  assert.equal(read.valid, true);
  assert.deepEqual(read.blocks.map((block) => block.kind), ["answer", "heading", "table", "heading", "list"]);
  assert.deepEqual(read.blocks[2].rows.map((row) => row.evidence), [["E1"], ["E2"]]);
  assert.deepEqual(readReply(catalog("today"), { lists: [], sentences: [], not_found: [] }).problems, ["the reply has no sentence"]);
});

test("checks balanced blocks against their entries and names each problem", () => {
  const good = readReply(catalog("balanced"), { not_found: [], blocks: [
    { block: "answer", sentences: [{ text: "It moved twice.", evidence: ["E1"] }] },
    { block: "timeline", title: "Dates", events: [{ date: "2026-09-10", text: "Set for Oct 5.", evidence: ["E1"] }, { date: "2026-09-24", text: "Moved to Oct 12.", evidence: ["E2"] }] },
    { block: "card", title: "THERM-482", kind: "ticket", facts: [{ label: "Status", value: "In Progress", evidence: ["E3"] }, { label: "Owner", value: "Tomas Okafor", evidence: ["E3"] }] },
  ] });
  assert.equal(good.valid, true);
  assert.deepEqual(good.view.map((node) => node.t), ["lead", "h", "timeline", "card"]);
  const bad = readReply(catalog("balanced"), { not_found: [], blocks: [
    { block: "table", columns: ["Owner", "Due"], rows: [{ cells: ["Priya"], evidence: ["E1"] }, { cells: ["Tomas", "2026-11-02"], evidence: ["E2"] }] },
    { block: "timeline", events: [{ date: "Nov 2", text: "Flash firmware.", evidence: ["E1"] }, { date: "2026-11-06", text: "Soak.", evidence: ["E2"] }] },
    { block: "quote", text: "Ship it.", from: "Review", evidence: ["E1", "E2"] },
  ] });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.problems, [
    "blocks[0] must be the answer block",
    "blocks[0].rows[0] must have one cell per column (2), not 1",
    "blocks[1].events[0].date must be YYYY-MM-DD",
    "blocks[2].evidence must be the one id the quote is copied from",
  ]);
});

test("reads one filled template, and refuses a template the catalog does not have", () => {
  const report = readReply(catalog("templates"), { not_found: [], template: { name: "report", answer: [{ text: "Two are open.", evidence: ["E1"] }], columns: ["Action", "Owner"],
    rows: [{ cells: ["Budget", "Noor Haddad"], evidence: ["E1"] }, { cells: ["Plan", "Priya Raman"], evidence: ["E2"] }], notes: [{ text: "The budget comes first.", evidence: ["E1"] }] } });
  assert.equal(report.valid, true);
  assert.deepEqual(report.blocks.map((block) => block.kind), ["answer", "table", "prose"]);
  const unknown = readReply(catalog("templates"), { not_found: [], template: { name: "dashboard", answer: [{ text: "Two are open.", evidence: ["E1"] }] } });
  assert.deepEqual(unknown.problems, ["template.name must be one of fact, list, report, story, profile"]);
});

const text = (id, words, evidence, variant = "body") => ({ id, component: "Text", variant, text: words, ...(evidence === undefined ? {} : { evidence }) });

test("infers primitives' answer, table, card, list and quote from their structure", () => {
  const read = readReply(catalog("primitives"), { root: "main", not_found: [], components: [
    { id: "main", component: "Column", children: ["answer", "table", "card", "steps", "quote"] },
    text("answer", "Two follow-ups are open.", ["E1"]),
    { id: "table", component: "Column", children: ["head", "r1", "r2"] },
    { id: "head", component: "Row", children: ["h1", "h2"] }, text("h1", "Owner", undefined, "caption"), text("h2", "Due", undefined, "caption"),
    { id: "r1", component: "Row", children: ["a1", "b1"] }, text("a1", "Noor Haddad", ["E1"]), text("b1", "2026-11-03", ["E1"]),
    { id: "r2", component: "Row", children: ["a2", "b2"] }, text("a2", "Priya Raman", ["E2"]), text("b2", "2026-11-05", ["E2"]),
    { id: "card", component: "Card", child: "facts" }, { id: "facts", component: "Column", children: ["title", "p1", "p2"] }, text("title", "THERM-482", undefined, "heading"),
    { id: "p1", component: "Row", children: ["l1", "v1"] }, text("l1", "Status", undefined, "caption"), text("v1", "In Progress", ["E3"]),
    { id: "p2", component: "Row", children: ["l2", "v2"] }, text("l2", "Owner", undefined, "caption"), text("v2", "Tomas Okafor", ["E3"]),
    { id: "steps", component: "List", ordered: true, children: ["s1", "s2"] }, text("s1", "Flash firmware 2.3 first.", ["E1"]), text("s2", "Then run the soak.", ["E2"]),
    text("quote", "“PVT starts on Nov 16 only if the DVT gate has passed.”", ["E4"]),
  ] });
  assert.equal(read.valid, true);
  assert.deepEqual(read.blocks.map((block) => block.kind), ["answer", "table", "card", "list", "quote"]);
  assert.deepEqual(read.blocks[1].columns, ["Owner", "Due"]);
  assert.deepEqual(read.blocks[2].facts.map((fact) => fact.label), ["Status", "Owner"]);
  assert.equal(read.blocks[3].ordered, true);
  assert.equal(read.view[0].component, "Column");
});

test("refuses a primitives tree that is not one tree under its root, or that does not open with the answer", () => {
  const read = readReply(catalog("primitives"), { root: "main", not_found: [], components: [
    { id: "main", component: "Column", children: ["list", "card", "ghost"] },
    { id: "list", component: "List", ordered: false, children: ["one", "two"] }, text("one", "The fan stalls at cold start.", ["E1"]), text("two", "The certificate is missing.", ["E2"]),
    { id: "card", component: "Card", child: "one" },
    text("loose", "Nobody holds this text.", ["E1"]),
  ] });
  assert.equal(read.valid, false);
  assert.deepEqual(read.problems, [
    "component main holds ghost, which is not a component",
    "component one is inside both list and card",
    "component loose is not inside root",
    "root must show a body Text first: the direct answer",
  ]);
});
