import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJson } from "./private-files.mjs";

/** The committed THERM world and cases (research loop evaluation v1). */
export const DATASET_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEST_PERSON = "{{TEST_PERSON}}";
const TRIGGERS = new Set(["ask", "approved_record", "sweep"]);
const STATES = new Set(["S0", "S1"]);
const BUDGETS = new Set(["live", "background"]);
const OUTCOMES = new Set(["answerable", "partial", "not_found"]);
const PART_TYPES = new Set(["fact", "date", "owner", "status", "conflict", "change"]);
const MEETING_ITEMS = new Set(["decision", "action", "rationale", "transcript"]);
const VERDICTS = new Set(["landed", "not_landed", "no_evidence"]);
const RELATIONS = new Set(["confirms", "conflicts", "needs_updating"]);

/** Deep-replaces the signed-in person placeholder with their directory display name. */
export function substitutePerson(value, name) {
  if (typeof name !== "string" || name.trim() === "" || name.includes(TEST_PERSON)) throw new Error("test person display name is required");
  if (typeof value === "string") return value.split(TEST_PERSON).join(name);
  if (Array.isArray(value)) return value.map(entry => substitutePerson(entry, name));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitutePerson(entry, name)]));
  return value;
}

/** Loads the world additions and both case splits. */
export function loadDataset(root = DATASET_ROOT) {
  const additions = readJson(join(root, "world", "additions.json"));
  const s1 = readJson(join(root, "world", "s1.json"));
  const splits = ["development", "holdout"].map(split => ({ split, file: readJson(join(root, "cases", `${split}.json`)) }));
  const cases = splits.flatMap(({ split, file }) => file.cases.map(entry => ({ ...entry, split })));
  return { additions, s1, cases };
}

function refProblems(ref, meetings, where) {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return [`${where}: reference is not an object`];
  const keys = Object.keys(ref).sort().join(",");
  if (keys === "ticket") return /^[A-Z][A-Z0-9]+-\d+$/u.test(ref.ticket) ? [] : [`${where}: ticket key ${ref.ticket} is invalid`];
  if (keys === "page" || keys === "page,section") return /^\d+$/u.test(ref.page) && (ref.section === undefined || (typeof ref.section === "string" && ref.section.length > 0)) ? [] : [`${where}: page reference is invalid`];
  if (keys === "item,meeting") return meetings.has(ref.meeting) && MEETING_ITEMS.has(ref.item) ? [] : [`${where}: meeting reference ${ref.meeting}/${ref.item} is invalid`];
  if (keys === "jira_project") return /^[A-Z][A-Z0-9]+$/u.test(ref.jira_project) ? [] : [`${where}: Jira project ${ref.jira_project} is invalid`];
  return [`${where}: unknown reference shape ${keys}`];
}

/**
 * An approved record's impact-card key: each affected item (a ticket, or one
 * part's sections of a page) with the relation the card should show (one
 * value, or a short list of acceptable values) and the owner. Every item is
 * evidence for one of the case's parts.
 */
function relationValid(relation) {
  if (typeof relation === "string") return RELATIONS.has(relation);
  return Array.isArray(relation) && relation.length >= 2 && new Set(relation).size === relation.length && relation.every(value => RELATIONS.has(value));
}

function affectedProblems(entry, meetings, restricted) {
  const where = entry.id;
  const problems = [];
  if (!meetings.has(entry.record?.meeting)) problems.push(`${where}: an approved record needs its record meeting`);
  if (!Array.isArray(entry.affected) || entry.affected.length === 0) return [...problems, `${where}: an approved record needs affected items`];
  const evidence = (entry.parts ?? []).flatMap(part => part.evidence ?? []);
  const ids = new Set();
  for (const item of entry.affected) {
    const at = `${where}/${item?.id}`;
    if (typeof item?.id !== "string" || ids.has(item.id) || !relationValid(item.relation) || !(item.owner === null || (typeof item.owner === "string" && item.owner.trim() !== "")) ||
        !Array.isArray(item.refs) || item.refs.length === 0) { problems.push(`${at}: affected item is invalid`); continue; }
    ids.add(item.id);
    for (const ref of item.refs) {
      problems.push(...refProblems(ref, meetings, at));
      if (restricted.has(ref.meeting) || ref.meeting === entry.record?.meeting) problems.push(`${at}: the record and restricted meetings are never affected items`);
      if (!evidence.some(value => isDeepStrictEqual(value, ref))) problems.push(`${at}: ${JSON.stringify(ref)} is not evidence for any part`);
    }
  }
  return problems;
}

/** Structural checks every committed case must pass; the export-based checks live in the dataset README. */
export function datasetProblems(dataset) {
  const problems = [];
  const meetings = new Set(dataset.additions.meetings.map(meeting => meeting.id));
  const restricted = new Set(dataset.additions.meetings.filter(meeting => meeting.project === dataset.additions.restricted_project.name).map(meeting => meeting.id));
  const ids = new Set();
  for (const entry of dataset.cases) {
    const where = entry.id;
    if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id)) problems.push(`case id ${entry.id} is invalid`);
    if (ids.has(entry.id)) problems.push(`${where}: duplicate case id`);
    ids.add(entry.id);
    if (!TRIGGERS.has(entry.trigger) || !STATES.has(entry.state) || !BUDGETS.has(entry.budget) || !OUTCOMES.has(entry.expected_outcome)) problems.push(`${where}: trigger, state, budget or outcome is invalid`);
    if (entry.trigger === "ask" && (typeof entry.question !== "string" || entry.question.trim() === "")) problems.push(`${where}: Ask needs a question`);
    if ((entry.trigger === "approved_record") !== (entry.scope?.kind === "record")) problems.push(`${where}: approved records, and only they, take the record's scope`);
    if (entry.trigger === "approved_record") problems.push(...affectedProblems(entry, meetings, restricted));
    else if (entry.affected !== undefined) problems.push(`${where}: only approved records list affected items`);
    if (entry.trigger === "sweep") {
      if (!Array.isArray(entry.findings) || entry.findings.length === 0) problems.push(`${where}: Sweep needs findings`);
      for (const finding of entry.findings ?? []) for (const ref of finding.citations ?? []) problems.push(...refProblems(ref, meetings, `${where} finding`));
      if (!Array.isArray(entry.verdicts) || entry.verdicts.length !== (entry.findings ?? []).length || entry.verdicts.some(verdict => !VERDICTS.has(verdict.expected))) problems.push(`${where}: Sweep needs one valid verdict per finding`);
      // A sweep result is graded by finding_index, so verdict i must be finding i's.
      else if (entry.verdicts.some((verdict, index) => verdict.finding !== entry.findings[index]?.finding)) problems.push(`${where}: each Sweep verdict must name its own finding, in the findings' order`);
    }
    if (entry.trigger !== "sweep" && entry.state !== "S0") problems.push(`${where}: only Sweeps run at S1`);
    if (!Array.isArray(entry.parts) || (entry.parts.length === 0 && entry.expected_outcome !== "not_found")) problems.push(`${where}: parts are required unless nothing should be found`);
    for (const part of entry.parts ?? []) {
      if (!PART_TYPES.has(part.type) || typeof part.requirement !== "string" || !Array.isArray(part.evidence) || part.evidence.length === 0) problems.push(`${where}/${part.id}: part is invalid`);
      for (const ref of part.evidence ?? []) {
        problems.push(...refProblems(ref, meetings, `${where}/${part.id}`));
        if (restricted.has(ref.meeting)) problems.push(`${where}/${part.id}: restricted meeting used as evidence`);
      }
    }
    for (const field of ["expected_needs", "gaps", "must_not"]) if (!Array.isArray(entry[field]) || entry[field].some(value => typeof value !== "string")) problems.push(`${where}: ${field} must be strings`);
    for (const ref of [...(entry.never_appears ?? []), ...(entry.distractors ?? [])]) problems.push(...refProblems(ref, meetings, `${where} exclusion`));
    for (const id of restricted) if (!(entry.never_appears ?? []).some(ref => ref.meeting === id)) problems.push(`${where}: restricted meeting ${id} missing from never_appears`);
  }
  return problems;
}
