import assert from "node:assert/strict";
import test from "node:test";
import { caseProblems, datesIn, evidenceOf, factsOf, fits, groundingOf, loadCases, mainShape, shapesOf } from "../grade.mjs";

const document = loadCases();
const caseOf = (id) => document.cases.find((entry) => entry.id === id);
const evidence = evidenceOf(JSON.stringify({ today: "2026-10-30", evidence: [
  { id: "E1", kind: "decision", title: "DVT ship plan", date: "2026-10-28", text: "Before the DVT build ships: first flash firmware 2.3, then run the 72-hour soak, then Ana Silva signs off the test report, and only then Dev Mehta books the courier." },
  { id: "E2", kind: "follow_up", title: "Run the 72-hour soak test", dates: { created: "2026-10-28T12:00:00.000-07:00" }, attributes: { owner: "Priya Raman", status: "open", due_at: "2026-11-06" }, text: "Decided: Run the soak." },
  { id: "E3", kind: "ticket", title: "THERM-488: Thermal pad RoHS certificate missing", date: "2026-09-15", date_kind: "created", attributes: { status: "Blocked", owner: "Dev Mehta" }, text: "Update from the supplier: the certificate is in final review." },
] }));
const answer = (text, ids = ["E1"]) => ({ kind: "answer", claims: [{ text, evidence: ids }] });

test("registers exactly the fifteen cases, each with facts its items say", () => {
  assert.equal(document.cases.length, 15);
  assert.deepEqual(caseProblems({ ...document, cases: document.cases.slice(1) }), ["there are 14 cases, not 15"]);
  const broken = structuredClone(document);
  broken.cases[0].expect.facts = [["Lena Brandt"]];
  assert.deepEqual(caseProblems(broken), ["case soak-owner: no item says Lena Brandt"]);
});

test("reads ISO days and month names, in 2026 unless a year is named", () => {
  assert.deepEqual([...datesIn("Due Nov 3, then 2026-11-06, then October 5, 2025, and Sept 9.")], ["2026-11-06", "2026-11-03", "2025-10-05", "2026-09-09"]);
  assert.deepEqual([...datesIn("The build may slip.")], []);
});

test("grounds a claim only in what it cites: ids, dates, names and quoted words", () => {
  const steps = caseOf("ship-steps");
  const clean = groundingOf(steps, [answer("Flash firmware 2.3 first; Priya Raman runs the soak by Nov 6.", ["E1", "E2"])], evidence);
  assert.deepEqual(clean, { grounded: true, problems: [] });
  const blocks = [
    answer("Four steps come first."),
    { kind: "list", ordered: true, claims: [
      { text: "Flash firmware 2.3.", evidence: [] },
      { text: "Run the soak by Nov 9.", evidence: ["E2"] },
      { text: "Priya Raman signs off the test report.", evidence: ["E1"] },
      { text: "Then \"Dev Mehta books the courier right away\".", evidence: ["E1", "E9"] },
    ] },
  ];
  assert.deepEqual(groundingOf(steps, blocks, evidence).problems, [
    "claim 2 (list) cites nothing",
    "claim 3 (list) writes 2026-11-09, which no item it cites has",
    "claim 4 (list) names Priya Raman, whom no item it cites names",
    "claim 5 (list) cites E9, which the writer was not given",
    "claim 5 (list) quotes \"Dev Mehta books the courier right away\", which is not word for word in what it cites",
  ]);
});

test("refuses an event dated by a ticket's creation day where the case forbids it", () => {
  const trap = caseOf("trap-undated");
  const timeline = [answer("The supplier moved this week.", ["E3"]), { kind: "timeline", events: [
    { date: "2026-09-15", text: "The supplier said the certificate is in final review.", evidence: ["E3"] },
    { date: "2026-10-28", text: "The ship plan was set.", evidence: ["E1"] },
  ] }];
  assert.deepEqual(groundingOf(trap, timeline, evidence).problems, ["claim 2 (timeline) dates an event 2026-09-15, a date the case forbids"]);
  // Writing the creation day in passing is not dating the event.
  assert.equal(groundingOf(trap, [answer("THERM-488, opened Sep 15, says the certificate is in final review.", ["E3"])], evidence).grounded, true);
});

test("finds every required fact, and in a case marked in order, in the listed order after the answer", () => {
  const steps = caseOf("ship-steps");
  const list = (texts) => ({ kind: "list", ordered: true, claims: texts.map((text) => ({ text, evidence: ["E1"] })) });
  const lead = answer("The courier is booked last, after firmware 2.3, the soak and the test report.");
  assert.deepEqual(factsOf(steps, [lead, list(["Flash firmware 2.3.", "Run the soak.", "Sign off the test report.", "Book the courier."])]), { nothing_lost: true, missing: [], in_order: true });
  assert.deepEqual(factsOf(steps, [lead, list(["Run the soak.", "Flash firmware 2.3.", "Sign off the test report.", "Book the courier."])]), { nothing_lost: false, missing: [], in_order: false });
  assert.deepEqual(factsOf(steps, [answer("Flash firmware 2.3, then run the soak.")]).missing, ["test report", "courier"]);
  // A date fact is found in any spelling of the day.
  assert.equal(factsOf(caseOf("notes-due"), [answer("They are due 2026-11-04.")]).nothing_lost, true);
});

test("tells the shapes an answer shows", () => {
  const shapes = (blocks) => [...shapesOf(blocks, evidence)].sort();
  assert.deepEqual(shapes([answer("Priya Raman owns it.", ["E2"])]), ["single"]);
  assert.deepEqual(shapes([answer("Three steps."), { kind: "list", ordered: true, claims: [{ text: "One.", evidence: ["E1"] }, { text: "Two.", evidence: ["E1"] }] }]), ["ordered"]);
  assert.deepEqual(shapes([answer("Two owners."), { kind: "table", title: "Owners", columns: ["Action", "Due"], rows: [{ cells: ["Soak", "2026-11-06"], evidence: ["E2"] }, { cells: ["Courier", "2026-11-10"], evidence: ["E1"] }] },
    { kind: "list", ordered: false, title: "Notes", claims: [{ text: "Soak first.", evidence: ["E1"] }, { text: "Courier last.", evidence: ["E1"] }] }]), ["grid", "parallel", "sections", "sequence"]);
  assert.deepEqual(shapes([answer("It is one ticket."), { kind: "card", title: "THERM-488", card_kind: "ticket", facts: [{ label: "Status", value: "Blocked", evidence: ["E3"] }, { label: "Owner", value: "Dev Mehta", evidence: ["E3"] }] }]), ["profile"]);
  assert.deepEqual(shapes([answer("The plan says:"), { kind: "quote", text: "then run the 72-hour soak, then Ana Silva signs off the test report", from: "DVT ship plan", evidence: ["E1"] }]), ["verbatim"]);
  assert.deepEqual(shapes([answer("It says \"first flash firmware 2.3, then run the 72-hour soak\".")]), ["single", "verbatim"]);
  assert.equal(mainShape([answer("Two steps."), { kind: "list", ordered: true, title: "Steps", claims: [{ text: "One.", evidence: ["E1"] }, { text: "Two.", evidence: ["E1"] }] }]), "ordered");
  assert.equal(mainShape([answer("Priya Raman owns it.", ["E2"])]), "single");
});

test("fits only an answer that shows one of the case's shapes, and a single case only a single answer", () => {
  const parallel = new Set(["parallel"]);
  assert.equal(fits(caseOf("ship-steps"), parallel), false);
  assert.equal(fits(caseOf("review-multi"), parallel), false);
  assert.equal(fits(caseOf("review-multi"), new Set(["sections"])), true);
  assert.equal(fits(caseOf("ticket-profile"), new Set(["prose"])), false);
  assert.equal(fits(caseOf("soak-owner"), new Set(["prose"])), false);
  assert.equal(fits(caseOf("soak-owner"), new Set(["single", "verbatim"])), true);
  assert.equal(fits(caseOf("trap-disagree"), new Set()), true);
});
