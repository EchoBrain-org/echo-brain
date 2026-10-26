/**
 * Deterministic grading for the Ask answer wording eval (README.md, "Pre-registered rules"). No model judges: each
 * trial is measured from the laid-out V8 answer alone, and the three rules are counts over trials.
 */
import { readFileSync } from "node:fs";
import { validatePersonQueryText } from "@echo-brain/organization-api";

export const CASES_FILE = new URL("./cases.json", import.meta.url);
/** Each group's number of cases, as pre-registered. */
export const GROUPS = Object.freeze({ names_long_id: 6, plain: 4 });
/** A lead may share at most this many consecutive words with the question (rule 1). */
export const MAX_SHARED_WORDS = 4;
/** Each rule passes when at least this share of trials passes it. */
export const THRESHOLD = 0.9;
const ITEM_KINDS = new Set(["follow_up", "decision", "ticket"]);

/**
 * A text's words, lower case: runs of letters and digits, joined across an inner hyphen, dot, underscore or apostrophe,
 * so "clean-v1-20261026-ask-timeline-aa79d90" and "it's" are one word each, and quotes and punctuation are not words.
 */
export function words(text) {
  return text.normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** The longest run of consecutive words two texts share. */
export function sharedRun(left, right) {
  const [a, b] = [words(left), words(right)];
  const run = new Array(b.length + 1).fill(0);
  let longest = 0;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = b.length; j >= 1; j -= 1) {
      run[j] = a[i - 1] === b[j - 1] ? run[j - 1] + 1 : 0;
      longest = Math.max(longest, run[j]);
    }
  }
  return longest;
}

/** Whether `phrase` is a run of whole words in `text`. */
export function says(text, phrase) {
  const [haystack, needle] = [words(text), words(phrase)];
  return needle.length > 0 && haystack.some((_, at) => needle.every((word, offset) => haystack[at + offset] === word));
}

/** How many times `id` is written in `text`, as a whole word. */
export function mentions(text, id) {
  const wanted = id.toLocaleLowerCase("en-US");
  return words(text).filter((word) => word === wanted).length;
}

const nonEmptyStrings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
const itemText = (item) => [item.title, item.label, item.text, item.owner, item.status, item.due_at, item.key, item.decision?.title, item.decision?.first_line].filter((value) => typeof value === "string").join("\n");

/** Every problem with the cases document; an empty list when it is the pre-registered set. */
export function caseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-wording-eval-cases-v1" || document.schema_version !== 1) return ["the cases document kind is invalid"];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.today ?? "") || typeof document.time_zone !== "string" || typeof document.asker !== "string") problems.push("today, time_zone and asker are required");
  const cases = Array.isArray(document.cases) ? document.cases : [];
  for (const [group, count] of Object.entries(GROUPS)) {
    const found = cases.filter((entry) => entry.group === group).length;
    if (found !== count) problems.push(`${group} has ${found} cases, not ${count}`);
  }
  const ids = new Set();
  for (const entry of cases) {
    const where = `case ${entry?.id}`;
    if (typeof entry?.id !== "string" || !/^[a-z0-9-]{3,80}$/u.test(entry.id) || ids.has(entry.id)) problems.push(`${where}: id is missing or repeated`);
    ids.add(entry?.id);
    if (!Object.hasOwn(GROUPS, entry?.group)) { problems.push(`${where}: group is invalid`); continue; }
    try { validatePersonQueryText(entry.question); } catch { problems.push(`${where}: the question is not a valid Ask question`); continue; }
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0 || !items.every((item) => ITEM_KINDS.has(item?.kind))) problems.push(`${where}: items must be follow-ups, decisions or tickets`);
    if (typeof entry.research?.query !== "string" || typeof entry.research?.need !== "string") problems.push(`${where}: research needs a query and a need`);
    const evidence = items.map(itemText).join("\n");
    if (!nonEmptyStrings(entry.long_ids)) problems.push(`${where}: long_ids must be a list of identifiers`);
    else for (const id of entry.long_ids) {
      if (words(id).length !== 1 || id.length < 20) problems.push(`${where}: ${id} is not one long identifier`);
      if (mentions(`${entry.question}\n${evidence}`, id) === 0) problems.push(`${where}: ${id} is in neither the question nor the items`);
    }
    if (entry.group === "names_long_id" && entry.long_ids?.every((id) => mentions(entry.question, id) === 0) && sharedRun(entry.question, evidence) < 6) problems.push(`${where}: the question names no long identifier or title`);
    const facts = entry.expect?.facts;
    if (!Array.isArray(facts) || facts.length === 0 || !facts.every((alternatives) => nonEmptyStrings(alternatives) && alternatives.length > 0)) problems.push(`${where}: facts are required`);
    else for (const alternatives of facts) {
      // A fact is the evidence's, or the asker themself, whom the writer may call "you".
      if (!alternatives.some((fact) => says(evidence, fact))) problems.push(`${where}: no item says ${alternatives[0]}`);
    }
    if (!nonEmptyStrings(entry.expect?.cites) || !entry.expect.cites.every((kind) => items.some((item) => item.kind === kind))) problems.push(`${where}: cites must name item kinds the case has`);
  }
  return problems;
}

/** The pre-registered cases, refused when they are not the set the README registered. */
export function loadCases(path = CASES_FILE) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const problems = caseProblems(document);
  if (problems.length > 0) throw new Error(`wording eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

/** The lead of a laid-out answer: its first part's lead block, or, without one, that part's first statement. */
export function leadOf(response) {
  const part = response?.parts?.[0];
  const statements = part?.statements ?? [];
  const block = part?.layout?.find((entry) => entry.kind === "lead");
  const chosen = block === undefined ? statements.slice(0, 1) : block.statements.map((index) => statements[index]).filter(Boolean);
  return chosen.map((statement) => statement.text).join(" ");
}

/**
 * One trial's measures and grades. `response` is the released V8 answer, or null when the trial failed. Statements are
 * every part's; the written text is those statements and each part's gap. An answer with no statement (no answer, or
 * code's fallback when the writer gave nothing usable) passes no rule.
 */
export function gradeTrial(caseDefinition, response) {
  const parts = response?.parts ?? [];
  const statements = parts.flatMap((part) => part.statements ?? []);
  if (statements.length === 0) {
    return Object.freeze({ lead: null, statements: Object.freeze([]), shared_words: null, id_mentions: Object.freeze({}), lead_names_question_id: null,
      facts_written: false, cited: false, rules: Object.freeze({ no_restating: false, long_ids_once: false, nothing_lost: false }) });
  }
  const written = [...statements.map((statement) => statement.text), ...parts.map((part) => part.gap ?? "")].join("\n");
  const statementText = statements.map((statement) => statement.text).join("\n");
  const lead = leadOf(response);
  const sharedWords = sharedRun(lead, caseDefinition.question);
  const idMentions = Object.fromEntries(caseDefinition.long_ids.map((id) => [id, mentions(written, id)]));
  const leadNamesQuestionId = caseDefinition.long_ids.some((id) => mentions(caseDefinition.question, id) > 0 && mentions(lead, id) > 0);
  const factsWritten = caseDefinition.expect.facts.every((alternatives) => alternatives.some((fact) => says(statementText, fact)));
  const citedKinds = new Set((response.citations ?? []).map((citation) => citation.kind));
  const cited = statements.every((statement) => (statement.citation_indexes ?? []).length > 0) && caseDefinition.expect.cites.every((kind) => citedKinds.has(kind));
  return Object.freeze({
    lead, statements: Object.freeze(statements.map((statement) => statement.text)), shared_words: sharedWords,
    id_mentions: Object.freeze(idMentions), lead_names_question_id: leadNamesQuestionId, facts_written: factsWritten, cited,
    rules: Object.freeze({
      no_restating: lead.length > 0 && sharedWords <= MAX_SHARED_WORDS,
      long_ids_once: Object.values(idMentions).every((count) => count <= 1) && !leadNamesQuestionId,
      nothing_lost: response.outcome === "answered" && factsWritten && cited,
    }),
  });
}

/**
 * The three pre-registered rules over graded trials (`{ grade }`): each passes when at least 90% of all trials pass it.
 * The wording change ships when all three pass. The means are reported beside them, never as rules.
 */
export function summarizeRules(trials) {
  const rate = (pick) => (trials.length === 0 ? null : trials.filter(pick).length / trials.length);
  const rule = (number, name) => {
    const passed = trials.filter((trial) => trial.grade.rules[name]).length;
    const share = rate((trial) => trial.grade.rules[name]);
    return Object.freeze({ rule: number, passed_trials: passed, trials: trials.length, rate: share, threshold: THRESHOLD, passed: share !== null && share >= THRESHOLD });
  };
  const graded = trials.filter((trial) => trial.grade.shared_words !== null);
  const mean = (values) => (values.length === 0 ? null : Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100);
  const rules = Object.freeze({ no_restating: rule(1, "no_restating"), long_ids_once: rule(2, "long_ids_once"), nothing_lost: rule(3, "nothing_lost") });
  return Object.freeze({
    rules,
    wording_ships: rules.no_restating.passed && rules.long_ids_once.passed && rules.nothing_lost.passed,
    measures: Object.freeze({
      mean_shared_words: mean(graded.map((trial) => trial.grade.shared_words)),
      max_shared_words: graded.length === 0 ? null : Math.max(...graded.map((trial) => trial.grade.shared_words)),
      mean_lead_words: mean(graded.map((trial) => words(trial.grade.lead).length)),
      mean_statements: mean(graded.map((trial) => trial.grade.statements.length)),
      long_id_mentions: graded.reduce((total, trial) => total + Object.values(trial.grade.id_mentions).reduce((sum, count) => sum + count, 0), 0),
      leads_naming_a_question_id: graded.filter((trial) => trial.grade.lead_names_question_id).length,
    }),
  });
}
