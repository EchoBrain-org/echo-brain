import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJson } from "./private-files.mjs";
import { REACH_COLLECTIONS, REACH_WINDOWS } from "./reach.mjs";

/** The committed THERM world and cases (research loop evaluation v1). */
export const DATASET_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TEST_PERSON = "{{TEST_PERSON}}";
const TRIGGERS = new Set(["ask", "approved_record", "sweep"]);
const STATES = new Set(["S0", "S1"]);
const BUDGETS = new Set(["live", "background"]);
const OUTCOMES = new Set(["answerable", "partial", "not_found"]);
/** `list` (ADR-0041): which items exist; its evidence names every member, and it scores only on naming them all. */
const PART_TYPES = new Set(["fact", "date", "owner", "status", "conflict", "change", "list"]);
const MEETING_ITEMS = new Set(["decision", "action", "rationale", "transcript"]);
const VERDICTS = new Set(["landed", "not_landed", "no_evidence"]);
/** The kinds an Ask need declares (ADR-0041): a case may name those its plan should declare. */
const NEED_KINDS = new Set(["which_items", "which_say", "content"]);
/** A key drafted from the export that the founder has not confirmed yet. */
const KEY_STATUSES = new Set(["awaiting_founder_confirmation"]);
const RELATIONS = new Set(["confirms", "conflicts", "needs_updating"]);
/**
 * The open-ended family (research tool contract v1, "Testing open-ended questions"): what each case tests, and the
 * contract's build steps a case can await (each named for what it adds), so a failure it expects reads apart from a
 * regression. `eval_full_catalog` is the evaluation endpoint binding the sources the V7 and V8 answers cite.
 */
const FAMILIES = new Set(["open_ended"]);
const CATEGORIES = new Set(["goal", "time", "own_work", "structure", "reach", "tools"]);
const CONTRACT_STEPS = new Set(["map_and_rules", "dates_and_links", "workspace_collections", "wider_calls", "connector_containers", "eval_full_catalog"]);
const CONTAINERS = new Set(["jira_project", "confluence_space", "slack_channel"]);

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

const nonEmpty = value => typeof value === "string" && value.trim() !== "" && value.trim() === value;

function refProblems(ref, meetings, where, followUps = new Set()) {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return [`${where}: reference is not an object`];
  const keys = Object.keys(ref).sort().join(",");
  // Workspace items (research tool contract v1): a project or person by name, a tool by id, a tool container by its
  // kind and provider id, and a world follow-up by its id.
  if (keys === "project" || keys === "person") return nonEmpty(ref[keys]) ? [] : [`${where}: ${keys} name is invalid`];
  if (keys === "tool") return /^[a-z][a-z0-9-]*$/u.test(ref.tool) ? [] : [`${where}: tool id ${ref.tool} is invalid`];
  if (keys === "container,id") return CONTAINERS.has(ref.container) && nonEmpty(ref.id) ? [] : [`${where}: tool container reference is invalid`];
  if (keys === "follow_up") return followUps.has(ref.follow_up) ? [] : [`${where}: follow-up ${ref.follow_up} is not in the world`];
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

/**
 * A list part (ADR-0041) names every member of the list its question asks for, each once and each a whole item: a
 * ticket, a page without a section, or a meeting item. Only Ask records lists; a task goal keeps the rules before it.
 */
function listPartProblems(entry, part, where) {
  const evidence = Array.isArray(part.evidence) ? part.evidence : [];
  const problems = [];
  if (entry.trigger !== "ask") problems.push(`${where}: only Ask cases have list parts`);
  if (evidence.some(ref => ref?.section !== undefined || ref?.jira_project !== undefined)) problems.push(`${where}: a list part names whole items, never a section or a Jira project`);
  if (new Set(evidence.map(ref => JSON.stringify(ref))).size !== evidence.length) problems.push(`${where}: a list part names each member once`);
  return problems;
}

/** A collection a reach key names: one collection, or a choice of several, any of which holds that part of the answer. */
function collectionEntryValid(entry) {
  if (typeof entry === "string") return REACH_COLLECTIONS.includes(entry);
  return Array.isArray(entry) && entry.length >= 2 && new Set(entry).size === entry.length && entry.every(name => REACH_COLLECTIONS.includes(name));
}

/**
 * The open-ended family's fields (research tool contract v1): only Ask cases carry them, and a case of the family names
 * what it tests and its reach and cost keys: the collections holding part of its answer, an optional time window they
 * must be looked at in, and its rounds (4 unless it says otherwise). `awaits` names the contract steps it needs.
 */
function openEndedProblems(entry) {
  const where = entry.id;
  if (entry.family === undefined && entry.reach === undefined && entry.category === undefined && entry.awaits === undefined) return [];
  const problems = [];
  if (entry.trigger !== "ask") problems.push(`${where}: only Ask cases are open-ended`);
  if (!FAMILIES.has(entry.family) || !CATEGORIES.has(entry.category)) problems.push(`${where}: an open-ended case names its family and one of the categories ${[...CATEGORIES].join(", ")}`);
  const reach = entry.reach;
  if (reach === null || typeof reach !== "object" || Array.isArray(reach) || Object.keys(reach).some(key => !["collections", "window", "max_rounds"].includes(key))) problems.push(`${where}: reach takes collections, window and max_rounds`);
  else {
    if (!Array.isArray(reach.collections) || reach.collections.length === 0 || reach.collections.some(value => !collectionEntryValid(value))) problems.push(`${where}: reach names the collections holding part of the answer, from ${REACH_COLLECTIONS.join(", ")}`);
    if (reach.window !== undefined && !REACH_WINDOWS.includes(reach.window)) problems.push(`${where}: reach window must be ${REACH_WINDOWS.join(", ")}`);
    if (reach.max_rounds !== undefined && (!Number.isSafeInteger(reach.max_rounds) || reach.max_rounds < 1 || reach.max_rounds > 10)) problems.push(`${where}: reach max_rounds must be 1 to 10`);
  }
  if (entry.awaits !== undefined && (!Array.isArray(entry.awaits) || entry.awaits.length === 0 || new Set(entry.awaits).size !== entry.awaits.length || entry.awaits.some(step => !CONTRACT_STEPS.has(step)))) {
    problems.push(`${where}: awaits names distinct contract steps: ${[...CONTRACT_STEPS].join(", ")}`);
  }
  return problems;
}

const FOLLOW_UP_STATES = new Set(["unsent", "open", "done", "not_relevant"]);
const FOLLOW_UP_EVENTS = new Set(["sent", "reassigned", "done", "not_relevant"]);
/**
 * The world's workspace (research tool contract v1): accounts, projects with members and roles and their tool mappings,
 * tools, and follow-ups whose history the founder seeds. Every name a project or follow-up gives is an account, every
 * follow-up comes from a meeting the test person can read, and its history ends in its status and owner.
 */
function workspaceProblems(additions, meetings) {
  const workspace = additions.workspace;
  if (workspace === undefined) return [];
  const problems = [];
  const accounts = new Set((workspace.accounts ?? []).map(account => account?.name));
  if (!Array.isArray(workspace.accounts) || accounts.size !== workspace.accounts.length || [...accounts].some(name => !nonEmpty(name))) problems.push("workspace: accounts need distinct names");
  const projectNames = new Set();
  for (const project of workspace.projects ?? []) {
    const at = `workspace project ${project?.name}`;
    if (!nonEmpty(project?.name) || projectNames.has(project.name) || project.name === additions.restricted_project.name) problems.push(`${at}: names must be distinct and not the restricted project's`);
    projectNames.add(project?.name);
    if (!["active", "archived"].includes(project?.status)) problems.push(`${at}: status must be active or archived`);
    const members = Array.isArray(project?.members) ? project.members : [];
    if (members.length === 0 || members.some(member => !accounts.has(member?.name) || !["lead", "member"].includes(member?.role)) || !members.some(member => member.role === "lead") ||
        new Set(members.map(member => member.name)).size !== members.length) problems.push(`${at}: members are distinct accounts, each a lead or a member, with at least one lead`);
    const container = value => value !== null && typeof value === "object" && /^\d+$/u.test(value.id ?? "") && nonEmpty(value.key) && nonEmpty(value.name);
    if (!(project?.jira_project === null || container(project?.jira_project)) || !Array.isArray(project?.confluence_spaces) || !project.confluence_spaces.every(container)) problems.push(`${at}: tool mappings are a Jira project or null, and a list of Confluence spaces`);
  }
  if (!Array.isArray(workspace.tools) || workspace.tools.some(tool => !/^[a-z][a-z0-9-]*$/u.test(tool?.tool_id ?? "") || typeof tool.connected !== "boolean")) problems.push("workspace: tools name a tool id and whether it is connected");
  const restricted = new Set(additions.meetings.filter(meeting => meeting.project === additions.restricted_project.name).map(meeting => meeting.id));
  const ids = new Set();
  for (const followUp of workspace.follow_ups ?? []) {
    const at = `workspace follow-up ${followUp?.id}`;
    if (!/^F\d+$/u.test(followUp?.id ?? "") || ids.has(followUp.id)) problems.push(`${at}: ids are distinct, F1, F2, ...`);
    ids.add(followUp?.id);
    if (!meetings.has(followUp?.meeting) || restricted.has(followUp.meeting)) problems.push(`${at}: it comes from a meeting the test person can read`);
    if (!/^[A-Z][A-Z0-9]+-\d+$/u.test(followUp?.follows ?? "")) problems.push(`${at}: it follows a ticket, by its key`);
    if (!accounts.has(followUp?.owner) || !FOLLOW_UP_STATES.has(followUp?.status)) problems.push(`${at}: its owner is an account and its status unsent, open, done or not_relevant`);
    const history = Array.isArray(followUp?.history) ? followUp.history : [];
    if (history.some(event => !FOLLOW_UP_EVENTS.has(event?.event) || !Number.isSafeInteger(event.day) || event.day < 0 || (event.owner !== undefined && !accounts.has(event.owner))) ||
        history.some((event, index) => index > 0 && event.day < history[index - 1].day)) problems.push(`${at}: its history is events in day order`);
    const sent = history.some(event => event.event === "sent");
    const last = history.at(-1)?.event;
    const owners = history.map(event => event.owner).filter(owner => owner !== undefined);
    if (sent !== (followUp?.status !== "unsent") || (followUp?.status === "done" && last !== "done") || (followUp?.status === "not_relevant" && last !== "not_relevant") ||
        (owners.length > 0 && owners.at(-1) !== followUp?.owner)) problems.push(`${at}: its history ends in its status and owner`);
  }
  return problems;
}

/** Structural checks every committed case must pass; the export-based checks live in the dataset README. */
export function datasetProblems(dataset) {
  const problems = [];
  const meetings = new Set(dataset.additions.meetings.map(meeting => meeting.id));
  const restricted = new Set(dataset.additions.meetings.filter(meeting => meeting.project === dataset.additions.restricted_project.name).map(meeting => meeting.id));
  const followUps = new Set((dataset.additions.workspace?.follow_ups ?? []).map(entry => entry.id));
  problems.push(...workspaceProblems(dataset.additions, meetings));
  const ids = new Set();
  for (const entry of dataset.cases) {
    const where = entry.id;
    problems.push(...openEndedProblems(entry));
    if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id)) problems.push(`case id ${entry.id} is invalid`);
    if (ids.has(entry.id)) problems.push(`${where}: duplicate case id`);
    ids.add(entry.id);
    if (!TRIGGERS.has(entry.trigger) || !STATES.has(entry.state) || !BUDGETS.has(entry.budget) || !OUTCOMES.has(entry.expected_outcome)) problems.push(`${where}: trigger, state, budget or outcome is invalid`);
    if (entry.trigger === "ask" && (typeof entry.question !== "string" || entry.question.trim() === "")) problems.push(`${where}: Ask needs a question`);
    if (entry.expected_kinds !== undefined) {
      const kinds = entry.expected_kinds;
      if (entry.trigger !== "ask") problems.push(`${where}: only Ask cases name the need kinds their plan should declare`);
      if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length || kinds.some(kind => !NEED_KINDS.has(kind))) problems.push(`${where}: expected_kinds must be distinct need kinds: which_items, which_say or content`);
    }
    if (entry.key_status !== undefined && !KEY_STATUSES.has(entry.key_status)) problems.push(`${where}: key_status can only be awaiting_founder_confirmation`);
    if ((entry.trigger === "approved_record") !== (entry.scope?.kind === "record")) problems.push(`${where}: approved records, and only they, take the record's scope`);
    if (entry.trigger === "approved_record") problems.push(...affectedProblems(entry, meetings, restricted));
    else if (entry.affected !== undefined) problems.push(`${where}: only approved records list affected items`);
    if (entry.trigger === "sweep") {
      if (!Array.isArray(entry.findings) || entry.findings.length === 0) problems.push(`${where}: Sweep needs findings`);
      for (const finding of entry.findings ?? []) for (const ref of finding.citations ?? []) problems.push(...refProblems(ref, meetings, `${where} finding`));
      if (!Array.isArray(entry.verdicts) || entry.verdicts.length !== (entry.findings ?? []).length || entry.verdicts.some(verdict => !VERDICTS.has(verdict.expected))) problems.push(`${where}: Sweep needs one valid verdict per finding`);
      // A sweep result is graded by finding_index, so verdict i must be finding i's.
      else if (entry.verdicts.some((verdict, index) => verdict.finding !== entry.findings[index]?.finding)) problems.push(`${where}: each Sweep verdict must name its own finding, in the findings' order`);
      // R77: a sweep re-reads its findings' items with no planner, so nothing asks for a need or reports a gap; its verdicts say what was not found.
      if (entry.expected_needs?.length > 0 || entry.gaps?.length > 0) problems.push(`${where}: a Sweep has no planner, so it names no expected needs or gaps`);
    }
    if (entry.trigger !== "sweep" && entry.state !== "S0") problems.push(`${where}: only Sweeps run at S1`);
    // An open-ended case whose answer the world cannot fix in advance ("what happened yesterday") is graded on reach and cost alone.
    if (!Array.isArray(entry.parts) || (entry.parts.length === 0 && entry.expected_outcome !== "not_found" && entry.reach === undefined)) problems.push(`${where}: parts are required unless nothing should be found or the case is graded on reach and cost alone`);
    for (const part of entry.parts ?? []) {
      if (!PART_TYPES.has(part.type) || typeof part.requirement !== "string" || !Array.isArray(part.evidence) || part.evidence.length === 0) problems.push(`${where}/${part.id}: part is invalid`);
      if (part.type === "list") problems.push(...listPartProblems(entry, part, `${where}/${part.id}`));
      for (const ref of part.evidence ?? []) {
        problems.push(...refProblems(ref, meetings, `${where}/${part.id}`, followUps));
        if (restricted.has(ref.meeting)) problems.push(`${where}/${part.id}: restricted meeting used as evidence`);
        if (ref.project === dataset.additions.restricted_project.name) problems.push(`${where}/${part.id}: restricted project used as evidence`);
      }
    }
    for (const field of ["expected_needs", "gaps", "must_not"]) if (!Array.isArray(entry[field]) || entry[field].some(value => typeof value !== "string")) problems.push(`${where}: ${field} must be strings`);
    for (const ref of [...(entry.never_appears ?? []), ...(entry.distractors ?? [])]) problems.push(...refProblems(ref, meetings, `${where} exclusion`, followUps));
    for (const id of restricted) if (!(entry.never_appears ?? []).some(ref => ref.meeting === id)) problems.push(`${where}: restricted meeting ${id} missing from never_appears`);
  }
  return problems;
}
