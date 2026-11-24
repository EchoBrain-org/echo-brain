/**
 * Deterministic grading for the follow-up resolution eval (Ask timeline v1, "Follow-up resolution eval
 * (pre-registered)", ADR-0047). No model judges: a trial passes or fails its case's expectation from the resolver's
 * structured reply alone, and the four rules are counts over trials. The thread resolution eval (Ask threads v1,
 * ADR-0056) is graded the same way, by its own cases and rules, in the second half of this file.
 */
import { readFileSync } from "node:fs";
import { validatePersonAnswerRequestV3, validatePersonQuestionText } from "@echo-brain/organization-api";

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
      try { validatePersonQuestionText(entry.question); } catch { problems.push(`${where}: the question is not a valid Ask question`); }
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

/*
 * ---- Thread resolution (Ask threads v1, "Thread resolution eval (pre-registered)", ADR-0056) ----
 *
 * A second pre-registered set, graded the same way: each case is an Ask with the asker's other threads, and for most an
 * open thread, and a trial passes or fails from the resolver's placement alone. The follow-up cases and their grading
 * above are unchanged.
 */

export const THREAD_CASES_FILE = new URL("./thread-cases.json", import.meta.url);
/** Each thread group's number of cases, as pre-registered. */
export const THREAD_GROUPS = Object.freeze({ continues_open: 6, one_other: 6, several_others: 6, new_subject: 6, same_subject_twice: 4 });
/** Rules 2 and 3 pass at or above; rules 1 and 4 allow no miss at all; rule 5 is reported for the founder. */
export const THREAD_THRESHOLDS = Object.freeze({ route_the_obvious: 0.9, leave_new_subjects_alone: 0.9 });
/** Trials of each case in the run that decides, as pre-registered. */
export const THREAD_TRIALS = 3;

/** Distinct thread numbers as a case names them: from 1, as the resolver is shown the threads. */
const threadNumbers = (value, threads) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
  && value.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= threads);
const sameSet = (left, right) => left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry));

/** Every problem with the thread cases document; an empty list when it is the pre-registered set. */
export function threadCaseProblems(document) {
  const problems = [];
  if (document === null || typeof document !== "object" || document.kind !== "echo-ask-thread-eval-cases-v1" || document.schema_version !== 1) return ["the thread cases document kind is invalid"];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.today ?? "") || typeof document.time_zone !== "string") problems.push("today and time_zone are required");
  const cases = Array.isArray(document.cases) ? document.cases : [];
  const ids = new Set();
  for (const [group, count] of Object.entries(THREAD_GROUPS)) {
    const found = cases.filter((entry) => entry.group === group).length;
    if (found !== count) problems.push(`${group} has ${found} cases, not ${count}`);
  }
  for (const entry of cases) {
    const where = `case ${entry?.id}`;
    if (typeof entry?.id !== "string" || !/^[a-z0-9-]{3,80}$/u.test(entry.id) || ids.has(entry.id)) problems.push(`${where}: id is missing or repeated`);
    ids.add(entry?.id);
    if (!Object.hasOwn(THREAD_GROUPS, entry?.group)) { problems.push(`${where}: group is invalid`); continue; }
    // Every case carries other threads: without them an answer can say nothing of where its question belongs.
    if (!Array.isArray(entry.threads)) { problems.push(`${where}: threads are required`); continue; }
    try { validatePersonAnswerRequestV3({ schema_version: 3, question: entry.question, ...(entry.previous === undefined ? {} : { previous: entry.previous }), threads: entry.threads }); }
    catch (error) { problems.push(`${where}: not a valid Ask with its threads (${error instanceof Error ? error.message : "invalid"})`); continue; }
    // A near miss is a note for readers: which thread is related to the question's subject without being the same thing.
    if (entry.near_miss !== undefined && (typeof entry.near_miss !== "string" || entry.near_miss.trim() === "")) problems.push(`${where}: near_miss says which thread is related and not the same`);
    const expect = entry.expect ?? {};
    const others = entry.threads.length;
    const open = entry.previous !== undefined;
    if (expect.thread === "open" && !open) problems.push(`${where}: only a case with a previous turn has an open thread`);
    switch (entry.group) {
      case "continues_open":
        if (expect.thread !== "open" || expect.merge !== undefined) problems.push(`${where}: expects the open thread and no merge`);
        break;
      case "one_other":
        if (expect.thread !== "other" || !threadNumbers(expect.threads, others) || expect.threads.length !== 1 || expect.merge !== undefined) problems.push(`${where}: expects exactly one of threads 1 to ${others} and no merge`);
        break;
      case "several_others":
        // Never every thread: a case in which naming them all is right would pay a resolver that reads nothing.
        if (expect.thread !== "other" || !threadNumbers(expect.threads, others) || expect.threads.length < 2 || expect.threads.length >= others || expect.merge !== undefined) problems.push(`${where}: expects two or more of threads 1 to ${others}, never all of them, and no merge`);
        break;
      case "new_subject":
        if (expect.thread !== "new" || expect.merge !== undefined) problems.push(`${where}: expects a new thread and no merge`);
        break;
      case "same_subject_twice": {
        const target = expect.thread === "other" && threadNumbers(expect.threads, others) && expect.threads.length === 1 ? expect.threads : expect.thread === "open" ? [] : null;
        if (target === null || !threadNumbers(expect.merge, others) || expect.merge.some((n) => target.includes(n))) problems.push(`${where}: expects the open thread or one of threads 1 to ${others}, and the other threads to merge with it`);
        break;
      }
      default: problems.push(`${where}: group is invalid`);
    }
  }
  return problems;
}

/** The pre-registered thread cases, refused when they are not the set the design registered. */
export function loadThreadCases(path = THREAD_CASES_FILE) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const problems = threadCaseProblems(document);
  if (problems.length > 0) throw new Error(`thread eval cases are invalid: ${problems.slice(0, 5).join("; ")}`);
  return document;
}

/**
 * One thread trial's grade against its case, from the kernel's placement (`{ thread: "open" | "new" | "other", … }`,
 * its `threads` and `merge` counting from 0) or null for a trial that threw:
 *
 * - `passed`: the placement is the group's expectation. Continues the open thread: `open`. One other thread: `other`
 *   naming exactly that thread. Several other threads: `other` naming exactly the candidates. New subject: `new`. Same
 *   subject twice: the expected thread with exactly its duplicates merged; when both are other threads, either may be
 *   the one named and the other merged, since the merged thread is the same.
 * - `named_all`: `other` naming every candidate, whatever else it names. Rule 1 reads it: a trial that names one
 *   candidate alone has guessed.
 * - `merged`: it named a merge at all. Rule 4 reads it.
 *
 * A `fallback` (no usable reply after one repair, so the product answered where the question was asked) passes nothing,
 * in every group.
 */
export function gradeThreadTrial(caseDefinition, placement, fallback = false) {
  if (fallback || placement === null || placement === undefined) return Object.freeze({ passed: false, named_all: false, merged: false });
  const expect = caseDefinition.expect;
  const numbers = (indexes) => indexes.map((index) => index + 1);
  let named = [];
  let merge = [];
  switch (placement.thread) {
    case "open": merge = numbers(placement.merge); break;
    case "new": break;
    case "other": named = numbers(placement.threads); merge = numbers(placement.merge); break;
    default: throw new Error("a placement is the open thread, a new one, or other threads");
  }
  const namedAll = caseDefinition.group === "several_others" && placement.thread === "other" && expect.threads.every((n) => named.includes(n));
  let passed = false;
  switch (caseDefinition.group) {
    case "continues_open": passed = placement.thread === "open"; break;
    case "one_other": passed = placement.thread === "other" && sameSet(named, expect.threads); break;
    case "several_others": passed = namedAll && sameSet(named, expect.threads); break;
    case "new_subject": passed = placement.thread === "new"; break;
    case "same_subject_twice":
      passed = expect.thread === "open" ? placement.thread === "open" && sameSet(merge, expect.merge)
        : placement.thread === "other" && named.length === 1 && sameSet([...named, ...merge], [...expect.threads, ...expect.merge]);
      break;
    default: throw new Error(`unknown thread group ${caseDefinition.group}`);
  }
  return Object.freeze({ passed, named_all: namedAll, merged: merge.length > 0 });
}

/**
 * Whether graded trials are the whole registered run, which alone decides: every registered case (`cases`, each an id
 * and its group), tried exactly THREAD_TRIALS times as trials 1 to 3, and no other trial. A selection of some cases, a
 * case run twice, or fewer trials is a run that may be reported and never decides.
 */
export function threadRunIsComplete(trials, cases) {
  const registered = new Map(cases.map((entry) => [entry.id, entry.group]));
  if (registered.size !== cases.length || trials.length !== registered.size * THREAD_TRIALS) return false;
  const seen = new Set();
  for (const trial of trials) {
    if (!registered.has(trial.case_id) || registered.get(trial.case_id) !== trial.group) return false;
    if (!Number.isSafeInteger(trial.trial) || trial.trial < 1 || trial.trial > THREAD_TRIALS) return false;
    const key = `${trial.case_id} ${trial.trial}`;
    // As many trials as the registered run has, each of a registered case and trial number, none twice: all of them.
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * The five pre-registered thread rules over graded trials (`{ case_id, trial, group, passed, named_all, merged }`), and
 * the one decision they make. Rule 1: every several-other-threads trial names every candidate. Rule 2: at least 90% of
 * continues-the-open-thread and one-other-thread trials pass. Rule 3: at least 90% of new-subject trials return `new`.
 * Rule 4: no trial outside same-subject-twice names a merge. Rule 5: same-subject-twice trials that pass, reported for
 * the founder to judge.
 *
 * ECHO picks threads only when rules 1, 2 and 4 pass over the whole registered run (`threadRunIsComplete`, against
 * `cases`, the registered set). Rule 2 decides with the other two because a resolver that names every other thread for
 * every question never guesses and never merges, and routes nothing. Rules 3 and 5 are for the founder.
 */
export function summarizeThreadRules(trials, cases) {
  const of = (...groups) => trials.filter((trial) => groups.includes(trial.group));
  const count = (list, pick) => list.filter(pick).length;
  const rate = (list, pick) => (list.length === 0 ? null : count(list, pick) / list.length);
  const several = of("several_others");
  const obvious = of("continues_open", "one_other");
  const fresh = of("new_subject");
  const twice = of("same_subject_twice");
  const unmerged = of("continues_open", "one_other", "several_others", "new_subject");
  const rules = Object.freeze({
    never_guess: Object.freeze({ rule: 1, named_all_trials: count(several, (trial) => trial.named_all), trials: several.length,
      passed: several.length > 0 && several.every((trial) => trial.named_all) }),
    route_the_obvious: Object.freeze({ rule: 2, passed_trials: count(obvious, (trial) => trial.passed), trials: obvious.length, rate: rate(obvious, (trial) => trial.passed),
      threshold: THREAD_THRESHOLDS.route_the_obvious, passed: obvious.length > 0 && rate(obvious, (trial) => trial.passed) >= THREAD_THRESHOLDS.route_the_obvious }),
    leave_new_subjects_alone: Object.freeze({ rule: 3, passed_trials: count(fresh, (trial) => trial.passed), trials: fresh.length, rate: rate(fresh, (trial) => trial.passed),
      threshold: THREAD_THRESHOLDS.leave_new_subjects_alone, passed: fresh.length > 0 && rate(fresh, (trial) => trial.passed) >= THREAD_THRESHOLDS.leave_new_subjects_alone }),
    never_merge_wrongly: Object.freeze({ rule: 4, merged_trials: count(unmerged, (trial) => trial.merged), trials: unmerged.length,
      passed: unmerged.length > 0 && unmerged.every((trial) => !trial.merged) }),
    // No threshold: the founder judges how many of the plain duplicates were merged.
    merge_the_obvious: Object.freeze({ rule: 5, passed_trials: count(twice, (trial) => trial.passed), trials: twice.length, rate: rate(twice, (trial) => trial.passed) }),
  });
  const complete = threadRunIsComplete(trials, cases);
  return Object.freeze({
    rules,
    // Only the whole registered set, each case once with three trials, decides anything.
    complete,
    // Rules 1, 2 and 4 decide whether ECHO picks threads at all, and only over the whole registered run.
    echo_picks_threads: complete && rules.never_guess.passed && rules.route_the_obvious.passed && rules.never_merge_wrongly.passed,
    // Rule 3 is reported with its threshold and goes to the founder when missed; rule 5 always does.
    founder_review: !rules.leave_new_subjects_alone.passed,
  });
}
