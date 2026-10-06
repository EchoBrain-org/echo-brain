import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { datasetProblems, loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { itemMatches, satisfying, ticketKey } from "../lib/match.mjs";
import { codeChecks } from "../lib/checks.mjs";
import { exportBindings } from "../lib/bindings.mjs";
import { startRequest } from "../lib/requests.mjs";
import { aggregate, runScores } from "../lib/report.mjs";
import { parseJudge } from "../lib/judge.mjs";
import { CALIBRATION_SAMPLE_RUNS, agreement, blindSheet, calibrationSheet, calibrationStatus, judgeChecks, scoreCalibration } from "../lib/calibration.mjs";
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
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { ...run, case_id: testCase.id, split: "development", state: "S0", trigger: "ask", model: "test-loop-model" });
  writePrivateJson(out, "runs/overlong-dvt-schedule-check/live-1.json", { case_id: "overlong-dvt-schedule-check", split: "development", state: "S0", trigger: "ask", budget: "live", trial: 1, model: "test-loop-model", outcome: "rejected", error: { code: "query_too_long" } });
  await main(["grade", "--no-judge", "--out", out]);
  await main(["report", "--out", out]);
  const report = readJson(join(out, "report.json"));
  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.runs_rejected_at_ingress, 1);
  assert.equal(report.cases.find(entry => entry.case_id === testCase.id).tools_found > 0, true);
  assert.equal(report.identity.model, "test-loop-model");
});

test("report withholds judge metrics until its exact grading pass is calibrated", async () => {
  const { main } = await import("../cli.mjs");
  const { writePrivateJson, readJson } = await import("../lib/private-files.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-uncalibrated-")));
  const testCase = caseById("bug-fix-dates-vs-dvt-review");
  const checks = codeChecks(testCase, completedRun(testCase, [ticket("THERM-46")], { writer_evidence: ["E1"], response: { outcome: "answered", parts: [{ statements: [{}] }], citations: [{}] } }), dataset);
  const judge = { needs: testCase.expected_needs.map(expected => ({ expected, covered: true })), invented_needs: [], parts: testCase.parts.map(part => ({ id: part.id, established_by_research: true, stated_in_answer: "yes", answer_correct: "yes" })), gaps: [], must_not: testCase.must_not.map(rule => ({ rule, violated: false })), unsupported_claims: 0, false_abstention: false, verdicts: [], notes: "" };
  writePrivateJson(out, "graded.json", { schema_version: 1, judge_model: "anthropic/claude-test", graded_at: "2026-10-06T00:00:00.000Z", runs: [{ checks, judge, judge_error: null }] });
  writePrivateJson(out, `runs/${testCase.id}/live-1.json`, { source_sha: "source", state: "S0", model: "test-loop-model" });
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
