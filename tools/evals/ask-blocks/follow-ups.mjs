/**
 * Deterministic grading for the gate's follow-up cases (README.md, "Follow-up cases", ADR-0053). No model judges: each
 * trial is measured from the follow-ups the kernel checked and the release saved, beside the released answer's ids.
 */
import { readFileSync } from "node:fs";
import { validatePersonQueryText } from "@echo-brain/organization-api";
import { ITEM_KINDS, nonEmptyStrings, says } from "../shared/grading.mjs";

export const CASES_FILE = new URL("./follow-ups-cases.json", import.meta.url);
/** The pre-registered cases, by id: a clear request, an implied task, an ordinary question, an unknown owner, a relative date. */
export const CASE_IDS = Object.freeze(["clear-request", "implied-task", "ordinary-question", "unknown-owner", "relative-date"]);
/** The gate passes when at least this share of all trials passes every check of its case. */
const THRESHOLD = 0.9;

/** Every problem with the cases document; an empty list when it is the pre-registered set. */
export function caseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-follow-ups-eval-cases-v1" || document.schema_version !== 1) return ["the cases document kind is invalid"];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.today ?? "") || typeof document.time_zone !== "string" || typeof document.asker !== "string" || Number.isNaN(Date.parse(document.asked_at ?? ""))) {
    problems.push("today, time_zone, asked_at and asker are required");
  }
  const cases = Array.isArray(document.cases) ? document.cases : [];
  const ids = cases.map((entry) => entry?.id);
  if (JSON.stringify(ids) !== JSON.stringify(CASE_IDS)) problems.push(`the cases are ${ids.join(", ")}, not ${CASE_IDS.join(", ")}`);
  for (const entry of cases) {
    const where = `case ${entry?.id}`;
    try { validatePersonQueryText(entry.question); } catch { problems.push(`${where}: the question is not a valid Ask question`); continue; }
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0 || !items.every((item) => ITEM_KINDS.has(item?.kind))) problems.push(`${where}: items must be follow-ups, decisions or tickets`);
    if (typeof entry.research?.query !== "string" || typeof entry.research?.need !== "string") problems.push(`${where}: research needs a query and a need`);
    const expect = entry.expect ?? {};
    if (expect.drafts !== 0 && expect.drafts !== 1) { problems.push(`${where}: expect.drafts must be 0 or 1`); continue; }
    if (expect.drafts === 0 && Object.keys(expect).length !== 1) problems.push(`${where}: a case that drafts nothing expects nothing else`);
    if (expect.drafts === 1 && !(nonEmptyStrings(expect.task_mentions) && expect.task_mentions.length > 0)) problems.push(`${where}: task_mentions are required`);
    if (Object.hasOwn(expect, "owner") && expect.owner !== null && !says(entry.question, expect.owner)) problems.push(`${where}: the question does not name ${expect.owner}`);
    if (Object.hasOwn(expect, "due_on") && !/^\d{4}-\d{2}-\d{2}$/u.test(expect.due_on)) problems.push(`${where}: due_on must be a day`);
  }
  return problems;
}

/** The pre-registered cases, refused when they are not the set the README registered. */
export function loadCases() {
  const document = JSON.parse(readFileSync(CASES_FILE, "utf8"));
  const problems = caseProblems(document);
  if (problems.length > 0) throw new Error(`follow-up eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

/**
 * One trial's checks. `response` is the released V8 answer, or null when the trial failed; `drafts` are the follow-ups
 * the release saved. `listed`: the answer lists exactly the saved drafts' ids, or none when none were saved. `count`: as
 * many drafts as the case expects (a case that expects one may get no more than one). `owner`, `due_on` and `task`: the
 * first draft's owner (absent for null), day and task words, when the case names them.
 */
export function gradeTrial(caseDefinition, response, drafts) {
  const expect = caseDefinition.expect;
  const saved = drafts ?? [];
  const first = saved[0];
  const checks = {
    released: response !== null,
    listed: response !== null && JSON.stringify(response.follow_ups ?? []) === JSON.stringify(saved.map((draft) => draft.item_id)),
    count: saved.length === expect.drafts,
    ...(Object.hasOwn(expect, "owner") ? { owner: first !== undefined && (expect.owner === null ? first.owner_name === undefined : first.owner_name === expect.owner) } : {}),
    ...(Object.hasOwn(expect, "due_on") ? { due_on: first?.due_on === expect.due_on } : {}),
    ...(expect.task_mentions === undefined ? {} : { task: first !== undefined && expect.task_mentions.every((word) => says(first.task, word)) }),
  };
  return Object.freeze({
    drafts: Object.freeze(saved.map(({ item_id: _id, ...draft }) => draft)),
    checks: Object.freeze(checks),
    passed: Object.values(checks).every(Boolean),
  });
}

/** Each check's passes over graded trials, each case's, and whether at least 90% of all trials passed every check. */
export function summarize(trials) {
  const passed = trials.filter((trial) => trial.grade.passed).length;
  const checks = {};
  for (const trial of trials) for (const [name, value] of Object.entries(trial.grade.checks)) {
    checks[name] ??= { passed: 0, trials: 0 };
    checks[name].trials += 1;
    if (value) checks[name].passed += 1;
  }
  return Object.freeze({
    trials: trials.length, passed, rate: trials.length === 0 ? null : passed / trials.length, threshold: THRESHOLD,
    passes: trials.length > 0 && passed / trials.length >= THRESHOLD,
    // An ordinary question that drafts a follow-up leaves a card the person has to dismiss: counted on its own.
    drafted_on_ordinary_question: trials.filter((trial) => trial.case_id === "ordinary-question" && trial.grade.drafts.length > 0).length,
    checks: Object.freeze(checks),
    cases: Object.freeze(Object.fromEntries(CASE_IDS.map((id) => {
      const own = trials.filter((trial) => trial.case_id === id);
      return [id, Object.freeze({ trials: own.length, passed: own.filter((trial) => trial.grade.passed).length, errors: own.filter((trial) => trial.error !== undefined).length })];
    }))),
  });
}
