import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { datasetProblems, loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { itemMatches, meetingIndex } from "../lib/match.mjs";
import { codeChecks } from "../lib/checks.mjs";
import { aggregate, markdownReport } from "../lib/report.mjs";
import { askedDays, collectionOfSource, collectionsLookedAt, reachChecks, refusalOf, traceCounts, uncheckedStated, windowOf } from "../lib/reach.mjs";
import { langsmithTraces, releaseCheck, releaseCheckLines } from "../lib/release-check.mjs";
import { privateDirectory, readJson, writePrivateJson } from "../lib/private-files.mjs";

const dataset = loadDataset();
const meetings = meetingIndex(dataset.additions);
const caseById = id => substitutePerson(dataset.cases.find(entry => entry.id === id), "Zhen Ye");
const M6 = ["decision", "action", "rationale", "transcript"].map(item => ({ meeting: "M6", item }));

/** One read as a round records it (AgenticResearchActionV1). */
const action = (tool, args, result = {}) => ({ tool, args, result: { items: [], opened: [], ...result } });
const round = (number, ...actions) => ({ round: number, elapsed_ms: 1, plan: [], actions, rejected: [] });
const finish = number => round(number, { tool: "finish", args: {}, result: { items: [], opened: [] } });
const research = (rounds, extra = {}) => ({ kind: "echo-agentic-research-result-v1", goal: { kind: "question", question: "q" }, plan: [], items: [], lists: [], rounds,
  stop: { reason: "finished", completed: true }, cost: { rounds: rounds.length, model_calls: rounds.length + 1, elapsed_ms: 9_000 }, coverage: { reads: [], inventories: [], notices: [] }, ...extra });
const completed = (value, ask, startedAt = "2026-10-19T18:00:00.000Z") => ({ trial: 1, budget: "live", outcome: "completed", started_at: startedAt,
  result: { status: "completed", research: value, ...(ask === undefined ? {} : { ask }) } });
const DATES_REFUSED = "follow_ups have no dates; omit since, until and date_field";

/**
 * The shape of the staging Ask "what are my current active projects?" on 40ba71c (research tool contract v1, "Why"):
 * a dated follow-ups list refused, then sent again six times in four rounds, and no projects source at all.
 */
function activeProjectsTrace() {
  const refused = args => action("list", { source: "follow_ups", owner: "Pat", ...args }, { error: DATES_REFUSED });
  return research([
    round(1, refused({ date_field: "due" }), action("list", { source: "meetings", kind: "action", owner: "Pat", date_field: "due" }, { items: ["E1", "E2"] })),
    round(2, refused({ date_field: "due" }), refused({ date_field: "due" }), action("list", { source: "meetings", kind: "action", owner: "Pat", date_field: "due" }, { note: "already listed in full; nothing more to list" })),
    round(3, refused({ since: "2026-10-19" }), action("list", { source: "meetings", kind: "action", owner: "Pat", since: "2026-10-19" })),
    round(4, refused({ date_field: "due" }), action("list", { source: "meetings", kind: "action", owner: "Pat", date_field: "due" }, { note: "already listed in full; nothing more to list" })),
    round(5, refused({ date_field: "due" }), refused({ since: "2026-10-19" })),
  ], { stop: { reason: "no_progress", completed: false }, items: [{ id: "E1", source: "meeting", kind: "action", title: "a" }, { id: "E2", source: "meeting", kind: "action", title: "b" }] });
}

test("a trace counts its rounds, calls per round, collections, refusals and repeated refusals (the 40ba71c projects Ask)", () => {
  const counts = traceCounts(activeProjectsTrace());
  assert.deepEqual([counts.rounds, counts.stop_reason, counts.calls, counts.calls_per_round], [5, "no_progress", 11, [2, 3, 2, 2, 2]]);
  assert.deepEqual(counts.collections, ["meetings"], "a refused call reads nothing, so follow-ups were never looked at");
  // Seven refused calls of one refusal: each after the first repeats it, whatever date argument it was reshaped into.
  assert.deepEqual([counts.refused, counts.repeated_refusals], [7, 6]);
  assert.deepEqual(counts.refusal_reasons, [`list follow_ups: ${DATES_REFUSED}`]);
  const reach = reachChecks({ reach: { collections: ["projects"] } }, completed(activeProjectsTrace()));
  assert.deepEqual([reach.looked_at_every_collection, reach.no_repeated_refusal, reach.unchecked_stated, reach.within_rounds, reach.met], [false, false, null, false, false]);
  assert.deepEqual(reach.missing, ["projects"]);
});

test("a structured refusal names its refused filters, and only the same refusal on the same target repeats it", () => {
  assert.equal(refusalOf(action("list", { source: "meetings" }, { filters: { date_field: "refused", since: "applied" }, supports: { dates: ["approved"] } })), "refused date_field");
  assert.equal(refusalOf(action("list", { source: "meetings" }, { filters: { status: { outcome: "refused" } } })), "refused status");
  assert.equal(refusalOf(action("list", { source: "meetings" }, { filters: { status: "ignored", owner: "partial" } })), null, "ignored and partial are outcomes, not refusals");
  assert.equal(refusalOf(action("list", { source: "meetings" }, { notice: true, note: "nothing more to list" })), null, "a notice is not a refusal");
  const counts = traceCounts(research([
    round(1, action("list", { source: "meetings", date_field: "due" }, { filters: { date_field: "refused" } }), action("list", { source: "tickets", date_field: "due" }, { filters: { date_field: "refused" } })),
    round(2, action("list", { source: "meeting", date_field: "sent" }, { filters: { date_field: "refused" } }), action("open", { id: "E9" }, { error: "unknown id; pass an id such as E4 from your scratchpad" }), action("open", { id: "E8" }, { error: "unknown id; pass an id such as E4 from your scratchpad" })),
    finish(3),
  ]));
  // The second meetings refusal repeats the first (same source, same refused filter); tickets and each open are their own.
  assert.deepEqual([counts.refused, counts.repeated_refusals, counts.rounds, counts.calls_per_round], [5, 1, 3, [2, 3, 0]]);
});

test("collections are named by source ids, selectors and the containers a source or item names", () => {
  assert.deepEqual(["meetings", "meeting", "jira", "tickets", "confluence", "pages", "follow_ups", "projects", "people", "tools", "slack"].map(collectionOfSource),
    ["meetings", "meetings", "tickets", "tickets", "pages", "pages", "follow_ups", "projects", "people", "tools", "slack"]);
  assert.deepEqual(["jira_projects", "jira-project", "confluence_spaces", "slack_channels", "calendar"].map(collectionOfSource), ["jira_projects", "jira_projects", "confluence_spaces", "slack_channels", null]);
  const value = research([
    round(1, action("search", { query: "THERM" }, { items: ["E1", "E2"] }), action("list", { source: "pages" }, { error: "that request is not valid" })),
    finish(2),
  ], { items: [
    { id: "E1", source: "projects", kind: "project", title: "THERM" },
    { id: "E2", source: "jira_projects", kind: "tool_container", title: "THERM", citation: { kind: "tool_container", container: "jira_project", container_id: "10003" } },
    { id: "E3", source: "follow_ups", kind: "follow_up", title: "THERM-47: TRACE-01", preloaded: true },
    { id: "E4", source: "people", kind: "person", title: "Mara Lindqvist" },
  ] });
  // A search of every source counts for what it returned; a linked or opened item counts; a preloaded one and a refused call do not.
  assert.deepEqual([...collectionsLookedAt(value)].sort(), ["jira_projects", "people", "projects"]);
});

test("a required window counts only calls whose dates hold it, on the day asked in UTC or in the lists' time zone", () => {
  assert.deepEqual(windowOf("yesterday", "2026-10-19"), { since: "2026-10-18", until: "2026-10-18" });
  assert.deepEqual(windowOf("this_week", "2026-10-21"), { since: "2026-10-19", until: "2026-10-21" });
  assert.deepEqual(windowOf("last_week", "2026-10-19"), { since: "2026-10-12", until: "2026-10-18" });
  assert.deepEqual(windowOf("this_week", "2026-10-19"), { since: "2026-10-19", until: "2026-10-19" }, "a week starts on Monday");
  const days = ["2026-10-19"];
  const looked = (...actions) => [...collectionsLookedAt(research([round(1, ...actions), finish(2)]), { window: "yesterday", days })].sort();
  assert.deepEqual(looked(
    action("list", { source: "meetings", since: "2026-10-18", until: "2026-10-18" }),
    action("list", { source: "documents", since: "1d" }),
    action("list", { source: "tickets", since: "2026-10-12" }),
    action("list", { source: "pages" }),
    action("search", { query: "review", source: "follow_ups", since: "2026-10-19" }),
  ), ["documents", "meetings", "tickets"], "undated calls and windows that cut the day do not count; an age and a wider window do");
  // A person's Ask sends its time zone, which its lists record: late evening in Los Angeles is the next day in UTC.
  const late = research([], { lists: [{ id: "L1", source: "meetings", filter: { time_zone: "America/Los_Angeles" }, members: [], complete: true }] });
  assert.deepEqual(askedDays("2026-10-20T05:30:00.000Z", late).sort(), ["2026-10-19", "2026-10-20"]);
  assert.deepEqual(askedDays("not a time", late), []);
});

test("the 40ba71c yesterday Ask looked at every collection in its window but ran six rounds to its budget", () => {
  const window = { since: "2026-10-18", until: "2026-10-18" };
  const value = research([
    round(1, ...["meetings", "documents", "tickets", "pages"].map(source => action("list", { source, ...window, date_field: source === "documents" ? "received" : source === "meetings" ? "occurred" : "updated" }, { note: "nothing more to list" }))),
    round(2, action("list", { source: "meetings", ...window }, { note: "nothing more to list" })),
    round(3, action("search", { query: "meeting", source: "meetings", ...window }, { note: "no matches", notice: true })),
    round(4, action("list", { source: "meetings" }, { items: ["E1"], more: true })),
    round(5, action("list", { source: "meetings" })),
    round(6, action("search", { query: "2026-10-18", source: "meetings" })),
  ], { stop: { reason: "budget", completed: false }, coverage: { reads: [], inventories: [], notices: ["missing dates"] } });
  const reach = reachChecks(caseById("what-happened-yesterday"), completed(value, { response: { outcome: "partial", parts: [], citations: [] } }, "2026-10-19T18:43:09.286Z"));
  assert.deepEqual([reach.looked_at_every_collection, reach.no_repeated_refusal, reach.within_rounds, reach.met], [true, true, false, false]);
  assert.equal(traceCounts(value).notices, 1);
});

test("unchecked items must be stated where the answer uses a list that has them", () => {
  const list = { id: "L1", source: "meetings", filter: { since: "2026-10-18", until: "2026-10-18" }, complete: true, members: ["E1"], unchecked: { count: 14, dates: ["approved"] } };
  const item = { id: "E1", source: "meeting", kind: "decision", title: "Pilot review", citation: { kind: "approved_record", atom_id: "a1" } };
  const relied = research([], { lists: [list], items: [item], plan: [{ part: 1, question: "q", notes: "", needs: [{ need: "n", kind: "which_items", status: "found", evidence: ["L1"] }] }] });
  const answer = text => ({ outcome: "answered", parts: [{ statements: [{ text, citation_indexes: [] }] }], citations: [] });
  assert.equal(uncheckedStated(relied, answer("One meeting was approved yesterday; 14 meetings have no recorded time and were not checked.")), true);
  assert.equal(uncheckedStated(relied, answer("One meeting was approved yesterday.")), false);
  assert.equal(uncheckedStated(relied, answer("Meeting 214 was approved.")), false, "a longer number is not the count");
  assert.equal(uncheckedStated(research([], { lists: [{ ...list, unchecked: { count: 3, dates: [] } }], plan: relied.plan }), answer("Three meetings were not checked.")), true, "a small count may be written in words");
  // A list the answer neither relied on nor cites from needs no statement; a cited member makes it used.
  const unused = research([], { lists: [list], items: [item] });
  assert.equal(uncheckedStated(unused, answer("Nothing to say.")), null);
  assert.equal(uncheckedStated(unused, { ...answer("The pilot review was approved."), citations: [{ citation: item.citation }] }), false);
  // Without a list carrying the count, a call's count stands for the list of its source.
  const fromCall = research([round(1, action("list", { source: "meetings", since: "2026-10-18", until: "2026-10-18" }, { unchecked: { count: 5, dates: ["approved"] } }))],
    { lists: [{ id: "L1", source: "meetings", filter: {}, complete: true, members: [] }], plan: relied.plan });
  assert.equal(uncheckedStated(fromCall, answer("Five meetings were not checked.")), true);
  assert.equal(traceCounts(fromCall).unchecked, 5);
  const reach = reachChecks({ reach: { collections: ["meetings"] } }, completed({ ...relied, rounds: [round(1, action("list", { source: "meetings" })), finish(2)] }, { response: answer("One meeting.") }));
  assert.deepEqual([reach.unchecked_stated, reach.met], [false, false]);
});

test("research finishes within its rounds only with a finished stop, and a choice of collections is met by any of them", () => {
  const value = research([round(1, action("list", { source: "jira_projects" }, { items: [] })), round(2, action("open", { id: "E1" })), finish(3)]);
  const key = { reach: { collections: [["projects", "jira_projects"]] } };
  assert.deepEqual([reachChecks(key, completed(value)).within_rounds, reachChecks(key, completed(value)).met], [true, true]);
  const long = research([...[1, 2, 3, 4].map(number => round(number, action("list", { source: "projects" }))), finish(5)]);
  assert.equal(reachChecks(key, completed(long)).within_rounds, false);
  assert.equal(reachChecks({ reach: { ...key.reach, max_rounds: 5 } }, completed(long)).within_rounds, true);
  assert.equal(reachChecks(key, completed({ ...value, stop: { reason: "step_limit", completed: false } })).within_rounds, false);
  const failed = reachChecks(key, { trial: 1, budget: "live", outcome: "failed", result: { status: "failed", error: { code: "timed_out" } } });
  assert.deepEqual([failed.looked_at_every_collection, failed.no_repeated_refusal, failed.unchecked_stated, failed.within_rounds, failed.met], [false, false, null, false, false]);
});

test("workspace references match projects and people by exact name, tools and containers by id, follow-ups by the ticket they follow", () => {
  const project = title => ({ kind: "project", title, citation: { kind: "project", project_id: "prj_1" } });
  assert.equal(itemMatches(project("THERM"), { project: "THERM" }, meetings), true);
  assert.equal(itemMatches(project("THERM Supplier Review"), { project: "THERM" }, meetings), false, "a project is never matched by a longer name");
  assert.equal(itemMatches(project("therm  "), { project: "THERM" }, meetings), true);
  assert.equal(itemMatches({ kind: "person", title: "Mara Lindqvist" }, { person: "Mara Lindqvist" }, meetings), true);
  assert.equal(itemMatches({ kind: "tool", title: "Jira", citation: { kind: "tool", tool_id: "jira" } }, { tool: "jira" }, meetings), true);
  const container = { kind: "tool_container", title: "THERM", citation: { kind: "tool_container", tool_id: "jira", container: "jira_project", container_id: "10003", permalink: "https://echobrain.atlassian.net/browse/THERM" } };
  assert.equal(itemMatches(container, { container: "jira_project", id: "10003" }, meetings), true);
  assert.equal(itemMatches(container, { container: "confluence_space", id: "10003" }, meetings), false);
  const followUp = title => ({ kind: "follow_up", title, text: "On: ticket\nLatest check: none yet", citation: { kind: "follow_up", item_id: "itm_0001" } });
  assert.equal(itemMatches(followUp("THERM-47: TRACE-01 — Confirm BUG-412 requirement and fix-owner links"), { follow_up: "F4" }, meetings), true);
  assert.equal(itemMatches(followUp("THERM-470: Another ticket"), { follow_up: "F4" }, meetings), false);
  assert.equal(itemMatches(followUp("Record the confirmed fix owner"), { follow_up: "F4" }, meetings), false, "a follow-up whose ticket the asker cannot open is not this one");
  assert.equal(itemMatches({ ...followUp("Record the confirmed fix owner"), text: "On: ticket\nExpected: THERM-47 records the fix owner" }, { follow_up: "F4" }, meetings), true, "ECHO's own phrase may name the ticket");
  assert.equal(itemMatches({ ...followUp("THERM-48: DVT-R2"), text: "Expected: waits on THERM-47" }, { follow_up: "F4" }, meetings), false, "a title naming another ticket decides");
  assert.equal(itemMatches({ kind: "ticket", title: "THERM-47: TRACE-01" }, { follow_up: "F4" }, meetings), false);
});

test("the dataset validates workspace references, the open-ended fields and the world's workspace", () => {
  const base = caseById("current-projects-and-leads");
  const problems = changed => datasetProblems({ ...dataset, cases: [{ ...base, ...changed }] });
  assert.deepEqual(problems({}), []);
  assert.ok(problems({ reach: { collections: ["calendar"] } }).some(problem => problem.includes("reach names the collections")));
  assert.ok(problems({ reach: { collections: [["projects"]] } }).some(problem => problem.includes("reach names the collections")), "a choice names at least two collections");
  assert.ok(problems({ reach: { collections: ["projects"], window: "tomorrow" } }).some(problem => problem.includes("window")));
  assert.ok(problems({ reach: { collections: ["projects"], depth: 2 } }).some(problem => problem.includes("reach takes")));
  assert.ok(problems({ category: "vibes" }).some(problem => problem.includes("categories")));
  assert.ok(problems({ awaits: ["magic"] }).some(problem => problem.includes("contract steps")));
  assert.ok(problems({ parts: [{ ...base.parts[0], evidence: [{ follow_up: "F99" }] }] }).some(problem => problem.includes("F99")));
  assert.ok(problems({ parts: [{ ...base.parts[0], evidence: [{ project: "THERM Supplier Review" }] }] }).some(problem => problem.includes("restricted project")));
  assert.ok(problems({ parts: [{ ...base.parts[0], evidence: [{ container: "jira_board", id: "1" }] }] }).some(problem => problem.includes("tool container")));
  assert.ok(problems({ parts: [] , reach: undefined, family: undefined, category: undefined, awaits: undefined }).some(problem => problem.includes("parts are required")));
  assert.deepEqual(problems({ parts: [] }), [], "an open-ended case may be graded on reach and cost alone");
  assert.ok(datasetProblems({ ...dataset, cases: [{ ...caseById("approved-record-t1-two-decimal-display"), family: "open_ended", category: "goal", reach: { collections: ["meetings"] } }] }).some(problem => problem.includes("only Ask cases are open-ended")));
  const world = workspace => datasetProblems({ ...dataset, additions: { ...dataset.additions, workspace: { ...dataset.additions.workspace, ...workspace } }, cases: [] });
  assert.deepEqual(world({}), []);
  const followUps = dataset.additions.workspace.follow_ups;
  assert.ok(world({ follow_ups: [{ ...followUps[2], history: followUps[2].history.slice(0, 1) }] }).some(problem => problem.includes("ends in its status and owner")), "a reassigned follow-up's history ends with its owner");
  assert.ok(world({ follow_ups: [{ ...followUps[0], meeting: "M6" }] }).some(problem => problem.includes("meeting the test person can read")));
  assert.ok(world({ follow_ups: [{ ...followUps[0], owner: "Wen Hao" }] }).some(problem => problem.includes("owner is an account")));
  assert.ok(world({ projects: [{ ...dataset.additions.workspace.projects[0], members: [{ name: "Mara Lindqvist", role: "member" }] }] }).some(problem => problem.includes("at least one lead")));
  assert.ok(world({ projects: [{ ...dataset.additions.workspace.projects[1], name: "THERM Supplier Review" }] }).some(problem => problem.includes("restricted project")));
});

test("the open-ended family asks every goal question in development and holds out each category, all keyed by reach", () => {
  const family = dataset.cases.filter(entry => entry.family === "open_ended");
  const development = family.filter(entry => entry.split === "development");
  const holdout = family.filter(entry => entry.split === "holdout");
  // The design's goal questions, in the founder's words, are development cases; held-out cases ask them otherwise.
  for (const id of ["open-items-and-owners", "open-items-meetings-and-participants", "open-items-time-since-assigned", "current-projects-and-leads", "what-happened-yesterday", "jira-space-link-for-project", "due-late-october-in-project", "project-confluence-pages"]) {
    assert.ok(development.some(entry => entry.id === id), id);
  }
  for (const category of ["goal", "time", "own_work", "structure", "reach", "tools"]) assert.ok(development.some(entry => entry.category === category), `development ${category}`);
  for (const category of ["goal", "time", "own_work", "structure", "tools"]) assert.ok(holdout.some(entry => entry.category === category), `holdout ${category}`);
  for (const entry of family) {
    assert.ok(entry.reach.collections.length > 0 && entry.trigger === "ask", entry.split === "development" ? entry.id : "a held-out case");
    for (const ref of M6) assert.ok(entry.never_appears.some(value => value.meeting === ref.meeting && value.item === ref.item));
  }
  // Every held-out Ask case names its kinds (world/README.md); the held-out ones are read here and never restated.
  assert.ok(holdout.length >= 8 && holdout.every(entry => Array.isArray(entry.expected_kinds)));
  // The Jira-only and Confluence-only questions read their tool and no workspace source, so they await no new collection.
  assert.deepEqual(caseById("project-confluence-pages").reach.collections, ["pages"]);
  assert.equal(caseById("project-confluence-pages").awaits, undefined);
});

test("open-ended runs carry reach checks and trace counts into grading, and the report shows them with what each case awaits", () => {
  // Every contract step has landed, so no case awaits one; a case that does still reports what it awaits.
  const testCase = { ...caseById("current-projects-and-leads"), awaits: ["workspace_collections", "eval_full_catalog"] };
  const items = [
    { id: "E1", source: "projects", kind: "project", title: "THERM", attributes: { role: "lead", leads: "Zhen Ye, Mara Lindqvist" }, citation: { kind: "project", project_id: "prj_1" }, read_in_full: false, opened: false, preloaded: false, cited_by_plan: false },
    { id: "E2", source: "projects", kind: "project", title: "Kestrel Pilot Launch", attributes: { role: "member", leads: "Mara Lindqvist" }, citation: { kind: "project", project_id: "prj_2" }, read_in_full: false, opened: false, preloaded: false, cited_by_plan: false },
  ];
  const value = research([round(1, action("list", { source: "projects", status: "active" }, { items: ["E1", "E2"] })), finish(2)], {
    items, lists: [{ id: "L1", source: "projects", filter: { status: "active" }, filter_applied: { status: "applied" }, complete: true, members: ["E1", "E2"] }],
    plan: [{ part: 1, question: "q", notes: "", needs: [{ need: "active projects", kind: "which_items", status: "found", evidence: ["L1"] }] }],
  });
  const answer = { writer_evidence: ["E1", "E2"], response: { outcome: "answered", parts: [{ statements: [{ text: "You have 2 current projects: THERM; Kestrel Pilot Launch.", citation_indexes: [0, 1] }] }], citations: items.map(item => ({ citation: item.citation, label: item.title })) } };
  const checks = codeChecks(testCase, completed(value, answer), dataset);
  assert.equal(checks.family, "open_ended");
  assert.deepEqual(checks.awaits, ["workspace_collections", "eval_full_catalog"]);
  assert.equal(checks.reach.met, true);
  assert.deepEqual([checks.trace.rounds, checks.trace.collections], [2, ["projects"]]);
  assert.deepEqual(checks.parts.map(part => [part.id, part.found, part.read]), [["p1", true, true], ["p2", true, false]]);
  const failed = codeChecks(testCase, { trial: 2, budget: "live", outcome: "failed", result: { status: "failed", error: { code: "timed_out" } } }, dataset);
  assert.equal(failed.reach.met, false);
  const report = aggregate([{ checks, judge: null }, { checks: failed, judge: null }]);
  const entry = report.cases[0];
  assert.deepEqual([entry.reach_met_in_every_run, entry.reach_collections, entry.reach_within_rounds, entry.trace_refused], [false, 0.5, 0.5, 0]);
  assert.deepEqual([report.summary.open_ended_cases, report.summary.open_ended_cases_met_in_every_run], [1, 0]);
  const markdown = markdownReport({ split: "development", state: "S0", world: "therm-v1", graded_at: "2026-10-19" }, report);
  const [, section] = markdown.split("## Reach and cost");
  assert.match(section, /Open-ended cases meeting reach and cost in every run: \*\*0 of 1\*\*/u);
  assert.match(section, /\| current-projects-and-leads \| live \| 2 \| 1 \| 0 \| 0 \| 0 \| 50% \| 50% \| — \| 50% \| projects \| workspace_collections, eval_full_catalog \|/u);
});

test("a report without trace counts or open-ended cases has no reach section", () => {
  const report = aggregate([{ checks: codeChecks(caseById("bug-fix-dates-vs-dvt-review"), { trial: 1, budget: "live", outcome: "failed", result: { status: "failed" } }, dataset), judge: null }]);
  assert.doesNotMatch(markdownReport({ split: "development", state: "S0", world: "therm-v1", graded_at: "2026-10-19" }, report), /## Reach and cost/u);
});

/** LangSmith runs of one staging Ask as the MCP's runs query returns them: root, research stage and tool runs. */
function langsmithAsk({ trace, question, started, research: value, answer, release = "abc1234", complete = true, withResearch = true }) {
  const root = { id: trace, name: "ECHO ask", run_type: "chain", is_root: true, parent_run_ids: [], start_time: started,
    metadata: { complete, release_sha: release, research_stop_reason: value.stop.reason, trigger: "ask" }, inputs: { brief: { goal: { kind: "question", question } } }, outputs: { trigger: "ask", output_kind: "answer", result: answer } };
  const stage = { id: `${trace}-research`, name: "research", run_type: "chain", is_root: false, parent_run_ids: [trace], start_time: started, metadata: { stage: "research" }, outputs: { research: { ...value, goal: { kind: "question", question } } } };
  let call = 0;
  const tools = value.rounds.flatMap(entry => entry.actions.map(read => ({ id: `${trace}-tool-${++call}`, name: read.tool, run_type: "tool", is_root: false, parent_run_ids: [trace, stage.id], start_time: started,
    metadata: { round: entry.round, tool_call_id: call }, inputs: read.args, outputs: { tool: read.tool, args: read.args, ...(read.result.error === undefined ? { items: read.result.items } : { error: read.result.error }) } })));
  return [root, ...(withResearch ? [stage] : []), ...tools];
}

test("the release check reads each open-ended question's latest staging trace and applies its reach and cost keys", () => {
  const questions = [
    { id: "current-projects-and-leads", question: caseById("current-projects-and-leads").question, reach: caseById("current-projects-and-leads").reach },
    { id: "open-items-and-owners", question: caseById("open-items-and-owners").question, reach: caseById("open-items-and-owners").reach },
  ];
  const good = research([round(1, action("list", { source: "projects", status: "active" }, { items: [] })), finish(2)]);
  const runs = [
    ...langsmithAsk({ trace: "t-old", question: questions[0].question, started: "2026-10-19T17:00:00.000Z", research: activeProjectsTrace(), answer: null }),
    ...langsmithAsk({ trace: "t-new", question: "  what are the CURRENT projects, and who are the project leads?", started: "2026-10-19T18:00:00.000Z", research: good, answer: { outcome: "answered", parts: [], citations: [] } }),
  ];
  const report = releaseCheck({ items: runs }, questions, { release_sha: "abc1234" });
  assert.equal(report.passed, false, "a question without a trace fails the check");
  const [projects, openItems] = report.questions;
  assert.deepEqual([projects.found, projects.trace_id, projects.passed, projects.rebuilt_from_tools], [true, "t-new", true, false], "the latest trace that asked it, compared ignoring case and spacing");
  assert.deepEqual([openItems.found, openItems.passed], [false, false]);
  assert.match(releaseCheckLines(report)[0], /^PASS current-projects-and-leads \(trace t-new\): rounds 2 \(finished\), calls per round 1\/0, refused 0, repeated refusals 0/u);
  assert.match(releaseCheckLines(report)[1], /^FAIL open-items-and-owners: no trace asked/u);
  // A trace from another release, or with an incomplete capture, fails whatever it reached.
  const other = releaseCheck(runs, questions.slice(0, 1), { release_sha: "fffffff" });
  assert.deepEqual(other.questions[0].problems, ["the trace ran release abc1234, not fffffff"]);
  const partial = releaseCheck(langsmithAsk({ trace: "t", question: questions[0].question, started: "2026-10-19T18:00:00.000Z", research: good, answer: null, complete: false }), questions.slice(0, 1));
  assert.deepEqual(partial.questions[0].problems, ["the trace's capture is incomplete"]);
});

test("a trace whose research run was not captured is rebuilt from its tool runs, rounds and refusals included", () => {
  const question = caseById("current-projects-and-leads").question;
  const runs = langsmithAsk({ trace: "t1", question, started: "2026-10-19T18:00:00.000Z", research: activeProjectsTrace(), answer: null, withResearch: false });
  const [trace] = langsmithTraces(runs);
  assert.deepEqual([trace.rebuilt_from_tools, trace.question, trace.stop_reason, trace.research.rounds.length], [true, question, "no_progress", 5]);
  const result = releaseCheck(runs, [{ id: "current-projects-and-leads", question, reach: { collections: ["projects"] } }]).questions[0];
  assert.deepEqual([result.counts.refused, result.counts.repeated_refusals, result.counts.rounds], [7, 6, 5]);
  assert.deepEqual(result.problems, ["collections not looked at: projects", "a refused call was sent again", "research did not finish within 4 rounds"]);
  // An API page names its runs `runs` and keeps metadata under `extra`, with a trace id and one parent.
  const api = runs.map(({ metadata, is_root: _root, parent_run_ids: parents, ...run }) => ({ ...run, trace_id: "t1", parent_run_id: parents.at(-1) ?? null, extra: { metadata } }));
  assert.equal(langsmithTraces({ runs: api })[0].research.rounds.length, 5);
  assert.throws(() => langsmithTraces({ nothing: true }), /holds no runs/u);
});

test("the release check names only open-ended development cases, runs from a private directory and fails loudly", async () => {
  const config = readJson(new URL("../release-check.json", import.meta.url).pathname);
  assert.ok(config.cases.length >= 2 && config.cases.length <= 3);
  for (const id of config.cases) assert.ok(dataset.cases.some(entry => entry.id === id && entry.split === "development" && entry.family === "open_ended"), id);
  const { main } = await import("../cli.mjs");
  const out = privateDirectory(mkdtempSync(join(tmpdir(), "research-loop-release-check-")));
  const done = research([round(1, action("list", { source: "projects" }, { items: [] }), action("list", { source: "follow_ups", status: "open" }, { items: [] }),
    ...["meetings", "documents", "tickets", "pages"].map(source => action("list", { source, since: "2026-10-18", until: "2026-10-18" }))), finish(2)]);
  const runs = config.cases.flatMap((id, index) => langsmithAsk({ trace: `t${index}`, question: caseById(id).question, started: "2026-10-19T18:00:00.000Z", research: done, answer: { outcome: "answered", parts: [], citations: [] } }));
  writePrivateJson(out, "langsmith-runs.json", { items: runs });
  await main(["release-check", "--out", out, "--release-sha", "abc1234"]);
  assert.equal(readJson(join(out, "release-check.json")).passed, true);
  writePrivateJson(out, "failing.json", { items: runs.filter(run => run.id !== "t0" && !run.id.startsWith("t0-")) });
  await assert.rejects(main(["release-check", "--out", out, "--runs", "failing.json"]), /release check failed/u);
  await assert.rejects(main(["release-check", "--out", out, "--runs", "../elsewhere.json"]), /inside --out/u);
});

test("the judge is told when the question was asked, since open-ended keys word time relative to it", async () => {
  const { JUDGE_SYSTEM, judgeInput } = await import("../lib/judge.mjs");
  const testCase = caseById("open-items-time-since-assigned");
  const value = research([round(1, action("list", { source: "follow_ups", status: "open" })), finish(2)]);
  const ask = { writer_evidence: [], response: { outcome: "answered", parts: [], citations: [] } };
  assert.equal(judgeInput(testCase, completed(value, ask, "2026-10-21T16:00:00.000Z")).case.asked_at, "2026-10-21T16:00:00.000Z");
  assert.equal("asked_at" in judgeInput(testCase, { ...completed(value, ask), started_at: undefined }).case, false);
  assert.match(JUDGE_SYSTEM, /case\.asked_at/u);
});
