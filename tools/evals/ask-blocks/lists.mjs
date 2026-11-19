/**
 * Deterministic grading for the gate's list cases (README.md, "List cases", ADR-0054). No model judges: each trial is
 * graded from the writer's own reply, as it gave it, together with the answer the kernel released from it, read into
 * common blocks (grade.mjs). A trial whose release came from code's fallback fails, so code's list cannot pass for the
 * writer's.
 */
import { readFileSync } from "node:fs";
import { validatePersonQueryText } from "@echo-brain/organization-api";
import { nonEmptyStrings, says, words } from "../shared/grading.mjs";
import { claimsOf, readingText } from "./grade.mjs";

export const CASES_FILE = new URL("./lists-cases.json", import.meta.url);
/** The pre-registered cases, by id, covering ADR-0054's six new evaluation cases (its second is two). */
export const CASE_IDS = Object.freeze(["which-items", "part-by-fact", "part-by-meaning", "one-named-item", "note-not-found", "note-disagrees", "how-many"]);
/** The pre-registered pass marks: of 21 trials, and of each case's 3. */
export const PASS = Object.freeze({ trials: 19, per_case: 2 });
const LISTS = new Set(["whole", "part", "none"]);
const NEED_KINDS = new Set(["which_items", "which_say", "content"]);
const NEED_STATUSES = new Set(["open", "found", "not_found"]);

// ---- cases -------------------------------------------------------------------------------------------------------
const alternatives = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => nonEmptyStrings(entry) && entry.length > 0);
/** The E ids of a case's list: its listed items, first in the case, in order. */
const membersOf = (caseDefinition) => caseDefinition.items.filter((item) => item.listed === true).map((_, at) => `E${at + 1}`);

/** Every problem with the cases document; an empty list when it is the pre-registered set. */
export function caseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-lists-eval-cases-v1" || document.schema_version !== 1) return ["the cases document kind is invalid"];
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
    const listed = items.filter((item) => item?.listed === true);
    // The list comes first, so its members are E1 to En; at least two, differing in status or owner, so it is a table.
    if (listed.length < 2 || !listed.every((item) => item.kind === "ticket") || items.slice(0, listed.length).some((item) => item.listed !== true)) problems.push(`${where}: the list must be two or more tickets, first among the items`);
    else if (new Set(listed.map((item) => `${item.status}\n${item.owner}`)).size < 2) problems.push(`${where}: the list's members must differ in status or owner`);
    if (!items.every((item) => item?.kind === "ticket" || item?.kind === "decision")) problems.push(`${where}: items must be tickets or decisions`);
    const research = entry.research ?? {};
    const steps = Array.isArray(research.steps) ? research.steps : [];
    if (!nonEmptyStrings(research.needs) || research.needs.length === 0) problems.push(`${where}: research needs its needs' wording`);
    else if (steps.length === 0 || steps[0].actions?.[0]?.tool !== "list" || steps.at(-1).actions?.[0]?.tool !== "finish") problems.push(`${where}: research must list first and finish last`);
    else if (!steps.every((step) => Array.isArray(step.needs) && step.needs.length === research.needs.length
      && step.needs.every((need) => NEED_KINDS.has(need.kind) && NEED_STATUSES.has(need.status) && Array.isArray(need.evidence)))) problems.push(`${where}: each step gives every need a kind, status and evidence`);
    const expect = entry.expect ?? {};
    const members = membersOf({ items });
    if (expect.list !== undefined && !LISTS.has(expect.list)) problems.push(`${where}: list must be whole, part or none`);
    if (expect.list === "part" && !(Array.isArray(expect.members) && expect.members.length >= 2 && expect.members.length < members.length
      && new Set(expect.members).size === expect.members.length && expect.members.every((id) => members.includes(id)))) problems.push(`${where}: a part names two or more of its list's members, not all`);
    if (expect.list !== "part" && (expect.members !== undefined || expect.by !== undefined)) problems.push(`${where}: only a part names members`);
    if (expect.by !== undefined && expect.by !== "where_or_members") problems.push(`${where}: by must be where_or_members`);
    for (const field of ["says", "not_found_mentions"]) if (expect[field] !== undefined && !alternatives(expect[field])) problems.push(`${where}: ${field} must be lists of alternatives`);
    if (expect.not_found_never_mentions !== undefined && !(nonEmptyStrings(expect.not_found_never_mentions) && expect.not_found_never_mentions.length > 0)) problems.push(`${where}: not_found_never_mentions must be words`);
    if (expect.count !== undefined && (expect.count !== members.length || expect.list !== "whole" || typeof expect.count_noun !== "string")) problems.push(`${where}: count is the whole list's, with its noun`);
  }
  return problems;
}

/** The pre-registered cases, refused when they are not the set the README registered. */
export function loadCases() {
  const document = JSON.parse(readFileSync(CASES_FILE, "utf8"));
  const problems = caseProblems(document);
  if (problems.length > 0) throw new Error(`list eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

// ---- the writer's reply and the released answer ------------------------------------------------------------------
const cleanId = (value) => (typeof value === "string" ? value.trim().toUpperCase() : null);
const narrowing = (entry) => ({
  ...(entry.where === undefined || entry.where === null ? {} : { where: entry.where }),
  ...(entry.members === undefined || entry.members === null ? {} : { members: Array.isArray(entry.members) ? entry.members.map(cleanId) : entry.members }),
});

/** The lists a writer's raw reply places, in either reply shape: list blocks, or the top-level "lists" of the reply before ADR-0054. */
export function placedLists(reply) {
  if (reply === null || typeof reply !== "object") return [];
  const blocks = Array.isArray(reply.blocks) ? reply.blocks.filter((block) => block?.block === "list" && cleanId(block.list) !== null).map((block) => ({ list: cleanId(block.list), ...narrowing(block) })) : [];
  const lists = Array.isArray(reply.lists) ? reply.lists.filter((entry) => cleanId(entry?.id) !== null).map((entry) => ({ list: cleanId(entry.id), ...narrowing(entry) })) : [];
  return [...blocks, ...lists];
}

/**
 * What a list's caption says it shows of how many: "7 Jira tickets ..." shows 7 of 7, "3 of the 9 ..." 3 of 9, "At
 * least 3 ... (12 listed so far)" 3 of 12, and a caption ending "(first 5 shown)" shows 5. Null for a caption with no count.
 */
function captionCounts(caption) {
  const part = /^(\d+) of (?:the|at least) (\d+) /u.exec(caption) ?? /^At least (\d+) .*\((\d+) listed so far\)/u.exec(caption);
  const whole = /^(?:At least )?(\d+) /u.exec(caption);
  if (part === null && whole === null) return null;
  const [shown, total] = part === null ? [Number(whole[1]), Number(whole[1])] : [Number(part[1]), Number(part[2])];
  const first = /\(first (\d+) shown\)$/u.exec(caption);
  return { shown: first === null ? shown : Number(first[1]), total };
}

/** The lists an answer shows: each captioned table, with its caption's shown and total counts and its rows' evidence ids. */
export function releasedLists(read) {
  if (read === null || read === undefined || read.valid !== true) return [];
  return read.blocks.filter((block) => block.kind === "table" && typeof block.caption === "string").map((block) => {
    const counts = captionCounts(block.caption);
    return Object.freeze({ caption: block.caption, shown: counts?.shown ?? null, total: counts?.total ?? null, rows: Object.freeze(block.rows.map((row) => Object.freeze([...row.evidence]))) });
  });
}

/** What the released answer says it did not find: each part's gap and its typed not-found explanation. */
const releasedNotFound = (response) => (response?.parts ?? []).flatMap((part) => [part.gap, part.gap_details?.not_found].filter((value) => typeof value === "string"));
/** The reply's own not-found entries, as text. */
const replyNotFound = (reply) => (Array.isArray(reply?.not_found) ? reply.not_found.filter((value) => typeof value === "string") : []);
const sameSet = (left, right) => left.length === right.length && left.every((id) => right.includes(id));

/** Whether the released statements outside any table write a number other than `count` directly before `noun` (one word between allowed, as "8 Jira tickets"). */
function otherCount(blocks, count, noun) {
  const wanted = words(noun)[0];
  return claimsOf(blocks).filter((claim) => claim.kind !== "table").some((claim) => {
    const said = words(claim.text);
    return said.some((word, at) => /^\d+$/u.test(word) && Number(word) !== count && (said[at + 1] === wanted || said[at + 2] === wanted));
  });
}

/**
 * One trial's checks (README.md, "List cases"). `reply` is the writer's last reply without an error (null for none),
 * `read` the released answer read as blocks (grade.mjs's readReleased; null for none), `response` the released answer,
 * and `fallbacks` the run's fallback count from its audit entry.
 */
export function gradeTrial(caseDefinition, { reply, read, response, fallbacks }) {
  const expect = caseDefinition.expect;
  const members = membersOf(caseDefinition);
  const placed = placedLists(reply);
  const shown = releasedLists(read);
  const blocks = read?.valid === true ? read.blocks : [];
  const text = readingText(blocks);
  const ownL1 = placed.filter((entry) => entry.list === "L1");
  const wholeEntry = (entry) => (entry.where === undefined && entry.members === undefined) || (entry.where === undefined && Array.isArray(entry.members) && sameSet([...new Set(entry.members)], members));
  const checks = {
    released: response !== null && response !== undefined && read?.valid === true,
    own_reply: reply !== null && reply !== undefined && fallbacks === 0,
    ...(expect.list === undefined ? {} : {
      placed: expect.list === "none" ? placed.length === 0
        : expect.list === "whole" ? ownL1.some(wholeEntry)
        : ownL1.some((entry) => (entry.where !== undefined || entry.members !== undefined) && !wholeEntry(entry)),
      shown: expect.list === "none" ? shown.length === 0
        : expect.list === "whole" ? shown.length === 1 && sameSet([...new Set(shown[0].rows.flat())], members) && shown[0].total === members.length && shown[0].shown === members.length
        : shown.length === 1 && sameSet([...new Set(shown[0].rows.flat())], expect.members) && shown[0].caption.startsWith(`${expect.members.length} of the ${members.length} `),
    }),
    ...(expect.says === undefined ? {} : { says: expect.says.every((options) => options.some((phrase) => says(text, phrase))) }),
    ...(expect.not_found_mentions === undefined ? {} : { not_found_mentions: expect.not_found_mentions.every((options) =>
      replyNotFound(reply).some((entry) => options.some((phrase) => says(entry, phrase))) && releasedNotFound(response).some((entry) => options.some((phrase) => says(entry, phrase)))) }),
    ...(expect.not_found_never_mentions === undefined ? {} : { not_found_never_mentions: ![...replyNotFound(reply), ...releasedNotFound(response)].some((entry) => expect.not_found_never_mentions.some((phrase) => says(entry, phrase))) }),
    ...(expect.count === undefined ? {} : { count: shown.length === 1 && shown[0].total === expect.count && !otherCount(blocks, expect.count, expect.count_noun) }),
  };
  return Object.freeze({
    placed: Object.freeze(placed),
    released_lists: Object.freeze(shown.map(({ caption, shown: count, total }) => Object.freeze({ caption, shown: count, total }))),
    checks: Object.freeze(checks),
    passed: Object.values(checks).every(Boolean),
  });
}

/** Each check's passes over graded trials, each case's passes, and how many trials passed every check of their case. */
export function summarize(trials) {
  const checks = {};
  for (const trial of trials) for (const [name, value] of Object.entries(trial.grade.checks)) {
    checks[name] ??= { passed: 0, trials: 0 };
    checks[name].trials += 1;
    if (value) checks[name].passed += 1;
  }
  return Object.freeze({
    trials: trials.length, passed: trials.filter((trial) => trial.grade.passed).length, pass: PASS,
    checks: Object.freeze(checks),
    cases: Object.freeze(Object.fromEntries(CASE_IDS.map((id) => {
      const own = trials.filter((trial) => trial.case_id === id);
      return [id, Object.freeze({ trials: own.length, passed: own.filter((trial) => trial.grade.passed).length, errors: own.filter((trial) => trial.error !== undefined).length })];
    }))),
  });
}

/** The set passes when at least 19 of 21 trials pass and no case passes fewer than 2 of its 3; only a complete run decides. */
export function decide(summary, complete) {
  const worst = Math.min(...Object.values(summary.cases).map((entry) => entry.passed));
  return Object.freeze({ complete, passes: complete ? summary.passed >= PASS.trials && worst >= PASS.per_case : null, passed: summary.passed, worst_case: worst });
}
