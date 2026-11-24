import assert from "node:assert/strict";
import test from "node:test";
import { gradeThreadTrial, summarizeThreadRules, THREAD_THRESHOLDS } from "../grade.mjs";

// Cases name threads from 1, as the resolver is shown them; the kernel's placement counts from 0.
const continues = { group: "continues_open", expect: { thread: "open" } };
const one = { group: "one_other", expect: { thread: "other", threads: [2] } };
const several = { group: "several_others", expect: { thread: "other", threads: [1, 3] } };
const fresh = { group: "new_subject", expect: { thread: "new" } };
const twiceOpen = { group: "same_subject_twice", expect: { thread: "open", merge: [2] } };
const twiceOther = { group: "same_subject_twice", expect: { thread: "other", threads: [1], merge: [3] } };
const open = (merge = [], resolution = { resolution: "same" }) => ({ thread: "open", resolution, merge });
const other = (threads, merge = []) => ({ thread: "other", threads, merge });
const NEW = { thread: "new" };
const FAILED = { passed: false, named_all: false, merged: false };

test("continues the open thread: open, whatever it refers to there", () => {
  assert.deepEqual(gradeThreadTrial(continues, open()), { passed: true, named_all: false, merged: false });
  assert.equal(gradeThreadTrial(continues, open([], { resolution: "resolved", question: "What are the details on THERM-482?", about: [0] })).passed, true);
  assert.equal(gradeThreadTrial(continues, open([], { resolution: "clarify", choices: [] })).passed, true);
  for (const placement of [NEW, other([0]), null]) assert.equal(gradeThreadTrial(continues, placement).passed, false);
  // It is the open thread, but it merged a thread no case of this group has: rule 4 sees it.
  assert.deepEqual(gradeThreadTrial(continues, open([1])), { passed: true, named_all: false, merged: true });
});

test("one other thread: other, naming exactly that thread", () => {
  assert.deepEqual(gradeThreadTrial(one, other([1])), { passed: true, named_all: false, merged: false });
  for (const placement of [other([0]), other([1, 0]), open(), NEW, null]) assert.equal(gradeThreadTrial(one, placement).passed, false);
  assert.deepEqual(gradeThreadTrial(one, other([1], [2])), { passed: true, named_all: false, merged: true });
});

test("several other threads: other, naming every candidate; one alone is a guess", () => {
  assert.deepEqual(gradeThreadTrial(several, other([0, 2])), { passed: true, named_all: true, merged: false });
  assert.deepEqual(gradeThreadTrial(several, other([2, 0])), { passed: true, named_all: true, merged: false });
  // Every candidate and one more: not a guess, and not the expectation.
  assert.deepEqual(gradeThreadTrial(several, other([0, 1, 2])), { passed: false, named_all: true, merged: false });
  for (const placement of [other([0]), other([2]), other([1]), open(), NEW, null]) assert.deepEqual(gradeThreadTrial(several, placement), FAILED);
});

test("a new subject: new", () => {
  assert.deepEqual(gradeThreadTrial(fresh, NEW), { passed: true, named_all: false, merged: false });
  for (const placement of [open(), other([0]), other([0, 1]), null]) assert.equal(gradeThreadTrial(fresh, placement).passed, false);
});

test("the same subject twice: the expected thread with exactly its duplicates merged, either other thread named", () => {
  assert.deepEqual(gradeThreadTrial(twiceOpen, open([1])), { passed: true, named_all: false, merged: true });
  for (const placement of [open(), open([0]), open([1, 2]), other([1]), NEW, null]) assert.equal(gradeThreadTrial(twiceOpen, placement).passed, false);
  assert.deepEqual(gradeThreadTrial(twiceOther, other([0], [2])), { passed: true, named_all: false, merged: true });
  // The two are one subject: naming the duplicate and merging the other leaves the same merged thread.
  assert.equal(gradeThreadTrial(twiceOther, other([2], [0])).passed, true);
  for (const placement of [other([0]), other([0, 2]), other([0], [1]), other([1], [0, 2]), open([2]), NEW, null]) assert.equal(gradeThreadTrial(twiceOther, placement).passed, false);
});

test("a fallback fails its trial in every group: answering where the question was asked for want of a usable reply places nothing", () => {
  // With a previous turn the product's fallback is the open thread; with none, a new thread.
  for (const caseDefinition of [continues, one, several, fresh, twiceOpen, twiceOther]) {
    assert.deepEqual(gradeThreadTrial(caseDefinition, open(), true), FAILED, caseDefinition.group);
    assert.deepEqual(gradeThreadTrial(caseDefinition, NEW, true), FAILED, caseDefinition.group);
  }
  // The same placements, when the model gave them, pass the groups that expect them.
  assert.equal(gradeThreadTrial(continues, open(), false).passed, true);
  assert.equal(gradeThreadTrial(fresh, NEW).passed, true);
});

test("refuses a placement or a group it does not know, rather than grading it as a miss", () => {
  assert.throws(() => gradeThreadTrial(continues, { thread: "elsewhere" }), /open thread, a new one, or other threads/u);
  assert.throws(() => gradeThreadTrial({ group: "another", expect: {} }, NEW), /unknown thread group/u);
});

test("rules: never guess, 90% routed, 90% left new, never a wrong merge; ECHO picks threads on rules 1 and 4", () => {
  const trials = (group, passed, total, more = {}) => Array.from({ length: total }, (_, index) => ({ group, passed: index < passed, named_all: false, merged: false, ...more }));
  const severalTrials = (namedAll) => Array.from({ length: 18 }, (_, index) => ({ group: "several_others", passed: index < namedAll, named_all: index < namedAll, merged: false }));
  const twice = (passed) => Array.from({ length: 12 }, (_, index) => ({ group: "same_subject_twice", passed: index < passed, named_all: false, merged: index < passed }));
  const base = [...trials("continues_open", 17, 18), ...trials("one_other", 16, 18), ...trials("new_subject", 17, 18), ...twice(9)];
  const passing = summarizeThreadRules([...severalTrials(18), ...base]);
  assert.deepEqual([passing.echo_picks_threads, passing.founder_review], [true, false]);
  assert.deepEqual(passing.rules.never_guess, { rule: 1, named_all_trials: 18, trials: 18, passed: true });
  assert.deepEqual(passing.rules.route_the_obvious, { rule: 2, passed_trials: 33, trials: 36, rate: 33 / 36, threshold: THREAD_THRESHOLDS.route_the_obvious, passed: true });
  assert.deepEqual(passing.rules.leave_new_subjects_alone, { rule: 3, passed_trials: 17, trials: 18, rate: 17 / 18, threshold: THREAD_THRESHOLDS.leave_new_subjects_alone, passed: true });
  assert.deepEqual(passing.rules.never_merge_wrongly, { rule: 4, merged_trials: 0, trials: 72, passed: true });
  // Rule 5 is reported for the founder: it has no threshold and decides nothing.
  assert.deepEqual(passing.rules.merge_the_obvious, { rule: 5, passed_trials: 9, trials: 12, rate: 0.75 });
  assert.equal(summarizeThreadRules([...severalTrials(18), ...base.filter((trial) => trial.group !== "same_subject_twice"), ...twice(0)]).echo_picks_threads, true);
  // One trial that names a single thread where several fit, and ECHO does not pick threads.
  const guessed = summarizeThreadRules([...severalTrials(17), ...base]);
  assert.deepEqual([guessed.rules.never_guess.passed, guessed.echo_picks_threads], [false, false]);
  // One merge outside the same-subject-twice group, in any group, and ECHO does not pick threads.
  for (const group of ["continues_open", "one_other", "several_others", "new_subject"]) {
    const merged = summarizeThreadRules([...severalTrials(18), ...base, { group, passed: true, named_all: group === "several_others", merged: true }]);
    assert.deepEqual([merged.rules.never_merge_wrongly.merged_trials, merged.rules.never_merge_wrongly.passed, merged.echo_picks_threads], [1, false, false], group);
  }
  // Rules 2 and 3 are reported against their thresholds, and go to the founder when missed; they are not the gate.
  const misrouted = summarizeThreadRules([...severalTrials(18), ...trials("continues_open", 16, 18), ...trials("one_other", 16, 18), ...trials("new_subject", 16, 18), ...twice(9)]);
  assert.deepEqual([misrouted.rules.route_the_obvious.passed, misrouted.rules.leave_new_subjects_alone.passed, misrouted.echo_picks_threads, misrouted.founder_review], [false, false, true, true]);
  // A run of part of the set cannot pass a rule whose trials it did not run.
  assert.equal(summarizeThreadRules(trials("new_subject", 18, 18)).echo_picks_threads, false);
});
