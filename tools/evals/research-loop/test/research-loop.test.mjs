import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../cli.mjs";
import { datasetProblems, loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { itemMatches, satisfying, ticketKey } from "../lib/match.mjs";
import { codeChecks, gradeSweep } from "../lib/checks.mjs";
import { discoverMeetings, exportBindings } from "../lib/bindings.mjs";
import { rejectedAtIngress, savedResult, startRequest } from "../lib/requests.mjs";
import { aggregate, markdownReport, runScores } from "../lib/report.mjs";
import { JUDGE_SYSTEM, judgeInput, parseJudge } from "../lib/judge.mjs";
import { CALIBRATION_SAMPLE_RUNS, agreement, blindSheet, calibrationSheet, calibrationStatus, judgeChecks, scoreCalibration } from "../lib/calibration.mjs";
import { privateDirectory, readJson, savedRunFiles, writePrivateJson } from "../lib/private-files.mjs";

const dataset = loadDataset();
const meetings = new Map(dataset.additions.meetings.map(meeting => [meeting.id, meeting]));
const titleOf = id => meetings.get(id).title;
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const ticket = (key, options = {}) => ({ id: options.id ?? "E1", source: "tickets", kind: "ticket", title: `${key}: Work item`,
  citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud", ticket_id: "10046", permalink: `https://echobrain.atlassian.net/browse/${key}`, text_sha256: digest(`text-${key}`) },
  ...(options.owner === undefined ? {} : { attributes: { status: "To Do", owner: options.owner } }),
  read_in_full: options.read ?? true, opened: true, preloaded: false, cited_by_plan: options.cited ?? true, ...(options.text === undefined ? {} : { text: options.text }) });
const recordCitation = id => ({ kind: "approved_record", atom_id: digest(`atom-${id}`), record_sha256: digest(`record-${id}`), policy_id: "project-members-readable-person-v1" });
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
/**
 * A judge reply that says yes to everything: every need covered, every part established (and, in an Ask, stated and
 * correct), every gap reported and every Sweep verdict as the key expects, with no rule violated.
 */
function judgeReply(testCase) {
  const answered = testCase.trigger === "ask" ? "yes" : "not_applicable";
  return { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [],
    parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: answered, answer_correct: answered })),
    gaps: testCase.gaps.map(gap => ({ gap, reported: true })), must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false,
    verdicts: (testCase.verdicts ?? []).map(verdict => ({ finding: verdict.finding, judged: verdict.expected, matches_expected: true })), notes: "" };
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
/** A sweep result citing these research items: one entry per finding, in input order (a null verdict was not assessed). */
function sweepResult(cited, entries, status = "assessed") {
  return { findings: entries.map(({ verdict, line, cites = [] }, finding_index) => ({ finding_index, verdict, line, citation_indexes: cites })), status, citations: cited.map(citationOf) };
}
/** What research returns for the two-decimal propagation Sweep at S1: SW-22b, TC-D-06 and the PRD's functional requirements. */
function propagationItems() {
  const prd = { id: "E3", source: "pages", kind: "page", title: "PRD — Mock Digital Thermometer · section 2", text: "## Functional requirements\nPRD-D01 shows one decimal place.",
    citation: { kind: "page", tool_id: "confluence", external_scope_id: "cloud", page_id: "1409025", section_id: "s2", version: "5", permalink: "https://echobrain.atlassian.net/wiki/x?s=2", text_sha256: digest("text-1409025-s2") },
    read_in_full: true, opened: true, preloaded: true, cited_by_plan: true };
  return [ticket("THERM-18", { id: "E1" }), ticket("THERM-40", { id: "E2" }), prd];
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
  // TRACE-01 states the demoted SW-14c hypothesis and must record the fix owner; the change-management rule M4 goes against is not replaced.
  const t3Key = Object.fromEntries(records.find(entry => entry.id === "approved-record-t3-bug-412-likely-cause").affected.map(item => [item.id, item.relation]));
  assert.deepEqual([t3Key.a4, t3Key.a11], [["conflicts", "needs_updating"], "conflicts"]);
  // The keyed items and their owners follow from the parts and the Jira assignees (world/README.md, "Reading the keys"): recompute them.
  const assignees = Object.fromEntries(dataset.additions.jira_updates.filter(update => update.set.assignee !== undefined).map(update => [update.key, update.set.assignee]));
  for (const entry of records) {
    const keyed = []; const seen = new Set();
    for (const part of entry.parts.filter(value => value.type === "conflict" || value.type === "change" || /\bagree/u.test(value.requirement))) {
      const pages = new Map();
      for (const ref of part.evidence) {
        if (ref.meeting !== undefined || seen.has(JSON.stringify(ref))) continue;
        seen.add(JSON.stringify(ref));
        if (ref.ticket !== undefined) keyed.push({ refs: [ref], owner: assignees[ref.ticket] ?? null });
        else if (pages.has(ref.page)) pages.get(ref.page).refs.push(ref);
        else { pages.set(ref.page, { refs: [ref], owner: null }); keyed.push(pages.get(ref.page)); }
      }
    }
    assert.deepEqual(entry.affected.map(({ relation: _relation, ...item }) => item), keyed.map((item, index) => ({ id: `a${index + 1}`, ...item })), entry.id);
  }
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
    const request = startRequest(substitutePerson(entry, "Zhen Ye"), bindings);
    assert.deepEqual(validatePersonResearchEvalStartRequestV1(request), request, entry.id);
    assert.equal(Object.hasOwn(request, "project_id"), entry.scope.kind === "project", entry.id);
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === request.trigger);
    assert.ok(definition !== undefined, entry.id);
    // The product's question limit now refuses an overlong question on the Authority, which the runner counts as rejected at ingress.
    if (entry.id === "overlong-dvt-schedule-check") assert.throws(() => definition.parseEvent(request.input), { code: "invalid_request" });
    else assert.doesNotThrow(() => definition.parseEvent(request.input), entry.id);
  }
  // Only an Ask question has a product ingress limit; any other refusal is the runner's or the bindings' error.
  const overlong = caseById("overlong-dvt-schedule-check");
  const refused = { name: "PersonAuthorityClientError", code: "invalid_request" };
  assert.equal(rejectedAtIngress(overlong, refused), true);
  assert.equal(rejectedAtIngress(caseById("approved-record-t1-two-decimal-display"), refused), false);
  assert.equal(rejectedAtIngress(overlong, { name: "OrganizationApiValidationError" }), false);
  assert.equal(rejectedAtIngress(overlong, { name: "PersonAuthorityClientError", code: "unavailable" }), false);
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
  assert.deepEqual(codeChecks(testCase, bare, dataset).error, { code: "no_rendered_result", message: "approved-record runs must return the impact card; run them again on the current endpoint" });
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

test("a chunk holding several keyed headings is credited only to the sections whose relation it gives", () => {
  const testCase = caseById("approved-record-t1-two-decimal-display");
  // One chunk holds both the TC-D-03 heading (a13, confirms) and the TC-D-06 heading (a7, conflicts or needs_updating).
  const shared = { id: "E13", source: "pages", kind: "page", title: "Verification plan · section 3", text: "## TC-D-03 — 100 readings, ≥99 within spec\n…\n## TC-D-06 — Displayed value matches sensor value\nOne decimal",
    citation: { kind: "page", tool_id: "confluence", external_scope_id: "cloud", page_id: "1212607", section_id: "s3", version: "4", permalink: "https://echobrain.atlassian.net/wiki/x?s=3", text_sha256: "sha256:0" },
    read_in_full: true, opened: true, preloaded: false, cited_by_plan: true };
  const items = [record("M2", "decision", "E1"), shared];
  const graded = (key, relation) => codeChecks(key, completedRun(key, items, undefined, impactCard(items, [{ text: "Two decimals.", citation_index: 0 }], [{ citation_index: 1, says_now: "The plan's display test.", relation }])), dataset).card;
  const state = card => ["a13", "a7"].map(id => card.affected.find(value => value.id === id)).map(value => [value.listed, value.relation_correct]);
  assert.deepEqual(state(graded(testCase, "confirms")), [[true, true], [false, false]]);
  assert.deepEqual(state(graded(testCase, "needs_updating")), [[false, false], [true, true]]);
  for (const relation of ["confirms", "needs_updating"]) assert.equal(graded(testCase, relation).relations_correct, graded(testCase, relation).listed, relation);
  // A relation neither section accepts is credited, as wrong, to the first of them in key order only.
  const strict = { ...testCase, affected: testCase.affected.map(value => value.id === "a7" ? { ...value, relation: "needs_updating" } : value) };
  assert.deepEqual(state(graded(strict, "conflicts")), [[false, false], [true, false]]);
  assert.equal(graded(strict, "conflicts").listed, 1);
});

test("grades a sweep result against the key with the verdict mapping", () => {
  const graded = gradeSweep({ verdicts: [{ expected: "landed" }, { expected: "not_landed" }, { expected: "no_evidence" }] },
    { findings: [{ finding_index: 0, verdict: "landed" }, { finding_index: 1, verdict: "changed" }, { finding_index: 2, verdict: null }] });
  assert.deepEqual(graded, { right: 2, total: 3, not_assessed: 1 });
});

test("sweep verdicts are graded by finding_index: a missing or repeated finding is wrong, a null verdict wrong and not assessed whatever the status", () => {
  const key = { verdicts: [{ expected: "landed" }, { expected: "not_landed" }, { expected: "no_evidence" }, { expected: "not_landed" }] };
  const result = (...verdicts) => ({ findings: verdicts.map((verdict, finding_index) => ({ finding_index, verdict })) });
  // still_open and changed are not landed; unreadable is no evidence.
  assert.deepEqual(gradeSweep(key, result("landed", "still_open", "unreadable", "changed")), { right: 4, total: 4, not_assessed: 0 });
  assert.deepEqual(gradeSweep(key, result("still_open", "landed", "still_open", "unreadable")), { right: 0, total: 4, not_assessed: 0 });
  // Out of order, each entry is still graded against its own finding.
  assert.deepEqual(gradeSweep(key, { findings: result("landed", "still_open", "unreadable", "changed").findings.reverse() }), { right: 4, total: 4, not_assessed: 0 });
  // A missing finding is wrong (and was not given a null verdict); a finding given twice is wrong.
  const repeated = { findings: [{ finding_index: 0, verdict: "landed" }, { finding_index: 1, verdict: "changed" }, { finding_index: 1, verdict: "changed" }] };
  assert.deepEqual(gradeSweep(key, repeated), { right: 1, total: 4, not_assessed: 0 });
  // A result may be assessed and still leave a finding the model was not shown at null.
  assert.deepEqual(gradeSweep(key, { ...result("landed", null, "unreadable", null), status: "assessed" }), { right: 2, total: 4, not_assessed: 2 });
  assert.deepEqual(gradeSweep(key, { ...result(null, null, "unreadable", null), status: "not_assessed" }), { right: 1, total: 4, not_assessed: 3 });
});

test("each Sweep verdict names its own finding, in the findings' order, since sweep results are graded by finding_index", () => {
  const sweep = dataset.cases.find(entry => entry.id === "sweep-two-decimal-propagation");
  const problems = changed => datasetProblems({ ...dataset, cases: [{ ...sweep, ...changed }] });
  assert.deepEqual(problems({}), []);
  assert.ok(problems({ verdicts: [...sweep.verdicts].reverse() }).some(problem => problem.includes("in the findings' order")), "reordered verdicts");
  assert.ok(problems({ verdicts: sweep.verdicts.map((verdict, index) => (index === 1 ? { ...verdict, finding: "TC-D-06 is open." } : verdict)) }).some(problem => problem.includes("in the findings' order")), "a verdict naming another finding");
});

test("a Sweep case names no planner needs or gaps: a sweep has no planner to ask for or report them (R77)", () => {
  const sweep = dataset.cases.find(entry => entry.id === "sweep-two-decimal-propagation");
  const problems = changed => datasetProblems({ ...dataset, cases: [{ ...sweep, ...changed }] });
  assert.ok(problems({ expected_needs: ["current SW-22b text"] }).some(problem => problem.includes("no planner")), "expected needs");
  assert.ok(problems({ gaps: ["a confirmed delivery date"] }).some(problem => problem.includes("no planner")), "gaps");
});

test("a planner-less sweep is not graded on planner needs, handed items or plan gaps, so they never count as zero", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  // As a sweep's research returns them (R77): the starting items read in full, no plan, so nothing is cited by one.
  const items = propagationItems().map(item => ({ ...item, preloaded: true, cited_by_plan: false }));
  const run = completedRun(testCase, items, undefined, sweepResult(items, [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: [1] },
    { verdict: "changed", line: "PRD-D01 now names three decimals, not two.", cites: [2] },
  ]));
  run.result.research = { ...run.result.research, plan: [], rounds: [] };
  const judge = parseJudge(testCase, judgeReply(testCase));
  const scores = runScores({ checks: codeChecks(testCase, run, dataset), judge });
  const notApplicable = entry => [entry.planner_needs_covered, entry.planner_invented_needs, entry.tools_handed, entry.noise_handed, entry.distractors_handed, entry.research_gaps_reported];
  assert.deepEqual(notApplicable(scores), [null, null, null, null, null, undefined]);
  assert.deepEqual([scores.tools_found, scores.tools_read, scores.complete_and_supported], [1, 1, true]);
  // A failed sweep scores zero on what a sweep does, and nothing on what it never does.
  const failed = runScores({ checks: codeChecks(testCase, { trial: 2, budget: testCase.budget, outcome: "failed", error: { code: "unavailable" } }, dataset), judge: null });
  assert.deepEqual([failed.tools_found, failed.research_established, failed.planner_needs_covered, failed.tools_handed], [0, 0, undefined, undefined]);
  // So the case's averages, and the cross-case planner averages, leave sweeps out.
  const report = aggregate([{ checks: codeChecks(testCase, run, dataset), judge }, { checks: codeChecks(testCase, { trial: 2, budget: testCase.budget, outcome: "failed", error: { code: "unavailable" } }, dataset), judge: null }]);
  assert.deepEqual(notApplicable(report.cases[0]).slice(0, 5), [null, null, null, null, null]);
  assert.deepEqual([report.summary.planner_needs_covered, report.summary.tools_handed], [null, null]);
  assert.match(markdownReport({ split: "development", state: "S1", world: "therm", graded_at: "2026-10-16" }, report), /A sweep has no planner/u);
});

test("a completed run without its rendered result still has its research scanned for restricted leaks", () => {
  // Research returned the restricted M6 decision, and a ticket whose text names the restricted supplier.
  const items = [ticket("THERM-18", { id: "E1", text: "Corvane signed off the rounding." }), record("M6", "decision", "E2")];
  const failed = ["approved-record-t1-two-decimal-display", "sweep-two-decimal-propagation"].map(id => {
    const testCase = caseById(id);
    const checks = codeChecks(testCase, completedRun(testCase, items), dataset);
    assert.deepEqual([checks.status, checks.error.code], ["failed", "no_rendered_result"], id);
    assert.deepEqual(checks.leaks.map(leak => (leak.kind === "item" ? `${leak.ref.meeting}/${leak.ref.item}` : leak.marker)), ["M6/decision", "Corvane"], id);
    return { checks, judge: null };
  });
  assert.equal(aggregate(failed).summary.runs_with_leaks, 2);
});

test("sweep runs are graded on their sweep result, never as an impact card, and a completed sweep run without one failed", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const items = propagationItems();
  const result = sweepResult(items.slice(0, 2), [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: [1] },
    { verdict: null, line: "Not assessed." },
  ]);
  const checks = codeChecks(testCase, completedRun(testCase, items, undefined, result), dataset);
  assert.equal(checks.status, "completed");
  assert.deepEqual(checks.sweep, { status: "assessed", right: 2, total: 3, not_assessed: 1 });
  assert.equal(checks.card, null);
  assert.deepEqual(checks.leaks, []);
  // A completed sweep run without its result delivered nothing to grade (it predates the endpoint's sweep result): every finding is wrong.
  const bare = codeChecks(testCase, completedRun(testCase, items), dataset);
  assert.deepEqual([bare.status, bare.error.code, bare.sweep], ["failed", "no_rendered_result", { right: 0, total: 3, not_assessed: 0 }]);
  assert.match(bare.error.message, /^sweep runs must return the sweep result; run them again on the current endpoint$/u);
  const failed = codeChecks(testCase, { trial: 2, budget: "background", outcome: "failed", result: { status: "failed", error: { code: "timed_out", message: "late" } } }, dataset);
  assert.deepEqual([failed.status, failed.sweep], ["failed", { right: 0, total: 3, not_assessed: 0 }]);
  // A sweep's lines and citations are released text: a restricted name in either is a leak.
  const line = structuredClone(result);
  line.findings[1].line = "Corvane still expects one decimal.";
  assert.ok(codeChecks(testCase, completedRun(testCase, items, undefined, line), dataset).leaks.some(leak => leak.marker === "Corvane"));
  const citation = structuredClone(result);
  citation.citations[0].label = "THERM-18: Wen Hao's rounding note";
  assert.ok(codeChecks(testCase, completedRun(testCase, items, undefined, citation), dataset).leaks.some(leak => leak.marker === "Wen Hao"));
});

test("a sweep run is complete and supported only when every verdict in its result is right", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const items = propagationItems();
  const judge = parseJudge(testCase, judgeReply(testCase));
  const scores = (cited, entries) => runScores({ checks: codeChecks(testCase, completedRun(testCase, items, undefined, sweepResult(cited, entries)), dataset), judge });
  const right = [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: [1] },
    { verdict: "changed", line: "PRD-D01 now names three decimals, not two.", cites: [2] },
  ];
  assert.equal(scores(items, right).complete_and_supported, true);
  assert.equal(scores(items, [right[0], right[1], { verdict: "landed", line: "PRD-D01 now requires two decimals.", cites: [2] }]).complete_and_supported, false);
  // The PRD finding was not judged, so the result cites only the two tickets (as the contract requires).
  assert.equal(scores(items.slice(0, 2), [right[0], right[1], { verdict: null, line: "Not assessed." }]).complete_and_supported, false);
});

test("a case whose request cannot be built is recorded as not started and the run goes on", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-unstartable-")));
  // M2 is not bound, so the approved-record case on M2 and the Sweep citing M2 cannot start; the other Sweep can.
  const { M2: _unbound, ...meetingsBound } = bindings.meetings;
  writePrivateJson(out, "bindings.json", { ...bindings, meetings: meetingsBound, test_person: "Zhen Ye" });
  const askCase = caseById("bug-fix-dates-vs-dvt-review");
  const card = t1CardRun();
  const gate = caseById("sweep-bug-412-and-gate");
  const results = {
    ask: completedRun(askCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }).result,
    approved_record: card.run.result,
    sweep: completedRun(gate, [ticket("THERM-46")], undefined, sweepResult([ticket("THERM-46")], [{ verdict: "still_open", line: "BUG-412 is still open.", cites: [0] }, ...[1, 2].map(() => ({ verdict: null, line: "Not assessed." }))])).result,
  };
  const started = [];
  const client = {
    async startResearchEval(request) { started.push(request); return { run_id: `run-${started.length}` }; },
    async readResearchEval(runId) { return { ...results[started[Number(runId.slice(4)) - 1].trigger], schema_version: 1, kind: "echo-person-research-eval-result-v1", run_id: runId }; },
  };
  const common = ["run", "--run", "--model", "loop-a", "--split", "development", "--trials", "1", "--out", out];
  await main([...common, "--state", "S0", "--only", "bug-fix-dates-vs-dvt-review,approved-record-t1-two-decimal-display,approved-record-t3-bug-412-likely-cause"], { client, poll_ms: 0 });
  await main([...common, "--state", "S1"], { client, poll_ms: 0 });
  // The run went on past each unstartable case: Ask, the M4 approved record and the Sweep citing M4 started, nothing else did.
  assert.deepEqual(started.map(request => request.trigger), ["ask", "approved_record", "sweep"]);
  const runs = new Map(savedRunFiles(out).map(entry => [entry.run.case_id, entry.run]));
  assert.equal(runs.size, 5);
  for (const id of ["approved-record-t1-two-decimal-display", "sweep-two-decimal-propagation"]) {
    assert.deepEqual([runs.get(id).outcome, runs.get(id).error.code, runs.get(id).model, typeof runs.get(id).source_sha], ["error", "case_not_startable", "loop-a", "string"], id);
  }
  assert.match(runs.get("sweep-two-decimal-propagation").error.message, /no decision citation bound for meeting M2/u);
  for (const id of ["approved-record-t3-bug-412-likely-cause", "sweep-bug-412-and-gate"]) assert.equal(runs.get(id).outcome, "completed", id);
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.deepEqual([report.summary.runs_not_started, report.summary.runs_failed], [2, 2]);
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /Failed runs: 2, of which not started \(the case's request could not be built\): 2; rejected at ingress: 0\./u);
});

test("a runner error that is not an unbound or unstartable citation still stops the run", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-broken-")));
  // Broken bindings (no tickets map) are a bug to fix, not a case to skip.
  const { tickets: _missing, ...broken } = bindings;
  writePrivateJson(out, "bindings.json", { ...broken, test_person: "Zhen Ye" });
  const client = { async startResearchEval() { throw new Error("must not start"); }, async readResearchEval() { throw new Error("must not read"); } };
  await assert.rejects(main(["run", "--run", "--model", "loop-a", "--split", "development", "--state", "S1", "--trials", "1", "--out", out], { client, poll_ms: 0 }), TypeError);
  assert.throws(() => savedRunFiles(out), /ENOENT/u, "no run row was written");
});

test("the judge sees the card as the answer, and its gap checks count for the card, not Ask's writer", () => {
  const testCase = caseById("approved-record-t3-bug-412-likely-cause");
  const items = [record("M4", "decision", "E1"), ticket("THERM-46", { id: "E2" })];
  const card = impactCard(items, [{ text: "Self-heating is the likely cause.", citation_index: 0 }], [{ citation_index: 1, says_now: "BUG-412 names the filter-dropout hypothesis.", relation: "conflicts" }], { unconfirmed: ["a verified root cause for BUG-412"] });
  const run = completedRun(testCase, items, undefined, card);
  const input = judgeInput(testCase, run);
  assert.deepEqual(input.answer.card.affected, [{ item: "THERM-46: Work item", says_now: "BUG-412 names the filter-dropout hypothesis.", relation: "conflicts" }]);
  assert.deepEqual(input.answer.card.unconfirmed, ["a verified root cause for BUG-412"]);
  const scores = runScores({ checks: codeChecks(testCase, run, dataset), judge: parseJudge(testCase, judgeReply(testCase)) });
  assert.deepEqual([scores.card_gaps_reported, scores.gaps_reported], [1, null]);
  const sweep = caseById("sweep-bug-412-and-gate");
  const sweepRendered = sweepResult([ticket("THERM-46")], [{ verdict: "still_open", line: "BUG-412 is still open.", cites: [0] }, ...[1, 2].map(() => ({ verdict: null, line: "Not assessed." }))]);
  const sweepScores = runScores({ checks: codeChecks(sweep, completedRun(sweep, [ticket("THERM-46")], undefined, sweepRendered), dataset), judge: parseJudge(sweep, judgeReply(sweep)) });
  // A sweep names no gaps (it has no plan to report them in), so none of its gap measures is known.
  assert.deepEqual([sweepScores.gaps_reported, sweepScores.card_gaps_reported, "research_gaps_reported" in sweepScores], [null, null, false]);
});

test("the judge sees a sweep result as per-finding verdicts with one line each, never as a card", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const items = propagationItems();
  const result = sweepResult(items.slice(0, 2), [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: [1] },
    { verdict: null, line: "Not assessed." },
  ]);
  const input = judgeInput(testCase, completedRun(testCase, items, undefined, result));
  assert.deepEqual(input.answer, { sweep: { status: "assessed", findings: [
    { finding_index: 0, verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: ["THERM-18: Work item"] },
    { finding_index: 1, verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: ["THERM-40: Work item"] },
    { finding_index: 2, verdict: null, line: "Not assessed.", cites: [] },
  ] } });
  assert.deepEqual(input.case.findings.map(entry => entry.finding), testCase.findings.map(entry => entry.finding), "finding_index points into the case's findings");
  assert.match(JUDGE_SYSTEM, /answer\.sweep/u);
  assert.match(JUDGE_SYSTEM, /per-finding verdicts with one line each/u);
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

test("reports count sweep verdicts per case and over all sweep cases, among the renderers", () => {
  const propagation = caseById("sweep-two-decimal-propagation");
  const items = propagationItems();
  // Key: landed, not landed, not landed. One run gets two right and leaves one not assessed; the other fails, so its three findings are wrong.
  const assessed = codeChecks(propagation, completedRun(propagation, items, undefined, sweepResult([items[0], items[2]], [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: null, line: "Not assessed." },
    { verdict: "still_open", line: "PRD-D01 still shows one decimal place.", cites: [1] },
  ])), dataset);
  const failed = codeChecks(propagation, { trial: 2, budget: "background", outcome: "failed", result: { status: "failed", error: { code: "timed_out", message: "late" } } }, dataset);
  // Key: not landed, landed, not landed; all three right.
  const gate = caseById("sweep-bug-412-and-gate");
  const tickets = [ticket("THERM-46", { id: "E1" }), ticket("THERM-47", { id: "E2" }), ticket("THERM-50", { id: "E3" })];
  const allRight = codeChecks(gate, completedRun(gate, tickets, undefined, sweepResult(tickets, [
    { verdict: "still_open", line: "BUG-412 is still open.", cites: [0] },
    { verdict: "landed", line: "TRACE-01 now records the fix owner.", cites: [1] },
    { verdict: "changed", line: "GATE-DVT is on hold under a new review board.", cites: [2] },
  ])), dataset);
  const report = aggregate([{ checks: assessed, judge: null }, { checks: failed, judge: null }, { checks: allRight, judge: null }]);
  const counts = entry => [entry.sweep_verdicts_right, entry.sweep_findings, entry.sweep_not_assessed];
  assert.deepEqual(counts(report.cases.find(entry => entry.case_id === propagation.id)), [2, 6, 1]);
  assert.deepEqual(counts(report.cases.find(entry => entry.case_id === gate.id)), [3, 3, 0]);
  assert.deepEqual(counts(report.summary), [5, 9, 1]);
  const identity = { split: "development+holdout", state: "S1", source_sha: "commit-a", model: "loop", world: "therm-v1", judge: null, graded_at: "2026-10-08T00:00:00.000Z" };
  const [loop, renderers] = markdownReport(identity, report).split("## Renderers");
  assert.doesNotMatch(loop, /verdicts right|not assessed|Sweep result/u, "the sweep result's numbers are renderer numbers");
  assert.match(renderers, /\| Sweep result \| verdicts right \/ findings \| 5 \/ 9 \|/u);
  assert.match(renderers, /\| Sweep result \| findings not assessed \| 1 \|/u);
  assert.match(renderers, /\| sweep-two-decimal-propagation \| background \| 2 \| 2 \/ 6 \| 1 \|/u);
  assert.match(renderers, /\| sweep-bug-412-and-gate \| background \| 1 \| 3 \/ 3 \| 0 \|/u);
  assert.match(renderers, /"Sweep verdicts correct" under Research loop is a different measure: the judge's reading of the items research read\./u, "the two verdict measures are told apart");
  // Without a sweep case the counts are unknown, not zero.
  const askCase = caseById("bug-fix-dates-vs-dvt-review");
  const askOnly = aggregate([{ checks: codeChecks(askCase, completedRun(askCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [] } }), dataset), judge: null }]);
  assert.deepEqual([counts(askOnly.cases[0]), counts(askOnly.summary)], [[null, null, null], [null, null, null]]);
  assert.match(markdownReport({ ...identity, state: "S0" }, askOnly), /\| Sweep result \| verdicts right \/ findings \| — \|/u);
});

test("export bindings read the site, cloud id and THERM issue ids", () => {
  const bound = exportBindings({ site: "https://echobrain.atlassian.net/", cloudId: "cloud-9", jira_batches: [{ issues: [{ id: "10046", key: "THERM-46" }, { id: "1", key: "ECHO-1" }] }] });
  assert.deepEqual(bound, { site: "https://echobrain.atlassian.net", cloud_id: "cloud-9", tickets: { "THERM-46": "10046" } });
});

test("meeting bindings search each record kind within the evidence search cap, and skip the restricted project", async () => {
  const { validatePersonEvidenceSearchRequestV1 } = await import("@echo-brain/organization-api");
  const { additions } = loadDataset();
  const requests = [];
  const citation = (meeting, kind, index) => ({ kind: "approved_record", atom_id: `atom-${meeting}-${kind}-${index}`, record_sha256: `record-${meeting}` });
  const client = {
    async evidenceSearch(request) {
      // As the Person client does: the request's own validator runs before anything is sent.
      validatePersonEvidenceSearchRequestV1(request);
      requests.push(request);
      const meeting = additions.meetings.find(value => value.title === request.query);
      const [kind] = request.kinds;
      // M1 has eleven decisions, more than one search returns; M5 has nothing approved yet.
      const count = meeting.id === "M5" ? 0 : meeting.id === "M1" && kind === "decision" ? 11 : 1;
      const items = Array.from({ length: count }, (_, index) => ({ kind, label: `${meeting.title} · ${kind} ${index}`, citation: citation(meeting.id, kind, index) }));
      return { items: [...items.slice(0, request.limit), { kind, label: "Another meeting", citation: citation("other", kind, 0) }] };
    },
  };
  const { meetings, missing } = await discoverMeetings(client, additions, bindings.project_id);
  const searched = additions.meetings.filter(meeting => meeting.project !== additions.restricted_project.name);
  assert.equal(requests.length, searched.length * 3);
  for (const request of requests) {
    assert.equal(request.limit, 10);
    assert.equal(request.project_id, bindings.project_id);
    assert.equal(request.kinds.length, 1);
  }
  assert.ok(!requests.some(request => request.query === additions.meetings.find(meeting => meeting.project === additions.restricted_project.name).title));
  assert.deepEqual(missing, ["M5"]);
  assert.equal(meetings.M1.decision.length, 10);
  assert.deepEqual(meetings.M1.action, [citation("M1", "action", 0)]);
  assert.deepEqual(meetings.M2, { decision: [citation("M2", "decision", 0)], action: [citation("M2", "action", 0)], rationale: [citation("M2", "rationale", 0)] });
});

test("reports weigh cases equally and keep unknowns unknown", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const items = [ticket("THERM-46")];
  const checks = codeChecks(testCase, completedRun(testCase, items, { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{ citation: items[0].citation }] } }), dataset);
  const unjudged = aggregate([{ checks, judge: null }]);
  assert.equal(unjudged.cases[0].complete_in_every_run, null);
  assert.equal(unjudged.summary.cases_with_unknown_completion, 1);
  const judged = judgeReply(testCase);
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
  const reply = judgeReply(testCase);
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
  const judge = parseJudge(testCase, judgeReply(testCase));
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

/** The 8 pages the October 4 list returned on staging (trace ee2f0973, release c15cd0f), in its order: id, title, version. */
const OCTOBER_4 = [
  ["589865", "ECHO Product Pipeline — Start Here", "3"],
  ["1474561", "Assumptions and decisions — source facts versus proposals", "3"],
  ["1441793", "Gate reviews — EVT pass, DVT hold, PVT pending", "3"],
  ["1409042", "Traceability — requirement threads and BUG-412 walkthrough", "3"],
  ["1409025", "PRD — System and acceptance requirements", "3"],
  ["1212607", "Verification plan — EVT, DVT and PVT mock results", "3"],
  ["1212589", "MRD — Mock Digital Thermometer", "3"],
  ["1015989", "Mock Digital Thermometer Home", "5"],
];
const OCT4_CASE = "confluence-pages-created-on-october-4-global";
const pageCitation = (id, version, section) => ({ kind: "page", tool_id: "confluence", external_scope_id: "site", page_id: id, section_id: section, version,
  permalink: `https://echobrain.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: digest(section === "inventory" ? "" : `text-${id}-${section}`) });
/** A page as its list row: title, dates and status, no text, never read in full. */
const pageRow = ([id, title, version], index) => ({ id: `E${index + 1}`, source: "pages", kind: "page", title, citation: pageCitation(id, version, "inventory"),
  dates: { created: "2026-10-04T23:20:00.000Z" }, attributes: { status: "current" }, read_in_full: false, opened: false, preloaded: false, cited_by_plan: false });
/** An opened page's first section, read in full, as Confluence releases it under a new id. */
const pageSection = ([id, title, version], index) => ({ id: `E${index + 9}`, source: "pages", kind: "page", title: `${title} · section 1`, citation: pageCitation(id, version, "s1"),
  text: "SYNTHETIC MOCK", read_in_full: true, opened: true, preloaded: false, cited_by_plan: true });
const ROWS = OCTOBER_4.map(pageRow);
/** The pages' titles from `from` to `to`, as a statement names them (the code check reads names from the text). */
const titles = (from, to) => OCTOBER_4.slice(from, to).map(([, title]) => title).join("; ");
/** A list research read (ADR-0041) holding these rows, read to a confirmed end and all shown to research. */
const listOf = rows => ({ id: "L1", source: "pages", filter: { since: "2026-10-04", until: "2026-10-04", date_field: "created", time_zone: "UTC" }, filter_applied: { since: "applied", until: "applied", date_field: "applied" },
  members: rows.map(row => row.id), shown: rows.length, ended: true, unverified_end: false, available: true, truncated: false, read_at: "2026-10-17T06:58:31.000Z", complete: true });
/** The October 4 list: its 8 rows. */
const OCT4_LIST = listOf(ROWS);
/**
 * An October 4 run: research's items, lists and found evidence with the need's declared kind (ADR-0041; none is
 * content), the ids the writer saw, and the items the answer cites, in one statement or in several. `testCase` may be
 * another list case.
 */
function october4Run({ testCase = caseById(OCT4_CASE), items = ROWS, lists, evidence, kind, writer, cites, text = `${(cites ?? []).map(item => item.title).join("; ")}.`, statements }) {
  const written = statements ?? [{ text, cites }];
  const cited = [...new Set(written.flatMap(statement => statement.cites))];
  const answer = { outcome: "answered", parts: [{ status: "answered", statements: written.map(statement => ({ text: statement.text, citation_indexes: statement.cites.map(item => cited.indexOf(item)) })) }], citations: cited.map(citationOf) };
  const run = completedRun(testCase, items, { writer_evidence: writer, response: answer });
  const need = { need: "Confluence pages created on 2026-10-04", ...(kind === undefined ? {} : { kind }), status: "found", evidence };
  run.result.research = { ...run.result.research, plan: [{ part: 1, question: testCase.question, notes: "", needs: [need] }], ...(lists === undefined ? {} : { lists }) };
  return { testCase, run };
}
/** A judge that says yes to everything: list parts must still score on the whole list. */
const lenientJudge = testCase => parseJudge(testCase, judgeReply(testCase));

test("the October 4 case keys the trace's 8 pages as one list part, and list parts name whole items, once, in Ask cases only", () => {
  const testCase = caseById(OCT4_CASE);
  assert.deepEqual([testCase.trigger, testCase.scope, testCase.question, testCase.parts.map(part => part.type), testCase.parts[0].evidence],
    ["ask", { kind: "global" }, "Which Confluence pages were created on October 4, 2026?", ["list"], OCTOBER_4.map(([page]) => ({ page }))]);
  for (const [, title] of OCTOBER_4) assert.ok(testCase.parts[0].requirement.includes(title), title);
  const entry = dataset.cases.find(value => value.id === OCT4_CASE);
  const problems = part => datasetProblems({ ...dataset, cases: [{ ...entry, parts: [{ ...entry.parts[0], ...part }] }] });
  assert.deepEqual(problems({}), []);
  // A section and a project are no members, and a list names each member once.
  for (const [evidence, problem] of [[[{ page: "1441793", section: "Gate policy" }], "whole items"], [[{ jira_project: "THERM" }], "whole items"], [[{ page: "589865" }, { page: "589865" }], "each member once"]]) {
    assert.ok(problems({ evidence }).some(value => value.includes(problem)), JSON.stringify(evidence));
  }
  // A task goal records no lists, so an approved record or a sweep has no list part.
  const record = dataset.cases.find(value => value.id === "approved-record-t1-two-decimal-display");
  assert.ok(datasetProblems({ ...dataset, cases: [{ ...record, parts: [...record.parts, { id: "p9", type: "list", requirement: "x", evidence: [{ ticket: "THERM-2" }] }] }] }).some(problem => problem.includes("only Ask cases have list parts")));
});

test("the October 4 answer that named 4 of the 8 pages earns nothing on its list part, whatever the judge says (trace ee2f0973)", () => {
  // As the failing run went: no list evidence, the plan cites the 8 rows and the 4 opened sections, and the writer
  // got only the sections, so the answer names 4 pages.
  const sections = OCTOBER_4.slice(0, 4).map(pageSection);
  const { testCase, run } = october4Run({ items: [...ROWS, ...sections], evidence: [...ROWS, ...sections].map(item => item.id), writer: sections.map(item => item.id), cites: sections });
  const checks = codeChecks(testCase, run, dataset);
  const [part] = checks.parts;
  assert.deepEqual([part.found, part.read, part.cited_by_plan, part.handed, part.named, part.members, part.members_named, checks.coverage.lists_named, checks.answer_citations.unresolved], [true, false, false, false, false, 8, 4, 0, 0]);
  const judged = runScores({ checks, judge: lenientJudge(testCase) });
  // Code decides without a judge too: the list was not named, so the run is not complete.
  assert.deepEqual([judged.writer_parts_correct, judged.writer_lists_named, judged.research_established, judged.complete_and_supported, runScores({ checks, judge: null }).complete_and_supported], [0, 0, 0, false, false]);
});

test("the fixed October 4 answer names all 8 pages from a complete list, citing each page's row, and scores; 7 of 8 earns nothing", () => {
  const ids = ROWS.map(row => row.id);
  const fixed = october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, cites: ROWS });
  const checks = codeChecks(fixed.testCase, fixed.run, dataset);
  const [part] = checks.parts;
  assert.deepEqual([part.found, part.read, part.cited_by_plan, part.handed, part.named, part.members_named], [true, true, true, true, true, 8]);
  // A list member's row resolves like an item read in full (ADR-0041).
  assert.deepEqual(checks.answer_citations, { total: 8, resolved_to_read: 8, unresolved: 0 });
  const scores = runScores({ checks, judge: lenientJudge(fixed.testCase) });
  assert.deepEqual([scores.tools_read, scores.tools_handed, scores.research_established, scores.writer_parts_correct, scores.writer_lists_named, scores.complete_and_supported], [1, 1, 1, 1, 1, true]);
  // Cited follows the declared kind alone (ADR-0041): a found which_items need citing the list by id. A content need's
  // list id, or its rows, never make the list cited; a need saved without a kind is content.
  const run = (options, cites = ROWS) => codeChecks(fixed.testCase, october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, cites, ...options }).run, dataset);
  const cited = (evidence, kind) => run({ evidence, kind }).parts[0].cited_by_plan;
  assert.deepEqual([cited(["L1"], "which_items"), cited(["L1"], "content"), cited(ids, "content"), cited(["L1"], undefined), cited(["E3"], "which_items"), cited(["L1"], "which_say")], [true, false, false, false, false, false]);
  const seven = run({}, ROWS.slice(0, 7));
  const sevenScores = runScores({ checks: seven, judge: lenientJudge(fixed.testCase) });
  assert.deepEqual([seven.parts[0].named, seven.parts[0].members_named, sevenScores.writer_parts_correct, sevenScores.writer_lists_named, sevenScores.complete_and_supported], [false, 7, 0, 0, false]);
  // A list not read to a confirmed end holds the members but is not read: research did not establish the whole list.
  const partial = run({ lists: [{ ...OCT4_LIST, unverified_end: true, complete: false }] });
  assert.deepEqual([partial.parts[0].read, partial.parts[0].named, runScores({ checks: partial, judge: lenientJudge(fixed.testCase) }).research_established], [false, true, 0]);
  // Without the list, a row's citation resolves to nothing research read; an opened section resolves only as text read in full.
  const unlisted = run({ lists: undefined, evidence: ids, kind: undefined });
  assert.deepEqual([unlisted.answer_citations.unresolved, unlisted.parts[0].read], [8, false]);
  const section = OCTOBER_4.slice(0, 1).map(pageSection);
  const bySection = codeChecks(fixed.testCase, october4Run({ items: [...ROWS, { ...section[0], read_in_full: false }], lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, cites: section }).run, dataset);
  assert.equal(bySection.answer_citations.unresolved, 1, "a section is no member of the list: it resolves only when read in full");
});

test("a writer's sentence names the members its text names, never every row it cites beside that text (W1)", () => {
  // Research stopped with the need found on rows (the X5 shape), so no statement code wrote names the list. The writer
  // names 4 of the 8 pages, citing their 4 sections, and the 8 rows it saw beside them, which W1 cites for their facts.
  const ids = ROWS.map(row => row.id);
  const sections = OCTOBER_4.slice(0, 4).map(pageSection);
  const sentence = { text: `The pages created on October 4, 2026 include ${titles(0, 4)}.`, cites: [...sections, ...ROWS] };
  const run = statements => october4Run({ items: [...ROWS, ...sections], lists: [OCT4_LIST], evidence: ids, kind: "which_items", writer: [...sections.map(item => item.id), ...ids], statements });
  const beside = run([sentence]);
  const checks = codeChecks(beside.testCase, beside.run, dataset);
  assert.deepEqual([checks.parts[0].named, checks.parts[0].members_named, checks.coverage.lists_named], [false, 4, 0]);
  // A statement code wrote cites only list members' rows, and names each member it cites, beside the same sentence too.
  const stated = codeChecks(beside.testCase, run([{ text: `8 Confluence pages created on October 4, 2026: ${titles(0, 8)}.`, cites: ROWS }, sentence]).run, dataset);
  assert.deepEqual([stated.parts[0].named, stated.parts[0].members_named], [true, 8]);
  // A row whose text the writer was given (a follow-up's row carries its text) still names only what the sentence says.
  const withText = ROWS.map((row, index) => index < 4 ? row : { ...row, text: "SYNTHETIC MOCK" });
  const own = october4Run({ items: [...withText, ...sections], lists: [OCT4_LIST], evidence: ids, kind: "which_items", writer: [...sections.map(item => item.id), ...ids], statements: [sentence] });
  const [ownPart] = codeChecks(own.testCase, own.run, dataset).parts;
  assert.deepEqual([ownPart.named, ownPart.members_named], [false, 4]);
  // "And N more" is code's count from ECHO's own list (addition 5): a writer's sentence that ends with one counts nothing.
  const counted = codeChecks(beside.testCase, run([{ ...sentence, text: `The pages include ${titles(0, 4)}; and 4 more.` }]).run, dataset);
  assert.equal(counted.parts[0].named, false);
  const code = codeChecks(beside.testCase, run([{ text: `8 Confluence pages created on October 4, 2026: ${titles(0, 4)}; and 4 more.`, cites: ROWS.slice(0, 4) }, sentence]).run, dataset);
  assert.deepEqual([code.parts[0].named, code.parts[0].members_named], [true, 4]);
});

/** Whether a one-statement answer citing `cites` names the list of `rows` its case keys, and how many members it names. */
function namedBy(text, cites, rows = ROWS, testCase) {
  const built = october4Run({ testCase, items: rows, lists: [listOf(rows)], evidence: ["L1"], kind: "which_items", writer: rows.map(row => row.id), cites, text });
  const [part] = codeChecks(built.testCase, built.run, dataset).parts;
  return [part.named, part.members_named];
}

test("a statement names a member it cites when its text holds the member's name, ignoring case and spacing, never inside a longer name", () => {
  // Naming a member without citing it is not naming it.
  assert.deepEqual(namedBy(`8 Confluence pages created on October 4, 2026: ${titles(0, 8)}.`, ROWS.slice(0, 7)), [false, 7]);
  // Names compare ignoring case and spacing, and a name inside a longer word names nothing: "Homepage" does not name
  // "Mock Digital Thermometer Home", and "Home" alone names nothing.
  assert.deepEqual(namedBy(`the pages are: ${titles(0, 7).replaceAll("; ", ";\n  ").toLowerCase()}; and mock   digital thermometer HOME.`, ROWS), [true, 8]);
  assert.deepEqual(namedBy("Mock Digital Thermometer Homepage and Home.", ROWS), [false, 0]);
  // A name inside a longer member's name names only the longer member.
  const pages = [["900001", "Release plan", "1"], ["900002", "Release plan v2", "1"]];
  const plans = { ...caseById(OCT4_CASE), id: "synthetic-release-plans", parts: [{ id: "p1", type: "list", requirement: "Both release plans.", evidence: pages.map(([page]) => ({ page })) }] };
  const rows = pages.map(pageRow);
  assert.deepEqual(namedBy("Release plan v2 replaces the first draft.", rows, rows, plans), [false, 1]);
  assert.deepEqual(namedBy("2 Confluence pages created on October 4, 2026: Release plan; Release plan v2.", rows, rows, plans), [true, 2]);
});

// Two "Weekly notes" pages recording `facts`, then "Budget"; one statement citing the first `cites` rows gives `names`.
function duplicateNames(facts, names, cites = 3) {
  const rows = [...facts, undefined].map((attributes, index) => ({ ...pageRow([`70000${index + 1}`, index < 2 ? "Weekly notes" : "Budget", "1"], index), attributes }));
  const testCase = { ...caseById(OCT4_CASE), id: "synthetic-weekly-notes", parts: [{ id: "p1", type: "list", requirement: "All 3 pages.", evidence: rows.map(row => ({ page: row.citation.page_id })) }] };
  const [named, members_named] = namedBy(`3 Confluence pages created on October 4, 2026: ${names}.`, rows.slice(0, cites), rows, testCase);
  return { named, members_named };
}

test("members sharing a title but not their status, owner or due date are each named only with the facts code adds to tell them apart", () => {
  const run = duplicateNames;
  const status = [{ status: "open" }, { status: "closed" }];
  for (const [facts, names, expected, cites] of [
    [status, "Weekly notes (open); Weekly notes (closed); Budget", { named: true, members_named: 3 }],
    // One title names neither member it could be, and a count cannot cover them.
    [status, "Weekly notes; Budget", { named: false, members_named: 1 }],
    [status, "Weekly notes; and 1 more", { named: false, members_named: 0 }, 2],
    [status, "Weekly notes (closed); Budget", { named: false, members_named: 2 }],
    // The member recording no owner is the one named without one.
    [[{ owner: "Dana Lee" }, {}], "Weekly notes (owner Dana Lee); Weekly notes; Budget", { named: true, members_named: 3 }],
    [[{ owner: "Dana Lee" }, {}], "Weekly notes (owner Dana Lee); Budget", { named: false, members_named: 2 }],
    [[{ due_at: "2026-10-09" }, { due_at: "2026-10-12" }], "Weekly notes (due October 9, 2026); Weekly notes (due October 12, 2026); Budget", { named: true, members_named: 3 }],
    // Facts differing only in case or spacing are the same, so code gives both members one name.
    [[{ status: "open" }, { status: " Open" }], "Weekly notes (2 pages); Budget", { named: true, members_named: 3 }],
  ]) assert.deepEqual(run(facts, names, cites), expected, names);
});

test("duplicate facts name only their whole value, never a competing value inside it", () => {
  for (const [facts, fragment] of [
    [[{ status: "open" }, { status: "not open" }], "not open"],
    [[{ status: "open" }, { status: "open for review" }], "open for review"],
    [[{ owner: "Lee" }, { owner: "Dana Lee" }], "owner Dana Lee"],
    [[{ due_at: "soon" }, { due_at: "not soon" }], "due not soon"],
    [[{ status: "open" }, { status: "not open" }], "status not open"],
    [[{ status: "review" }, { status: "ready, review" }], "ready, review"],
  ]) {
    assert.deepEqual(duplicateNames(facts, `Weekly notes (${fragment}); Budget`), { named: false, members_named: 2 }, fragment);
  }
  assert.deepEqual(duplicateNames([{ status: "open", owner: "Lee" }, { status: "closed", owner: "Open Lee" }],
    "Weekly notes (closed, owner Open Lee); Budget"), { named: false, members_named: 2 });
});

test("duplicate facts accept the renderer's field-specific truncation", () => {
  for (const [field, limit, prefix] of [["status", 60, ""], ["owner", 80, "owner "], ["due_at", 40, "due "]]) {
    const value = "🧪 ".repeat(limit);
    const cut = `${[...value.trim()].slice(0, limit - 1).join("").trimEnd()}…`;
    const facts = [{ [field]: value }, { [field]: "other" }];
    assert.deepEqual(duplicateNames(facts, `Weekly notes (${prefix}${cut}); Weekly notes (${prefix}other); Budget`), { named: true, members_named: 3 }, field);
  }
});

test("a title cut at 120 characters stays apart from a whole title equal to what stands before its ellipsis", () => {
  const short = "Probe drift ".repeat(10).trim();
  assert.equal([...short].length, 119);
  const pages = [["700011", short, "1"], ["700012", `${short} and battery sag`, "1"]];
  const rows = pages.map((page, index) => pageRow(page, index));
  const testCase = { ...caseById(OCT4_CASE), id: "synthetic-cut-titles", parts: [{ id: "p1", type: "list", requirement: "Both pages.", evidence: pages.map(([page]) => ({ page })) }] };
  const named = (names, cites) => namedBy(`2 Confluence pages created on October 4, 2026: ${names}.`, cites, rows, testCase)[1];
  // Code's names; the long title whole, as a writer may give it; and code's cut name alone, which is not the short title.
  assert.deepEqual([named(`${short}; ${short}…`, rows), named(`${short}; ${pages[1][1]}`, rows), named(`${short}…`, rows.slice(0, 1))], [2, 2, 0]);
});

test("past an answer's 25 names, cut, merged and lowercased names match, and only a statement naming every row it cites counts the rest", () => {
  // 30 pages: a title past 120 characters, which code cuts, two pages sharing a label, which code names once, and 27 others.
  const long = "Field return analysis for the mock digital thermometer: probe drift, battery sag, display rounding and fixture tolerances, with owners";
  assert.ok([...long].length > 120);
  const pages = [["800001", long, "1"], ["800002", "Weekly notes", "1"], ["800003", "weekly  notes", "2"],
    ...Array.from({ length: 27 }, (_, index) => [`8001${String(index + 4).padStart(2, "0")}`, `Release checklist ${String(index + 4).padStart(2, "0")}`, "1"])];
  const testCase = { ...caseById(OCT4_CASE), id: "synthetic-thirty-pages", parts: [{ id: "p1", type: "list", requirement: "All 30 pages.", evidence: pages.map(([page]) => ({ page })) }] };
  const rows = pages.map(pageRow);
  const title = ([, value]) => value;
  // The renderer names 25 members (the merged label covers two), then counts the other 5 from ECHO's list (addition 5).
  const names = [`${[...long].slice(0, 119).join("").trimEnd()}…`, "Weekly notes (2 pages)", ...pages.slice(3, 25).map(title)];
  assert.deepEqual(namedBy(`30 Confluence pages created on October 4, 2026: ${names.join("; ")}; and 5 more.`, rows.slice(0, 25), rows, testCase), [true, 25]);
  // A statement citing only rows whose text leaves one of them unnamed is not one code wrote: its "and N more" counts nothing.
  assert.deepEqual(namedBy(`30 Confluence pages created on October 4, 2026: ${names.slice(0, -1).join("; ")}; and 6 more.`, rows.slice(0, 25), rows, testCase), [false, 24]);
  // A writer's sentence naming every member, the long title whole and in lowercase, names the list without any count.
  assert.deepEqual(namedBy(`The pages are ${[long.toLowerCase(), "Weekly Notes", ...pages.slice(3).map(title)].join(", ")}.`, rows, rows, testCase), [true, 30]);
});

test("a member the key names by its meeting is never named by text: its title is its meeting's label, not the name code gives it", () => {
  // The research result titles a meeting record by its meeting's label; code names it by a line of its own text (its
  // list label), which the result does not carry. So the check cannot tell which record a text names, and reads none.
  const rows = [record("M1", "decision", "E1"), record("M3", "decision", "E2")];
  const testCase = { ...caseById(OCT4_CASE), id: "synthetic-meeting-decisions", parts: [{ id: "p1", type: "list", requirement: "Both decisions.", evidence: [{ meeting: "M1", item: "decision" }, { meeting: "M3", item: "decision" }] }] };
  const { run } = october4Run({ testCase, items: rows, lists: [{ ...listOf(rows), source: "records" }], evidence: ["L1"], kind: "which_items", writer: rows.map(row => row.id), cites: rows, text: `2 decisions: ${rows.map(row => row.title).join("; ")}.` });
  const [part] = codeChecks(testCase, run, dataset).parts;
  assert.deepEqual([part.found, part.read, part.named, part.members_named], [true, true, false, 0]);
});

test("each Ask run reports its plan's needs by declared kind, and a case may name the kinds its plan should declare (ADR-0041)", () => {
  const ids = ROWS.map(row => row.id);
  const kinds = needs => {
    const { testCase, run } = october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, cites: ROWS });
    run.result.research.plan = [{ part: 1, question: testCase.question, notes: "", needs }];
    return codeChecks(testCase, run, dataset);
  };
  const need = (kind, evidence = ["L1"]) => ({ need: `n ${kind}`, ...(kind === undefined ? {} : { kind }), status: "found", evidence });
  const all = kinds([need("which_items"), need("which_say"), need("content", ["E1"]), need(undefined, ["E1"])]);
  assert.deepEqual(all.kinds, { which_items: 1, which_say: 1, content: 1, missing: 1 });
  // The October 4 case expects which_items: a plan that declares only it passes; any other set fails, a need without a kind counting as content.
  assert.deepEqual(caseById(OCT4_CASE).expected_kinds, ["which_items"]);
  assert.deepEqual([kinds([need("which_items")]).declared_kinds, all.declared_kinds, kinds([need(undefined)]).declared_kinds, kinds([]).declared_kinds], [true, false, false, false]);
  // The two BUG-412 cases: which pages of a picked set mention it is which_say; which tickets of a whole source is content.
  const confluence = caseById("confluence-pages-october-4-mentioning-bug-412");
  const jira = caseById("jira-tickets-mentioning-bug-412-global");
  assert.deepEqual([confluence.expected_kinds, jira.expected_kinds, confluence.key_status, jira.key_status], [["which_say"], ["content"], "awaiting_founder_confirmation", "awaiting_founder_confirmation"]);
  const declared = (testCase, needs) => {
    const run = completedRun(testCase, ROWS, { writer_evidence: [], response: { outcome: "answered", parts: [{ statements: [] }], citations: [] } });
    run.result.research = { ...run.result.research, plan: [{ part: 1, question: testCase.question, notes: "", needs }] };
    return codeChecks(testCase, run, dataset).declared_kinds;
  };
  assert.deepEqual([declared(jira, [need("content", ["E1"])]), declared(jira, [need(undefined, ["E1"])]), declared(jira, [need("which_say")]), declared(confluence, [need("which_say")]), declared(confluence, [need("which_items"), need("which_say")])],
    [true, true, false, true, false]);
  // Every held-out Ask case names its kinds, so the score also measures rule 3 on questions tuning never sees. The keys
  // are read from the file and restated nowhere (tests/architecture/research-loop-holdout-isolation.test.ts): each case's
  // check passes a plan declaring exactly its kinds and fails one declaring only the kinds it does not name.
  const held = dataset.cases.filter(entry => entry.split === "holdout" && entry.trigger === "ask").map(entry => caseById(entry.id));
  assert.ok(held.length > 0);
  assert.equal(held.filter(entry => entry.expected_kinds === undefined).length, 0, "every held-out Ask case names its kinds");
  const plan = values => values.map(kind => need(kind, kind === "content" ? ["E1"] : ["L1"]));
  const others = values => ["which_items", "which_say", "content"].filter(kind => !values.includes(kind));
  assert.deepEqual(held.map(entry => [declared(entry, plan(entry.expected_kinds)), declared(entry, plan(others(entry.expected_kinds)))]), held.map(() => [true, false]));
  // A case that names no kinds has no such check, and a failed run of one that does scores zero on it.
  const other = caseById("bug-fix-dates-vs-dvt-review");
  const unnamed = codeChecks(other, completedRun(other, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [], citations: [] } }), dataset);
  const failed = codeChecks(jira, { trial: 1, budget: "live", outcome: "failed", result: { status: "failed", error: { code: "timed_out" } } }, dataset);
  assert.deepEqual(["declared_kinds" in unnamed, failed.declared_kinds, runScores({ checks: failed, judge: null }).planner_kinds_declared, runScores({ checks: kinds([need("which_items")]), judge: null }).planner_kinds_declared, runScores({ checks: unnamed, judge: null }).planner_kinds_declared],
    [false, false, 0, 1, null]);
});

test("the report shows each Ask case's need kinds beside the declared-kind check, and the keys awaiting the founder", () => {
  const jira = caseById("jira-tickets-mentioning-bug-412-global");
  const run = kind => {
    const graded = completedRun(jira, ROWS, { writer_evidence: [], response: { outcome: "answered", parts: [{ statements: [] }], citations: [] } });
    graded.result.research = { ...graded.result.research, plan: [{ part: 1, question: jira.question, notes: "", needs: [{ need: "Jira tickets that mention BUG-412", kind, status: "found", evidence: ["E1"] }] }] };
    return { checks: codeChecks(jira, graded, dataset), judge: null };
  };
  const report = aggregate([run("content"), run("which_say")]);
  assert.deepEqual([report.cases[0].kinds, report.cases[0].planner_kinds_declared, report.summary.cases_awaiting_key_confirmation], [{ which_items: 0, which_say: 1, content: 1, missing: 0 }, 0.5, [jira.id]]);
  const markdown = markdownReport({ split: "development", state: "S0", world: "therm-v1", graded_at: "2026-10-18" }, report);
  for (const line of [/Keys drafted from the export and awaiting the founder's confirmation: jira-tickets-mentioning-bug-412-global\./u, /\| Planner \| need kinds as the case expects \(code check\) \| 50% \|/u, /\| jira-tickets-mentioning-bug-412-global \| live \| 0 \| 1 \| 1 \| 0 \| 50% \|/u]) assert.match(markdown, line);
});

test("the dataset accepts expected kinds only on Ask cases and a key awaiting confirmation as its only status", () => {
  const entry = dataset.cases.find(value => value.id === "jira-tickets-mentioning-bug-412-global");
  const problems = changed => datasetProblems({ ...dataset, cases: [{ ...entry, ...changed }] });
  const { key_status: _status, ...confirmed } = entry;
  assert.deepEqual([problems({}), datasetProblems({ ...dataset, cases: dataset.cases.filter(value => value.id === "confluence-pages-october-4-mentioning-bug-412") }), datasetProblems({ ...dataset, cases: [confirmed] })], [[], [], []]);
  for (const expected_kinds of [[], ["content", "content"], ["list"], "content"]) assert.ok(problems({ expected_kinds }).some(problem => problem.includes("expected_kinds must be distinct need kinds")), JSON.stringify(expected_kinds));
  const record = dataset.cases.find(value => value.id === "approved-record-t1-two-decimal-display");
  assert.ok(datasetProblems({ ...dataset, cases: [{ ...record, expected_kinds: ["content"] }] }).some(problem => problem.includes("only Ask cases name the need kinds")));
  for (const key_status of ["confirmed", "draft", ""]) assert.ok(problems({ key_status }).some(problem => problem.includes("key_status can only be awaiting_founder_confirmation")));
});

test("a list longer than an answer's 25 names scores as named when its statement counts the rest from the list", () => {
  // The renderer names at most 25 members, then "and N more" with N from ECHO's own list (ADR-0041, addition 5).
  const ids = ROWS.map(row => row.id);
  const part = text => codeChecks(caseById(OCT4_CASE), october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, cites: ROWS.slice(0, 6), text }).run, dataset).parts[0];
  const counted = part(`8 Confluence pages created on October 4, 2026: ${titles(0, 6)}; and 2 more.`);
  assert.deepEqual([counted.named, counted.members_named], [true, 6]);
  // A count that leaves members out, or no count at all, is still some of the list.
  assert.deepEqual([part(`8 Confluence pages: ${titles(0, 6)}; and 1 more.`).named, part("The pages.").named], [false, false]);
  // Each statement is read alone: a statement selecting members by id past the full statement's names never counts twice.
  const both = codeChecks(caseById(OCT4_CASE), october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ids, statements: [
    { text: `8 Confluence pages created on October 4, 2026: ${titles(0, 6)}; and 2 more.`, cites: ROWS.slice(0, 6) },
    { text: `1 of the 8 Confluence pages created on October 4, 2026: ${titles(6, 7)} (status current).`, cites: ROWS.slice(6, 7) },
  ] }).run, dataset).parts[0];
  assert.deepEqual([both.named, both.members_named], [true, 7]);
});

test("a failed run of a list case scores zero on naming its list, and reports show lists named apart from parts correct", () => {
  const testCase = caseById(OCT4_CASE);
  const failed = codeChecks(testCase, { trial: 2, budget: "live", outcome: "failed", result: { status: "failed", error: { code: "timed_out" } } }, dataset);
  // A case without list parts has no such measure.
  const other = caseById("bug-fix-dates-vs-dvt-review");
  assert.deepEqual([failed.list_parts, runScores({ checks: failed, judge: null }).writer_lists_named, "writer_lists_named" in runScores({ checks: codeChecks(other, { trial: 1, budget: "live", outcome: "failed", error: { code: "unavailable" } }, dataset), judge: null })], [1, 0, false]);
  const fixed = october4Run({ lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ROWS.map(row => row.id), cites: ROWS });
  const report = aggregate([{ checks: codeChecks(testCase, fixed.run, dataset), judge: null }, { checks: failed, judge: null }]);
  assert.equal(report.cases[0].writer_lists_named, 0.5);
  const [, renderers] = markdownReport({ split: "development", state: "S0", world: "therm-v1", graded_at: "2026-10-17" }, report).split("## Renderers");
  assert.match(renderers, /\| Ask writer \| lists named in full \(code check\) \| 50% \|/u);
  // Unjudged, parts correct counts only the failed run's zero; lists named is a code check, so both runs count.
  assert.match(renderers, new RegExp(`\\| ${OCT4_CASE} \\| ask \\| live \\| 0% \\| — \\| — \\| — \\| — \\| 50% \\|`, "u"));
});

test("list rows the writer saw are never noise, and hand over row facts but not other content (ADR-0041)", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  // Research read SW-14c in full, and listed DVT-R2 and 60 ECHO tickets (distractors) as rows; the writer saw all of them.
  const row = (key, id) => ({ ...ticket(key, { id, read: false, cited: false }), attributes: { status: "In Progress" } });
  const rows = [row("THERM-48", "E2"), ...Array.from({ length: 60 }, (_, index) => row(`ECHO-${index + 1}`, `E${index + 3}`))];
  const items = [ticket("THERM-12", { id: "E1", text: "SW-14c is due 2026-10-20." }), ...rows];
  const run = completedRun(testCase, items, { writer_evidence: items.map(item => item.id), response: { outcome: "answered", parts: [{ statements: [] }], citations: [] } });
  run.result.research = { ...run.result.research, lists: [{ ...OCT4_LIST, source: "tickets", members: rows.map(item => item.id) }] };
  const checks = codeChecks(testCase, run, dataset);
  // DVT-R2's row carries its date (p4), but not why the hold stands (p6, a conflict); SW-14c's text hands over p3.
  assert.deepEqual([...["p3", "p4", "p6"].map(id => checks.parts.find(entry => entry.id === id).handed), checks.noise_handed, checks.distractors.found, checks.distractors.handed], [true, true, false, 0, 60, 0]);
});

test("saved runs keep Ask's lists, and the judge sees them as rows without text and grades a list part on the whole list", () => {
  const research = { schema_version: 1, kind: "echo-agentic-research-result-v1", trigger: "ask", goal: { kind: "question", question: "q" }, plan: [], items: ROWS, lists: [OCT4_LIST], rounds: [], coverage: {}, stop: {}, cost: {} };
  assert.deepEqual(savedResult({ status: "completed", research: { ...research, server: { receipts: [] } } }).research.lists, [OCT4_LIST]);
  const { testCase, run } = october4Run({ items: [...ROWS, ...OCTOBER_4.slice(0, 1).map(pageSection)], lists: [OCT4_LIST], evidence: ["L1"], kind: "which_items", writer: ROWS.map(row => row.id), cites: ROWS });
  const input = judgeInput(testCase, run);
  assert.deepEqual(input.research.lists.map(list => [list.id, list.complete, list.count, list.filter.date_field]), [["L1", true, 8, "created"]]);
  assert.deepEqual(input.research.lists[0].members[0], { id: "E1", kind: "page", title: "ECHO Product Pipeline — Start Here", dates: { created: "2026-10-04T23:20:00.000Z" }, attributes: { status: "current" } });
  assert.equal(JSON.stringify(input.research.lists).includes("SYNTHETIC MOCK"), false, "a list shows rows, never text");
  assert.deepEqual(input.key.parts.map(part => part.type), ["list"]);
  // Past an answer's 25 names, "and N more" counts the rest, as the code check does.
  for (const rule of [/A part of type list names a set of items/u, /Naming some of them otherwise is no\./u, /ends 'and N more' names the whole set when the items it names plus N are every one of them/u]) assert.match(JUDGE_SYSTEM, rule);
  // A run without lists shows the judge none.
  const other = caseById("bug-fix-dates-vs-dvt-review");
  assert.equal("lists" in judgeInput(other, completedRun(other, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [], citations: [] } })).research, false);
  // The founder's blind sheet asks about every member of a list part.
  const questions = judgeChecks(testCase, lenientJudge(testCase)).map(check => check.question);
  for (const start of ["Does a complete list research read hold every item in:", "Does the answer name every item in this list"]) assert.ok(questions.some(question => question.startsWith(start)), start);
});

test("grade and report run end to end on saved runs without a judge, a sweep run graded on its sweep result", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-cli-")));
  writePrivateJson(out, "bindings.json", { ...bindings, test_person: "Zhen Ye" });
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const run = completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } });
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { ...run, case_id: testCase.id, split: "development", state: "S0", trigger: "ask", model: "test-loop-model", source_sha: "commit-a" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { case_id: "overlong-dvt-schedule-check", split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "test-loop-model", source_sha: "commit-a", outcome: "rejected", error: { code: "query_too_long" } });
  const card = t1CardRun();
  writePrivateJson(out, `runs/${card.testCase.id}/background-1.json`, { ...card.run, case_id: card.testCase.id, split: "development", state: "S0", trigger: "approved_record", model: "test-loop-model", source_sha: "commit-a" });
  const sweep = caseById("sweep-two-decimal-propagation");
  const items = propagationItems();
  const result = sweepResult(items.slice(0, 2), [
    { verdict: "landed", line: "SW-22b now specifies two-decimal formatting.", cites: [0] },
    { verdict: "still_open", line: "TC-D-06 still expects one decimal.", cites: [1] },
    { verdict: null, line: "Not assessed." },
  ]);
  writePrivateJson(out, `runs/${sweep.id}/background-1.json`, { ...completedRun(sweep, items, undefined, result), case_id: sweep.id, split: "development", state: "S1", trigger: "sweep", model: "test-loop-model", source_sha: "commit-a" });
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.summary.cases, 4);
  assert.equal(report.cases.find(entry => entry.case_id === card.testCase.id).card_items_listed, 4 / card.testCase.affected.length);
  assert.equal(report.summary.runs_rejected_at_ingress, 1);
  assert.equal(report.cases.find(entry => entry.case_id === testCase.id).tools_found > 0, true);
  assert.equal(report.identity.model, "test-loop-model");
  assert.deepEqual([report.summary.sweep_verdicts_right, report.summary.sweep_findings, report.summary.sweep_not_assessed], [2, 3, 1]);
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /\| sweep-two-decimal-propagation \| background \| 1 \| 2 \/ 3 \| 1 \|/u);
});

test("report withholds judge metrics until its exact grading pass is calibrated", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-uncalibrated-")));
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const checks = codeChecks(testCase, completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }), dataset);
  const judge = judgeReply(testCase);
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { source_sha: "source", state: "S0", model: "test-loop-model" });
  const [{ file, sha256 }] = savedRunFiles(out);
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: "anthropic/claude-test", graded_at: "2026-10-06T00:00:00.000Z", runs: [{ run: { file, sha256 }, checks, judge, judge_error: null }] });
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.identity.judge_calibration.status, "untrusted");
  assert.equal(report.summary.research_established, null);
  // A withheld judge counts no false abstentions, not zero, and withholding adds no measure an entry does not carry.
  assert.deepEqual([report.cases[0].false_abstention_runs, Object.hasOwn(report.summary, "false_abstention_runs"), Object.hasOwn(report.cases[0], "writer_false_abstention")], [null, false, false]);
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /judge-derived metrics are withheld/u);
});

test("runs record an explicit loop model and reports refuse mixed identities", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-model-")));
  await assert.rejects(main(["run", "--run", "--split", "development", "--state", "S0", "--out", out]), /--model is required/u);
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: null, graded_at: "2026-10-06T00:00:00.000Z", runs: [] });
  writePrivateJson(out, "runs/a/live-1.json", { state: "S0", model: "loop-a" });
  writePrivateJson(out, "runs/b/live-1.json", { state: "S0", model: "loop-b" });
  await assert.rejects(main(["report", "--out", out]), /one evaluated loop model/u);
});

test("reports refuse runs from more than one source commit", async () => {
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-source-")));
  writePrivateJson(out, "bindings.json", { ...bindings, test_person: "Zhen Ye" });
  const rejected = { split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "loop-a", outcome: "rejected", error: { code: "query_too_long" } };
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { ...rejected, case_id: "overlong-dvt-schedule-check", source_sha: "commit-a" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-2.json", { ...rejected, case_id: "overlong-dvt-schedule-check", trial: 2, source_sha: "commit-b" });
  await main(["grade", "--no-judge", "--out", out]);
  await assert.rejects(main(["report", "--out", out]), /one source commit/u);
});

test("reports refuse saved runs that changed after grading", async () => {
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
