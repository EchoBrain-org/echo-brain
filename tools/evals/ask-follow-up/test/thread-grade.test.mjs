import assert from "node:assert/strict";
import test from "node:test";
import { gradeThreadTrial, loadThreadCases, summarizeThreadLabels, summarizeThreadRules, THREAD_GROUPS, THREAD_THRESHOLDS, threadRunIsComplete, threadTrialLabel } from "../grade.mjs";

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

test("reports a label only for an answer in the open thread, and checks it against the case's own questions as the desktop does", () => {
  const asked = { ...continues, previous: { question: "Why did the drop test fail on MECH-214?", earlier: [{ question: "When is the FCC pre-scan booked?" }] }, question: "who owns the retest?" };
  const labelled = (label, resolution = { resolution: "same" }) => ({ ...open([], resolution), label });
  assert.deepEqual(threadTrialLabel(asked, labelled("drop test: owns, retest")), { labellable: true, labelled: true, label_fits: true });
  // A word of the older turn's question is the person's too; one they never typed is not, nor one spelled otherwise.
  assert.deepEqual(threadTrialLabel(asked, labelled("FCC pre-scan: retest", { resolution: "resolved", question: "Who owns the MECH-214 retest?", about: [] })), { labellable: true, labelled: true, label_fits: true });
  assert.deepEqual(threadTrialLabel(asked, labelled("drop test: owner")), { labellable: true, labelled: true, label_fits: false });
  assert.deepEqual(threadTrialLabel(asked, open()), { labellable: true, labelled: false, label_fits: false });
  // Nothing for a clarify, another thread, a new one, a fallback or a trial that threw.
  assert.deepEqual(threadTrialLabel(asked, open([], { resolution: "clarify", choices: [] })), {});
  for (const placement of [other([0]), NEW, null]) assert.deepEqual(threadTrialLabel(asked, placement), {});
  assert.deepEqual(threadTrialLabel(asked, labelled("drop test"), true), {});
  // Never graded: the grade is the same with a label or without.
  assert.deepEqual(gradeThreadTrial(asked, labelled("drop test")), gradeThreadTrial(asked, open()));
});

test("counts labels beside the rules, and no label result changes them or the gate", () => {
  const trials = [
    { labellable: true, labelled: true, label_fits: true }, { labellable: true, labelled: true, label_fits: false },
    { labellable: true, labelled: false, label_fits: false }, {}, {},
  ];
  assert.deepEqual(summarizeThreadLabels(trials), { reported_only: true, open_trials: 3, labelled: 2, fitting: 1 });
  assert.deepEqual(summarizeThreadLabels([]), { reported_only: true, open_trials: 0, labelled: 0, fitting: 0 });
  const run = wholeRun();
  const unlabelled = decide(run);
  assert.deepEqual(decide(run.map((trial) => ({ ...trial, labellable: true, labelled: true, label_fits: false }))), unlabelled);
  assert.ok(!("labels" in unlabelled), "the rules' summary is the registered one");
});

test("refuses a placement or a group it does not know, rather than grading it as a miss", () => {
  assert.throws(() => gradeThreadTrial(continues, { thread: "elsewhere" }), /open thread, a new one, or other threads/u);
  assert.throws(() => gradeThreadTrial({ group: "another", expect: {} }, NEW), /unknown thread group/u);
});

/** A registered set shaped like the real one: each group's number of cases, by id. */
const REGISTERED = Object.entries(THREAD_GROUPS).flatMap(([group, count]) => Array.from({ length: count }, (_, index) => ({ id: `${group}-${index + 1}`, group })));
/** What a trial that meets its group's expectation is graded as. */
const met = (group) => ({ passed: true, named_all: group === "several_others", merged: group === "same_subject_twice" });
const MISSED = { passed: false, named_all: false, merged: false };
/**
 * The whole registered run: every case, trials 1 to 3. Every trial meets its expectation, but the first `misses[group]`
 * trials of a group, which miss it, and any trial `change` returns another grade for.
 */
function wholeRun(misses = {}, change = () => undefined) {
  const seen = {};
  return REGISTERED.flatMap((entry) => [1, 2, 3].map((trial) => {
    seen[entry.group] = (seen[entry.group] ?? 0) + 1;
    const graded = seen[entry.group] <= (misses[entry.group] ?? 0) ? MISSED : met(entry.group);
    return { case_id: entry.id, trial, group: entry.group, ...graded, ...change(entry, trial) };
  }));
}
const decide = (trials) => summarizeThreadRules(trials, REGISTERED);

test("rules: never guess, 90% routed, 90% left new, never a wrong merge; ECHO picks threads on rules 1, 2 and 4", () => {
  const passing = decide(wholeRun({ continues_open: 1, one_other: 2, new_subject: 1, same_subject_twice: 3 }));
  assert.deepEqual([passing.complete, passing.echo_picks_threads, passing.founder_review], [true, true, false]);
  assert.deepEqual(passing.rules.never_guess, { rule: 1, named_all_trials: 18, trials: 18, passed: true });
  assert.deepEqual(passing.rules.route_the_obvious, { rule: 2, passed_trials: 33, trials: 36, rate: 33 / 36, threshold: THREAD_THRESHOLDS.route_the_obvious, passed: true });
  assert.deepEqual(passing.rules.leave_new_subjects_alone, { rule: 3, passed_trials: 17, trials: 18, rate: 17 / 18, threshold: THREAD_THRESHOLDS.leave_new_subjects_alone, passed: true });
  assert.deepEqual(passing.rules.never_merge_wrongly, { rule: 4, merged_trials: 0, trials: 72, passed: true });
  // Rule 5 is reported for the founder: it has no threshold and decides nothing, even when no duplicate was merged.
  assert.deepEqual(passing.rules.merge_the_obvious, { rule: 5, passed_trials: 9, trials: 12, rate: 0.75 });
  assert.equal(decide(wholeRun({ same_subject_twice: 12 })).echo_picks_threads, true);
  // One trial that names a single thread where several fit, and ECHO does not pick threads.
  const guessed = decide(wholeRun({ several_others: 1 }));
  assert.deepEqual([guessed.rules.never_guess, guessed.echo_picks_threads], [{ rule: 1, named_all_trials: 17, trials: 18, passed: false }, false]);
  // One merge outside the same-subject-twice group, in any group, and ECHO does not pick threads.
  for (const group of ["continues_open", "one_other", "several_others", "new_subject"]) {
    const merged = decide(wholeRun({}, (entry, trial) => (entry.id === `${group}-2` && trial === 3 ? { merged: true } : undefined)));
    assert.deepEqual([merged.rules.never_merge_wrongly.merged_trials, merged.rules.never_merge_wrongly.passed, merged.echo_picks_threads], [1, false, false], group);
  }
  // Rule 2 decides too: 32 of 36 routed is under 90%, and ECHO does not pick threads, though it never guessed or merged.
  const misrouted = decide(wholeRun({ continues_open: 2, one_other: 2 }));
  assert.deepEqual([misrouted.rules.never_guess.passed, misrouted.rules.route_the_obvious.passed, misrouted.rules.never_merge_wrongly.passed, misrouted.echo_picks_threads], [true, false, true, false]);
  assert.equal(decide(wholeRun({ continues_open: 2, one_other: 1 })).echo_picks_threads, true);
  // Rule 3 is reported against its threshold and goes to the founder when missed; it is not the gate.
  const filed = decide(wholeRun({ new_subject: 2 }));
  assert.deepEqual([filed.rules.leave_new_subjects_alone.passed, filed.echo_picks_threads, filed.founder_review], [false, true, true]);
});

test("only the whole registered run decides: every case once, three trials each", () => {
  const whole = wholeRun();
  assert.equal(threadRunIsComplete(whole, REGISTERED), true);
  assert.deepEqual([decide(whole).complete, decide(whole).echo_picks_threads], [true, true]);
  // The same trials in another order are the same run.
  assert.equal(threadRunIsComplete([...whole].reverse(), REGISTERED), true);
  const lacking = {
    "one trial short": whole.slice(1),
    "two trials of each case": whole.filter((trial) => trial.trial <= 2),
    "one case alone": whole.filter((trial) => trial.case_id === "several_others-1"),
    "one group alone": whole.filter((trial) => trial.group === "several_others"),
    "a case run twice in another's place": whole.map((trial) => (trial.case_id === "one_other-1" ? { ...trial, case_id: "one_other-2" } : trial)),
    "a trial numbered twice": whole.map((trial) => (trial.case_id === "new_subject-1" && trial.trial === 3 ? { ...trial, trial: 2 } : trial)),
    "a fourth trial": [...whole.slice(1), { ...whole[0], trial: 4 }],
    "a case that is not registered": whole.map((trial) => (trial.case_id === "new_subject-1" ? { ...trial, case_id: "new_subject-9" } : trial)),
    "a case graded as another group's": whole.map((trial) => (trial.case_id === "new_subject-1" ? { ...trial, group: "continues_open" } : trial)),
    "every trial twice": [...whole, ...whole],
    "no trial": [],
  };
  for (const [name, trials] of Object.entries(lacking)) {
    assert.equal(threadRunIsComplete(trials, REGISTERED), false, name);
    // Whatever its rules say, a run that is not the whole registered run never lets ECHO pick threads.
    assert.deepEqual([decide(trials).complete, decide(trials).echo_picks_threads], [false, false], name);
  }
  // The single case with one passing trial that used to set the gate.
  const single = decide([{ case_id: "several_others-1", trial: 1, group: "several_others", ...met("several_others") }]);
  assert.deepEqual([single.rules.never_guess.passed, single.echo_picks_threads], [true, false]);
  // A registered set that names a case twice has no whole run.
  assert.equal(threadRunIsComplete(whole, [...REGISTERED, REGISTERED[0]]), false);
});

/** A placement as the kernel returns it for a policy that names these thread numbers (from 1), reading nothing. */
const naming = (numbers) => ({ thread: "other", threads: numbers.map((n) => n - 1), merge: [] });
/** The whole registered run of a policy over the real cases: three trials of what it places each case as. */
function policyRun(document, policy) {
  return document.cases.flatMap((entry) => [1, 2, 3].map((trial) => ({ case_id: entry.id, trial, group: entry.group, ...gradeThreadTrial(entry, policy(entry)) })));
}

test("no constant policy qualifies over the registered cases: one that reads nothing cannot let ECHO pick threads", () => {
  const document = loadThreadCases();
  const all = (entry) => entry.threads.map((_, index) => index + 1);
  const verdict = (policy) => summarizeThreadRules(policyRun(document, policy), document.cases);
  // The registered expectations themselves do qualify: the gate can be passed.
  const expected = verdict((entry) => (entry.expect.thread === "open" ? { thread: "open", resolution: { resolution: "same" }, merge: (entry.expect.merge ?? []).map((n) => n - 1) }
    : entry.expect.thread === "new" ? { thread: "new" } : { thread: "other", threads: entry.expect.threads.map((n) => n - 1), merge: (entry.expect.merge ?? []).map((n) => n - 1) }));
  assert.deepEqual([expected.complete, expected.echo_picks_threads], [true, true]);

  // "Name every other thread for every question" never guesses and never merges. It routes nothing, and rule 2 decides.
  const every = verdict((entry) => naming(all(entry)));
  assert.deepEqual([every.complete, every.rules.never_guess.passed, every.rules.never_merge_wrongly.passed], [true, true, true]);
  assert.deepEqual([every.rules.route_the_obvious.passed_trials, every.rules.route_the_obvious.passed, every.echo_picks_threads], [0, false, false]);
  // And it is not what any several-threads case expects: each leaves a thread that is no candidate.
  assert.equal(policyRun(document, (entry) => naming(all(entry))).filter((trial) => trial.group === "several_others" && trial.passed).length, 0);

  // "Name every thread but the last" used to be exactly right for all six several-threads cases. The thread that is no
  // candidate now sits first, in the middle and last, so it misses a candidate and guesses.
  const butLast = verdict((entry) => naming(all(entry).slice(0, -1)));
  assert.deepEqual([butLast.rules.never_guess.named_all_trials, butLast.rules.never_guess.passed, butLast.rules.route_the_obvious.passed, butLast.echo_picks_threads], [6, false, false, false]);

  // No other rule about position, and no single answer for everything, does better.
  const constant = {
    "every thread but the first": (entry) => naming(all(entry).slice(1)),
    "the first thread": () => naming([1]),
    "the second thread": () => naming([2]),
    "the last thread": (entry) => naming([entry.threads.length]),
    "the first two threads": () => naming([1, 2]),
    "always the open thread": (entry) => (entry.previous === undefined ? { thread: "new" } : { thread: "open", resolution: { resolution: "same" }, merge: [] }),
    "always a new thread": () => ({ thread: "new" }),
  };
  for (const [name, policy] of Object.entries(constant)) {
    const judged = verdict(policy);
    assert.equal(judged.complete, true, name);
    assert.equal(judged.echo_picks_threads, false, name);
    // Each fails on reading, not on a technicality: it guesses where several threads fit, or routes too little.
    assert.ok(!judged.rules.never_guess.passed || !judged.rules.route_the_obvious.passed, name);
    assert.ok(judged.rules.never_guess.named_all_trials < 18, `${name}: it names every candidate in some case only by luck of position`);
  }
});
