import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { datasetProblems, loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { itemMatches, ticketKey } from "../lib/match.mjs";
import { codeChecks } from "../lib/checks.mjs";
import { exportBindings } from "../lib/bindings.mjs";
import { startRequest } from "../lib/requests.mjs";
import { aggregate, runScores } from "../lib/report.mjs";
import { parseJudge } from "../lib/judge.mjs";
import { agreement, blindSheet } from "../lib/calibration.mjs";
import { privateDirectory } from "../lib/private-files.mjs";

const dataset = loadDataset();
const meetings = new Map(dataset.additions.meetings.map(meeting => [meeting.id, meeting]));
const titleOf = id => meetings.get(id).title;
const ticket = (key, options = {}) => ({ id: options.id ?? "E1", source: "tickets", kind: "ticket", title: `${key}: Work item`,
  citation: { kind: "ticket", tool_id: "jira", external_scope_id: "cloud", ticket_id: "10046", permalink: `https://echobrain.atlassian.net/browse/${key}`, text_sha256: "sha256:0" },
  read_in_full: options.read ?? true, opened: true, preloaded: false, cited_by_plan: options.cited ?? true, ...(options.text === undefined ? {} : { text: options.text }) });
const record = (meeting, kind, id) => ({ id, source: "meetings", kind, title: titleOf(meeting), citation: { kind: "approved_record" }, text: "x", read_in_full: true, opened: true, preloaded: false, cited_by_plan: false });
const bindings = { project_id: "prj_00000000-0000-4000-8000-000000000003", site: "https://echobrain.atlassian.net", cloud_id: "cloud-1",
  tickets: { "THERM-18": "10018", "THERM-40": "10040", "THERM-46": "10046", "THERM-47": "10047", "THERM-48": "10048", "THERM-38": "10038", "THERM-2": "10002", "THERM-50": "10050" },
  meetings: Object.fromEntries(["M1", "M2", "M3", "M4", "M5"].map(id => [id, { decision: [{ kind: "approved_record", atom_id: `atom-${id}` }], action: [{ kind: "approved_record", atom_id: `action-${id}` }], rationale: [] }])) };
const caseById = id => substitutePerson(dataset.cases.find(entry => entry.id === id), "Zhen Ye");
function completedRun(testCase, items, ask) {
  return { trial: 1, budget: testCase.budget, outcome: "completed", result: { status: "completed", research: {
    kind: "echo-agentic-research-result-v1", trigger: testCase.trigger, goal: { kind: "question", question: testCase.question }, items, plan: [{ part: 1, question: "q", notes: "", needs: [{ need: "n", status: "found", evidence: ["E1"] }] }],
    rounds: [{ round: 1 }], stop: { reason: "finished", completed: true }, cost: { rounds: 2, model_calls: 3, elapsed_ms: 12_000 },
  }, ...(ask === undefined ? {} : { ask }) } };
}

test("the committed dataset is structurally valid and keeps the restricted meeting out of evidence", () => {
  assert.deepEqual(datasetProblems(dataset), []);
  assert.ok(dataset.cases.length >= 25);
  assert.ok(dataset.cases.some(entry => entry.trigger === "check") && dataset.cases.some(entry => entry.trigger === "sweep"));
  assert.ok(dataset.additions.restricted_project.leak_markers.includes("Corvane"));
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
});

test("start requests carry the goal, scope and starting citations for each trigger", () => {
  const ask = startRequest(caseById("bug-fix-dates-vs-dvt-review"), bindings);
  assert.deepEqual(ask, { schema_version: 1, budget: "live", project_id: bindings.project_id, trigger: "ask", question: "Are the BUG-412 fix dates on track for the DVT gate review?" });
  assert.deepEqual(startRequest(caseById("check-t1-two-decimal-display"), bindings).record, { kind: "approved_record", atom_id: "atom-M2" });
  const sweep = startRequest(caseById("sweep-two-decimal-propagation"), bindings);
  assert.equal(sweep.trigger, "sweep");
  assert.deepEqual(sweep.findings[0].citations[0], { kind: "ticket", tool_id: "jira", external_scope_id: "cloud-1", ticket_id: "10018", permalink: "https://echobrain.atlassian.net/browse/THERM-18", text_sha256: sweep.findings[0].citations[0].text_sha256 });
  assert.equal(startRequest(caseById("bug-fix-dates-vs-dvt-review"), bindings, "background").budget, "background");
});

test("export bindings read the site, cloud id and THERM issue ids", () => {
  const bound = exportBindings({ site: "https://echobrain.atlassian.net/", cloudId: "cloud-9", jira_batches: [{ issues: [{ id: "10046", key: "THERM-46" }, { id: "1", key: "ECHO-1" }] }] });
  assert.deepEqual(bound, { site: "https://echobrain.atlassian.net", cloud_id: "cloud-9", tickets: { "THERM-46": "10046" } });
});

test("reports weigh cases equally and keep unknowns unknown", () => {
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const items = [ticket("THERM-46")];
  const checks = codeChecks(testCase, completedRun(testCase, items, { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }), dataset);
  const unjudged = aggregate([{ checks, judge: null }]);
  assert.equal(unjudged.cases[0].complete_in_every_run, null);
  assert.equal(unjudged.summary.cases_with_unknown_completion, 1);
  const judged = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "yes", answer_correct: "yes" })),
    gaps: [], must_not_violations: [], unsupported_claims: 0, false_abstention: false, verdicts: [], notes: "" };
  assert.equal(runScores({ checks, judge: judged }).complete_and_supported, true);
  assert.equal(runScores({ checks: { ...checks, leaks: [{ kind: "marker" }] }, judge: judged }).complete_and_supported, false);
  const other = codeChecks({ ...testCase, id: "other" }, completedRun(testCase, []), dataset);
  const report = aggregate([{ checks, judge: judged }, { checks: { ...checks, trial: 2 }, judge: judged }, { checks: other, judge: { ...judged, parts: judged.parts.map(part => ({ ...part, established_by_research: false })) } }]);
  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.cases_complete_in_every_run, 1);
  assert.equal(report.summary.tools_found, 0.5 * (checks.coverage.found / checks.parts.length));
});

test("judge replies must cover every part, need and verdict, and calibration needs 90% agreement", () => {
  const testCase = caseById("sweep-two-decimal-propagation");
  const reply = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "not_applicable", answer_correct: "not_applicable" })),
    gaps: [], must_not_violations: [], unsupported_claims: 0, false_abstention: false, verdicts: testCase.verdicts.map(verdict => ({ finding: verdict.finding, judged: verdict.expected, matches_expected: true })), notes: "" };
  const judged = parseJudge(testCase, reply);
  assert.throws(() => parseJudge(testCase, { ...reply, parts: reply.parts.slice(1) }));
  assert.throws(() => parseJudge(testCase, { ...reply, verdicts: [] }));
  const graded = [{ checks: { case_id: testCase.id, trial: 1, budget: "background" }, judge: judged }];
  const cases = new Map([[testCase.id, testCase]]);
  const sheet = blindSheet(graded, cases);
  assert.equal(JSON.stringify(sheet).includes('"judge"'), false, "the sheet is blind");
  for (const check of sheet[0].checks) check.founder = check.id.startsWith("must_not") ? false : true;
  assert.equal(agreement(sheet, graded, cases).trusted, true);
  sheet[0].checks[0].founder = false; sheet[0].checks[1].founder = false;
  const result = agreement(sheet, graded, cases);
  assert.equal(result.trusted, result.rate >= 0.9);
  assert.equal(result.disagreements.length, 2);
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
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { ...run, case_id: testCase.id, split: "development", state: "S0", trigger: "ask" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { case_id: "overlong-dvt-schedule-check", split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, outcome: "rejected", error: { code: "query_too_long" } });
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.runs_rejected_at_ingress, 1);
  assert.equal(report.cases.find(entry => entry.case_id === testCase.id).tools_found > 0, true);
});
