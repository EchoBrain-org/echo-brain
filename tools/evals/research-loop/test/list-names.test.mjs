import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadDataset, substitutePerson } from "../lib/dataset.mjs";
import { codeChecks } from "../lib/checks.mjs";
import { runScores } from "../lib/report.mjs";

/**
 * "Lists named in full" reads a member as named by a statement only when the statement cites it and its text names it,
 * as code writes names (ADR-0041, addition 7). The response does not say which statements code wrote, so citing a
 * member never names it alone.
 */

const dataset = loadDataset();
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const caseById = id => substitutePerson(dataset.cases.find(entry => entry.id === id), "Zhen Ye");
const citationOf = item => ({ citation: item.citation, kind: item.kind, label: item.title, visibility: "project" });
const pageCitation = (id, version, section) => ({ kind: "page", tool_id: "confluence", external_scope_id: "site", page_id: id, section_id: section, version,
  permalink: `https://echobrain.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`, text_sha256: digest(section === "inventory" ? "" : `text-${id}-${section}`) });
/** A page as its list row: title, dates and status, never read in full; `text` when the row carries it, as a follow-up's does. */
const pageRow = ([id, title, version], index, text) => ({ id: `E${index + 1}`, source: "pages", kind: "page", title, citation: pageCitation(id, version, "inventory"),
  dates: { created: "2026-10-04T23:20:00.000Z" }, attributes: { status: "current" }, ...(text === undefined ? {} : { text }), read_in_full: false, opened: false, preloaded: false, cited_by_plan: false });
/** An opened page's first section, read in full, under a new id. */
const pageSection = ([id, title, version], index, offset) => ({ id: `E${index + offset}`, source: "pages", kind: "page", title: `${title} · section 1`, citation: pageCitation(id, version, "s1"),
  text: "SYNTHETIC MOCK", read_in_full: true, opened: true, preloaded: false, cited_by_plan: true });
const listOf = rows => ({ id: "L1", source: "pages", filter: { since: "2026-10-04", until: "2026-10-04", date_field: "created", time_zone: "UTC" }, filter_applied: { since: "applied", until: "applied", date_field: "applied" },
  members: rows.map(row => row.id), shown: rows.length, ended: true, unverified_end: false, available: true, truncated: false, read_at: "2026-10-17T06:58:31.000Z", complete: true });

/** A completed Ask run of `testCase`: research's items and lists, the writer's ids, and the answer's statements, each `{ text, cites }`. */
function askRun(testCase, { items, lists, writer, statements }) {
  const cited = [...new Set(statements.flatMap(statement => statement.cites))];
  const response = { outcome: "answered", parts: [{ status: "answered", statements: statements.map(statement => ({ text: statement.text, citation_indexes: statement.cites.map(item => cited.indexOf(item)) })) }], citations: cited.map(citationOf) };
  const research = { kind: "echo-agentic-research-result-v1", trigger: "ask", goal: { kind: "question", question: testCase.question }, items, lists,
    plan: [{ part: 1, question: testCase.question, notes: "", needs: [{ need: "the list", kind: "which_items", status: "found", evidence: ["L1"] }] }],
    rounds: [{ round: 1 }], stop: { reason: "finished", completed: true }, cost: { rounds: 2, model_calls: 3, elapsed_ms: 12_000 } };
  return { trial: 1, budget: testCase.budget, outcome: "completed", result: { status: "completed", research, ask: { writer_evidence: writer, response } } };
}
const listPart = (testCase, run) => codeChecks(testCase, run, dataset).parts.find(part => part.type === "list");
const scored = (part, extra = {}) => ({ named: part.named, members_named: part.members_named, ...extra });

/** The 8 pages of the October 4 list (trace ee2f0973), in its order: id, title, version. */
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
const OCT4 = caseById("confluence-pages-created-on-october-4-global");
const ROWS = OCTOBER_4.map((page, index) => pageRow(page, index));
const SECTIONS = OCTOBER_4.slice(0, 4).map((page, index) => pageSection(page, index, 9));
const titles = pages => pages.map(([, title]) => title);
/** The statement code writes for the whole October 4 list (agenticListStatementV1): its count, filter and names. */
const STATED = `8 Confluence pages created on October 4, 2026: ${titles(OCTOBER_4).join("; ")}.`;
/** The October 4 answer that named 4 of the 8 pages. */
const FOUR = `The pages created on October 4, 2026 include ${titles(OCTOBER_4.slice(0, 4)).join(", ")}.`;

test("a sentence citing 8 rows that carry text, as follow-ups' rows do, names the 4 its text names, not all 8 (the Codex shape)", () => {
  const rows = OCTOBER_4.map((page, index) => pageRow(page, index, "SYNTHETIC MOCK"));
  const run = statements => askRun(OCT4, { items: rows, lists: [listOf(rows)], writer: rows.map(row => row.id), statements });
  // Citing only list members' rows once read as code's statement, so every cited row counted as a name.
  const four = listPart(OCT4, run([{ text: FOUR, cites: rows }]));
  assert.deepEqual(scored(four), { named: false, members_named: 4 });
  // So the code check fails the run, whatever the judge says, as it does for 4 of 8 pages.
  const checks = codeChecks(OCT4, run([{ text: FOUR, cites: rows }]), dataset);
  assert.deepEqual([checks.coverage.lists_named, runScores({ checks, judge: null }).writer_lists_named, runScores({ checks, judge: null }).complete_and_supported], [0, 0, false]);
  // Its own "and 4 more" is no count from code: its text does not name every row it cites, so it reads as no statement code wrote.
  assert.deepEqual(scored(listPart(OCT4, run([{ text: `${FOUR.slice(0, -1)}; and 4 more.`, cites: rows }]))), { named: false, members_named: 4 });
  // The same rows named in full are named.
  assert.deepEqual(scored(listPart(OCT4, run([{ text: STATED, cites: rows }]))), { named: true, members_named: 8 });
});

test("the October 4 case: code's statement names all 8 pages; the 4-of-8 answer names 4, with or without the rows beside its sections", () => {
  const items = [...ROWS, ...SECTIONS];
  const run = statements => askRun(OCT4, { items, lists: [listOf(ROWS)], writer: items.map(item => item.id), statements });
  assert.deepEqual(scored(listPart(OCT4, run([{ text: STATED, cites: ROWS }]))), { named: true, members_named: 8 });
  // The 4-of-8 answer citing its 4 sections, and citing the 8 rows beside them (W1's row facts, or rows its list id brings).
  assert.deepEqual(scored(listPart(OCT4, run([{ text: FOUR, cites: SECTIONS }]))), { named: false, members_named: 4 });
  assert.deepEqual(scored(listPart(OCT4, run([{ text: FOUR, cites: [...SECTIONS, ...ROWS] }]))), { named: false, members_named: 4 });
  // Citing a member is not naming it: a statement that cites all 8 rows and names none names nothing.
  assert.deepEqual(scored(listPart(OCT4, run([{ text: "These are the pages created on October 4, 2026.", cites: ROWS }]))), { named: false, members_named: 0 });
  // Nor is naming a member without citing it.
  assert.deepEqual(scored(listPart(OCT4, run([{ text: STATED, cites: ROWS.slice(0, 7) }]))), { named: false, members_named: 7 });
  // Names compare ignoring case and spacing, and a name inside a longer one the text holds is not named by it: the
  // MRD's title is no part of "Mock Digital Thermometer Home", and "Home" alone names nothing.
  const loose = `the pages are: ${titles(OCTOBER_4.slice(0, 7)).join(";\n  ").toLowerCase()}; and mock   digital thermometer HOME.`;
  assert.deepEqual(scored(listPart(OCT4, run([{ text: loose, cites: ROWS }]))), { named: true, members_named: 8 });
  assert.deepEqual(scored(listPart(OCT4, run([{ text: "Mock Digital Thermometer Homepage and Home.", cites: ROWS }]))), { named: false, members_named: 0 });
});

test("a name inside a longer member's name names only the longer member", () => {
  const pages = [["900001", "Release plan", "1"], ["900002", "Release plan v2", "1"]];
  const rows = pages.map((page, index) => pageRow(page, index));
  const testCase = { ...OCT4, id: "synthetic-release-plans", parts: [{ id: "p1", type: "list", requirement: "Both release plans.", evidence: pages.map(([page]) => ({ page })) }] };
  const part = text => scored(listPart(testCase, askRun(testCase, { items: rows, lists: [listOf(rows)], writer: rows.map(row => row.id), statements: [{ text, cites: rows }] })));
  assert.deepEqual(part("Release plan v2 replaces the first draft."), { named: false, members_named: 1 });
  assert.deepEqual(part("2 Confluence pages created on October 4, 2026: Release plan; Release plan v2."), { named: true, members_named: 2 });
});

test("members sharing a title but not their status, owner or due date are each named only with the facts code adds to tell them apart", () => {
  // Two "Weekly notes" pages recording `facts`, then "Budget"; one statement citing the first `cites` rows gives `names`.
  const run = (facts, names, cites = 3) => {
    const rows = [...facts, undefined].map((attributes, index) => ({ ...pageRow([`70000${index + 1}`, index < 2 ? "Weekly notes" : "Budget", "1"], index), attributes }));
    const testCase = { ...OCT4, id: "synthetic-weekly-notes", parts: [{ id: "p1", type: "list", requirement: "All 3 pages.", evidence: rows.map(row => ({ page: row.citation.page_id })) }] };
    const statements = [{ text: `3 Confluence pages created on October 4, 2026: ${names}.`, cites: rows.slice(0, cites) }];
    return scored(listPart(testCase, askRun(testCase, { items: rows, lists: [listOf(rows)], writer: rows.map(row => row.id), statements })));
  };
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

test("a title cut at 120 characters stays apart from a whole title equal to what stands before its ellipsis", () => {
  const short = "Probe drift ".repeat(10).trim();
  assert.equal([...short].length, 119);
  const pages = [["700011", short, "1"], ["700012", `${short} and battery sag`, "1"]];
  const rows = pages.map((page, index) => pageRow(page, index));
  const testCase = { ...OCT4, id: "synthetic-cut-titles", parts: [{ id: "p1", type: "list", requirement: "Both pages.", evidence: pages.map(([page]) => ({ page })) }] };
  const named = (names, cites) => listPart(testCase, askRun(testCase, { items: rows, lists: [listOf(rows)], writer: rows.map(row => row.id),
    statements: [{ text: `2 Confluence pages created on October 4, 2026: ${names}.`, cites }] })).members_named;
  // Code's names; the long title whole, as a writer may give it; and code's cut name alone, which is not the short title.
  assert.deepEqual([named(`${short}; ${short}…`, rows), named(`${short}; ${pages[1][1]}`, rows), named(`${short}…`, rows.slice(0, 1))], [2, 2, 0]);
});

test("past an answer's 25 names, code's statement and its 'and N more' name the whole list; cut, merged and lowercased names match", () => {
  // 30 pages: a title past 120 characters, which code cuts, two pages sharing a label, which code names once, and 27 others.
  const long = "Field return analysis for the mock digital thermometer: probe drift, battery sag, display rounding and fixture tolerances, with owners";
  assert.ok([...long].length > 120);
  const cutName = `${[...long].slice(0, 119).join("").trimEnd()}…`;
  const pages = [["800001", long, "1"], ["800002", "Weekly notes", "1"], ["800003", "weekly  notes", "2"],
    ...Array.from({ length: 27 }, (_, index) => [`8001${String(index + 4).padStart(2, "0")}`, `Release checklist ${String(index + 4).padStart(2, "0")}`, "1"])];
  const rows = pages.map((page, index) => pageRow(page, index));
  const testCase = { ...OCT4, id: "synthetic-thirty-pages", parts: [{ id: "p1", type: "list", requirement: "All 30 pages.", evidence: pages.map(([page]) => ({ page })) }] };
  const section = pageSection(pages[0], 0, 31);
  const run = statements => askRun(testCase, { items: [...rows, section], lists: [listOf(rows)], writer: rows.map(row => row.id), statements });
  // The renderer names 25 members (the merged label covers two), then counts the other 5 from ECHO's list (addition 5).
  const named = [cutName, "Weekly notes (2 pages)", ...titles(pages.slice(3, 25))];
  const stated = `30 Confluence pages created on October 4, 2026: ${named.join("; ")}; and 5 more.`;
  assert.deepEqual(scored(listPart(testCase, run([{ text: stated, cites: rows.slice(0, 25) }]))), { named: true, members_named: 25 });
  // A count that leaves a member out is some of the list.
  assert.equal(listPart(testCase, run([{ text: stated.replace("and 5 more", "and 4 more"), cites: rows.slice(0, 25) }])).named, false);
  // "And N more" counts only from a statement code wrote: one whose text names every row it cites, and that cites only rows.
  const unnamed = `30 Confluence pages created on October 4, 2026: ${named.slice(0, -1).join("; ")}; and 6 more.`;
  assert.deepEqual(scored(listPart(testCase, run([{ text: unnamed, cites: rows.slice(0, 25) }]))), { named: false, members_named: 24 });
  assert.deepEqual(scored(listPart(testCase, run([{ text: stated, cites: [...rows.slice(0, 25), section] }]))), { named: false, members_named: 25 });
  // A writer's sentence naming every member, the long title whole and in lowercase, names the list without any count.
  const whole = `The pages are ${[long.toLowerCase(), "Weekly Notes", ...titles(pages.slice(3))].join(", ")}.`;
  assert.deepEqual(scored(listPart(testCase, run([{ text: whole, cites: rows }]))), { named: true, members_named: 30 });
});

test("a member the key names by its meeting is never named by text: its title is its meeting's label, not the name code gives it", () => {
  // The research result titles a meeting record by its meeting's label; code names it by a line of its own text (its
  // list label), which the result does not carry. So the check cannot tell which record a text names, and reads none.
  const meetings = new Map(dataset.additions.meetings.map(meeting => [meeting.id, meeting]));
  const record = (meeting, index) => ({ id: `E${index + 1}`, source: "meetings", kind: "decision", title: meetings.get(meeting).title,
    citation: { kind: "approved_record", atom_id: digest(`atom-${meeting}`), record_sha256: digest(`record-${meeting}`), policy_id: "organization-member-readable-person-v2" },
    read_in_full: false, opened: false, preloaded: false, cited_by_plan: false });
  const rows = ["M1", "M3"].map(record);
  const testCase = { ...OCT4, id: "synthetic-meeting-decisions", parts: [{ id: "p1", type: "list", requirement: "Both decisions.", evidence: [{ meeting: "M1", item: "decision" }, { meeting: "M3", item: "decision" }] }] };
  const text = `2 decisions: ${rows.map(row => row.title).join("; ")}.`;
  const part = listPart(testCase, askRun(testCase, { items: rows, lists: [{ ...listOf(rows), source: "records" }], writer: rows.map(row => row.id), statements: [{ text, cites: rows }] }));
  assert.deepEqual([part.found, part.read, part.named, part.members_named], [true, true, false, 0]);
});
