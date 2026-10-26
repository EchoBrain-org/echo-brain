/**
 * Deterministic grading for the follow-up resolution eval (Ask timeline v1, "Follow-up resolution eval
 * (pre-registered)", ADR-0047). No model judges: a trial passes or fails its case's expectation from the resolver's
 * structured reply alone, and the four rules are counts over trials.
 */
import { readFileSync } from "node:fs";
import { validatePersonAnswerRequestV3, validatePersonQueryText } from "@echo-brain/organization-api";

export const CASES_FILE = new URL("./cases.json", import.meta.url);
/** Each group's number of cases, as pre-registered. */
export const GROUPS = Object.freeze({ one_referent: 10, several_referents: 10, unrelated: 5, standalone: 5 });
/** Rule 2 and rule 3 pass at or above, rule 4 at or below; rule 1 allows no guess at all. */
export const THRESHOLDS = Object.freeze({ resolve_the_obvious: 0.9, leave_unrelated_alone: 0.9, do_not_over_ask: 0.1 });

const lower = (text) => text.toLocaleLowerCase("en-US");
const mentions = (text, alternatives) => alternatives.some((term) => lower(text).includes(lower(term)));
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim() !== "");

/** Every problem with the cases document; an empty list when it is the pre-registered set. */
export function caseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-follow-up-eval-cases-v1" || document.schema_version !== 1) return ["the cases document kind is invalid"];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.today ?? "") || typeof document.time_zone !== "string") problems.push("today and time_zone are required");
  const cases = Array.isArray(document.cases) ? document.cases : [];
  const ids = new Set();
  for (const [group, count] of Object.entries(GROUPS)) {
    const found = cases.filter((entry) => entry.group === group).length;
    if (found !== count) problems.push(`${group} has ${found} cases, not ${count}`);
  }
  for (const entry of cases) {
    const where = `case ${entry?.id}`;
    if (typeof entry?.id !== "string" || !/^[a-z0-9-]{3,80}$/u.test(entry.id) || ids.has(entry.id)) problems.push(`${where}: id is missing or repeated`);
    ids.add(entry?.id);
    if (!Object.hasOwn(GROUPS, entry?.group)) { problems.push(`${where}: group is invalid`); continue; }
    try { validatePersonAnswerRequestV3({ schema_version: 3, question: entry.question, previous: entry.previous }); }
    catch (error) { problems.push(`${where}: not a valid Ask with its previous turn (${error instanceof Error ? error.message : "invalid"})`); continue; }
    if (entry.previous.purpose !== "follow_up") problems.push(`${where}: the previous turn is not a follow-up`);
    const sources = entry.previous.citations.length;
    const expect = entry.expect ?? {};
    if (entry.group === "one_referent") {
      if (!Array.isArray(expect.about) || expect.about.length === 0 || !expect.about.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= sources)) problems.push(`${where}: about must name sources 1 to ${sources}`);
      if (!nonEmptyStrings(expect.names)) problems.push(`${where}: names are required`);
    } else if (entry.group === "several_referents") {
      if (!Array.isArray(expect.candidates) || expect.candidates.length < 2 || expect.candidates.length > 4 || !expect.candidates.every(nonEmptyStrings)) problems.push(`${where}: 2 to 4 candidates are required`);
    } else {
      if (!nonEmptyStrings(expect.terms)) problems.push(`${where}: terms are required`);
      else if (!expect.terms.every((term) => lower(entry.question).includes(lower(term)))) problems.push(`${where}: its own question must carry its terms`);
      try { validatePersonQueryText(entry.question); } catch { problems.push(`${where}: the question is not a valid Ask question`); }
    }
  }
  return problems;
}

/** The pre-registered cases, refused when they are not the set the design registered. */
export function loadCases(path = CASES_FILE) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const problems = caseProblems(document);
  if (problems.length > 0) throw new Error(`follow-up eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

/** Whether each candidate is named by its own choice: a matching of candidates to distinct choices (2 to 4 of each). */
function covers(choices, candidates) {
  const texts = choices.map((choice) => `${choice.label} ${choice.question}`);
  const match = (index, used) => index === candidates.length
    || texts.some((text, at) => !used.has(at) && mentions(text, candidates[index]) && match(index + 1, new Set([...used, at])));
  return match(0, new Set());
}

/**
 * One trial's grade against its case: `passed` by the group's expectation, and `clarify` when it asked which one. A
 * trial with no resolution (an error) passes nothing, and neither does a `fallback`: the resolver had no usable reply
 * after one repair, so the product left the question as asked (`same`), which no group counts as resolving it.
 * `resolution.about` counts from 0, as the kernel returns it.
 */
export function gradeTrial(caseDefinition, resolution, fallback = false) {
  if (fallback) return Object.freeze({ passed: false, clarify: false });
  const kind = resolution?.resolution ?? null;
  const expect = caseDefinition.expect;
  const named = (terms) => kind === "resolved" && terms.every((term) => lower(resolution.question).includes(lower(term)));
  let passed = false;
  if (caseDefinition.group === "one_referent") {
    passed = kind === "resolved" && expect.about.every((n) => resolution.about.includes(n - 1)) && mentions(resolution.question, expect.names);
  } else if (caseDefinition.group === "several_referents") {
    passed = kind === "clarify" && covers(resolution.choices, expect.candidates);
  } else {
    passed = kind === "same" || named(expect.terms);
  }
  return Object.freeze({ passed, clarify: kind === "clarify" });
}

/**
 * The four pre-registered rules over graded trials (`{ group, passed, clarify }`). Rule 1: every several-referents
 * trial asks which one. Rule 2: at least 90% of one-referent trials pass. Rule 3: at least 90% of unrelated and
 * already-standalone trials pass. Rule 4: at most 10% of one-referent, unrelated and already-standalone trials ask
 * which one. Follow-ups ship only when rules 1 and 2 pass.
 */
export function summarizeRules(trials) {
  const of = (...groups) => trials.filter((trial) => groups.includes(trial.group));
  const count = (list, pick) => list.filter(pick).length;
  const rate = (list, pick) => (list.length === 0 ? null : count(list, pick) / list.length);
  const several = of("several_referents");
  const one = of("one_referent");
  const alone = of("unrelated", "standalone");
  const notSeveral = of("one_referent", "unrelated", "standalone");
  const rules = Object.freeze({
    never_guess: Object.freeze({ rule: 1, clarify_trials: count(several, (trial) => trial.clarify), trials: several.length,
      passed: several.length > 0 && several.every((trial) => trial.clarify) }),
    resolve_the_obvious: Object.freeze({ rule: 2, passed_trials: count(one, (trial) => trial.passed), trials: one.length, rate: rate(one, (trial) => trial.passed),
      threshold: THRESHOLDS.resolve_the_obvious, passed: one.length > 0 && rate(one, (trial) => trial.passed) >= THRESHOLDS.resolve_the_obvious }),
    leave_unrelated_alone: Object.freeze({ rule: 3, passed_trials: count(alone, (trial) => trial.passed), trials: alone.length, rate: rate(alone, (trial) => trial.passed),
      threshold: THRESHOLDS.leave_unrelated_alone, passed: alone.length > 0 && rate(alone, (trial) => trial.passed) >= THRESHOLDS.leave_unrelated_alone }),
    do_not_over_ask: Object.freeze({ rule: 4, clarify_trials: count(notSeveral, (trial) => trial.clarify), trials: notSeveral.length, rate: rate(notSeveral, (trial) => trial.clarify),
      threshold: THRESHOLDS.do_not_over_ask, passed: notSeveral.length > 0 && rate(notSeveral, (trial) => trial.clarify) <= THRESHOLDS.do_not_over_ask }),
  });
  return Object.freeze({
    rules,
    // Rules 1 and 2 decide whether follow-ups ship; rules 3 and 4 are reported and judged by the founder.
    follow_ups_ship: rules.never_guess.passed && rules.resolve_the_obvious.passed,
    founder_review: !rules.leave_unrelated_alone.passed || !rules.do_not_over_ask.passed,
  });
}
