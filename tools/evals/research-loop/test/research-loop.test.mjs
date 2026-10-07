import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { datasetProblems, loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { itemMatches, satisfying, ticketKey } from "../lib/match.mjs";
import { codeChecks } from "../lib/checks.mjs";
import { exportBindings } from "../lib/bindings.mjs";
import { rejectedAtIngress, savedResult, startRequest } from "../lib/requests.mjs";
import { aggregate, markdownReport, runScores } from "../lib/report.mjs";
import { judgeInput, parseJudge } from "../lib/judge.mjs";
import { CALIBRATION_SAMPLE_RUNS, agreement, blindSheet, calibrationSheet, calibrationStatus, judgeChecks, scoreCalibration } from "../lib/calibration.mjs";
import { privateDirectory } from "../lib/private-files.mjs";

const dataset = loadDataset();
const meetings = new Map(dataset.additions.meetings.map(meeting => [meeting.id, meeting]));
const titleOf = id => meetings.get(id).title;
const ticket = (key, options = {}) => ({ id: options.id ?? "E1", source: "tickets", kind: "ticket", title: `${key}: Work item`,
  citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud", ticket_id: "10046", permalink: `https://echobrain.atlassian.net/browse/${key}`, text_sha256: "sha256:0" },
  ...(options.owner === undefined ? {} : { attributes: { status: "To Do", owner: options.owner } }),
  read_in_full: options.read ?? true, opened: true, preloaded: false, cited_by_plan: options.cited ?? true, ...(options.text === undefined ? {} : { text: options.text }) });
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const recordCitation = id => ({ kind: "approved_record", atom_id: digest(`atom-${id}`), record_sha256: digest(`record-${id}`), policy_id: "organization-member-readable-person-v2" });
const record = (meeting, kind, id) => ({ id, source: "meetings", kind, title: titleOf(meeting), citation: recordCitation(`${meeting}-${kind}`), text: "x", read_in_full: true, opened: true, preloaded: false, cited_by_plan: false });
const bindings = { project_id: "prj_00000000-0000-4000-8000-000000000003", site: "https://echobrain.atlassian.net", cloud_id: "cloud-1",
  tickets: Object.fromEntries(["2", "18", "38", "40", "46", "47", "48", "50"].map(number => [`THERM-${number}`, `100${number.padStart(2, "0")}`])),
  meetings: Object.fromEntries(["M1", "M2", "M3", "M4", "M5"].map(id => [id, { decision: [recordCitation(`${id}-decision`)], action: [recordCitation(`${id}-action`)], rationale: [] }])) };
const caseById = id => substitutePerson(dataset.cases.find(entry => entry.id === id), "Zhen Ye");
function completedRun(testCase, items, ask, rendered) {
  return { trial: 1, budget: testCase.budget, outcome: "completed", result: { status: "completed", research: {
    kind: "echo-agentic-research-result-v1", trigger: testCase.trigger, goal: { kind: "question", question: testCase.question }, items, plan: [{ part: 1, question: "q", notes: "", needs: [{ need: "n", status: "found", evidence: ["E1"] }] }],
    rounds: [{ round: 1 }], stop: { reason: "finished", completed: true }, cost: { rounds: 2, model_calls: 3, elapsed_ms: 12_000 },
  }, ...(ask === undefined ? {} : { ask }), ...(rendered === undefined ? {} : { rendered }) } };
}
/** An impact card citing these research items (as the renderer cites bundle items). */
const citationOf = item => ({ citation: item.citation, kind: item.kind, label: item.title, visibility: "project" });
function impactCard(cited, decided, affected, extra = {}) {
  const people = new Map();
  for (const row of affected) if (row.owner !== undefined) people.set(row.owner, [...(people.get(row.owner) ?? []), row.citation_index]);
  return { decided, affected, unconfirmed: [], people: [...people].map(([name, items]) => ({ name, items })), status: "assessed", citations: cited.map(citationOf), ...extra };
}
/** Approved record M2 (T1): a card that lists four key items, one unrelated item and one item research never returned. */
function t1CardRun() {
  const testCase = caseById("approved-record-t1-two-decimal-display");
  const items = [record("M2", "decision", "E1"), ticket("THERM-2", { id: "E2" }), ticket("THERM-18", { id: "E3" }), ticket("THERM-54", { id: "E4", owner: "Zhen Ye" }), ticket("THERM-16", { id: "E5" }), ticket("ECHO-6", { id: "E6" })];
  const never = ticket("THERM-99", { id: "E99" });
  const card = impactCard([...items, never], [{ text: "The display shows two decimals.", citation_index: 0 }], [
    { citation_index: 1, says_now: "MRD-02 says one decimal.", relation: "conflicts" },
    { citation_index: 2, says_now: "SW-22b rounds to one decimal.", relation: "confirms" },
    { citation_index: 3, says_now: "OD-REGISTER holds the rounding decision.", relation: "needs_updating", owner: "Zhen Ye" },
    { citation_index: 4, says_now: "SW-22 formats one decimal.", relation: "needs_updating", owner: "Mara Lindqvist" },
    { citation_index: 5, says_now: "ECHO-6 is another project's ticket.", relation: "confirms" },
    { citation_index: 6, says_now: "Not an item research returned.", relation: "confirms" },
  ]);
  return { testCase, items, card, run: completedRun(testCase, items, undefined, card) };
}

test("the committed dataset is structurally valid and keeps the restricted meeting out of evidence", () => {
  assert.deepEqual(datasetProblems(dataset), []);
  assert.ok(dataset.cases.length >= 25);
  assert.ok(dataset.cases.some(entry => entry.trigger === "approved_record") && dataset.cases.some(entry => entry.trigger === "sweep"));
  assert.equal(dataset.cases.some(entry => entry.trigger === "check"), false, "Check cases are approved-record cases now");
  assert.ok(dataset.additions.restricted_project.leak_markers.includes("Corvane"));
});

test("approved-record keys give every affected item a relation and an owner, taken from the case's own evidence", () => {
  const records = dataset.cases.filter(entry => entry.trigger === "approved_record");
  assert.equal(records.length, 3);
  for (const entry of records) {
    assert.equal(entry.scope.kind, "record", `${entry.id}: the run reads where its record is`);
    assert.ok(entry.affected.length > 0 && entry.affected.length <= 20, entry.id);
    for (const item of entry.affected) assert.ok([item.relation].flat().every(value => ["confirms", "conflicts", "needs_updating"].includes(value)) && (item.owner === null || typeof item.owner === "string"), `${entry.id}/${item.id}`);
  }
  // The record's own text decides: M2 keeps the ±0.1 °C accuracy, so the accuracy items confirm it; MRD-02 says one decimal, which M2 both contradicts and updates.
  const t1Key = Object.fromEntries(records.find(entry => entry.id === "approved-record-t1-two-decimal-display").affected.map(item => [item.id, item.relation]));
  for (const id of ["a8", "a9", "a10", "a11", "a12", "a13"]) assert.equal(t1Key[id], "confirms", id);
  assert.deepEqual(t1Key.a1, ["conflicts", "needs_updating"]);
  // Owners come from item details: only the four tickets assigned to the test person have one.
  const owned = records.flatMap(entry => entry.affected.filter(item => item.owner !== null).flatMap(item => item.refs.map(ref => ref.ticket)));
  assert.deepEqual([...new Set(owned)].sort(), ["THERM-47", "THERM-54"]);
  const t1 = records.find(entry => entry.id === "approved-record-t1-two-decimal-display");
  const problems = changed => datasetProblems({ ...dataset, cases: [{ ...t1, ...changed }] });
  assert.deepEqual(problems({}), []);
  assert.ok(problems({ affected: [] }).some(problem => problem.includes("affected items")));
  assert.ok(problems({ scope: { kind: "project", project: "THERM" } }).some(problem => problem.includes("record's scope")));
  for (const relation of ["changes", [], ["conflicts"], ["conflicts", "conflicts"], ["conflicts", "changes"]]) {
    assert.ok(problems({ affected: [{ ...t1.affected[0], relation }] }).some(problem => problem.includes("affected item is invalid")), JSON.stringify(relation));
  }
  assert.ok(problems({ affected: [{ ...t1.affected[0], refs: [{ ticket: "THERM-99" }] }] }).some(problem => problem.includes("not evidence for any part")));
  assert.ok(datasetProblems({ ...dataset, cases: [{ ...caseById("bug-fix-dates-vs-dvt-review"), affected: t1.affected }] }).some(problem => problem.includes("only approved records")));
});

test("substitution replaces the signed-in person everywhere and refuses a missing name", () => {
  assert.equal(JSON.stringify(substitutePerson(dataset.additions, "Zhen Ye")).includes("{{TEST_PERSON}}"), false);
  assert.throws(() => substitutePerson({}, ""));
});

test("items match references by citation identity, never by E-number", () => {
  assert.equal(ticketKey(ticket("THERM-46")), "THERM-46");
  assert.equal(itemMatches(ticket("THERM-46"), { ticket: "THERM-46" }, meetings), true);
  assert.equal(itemMatches({ ...ticket("THERM-46"), citation: { ...ticket("THERM-46").citation, permalink: "https://x.test/other" } }, { ticket: "THERM-46" }, meetings), true, "a title key still identifies the ticket");
  assert.equal(itemMatches(ticket("ECHO-6"), { jira_project: "ECHO" }, meetings), true);
  const page = { kind: "page", title: "MRD — Mock Digital Thermometer", citation: { page_id: "1409025" } };
  assert.equal(itemMatches(page, { page: "1212589" }, meetings), false, "a page never matches by title when its id differs");
  assert.equal(itemMatches(record("M2", "decision", "E2"), { meeting: "M2", item: "decision" }, meetings), true);
  assert.equal(itemMatches(record("M2", "action", "E2"), { meeting: "M2", item: "decision" }, meetings), false);
  assert.equal(itemMatches({ kind: "document_passage", title: `Transcript: ${titleOf("M5")}` }, { meeting: "M5", item: "transcript" }, meetings), true);
});

test("a page section is carried by the chunk holding its heading or the next chunk, not by other chunks", () => {
  const chunk = (index, text) => ({ id: `E${index}`, kind: "page", title: `Gate reviews · section ${index}`, text, citation: { page_id: "1441793", section_id: `s${index}`, version: "4" } });
  const items = [chunk(1, "EVT review text"), chunk(2, "…## DVT review — hold on accuracy\nHOLD"), chunk(3, "continues the DVT hold"), chunk(4, "PVT review")];
  const ref = { page: "1441793", section: "DVT review — hold on accuracy" };
  assert.deepEqual(satisfying(items, ref, meetings).map(item => item.id), ["E2", "E3"]);
  assert.deepEqual(satisfying(items, { page: "1441793" }, meetings).map(item => item.id), ["E1", "E2", "E3", "E4"]);
  assert.deepEqual(satisfying([chunk(1, "EVT"), chunk(4, "PVT")], ref, meetings), []);
});

test("failed and rejected runs score zero and make a case incomplete, never unknown", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const good = codeChecks(testCase, completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }), dataset);
  const failed = codeChecks(testCase, { trial: 2, budget: "live", outcome: "failed", result: { status: "failed", error: { code: "rate_limited" } } }, dataset);
  const report = aggregate([{ checks: good, judge: null }, { checks: failed, judge: null }]);
  assert.equal(report.cases[0].complete_in_every_run, false);
  assert.equal(report.cases[0].tools_found, (good.coverage.found / good.parts.length) / 2);
  assert.equal(report.cases[0].failed_runs, 1);
});

test("code checks separate found, read, cited and handed, and fail on restricted items or markers", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const items = [ticket("THERM-46", { id: "E1" }), ticket("THERM-12", { id: "E2", read: false, cited: false }), record("M6", "decision", "E3")];
  const checks = codeChecks(testCase, completedRun(testCase, items, { writer_evidence: ["E1", "E3"], response: { outcome: "partial", parts: [{ statements: [], gap: "Not found: x." }], citations: [] } }), dataset);
  const p2 = checks.parts.find(part => part.id === "p2");
  const p3 = checks.parts.find(part => part.id === "p3");
  assert.deepEqual([p2.found, p2.read, p2.handed], [true, true, true]);
  assert.deepEqual([p3.found, p3.read, p3.handed], [true, false, false]);
  assert.ok(checks.leaks.some(leak => leak.kind === "item"));
  assert.equal(checks.noise_handed, 1);
  const marker = codeChecks(testCase, completedRun(testCase, [ticket("THERM-46", { text: "Corvane said so" })]), dataset);
  assert.ok(marker.leaks.some(leak => leak.kind === "marker" && leak.marker === "Corvane"));
  assert.equal(codeChecks(testCase, { trial: 1, budget: "live", outcome: "rejected", error: { code: "query_too_long" } }, dataset).status, "rejected_at_ingress");
  const unread = ticket("THERM-46", { id: "E4", read: false });
  const citedUnread = codeChecks(testCase, completedRun(testCase, [unread], { writer_evidence: ["E4"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: unread.citation }] } }), dataset);
  assert.deepEqual(citedUnread.answer_citations, { total: 1, resolved_to_read: 0, unresolved: 1 });
  assert.equal(citedUnread.answer_citation_violations[0].item_index, 0);
  const read = ticket("THERM-46", { id: "E5" });
  const reorderedCitation = { text_sha256: read.citation.text_sha256, permalink: read.citation.permalink, ticket_id: read.citation.ticket_id, external_scope_id: read.citation.external_scope_id, tool_id: read.citation.tool_id, kind: read.citation.kind };
  assert.equal(codeChecks(testCase, completedRun(testCase, [read], { writer_evidence: ["E5"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: reorderedCitation }] } }), dataset).answer_citations.unresolved, 0);
});

test("start requests are envelopes the API and each trigger definition accept; an approved record's request names no scope", async () => {
  const ask = startRequest(caseById("bug-fix-dates-vs-dvt-review"), bindings);
  assert.deepEqual(ask, { schema_version: 1, trigger: "ask", input: { question: "Are the BUG-412 fix dates on track for the DVT gate review?" }, budget: "live", project_id: bindings.project_id });
  assert.deepEqual(startRequest(caseById("approved-record-t1-two-decimal-display"), bindings), { schema_version: 1, trigger: "approved_record", input: { record: bindings.meetings.M2.decision[0] }, budget: "background" });
  const sweep = startRequest(caseById("sweep-two-decimal-propagation"), bindings);
  assert.equal(sweep.trigger, "sweep");
  assert.equal(sweep.project_id, bindings.project_id);
  assert.deepEqual(sweep.input.findings[0].citations[0], { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10018", permalink: "https://echobrain.atlassian.net/browse/THERM-18", text_sha256: sweep.input.findings[0].citations[0].text_sha256 });
  assert.equal(startRequest(caseById("bug-fix-dates-vs-dvt-review"), bindings, "background").budget, "background");

  const { validatePersonResearchEvalStartRequestV1 } = await import("@echo-brain/organization-api");
  const { AGENTIC_TRIGGER_DEFINITIONS_V1 } = await import("@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1");
  for (const entry of dataset.cases) {
    // This Sweep's last finding cites only the M5 transcript, which cannot start research in v1; the runner records it as not started.
    if (entry.id === "sweep-bug-412-and-gate") continue;
    const request = startRequest(substitutePerson(entry, "Zhen Ye"), bindings);
    assert.deepEqual(validatePersonResearchEvalStartRequestV1(request), request, entry.id);
    assert.equal(Object.hasOwn(request, "project_id"), entry.scope.kind === "project", entry.id);
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === request.trigger);
    assert.ok(definition !== undefined, entry.id);
    // The product's question limit now refuses an overlong question on the Authority, which the runner counts as rejected at ingress.
    if (entry.id === "overlong-dvt-schedule-check") assert.throws(() => definition.parseEvent(request.input), { code: "invalid_request" });
    else assert.doesNotThrow(() => definition.parseEvent(request.input), entry.id);
  }
  assert.equal(rejectedAtIngress({ name: "PersonAuthorityClientError", code: "invalid_request" }), true);
  assert.equal(rejectedAtIngress({ name: "OrganizationApiValidationError" }), true);
  assert.equal(rejectedAtIngress({ name: "PersonAuthorityClientError", code: "unavailable" }), false);
});

test("a saved impact-card run keeps the card and the trimmed bundle, never server records", () => {
  const { run, card } = t1CardRun();
  const research = run.result.research;
  const read = { schema_version: 1, kind: "echo-person-research-eval-result-v1", run_id: "rr_00000000-0000-4000-8000-000000000001", status: "completed",
    research: { ...research, gathered_for: { scope: { kind: "global" }, checked_at: null }, server: { receipts: [digest("receipt")], invocation_digests: [], generations: [] } }, rendered: card };
  assert.deepEqual(savedResult(read), { status: "completed", research, rendered: card });
  assert.deepEqual(savedResult({ status: "failed", error: { code: "timed_out", message: "late" } }), { status: "failed", error: { code: "timed_out", message: "late" } });
});

test("impact cards are graded on listed items, relations, owners, and invented items or people", () => {
  const { testCase, run } = t1CardRun();
  const checks = codeChecks(testCase, run, dataset);
  assert.equal(checks.status, "completed");
  assert.equal(checks.card.expected, testCase.affected.length);
  // THERM-2, THERM-18, THERM-54 and THERM-16 are key items; THERM-18's relation (not in its accepted list) and THERM-16's owner are wrong.
  assert.deepEqual([checks.card.listed, checks.card.relations_correct, checks.card.owners_correct], [4, 3, 3]);
  assert.deepEqual(checks.card.invented.map(entry => entry.kind === "person" ? entry.name : entry.label).sort(), ["ECHO-6: Work item", "Mara Lindqvist", "THERM-99: Work item"]);
  const scores = runScores({ checks, judge: null });
  assert.deepEqual([scores.card_items_listed, scores.card_relations_correct, scores.card_owners_correct, scores.card_invented], [4 / testCase.affected.length, 0.75, 0.75, 3]);
  assert.equal(scores.complete_and_supported, false, "an invented item or person fails the run without a judge");
  // A card is part of the run's released text: a restricted name in it is a leak.
  const leaked = t1CardRun();
  leaked.card.affected[0].says_now = "Corvane confirmed the date.";
  assert.ok(codeChecks(leaked.testCase, leaked.run, dataset).leaks.some(leak => leak.marker === "Corvane"));
  // A completed approved-record run without its card delivered nothing to grade.
  const bare = completedRun(testCase, run.result.research.items);
  assert.deepEqual([codeChecks(testCase, bare, dataset).status, runScores({ checks: codeChecks(testCase, bare, dataset), judge: null }).card_items_listed], ["failed", 0]);
});

test("a card row is credited to the keyed section its chunk holds, not to the section the chunk before it started", () => {
  const testCase = caseById("approved-record-t1-two-decimal-display");
  // Verification plan 1212607: chunk s3 holds the TC-D-03 heading (key a13, confirms), chunk s4 the TC-D-06 heading (key a7, conflicts or needs_updating).
  const chunk = (index, text) => ({ id: `E${index + 10}`, source: "pages", kind: "page", title: `Verification plan · section ${index}`, text,
    citation: { kind: "page", tool_id: "confluence", external_scope_id: "cloud", page_id: "1212607", section_id: `s${index}`, version: "4", permalink: `https://echobrain.atlassian.net/wiki/x?s=${index}`, text_sha256: "sha256:0" },
    read_in_full: true, opened: true, preloaded: false, cited_by_plan: true });
  const s3 = chunk(3, "## TC-D-03 — 100 readings, ≥99 within spec\nAccuracy ±0.1 °C"); const s4 = chunk(4, "## TC-D-06 — Displayed value matches sensor value\nOne decimal");
  const items = [record("M2", "decision", "E1"), s3, s4];
  const graded = (affected, cited = items) => codeChecks(testCase, completedRun(testCase, items, undefined, impactCard(cited, [{ text: "Two decimals.", citation_index: 0 }], affected)), dataset).card;
  const entry = (card, id) => card.affected.find(value => value.id === id);
  const both = graded([{ citation_index: 1, says_now: "TC-D-03 checks ±0.1 °C.", relation: "confirms" }, { citation_index: 2, says_now: "TC-D-06 expects one decimal.", relation: "needs_updating" }]);
  assert.deepEqual([entry(both, "a13"), entry(both, "a7")].map(value => [value.listed, value.relation_correct]), [[true, true], [true, true]]);
  assert.deepEqual([both.listed, both.relations_correct], [2, 2]);
  // A card listing only the TC-D-06 chunk lists TC-D-06, not TC-D-03 too.
  const only = graded([{ citation_index: 1, says_now: "TC-D-06 expects one decimal.", relation: "needs_updating" }], [items[0], s4]);
  assert.deepEqual([entry(only, "a13").listed, entry(only, "a7").listed, only.listed, only.relations_correct], [false, true, 1, 1]);
  // A continuation chunk holding no keyed heading still carries the section before it.
  const s5 = { ...chunk(5, "continues TC-D-06: expected one decimal"), id: "E15" };
  const continued = codeChecks(testCase, completedRun(testCase, [...items, s5], undefined, impactCard([items[0], s5], [{ text: "Two decimals.", citation_index: 0 }], [{ citation_index: 1, says_now: "TC-D-06 expects one decimal.", relation: "conflicts" }])), dataset).card;
  assert.deepEqual([entry(continued, "a7").listed, entry(continued, "a7").relation_correct, continued.listed], [true, true, 1]);
});

test("a case whose request cannot be built is recorded as not started and the run goes on", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson, readJson, savedRunFiles } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-unstartable-")));
  // M2 is not bound, so the approved-record case on M2 and the Sweep citing M2 cannot start; the other Sweep cites only a transcript.
  const { M2: _unbound, ...meetingsBound } = bindings.meetings;
  writePrivateJson(out, "bindings.json", { ...bindings, meetings: meetingsBound, test_person: "Zhen Ye" });
  const askCase = caseById("bug-fix-dates-vs-dvt-review");
  const card = t1CardRun();
  const results = {
    ask: completedRun(askCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }).result,
    approved_record: card.run.result,
  };
  const started = [];
  const client = {
    async startResearchEval(request) { started.push(request); return { run_id: `run-${started.length}` }; },
    async readResearchEval(runId) { return { ...results[started[Number(runId.slice(4)) - 1].trigger], schema_version: 1, kind: "echo-person-research-eval-result-v1", run_id: runId }; },
  };
  const common = ["run", "--run", "--model", "loop-a", "--split", "development", "--trials", "1", "--out", out];
  await main([...common, "--state", "S0", "--only", "bug-fix-dates-vs-dvt-review,approved-record-t1-two-decimal-display,approved-record-t3-bug-412-likely-cause"], { client, poll_ms: 0 });
  await main([...common, "--state", "S1"], { client, poll_ms: 0 });
  // The run went on past each unstartable case: Ask and the M4 approved record started, nothing else did.
  assert.deepEqual(started.map(request => request.trigger), ["ask", "approved_record"]);
  const runs = new Map(savedRunFiles(out).map(entry => [entry.run.case_id, entry.run]));
  assert.equal(runs.size, 5);
  for (const id of ["approved-record-t1-two-decimal-display", "sweep-two-decimal-propagation", "sweep-bug-412-and-gate"]) {
    assert.deepEqual([runs.get(id).outcome, runs.get(id).error.code, runs.get(id).model, typeof runs.get(id).source_sha], ["error", "case_not_startable", "loop-a", "string"], id);
  }
  assert.match(runs.get("sweep-bug-412-and-gate").error.message, /cannot start research/u);
  assert.equal(runs.get("approved-record-t3-bug-412-likely-cause").outcome, "completed");
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.deepEqual([report.summary.runs_not_started, report.summary.runs_failed], [3, 3]);
  assert.match((await import("node:fs")).readFileSync(join(out, "report.md"), "utf8"), /Failed runs: 3, of which not started \(the case's request could not be built\): 3; rejected at ingress: 0\./u);
});

test("the judge sees the card as the answer, and its gap checks count for the card, not Ask's writer", () => {
  const testCase = caseById("approved-record-t3-bug-412-likely-cause");
  const items = [record("M4", "decision", "E1"), ticket("THERM-46", { id: "E2" })];
  const card = impactCard(items, [{ text: "Self-heating is the likely cause.", citation_index: 0 }], [{ citation_index: 1, says_now: "BUG-412 names the filter-dropout hypothesis.", relation: "conflicts" }], { unconfirmed: ["a verified root cause for BUG-412"] });
  const run = completedRun(testCase, items, undefined, card);
  const input = judgeInput(testCase, run);
  assert.deepEqual(input.answer.card.affected, [{ item: "THERM-46: Work item", says_now: "BUG-412 names the filter-dropout hypothesis.", relation: "conflicts" }]);
  assert.deepEqual(input.answer.card.unconfirmed, ["a verified root cause for BUG-412"]);
  const judged = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "not_applicable", answer_correct: "not_applicable" })),
    gaps: testCase.gaps.map(gap => ({ gap, reported: true })), must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: [], notes: "" };
  const scores = runScores({ checks: codeChecks(testCase, run, dataset), judge: parseJudge(testCase, judged) });
  assert.deepEqual([scores.card_gaps_reported, scores.gaps_reported, scores.research_gaps_reported], [1, null, null]);
  const sweep = caseById("sweep-bug-412-and-gate");
  const sweepJudge = { ...judged, parts: sweep.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "not_applicable", answer_correct: "not_applicable" })), needs: sweep.expected_needs.map(expected => ({ expected, covered: true })),
    gaps: sweep.gaps.map(gap => ({ gap, reported: false })), must_not: sweep.must_not.map(rule => ({ rule, violated: false })), verdicts: sweep.verdicts.map(verdict => ({ finding: verdict.finding, judged: verdict.expected, matches_expected: true })) };
  const sweepScores = runScores({ checks: codeChecks(sweep, completedRun(sweep, [ticket("THERM-46")]), dataset), judge: parseJudge(sweep, sweepJudge) });
  assert.deepEqual([sweepScores.research_gaps_reported, sweepScores.gaps_reported, sweepScores.card_gaps_reported], [0, null, null]);
});

test("reports print research-loop and renderer numbers in separate sections", () => {
  const askCase = caseById("bug-fix-dates-vs-dvt-review");
  const items = [ticket("THERM-46")];
  const askChecks = codeChecks(askCase, completedRun(askCase, items, { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: items[0].citation }] } }), dataset);
  const { testCase, run } = t1CardRun();
  const fallback = t1CardRun();
  fallback.card.status = "not_assessed";
  for (const row of fallback.card.affected) delete row.relation;
  const report = aggregate([{ checks: askChecks, judge: null }, { checks: codeChecks(testCase, run, dataset), judge: null }, { checks: { ...codeChecks(fallback.testCase, fallback.run, dataset), trial: 2 }, judge: null }]);
  assert.equal(report.summary.card_items_listed, 4 / testCase.affected.length);
  assert.equal(report.summary.card_relations_correct, (0.75 + 0) / 2, "a not-assessed card relates nothing");
  assert.deepEqual([report.summary.cards, report.summary.cards_not_assessed], [2, 1]);
  const markdown = markdownReport({ split: "development", state: "S0", source_sha: "commit-a", model: "loop", world: "therm-v1", judge: null, graded_at: "2026-10-06T00:00:00.000Z" }, report);
  const [loop, renderers] = markdown.split("## Renderers");
  const [overall, loopOnly] = loop.split("## Research loop");
  assert.match(overall, /\| Case \| Trigger \| Budget \| Runs \| Complete and supported \|/u);
  assert.match(loopOnly, /required items found/u);
  assert.doesNotMatch(loopOnly, /affected items listed|parts correct in the answer|Complete/u);
  assert.match(renderers, /\| Impact card \| affected items listed \| 25% \|/u);
  assert.match(renderers, /\| Impact card \| cards not assessed \(no-model fallback\) \| 1 of 2 \|/u);
  assert.match(renderers, /\| Ask writer \| parts correct in the answer \|/u);
  assert.match(renderers, /\| approved-record-t1-two-decimal-display \| approved_record \| background \| — \| 25% \|/u);
});

test("export bindings read the site, cloud id and THERM issue ids", () => {
  const bound = exportBindings({ site: "https://echobrain.atlassian.net/", cloudId: "cloud-9", jira_batches: [{ issues: [{ id: "10046", key: "THERM-46" }, { id: "1", key: "ECHO-1" }] }] });
  assert.deepEqual(bound, { site: "https://echobrain.atlassian.net", cloud_id: "cloud-9", tickets: { "THERM-46": "10046" } });
});

test("reports weigh cases equally and keep unknowns unknown", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const items = [ticket("THERM-46")];
  const checks = codeChecks(testCase, completedRun(testCase, items, { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: items[0].citation }] } }), dataset);
  const unjudged = aggregate([{ checks, judge: null }]);
  assert.equal(unjudged.cases[0].complete_in_every_run, null);
  assert.equal(unjudged.summary.cases_with_unknown_completion, 1);
  const judged = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "yes", answer_correct: "yes" })),
    gaps: [], must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: [], notes: "" };
  assert.equal(runScores({ checks, judge: judged }).complete_and_supported, true);
  assert.equal(runScores({ checks: { ...checks, leaks: [{ kind: "marker" }] }, judge: judged }).complete_and_supported, false);
  const other = codeChecks({ ...testCase, id: "other" }, completedRun(testCase, []), dataset);
  const report = aggregate([{ checks, judge: judged }, { checks: { ...checks, trial: 2 }, judge: judged }, { checks: other, judge: { ...judged, parts: judged.parts.map(part => ({ ...part, established_by_research: false })) } }]);
  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.cases_complete_in_every_run, 1);
  assert.equal(report.summary.tools_found, 0.5 * (checks.coverage.found / checks.parts.length));
  const gapCase = { ...testCase, gaps: ["Name the remaining unknown."] };
  const gapChecks = codeChecks(gapCase, completedRun(gapCase, items, { writer_evidence: ["E1"], response: { outcome: "partial", parts: [{ statements: [{}], gap: "not found" }], citations: [{ citation: items[0].citation }] } }), dataset);
  assert.equal(runScores({ checks: gapChecks, judge: { ...judged, gaps: [{ gap: "Name the remaining unknown.", reported: false }] } }).complete_and_supported, false);
  const unread = ticket("THERM-46", { id: "E9", read: false });
  const unreadCitation = codeChecks(testCase, completedRun(testCase, [unread], { writer_evidence: ["E9"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: unread.citation }] } }), dataset);
  assert.equal(runScores({ checks: unreadCitation, judge: judged }).complete_and_supported, false);
});

test("judge replies must cover every part, need and verdict, and one run cannot calibrate a judge", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const reply = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "not_applicable", answer_correct: "not_applicable" })),
    gaps: [], must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: testCase.verdicts.map(verdict => ({ finding: verdict.finding, judged: verdict.expected, matches_expected: true })), notes: "" };
  const judged = parseJudge(testCase, reply);
  assert.throws(() => parseJudge(testCase, { ...reply, parts: reply.parts.slice(1) }));
  assert.throws(() => parseJudge(testCase, { ...reply, verdicts: [] }));
  const gapCase = { ...testCase, gaps: ["The unknown date is not recorded."] };
  assert.throws(() => parseJudge(gapCase, reply), /gaps do not match/u);
  assert.throws(() => parseJudge(gapCase, { ...reply, gaps: [{ gap: "Some other gap.", reported: true }] }), /gap does not match/u);
  assert.ok(judgeChecks(gapCase, { ...judged, gaps: [{ gap: "The unknown date is not recorded.", reported: true }] }).some(check => check.id === "gap:0"));
  const graded = [{ checks: { case_id: testCase.id, trial: 1, budget: "background" }, judge: judged }];
  const cases = new Map([[testCase.id, testCase]]);
  const sheet = blindSheet(graded, cases);
  assert.equal(JSON.stringify(sheet).includes('"judge"'), false, "the sheet is blind");
  for (const check of sheet[0].checks) check.founder = check.id.startsWith("must_not") ? false : true;
  assert.equal(agreement(sheet, graded, cases).trusted, false, "the agreement bar also requires the blind 15-run sample");
  sheet[0].checks[0].founder = false; sheet[0].checks[1].founder = false;
  const result = agreement(sheet, graded, cases);
  assert.equal(result.sufficient_sample, false);
  assert.equal(result.trusted, false);
  assert.equal(result.disagreements.length, 2);
});

test("only a complete, current 15-run blind calibration certifies judge metrics", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const judge = parseJudge(testCase, { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "not_applicable", answer_correct: "not_applicable" })),
    gaps: [], must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: testCase.verdicts.map(verdict => ({ finding: verdict.finding, judged: verdict.expected, matches_expected: true })), notes: "" });
  const runs = Array.from({ length: CALIBRATION_SAMPLE_RUNS }, (_, index) => ({ checks: { case_id: testCase.id, trial: index + 1, budget: "background" }, judge }));
  const graded = { schema_version: 1, judge_model: "anthropic/claude-test", graded_at: "2026-10-06T00:00:00.000Z", runs };
  const cases = new Map([[testCase.id, testCase]]);

  const sheet = calibrationSheet(graded, cases);
  const missingRow = structuredClone(sheet);
  missingRow.rows.pop();
  assert.throws(() => scoreCalibration(missingRow, graded, cases), /rows do not match/u, "the founder cannot calibrate only easy rows");
  for (const row of sheet.rows) for (const check of row.checks) check.founder = check.id.startsWith("must_not") ? false : true;
  const result = scoreCalibration(sheet, graded, cases);
  assert.equal(result.trusted, true);
  assert.equal(calibrationStatus(graded, result).trusted, true);

  assert.equal(calibrationStatus({ ...graded, graded_at: "2026-10-06T00:01:00.000Z" }, result).trusted, false, "a stale result cannot certify a regrade");
  assert.equal(calibrationStatus({ ...graded, runs: runs.slice(0, 1) }, result).trusted, false, "one matching run cannot certify the judge");
  assert.equal(calibrationStatus(graded, { ...result, rate: Number.NaN }).trusted, false, "a malformed rate cannot turn a result into a pass");
  assert.throws(() => calibrationSheet({ ...graded, runs: runs.map(run => ({ ...run, checks: { ...run.checks, trial: 1 } })) }, cases), /duplicate run identities/u);
});

test("results may not be written inside the repository", () => {
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  assert.throws(() => privateDirectory(join(repository, "tools", "evals", "research-loop", "results")), /outside the repository/u);
  const outside = mkdtempSync(join(tmpdir(), "research-loop-eval-"));
  assert.equal(typeof privateDirectory(outside), "string");
});

test("grade and report run end to end on saved runs without a judge", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson, readJson } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-cli-")));
  writePrivateJson(out, "bindings.json", { ...bindings, test_person: "Zhen Ye" });
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const run = completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } });
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { ...run, case_id: testCase.id, split: "development", state: "S0", trigger: "ask", model: "test-loop-model", source_sha: "commit-a" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { case_id: "overlong-dvt-schedule-check", split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "test-loop-model", source_sha: "commit-a", outcome: "rejected", error: { code: "query_too_long" } });
  const card = t1CardRun();
  writePrivateJson(out, `runs/${card.testCase.id}/background-1.json`, { ...card.run, case_id: card.testCase.id, split: "development", state: "S0", trigger: "approved_record", model: "test-loop-model", source_sha: "commit-a" });
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.summary.cases, 3);
  assert.equal(report.cases.find(entry => entry.case_id === card.testCase.id).card_items_listed, 4 / card.testCase.affected.length);
  assert.equal(report.summary.runs_rejected_at_ingress, 1);
  assert.equal(report.cases.find(entry => entry.case_id === testCase.id).tools_found > 0, true);
  assert.equal(report.identity.model, "test-loop-model");
});

test("report withholds judge metrics until its exact grading pass is calibrated", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson, readJson, savedRunFiles } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-uncalibrated-")));
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const checks = codeChecks(testCase, completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }), dataset);
  const judge = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "yes", answer_correct: "yes" })), gaps: [], must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: [], notes: "" };
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { source_sha: "source", state: "S0", model: "test-loop-model" });
  const [{ file, sha256 }] = savedRunFiles(out);
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: "anthropic/claude-test", graded_at: "2026-10-06T00:00:00.000Z", runs: [{ run: { file, sha256 }, checks, judge, judge_error: null }] });
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.identity.judge_calibration.status, "untrusted");
  assert.equal(report.summary.research_established, null);
  assert.match((await import("node:fs")).readFileSync(join(out, "report.md"), "utf8"), /judge-derived metrics are withheld/u);
});

test("runs record an explicit loop model and reports refuse mixed identities", async () => {
  const { main } = await import("../cli.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-model-")));
  await assert.rejects(main(["run", "--run", "--split", "development", "--state", "S0", "--out", out]), /--model is required/u);
  const { writePrivateJson } = await import("../lib/private-files.mjs");
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: null, graded_at: "2026-10-06T00:00:00.000Z", runs: [] });
  writePrivateJson(out, "runs/a/live-1.json", { state: "S0", model: "loop-a" });
  writePrivateJson(out, "runs/b/live-1.json", { state: "S0", model: "loop-b" });
  await assert.rejects(main(["report", "--out", out]), /one evaluated loop model/u);
});

test("reports refuse runs from more than one source commit", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-source-")));
  writePrivateJson(out, "bindings.json", { ...bindings, test_person: "Zhen Ye" });
  const rejected = { split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "loop-a", outcome: "rejected", error: { code: "query_too_long" } };
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { ...rejected, case_id: "overlong-dvt-schedule-check", source_sha: "commit-a" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-2.json", { ...rejected, case_id: "overlong-dvt-schedule-check", trial: 2, source_sha: "commit-b" });
  await main(["grade", "--no-judge", "--out", out]);
  await assert.rejects(main(["report", "--out", out]), /one source commit/u);
});

test("reports refuse saved runs that changed after grading", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-regraded-")));
  writePrivateJson(out, "bindings.json", { ...bindings, test_person: "Zhen Ye" });
  const rejected = { case_id: "overlong-dvt-schedule-check", split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "loop-a", source_sha: "commit-a", outcome: "rejected", error: { code: "query_too_long" } };
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", rejected);
  await main(["grade", "--no-judge", "--out", out]);
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-2.json", { ...rejected, trial: 2 });
  await assert.rejects(main(["report", "--out", out]), /changed since grading/u, "an added run");
  await main(["grade", "--no-judge", "--out", out]);
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-2.json", { ...rejected, trial: 2, outcome: "failed", error: { code: "unavailable" } });
  await assert.rejects(main(["report", "--out", out]), /changed since grading/u, "an overwritten run");
});
