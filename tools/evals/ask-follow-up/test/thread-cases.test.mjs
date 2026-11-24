import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validatePersonAnswerRequestV3 } from "@echo-brain/organization-api";
import { GROUPS, THREAD_CASES_FILE, THREAD_GROUPS, loadCases, loadThreadCases, threadCaseProblems } from "../grade.mjs";

const document = loadThreadCases();
const of = (group) => document.cases.filter((entry) => entry.group === group);

test("the pre-registered thread set: 28 cases in the design's five groups, each a valid Ask with its threads", () => {
  assert.deepEqual(THREAD_GROUPS, { continues_open: 6, one_other: 6, several_others: 6, new_subject: 6, same_subject_twice: 4 });
  assert.deepEqual(threadCaseProblems(document), []);
  for (const entry of document.cases) {
    const request = { schema_version: 3, question: entry.question, ...(entry.previous === undefined ? {} : { previous: entry.previous }), threads: entry.threads };
    assert.deepEqual(validatePersonAnswerRequestV3(request), request, entry.id);
    // The other threads are listed as the desktop sends them: most recently asked first.
    const asked = entry.threads.map((thread) => thread.asked_at);
    assert.deepEqual(asked, [...asked].sort().reverse(), `${entry.id}: threads are most recent first`);
  }
});

test("leaves the thirty follow-up cases as they were", () => {
  assert.deepEqual(GROUPS, { one_referent: 10, several_referents: 10, unrelated: 5, standalone: 5 });
  assert.ok(loadCases().cases.every((entry) => entry.threads === undefined && entry.previous.earlier === undefined));
});

test("covers an open thread with older turns, and a question asked with no thread open", () => {
  assert.ok(document.cases.some((entry) => entry.previous?.earlier !== undefined), "a case carries older turns");
  for (const group of ["one_other", "several_others", "new_subject", "same_subject_twice"]) {
    assert.ok(of(group).some((entry) => entry.previous === undefined), `${group}: a case has no thread open`);
    assert.ok(of(group).some((entry) => entry.previous !== undefined), `${group}: a case has a thread open`);
  }
  // Only a case with a thread open can continue it.
  assert.ok(of("continues_open").every((entry) => entry.previous?.purpose === "follow_up"));
});

test("grounds every expectation in the threads the resolver is shown", () => {
  for (const entry of document.cases) {
    const numbers = [...(entry.expect.threads ?? []), ...(entry.expect.merge ?? [])];
    assert.ok(numbers.every((n) => n >= 1 && n <= entry.threads.length), `${entry.id}: names threads it carries`);
    assert.equal(new Set(numbers).size, numbers.length, `${entry.id}: names each thread once`);
  }
  assert.ok(of("same_subject_twice").some((entry) => entry.expect.thread === "open") && of("same_subject_twice").some((entry) => entry.expect.thread === "other"));
});

test("puts the threads that fit where no rule about position finds them", () => {
  const place = (number, count) => (number === 1 ? "first" : number === count ? "last" : "middle");
  const tally = (places) => Object.fromEntries(["first", "middle", "last"].map((name) => [name, places.filter((value) => value === name).length]));
  // One other thread: the thread the question belongs to is first, in the middle and last, twice each.
  assert.deepEqual(tally(of("one_other").map((entry) => place(entry.expect.threads[0], entry.threads.length))), { first: 2, middle: 2, last: 2 });
  // Several other threads: each case leaves exactly one thread that is no candidate, and it too sits in each place twice.
  const others = of("several_others").map((entry) => entry.threads.map((_, index) => index + 1).filter((n) => !entry.expect.threads.includes(n)).map((n) => place(n, entry.threads.length)));
  assert.ok(others.every((places) => places.length === 1));
  assert.deepEqual(tally(others.flat()), { first: 2, middle: 2, last: 2 });
  // So naming every thread but the last, or but the first, is not what every several-threads case expects.
  const exact = (pick) => of("several_others").filter((entry) => JSON.stringify(pick(entry.threads.map((_, index) => index + 1))) === JSON.stringify(entry.expect.threads)).length;
  assert.deepEqual([exact((all) => all.slice(0, -1)), exact((all) => all.slice(1)), exact((all) => all)], [2, 2, 0]);
});

test("places near misses, threads that are related and not the same subject, in every group, so no merge and no guess is free", () => {
  const near = document.cases.filter((entry) => entry.near_miss !== undefined);
  for (const group of Object.keys(THREAD_GROUPS)) assert.ok(near.some((entry) => entry.group === group), `${group} has a near miss`);
  // Rule 4 reads the groups that expect no merge: most near misses sit there.
  assert.ok(near.filter((entry) => entry.group !== "same_subject_twice").length >= 8);
  const copy = JSON.parse(readFileSync(THREAD_CASES_FILE, "utf8"));
  copy.cases.find((entry) => entry.near_miss !== undefined).near_miss = " ";
  assert.match(threadCaseProblems(copy).join(), /near_miss says which thread is related/u);
});

test("refuses a set that is not the registered one", () => {
  const altered = (change) => { const copy = JSON.parse(readFileSync(THREAD_CASES_FILE, "utf8")); change(copy); return threadCaseProblems(copy); };
  const first = (copy, group) => copy.cases.find((entry) => entry.group === group);
  assert.match(altered((copy) => { copy.cases.pop(); }).join(), /same_subject_twice has 3 cases/u);
  assert.match(altered((copy) => { first(copy, "continues_open").expect = { thread: "new" }; }).join(), /expects the open thread and no merge/u);
  assert.match(altered((copy) => { first(copy, "continues_open").expect.merge = [1]; }).join(), /expects the open thread and no merge/u);
  assert.match(altered((copy) => { first(copy, "one_other").expect.threads = [1, 2]; }).join(), /expects exactly one of threads/u);
  assert.match(altered((copy) => { first(copy, "one_other").expect.threads = [9]; }).join(), /expects exactly one of threads 1 to 3/u);
  assert.match(altered((copy) => { first(copy, "several_others").expect.threads = [1]; }).join(), /expects two or more of threads/u);
  // A several-threads case in which every thread is a candidate would pay a resolver that names them all unread.
  assert.match(altered((copy) => { const entry = first(copy, "several_others"); entry.expect.threads = entry.threads.map((_, index) => index + 1); }).join(), /never all of them/u);
  assert.match(altered((copy) => { first(copy, "new_subject").expect = { thread: "open" }; }).join(), /expects a new thread and no merge/u);
  assert.match(altered((copy) => { first(copy, "same_subject_twice").expect.merge = []; }).join(), /the other threads to merge with it/u);
  assert.match(altered((copy) => { const entry = copy.cases.find((item) => item.expect.thread === "other" && item.expect.merge !== undefined); entry.expect.merge = entry.expect.threads; }).join(), /the other threads to merge with it/u);
  assert.match(altered((copy) => { const entry = copy.cases.find((item) => item.previous === undefined); entry.expect = { thread: "open" }; }).join(), /only a case with a previous turn has an open thread/u);
  assert.match(altered((copy) => { copy.cases[0].threads[0].questions = []; }).join(), /not a valid Ask with its threads/u);
  assert.match(altered((copy) => { copy.cases[0].previous.statements[0].citation_indexes = [7]; }).join(), /not a valid Ask with its threads/u);
  assert.match(altered((copy) => { delete copy.cases[0].threads; }).join(), /threads are required/u);
  assert.match(altered((copy) => { copy.cases[1].id = copy.cases[0].id; }).join(), /missing or repeated/u);
  assert.deepEqual(altered((copy) => { copy.kind = "echo-ask-follow-up-eval-cases-v1"; }), ["the thread cases document kind is invalid"]);
});
