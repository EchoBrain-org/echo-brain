import assert from "node:assert/strict";
import test from "node:test";
import { gradeTrial, summarizeRules, THRESHOLDS } from "../grade.mjs";

const one = { group: "one_referent", expect: { about: [1], names: ["THERM-482"] } };
const several = { group: "several_referents", expect: { candidates: [["THERM-482"], ["MECH-214"]] } };
const unrelated = { group: "unrelated", expect: { terms: ["firmware team"] } };
const standalone = { group: "standalone", expect: { terms: ["THERM-482"] } };
const resolved = (question, about = [0]) => ({ resolution: "resolved", question, about });
const clarify = (...choices) => ({ resolution: "clarify", choices: choices.map(([label, question]) => ({ label, question })) });
const SAME = { resolution: "same" };

test("one referent: resolved, about the expected source, and naming it", () => {
  assert.deepEqual(gradeTrial(one, resolved("What are the details on THERM-482?")), { passed: true, clarify: false });
  assert.deepEqual(gradeTrial(one, resolved("What are the details on therm-482?", [0, 1])), { passed: true, clarify: false });
  for (const resolution of [resolved("What are the details on THERM-482?", [1]), resolved("What are the details on that ticket?"), SAME, null]) {
    assert.equal(gradeTrial(one, resolution).passed, false);
  }
  assert.deepEqual(gradeTrial(one, clarify(["A", "What is A?"], ["B", "What is B?"])), { passed: false, clarify: true });
});

test("several referents: clarify, with each candidate named by a choice of its own", () => {
  assert.deepEqual(gradeTrial(several, clarify(["THERM-482", "What are the details on THERM-482?"], ["Bezel", "What are the details on MECH-214?"])), { passed: true, clarify: true });
  // Two choices for the same candidate leave the other uncovered; that is still clarify, never a guess.
  assert.deepEqual(gradeTrial(several, clarify(["THERM-482", "What is THERM-482?"], ["THERM-482 again", "Who owns THERM-482?"])), { passed: false, clarify: true });
  assert.deepEqual(gradeTrial(several, resolved("What are the details on THERM-482?")), { passed: false, clarify: false });
  assert.equal(gradeTrial(several, SAME).passed, false);
});

test("unrelated and already standalone: same, or resolved keeping every term", () => {
  for (const [caseDefinition, kept, lost] of [[unrelated, "Who leads the firmware team?", "Who leads THERM-482?"], [standalone, "What are the details on THERM-482?", "What are the details on that ticket?"]]) {
    assert.deepEqual(gradeTrial(caseDefinition, SAME), { passed: true, clarify: false });
    assert.equal(gradeTrial(caseDefinition, resolved(kept, [])).passed, true);
    assert.equal(gradeTrial(caseDefinition, resolved(lost)).passed, false);
    assert.deepEqual(gradeTrial(caseDefinition, clarify(["A", "What is A?"], ["B", "What is B?"])), { passed: false, clarify: true });
    assert.equal(gradeTrial(caseDefinition, null).passed, false);
  }
});

test("a fallback fails its trial in every group: the question left as asked for want of a usable reply is no resolution", () => {
  for (const caseDefinition of [one, several, unrelated, standalone]) {
    assert.deepEqual(gradeTrial(caseDefinition, SAME, true), { passed: false, clarify: false }, caseDefinition.group);
  }
  // The same reply, when the model gave it, still leaves an unrelated or already standalone question alone.
  assert.equal(gradeTrial(unrelated, SAME, false).passed, true);
  assert.equal(gradeTrial(standalone, SAME).passed, true);
});

test("rules: no guess at all, 90% resolved, 90% left alone, at most 10% asked which one; follow-ups ship on rules 1 and 2", () => {
  const trials = (group, passed, total, clarify = 0) => Array.from({ length: total }, (_, index) => ({ group, passed: index < passed, clarify: index < clarify }));
  const several = (clarified) => Array.from({ length: 30 }, (_, index) => ({ group: "several_referents", passed: index < clarified, clarify: index < clarified }));
  const base = [...trials("one_referent", 27, 30), ...trials("unrelated", 14, 15), ...trials("standalone", 13, 15)];
  const passing = summarizeRules([...several(30), ...base]);
  assert.equal(passing.follow_ups_ship, true);
  assert.equal(passing.founder_review, false);
  assert.deepEqual(passing.rules.never_guess, { rule: 1, clarify_trials: 30, trials: 30, passed: true });
  assert.deepEqual(passing.rules.resolve_the_obvious, { rule: 2, passed_trials: 27, trials: 30, rate: 0.9, threshold: THRESHOLDS.resolve_the_obvious, passed: true });
  assert.equal(passing.rules.leave_unrelated_alone.passed, true);
  assert.equal(passing.rules.do_not_over_ask.rate, 0);
  // One guess, or one resolved trial too few, keeps follow-ups switched off.
  assert.equal(summarizeRules([...several(29), ...base]).follow_ups_ship, false);
  assert.equal(summarizeRules([...several(30), ...trials("one_referent", 26, 30), ...base.slice(30)]).follow_ups_ship, false);
  // Rule 4 counts one-referent, unrelated and standalone trials together: 7 of 60 asking which one is past 10%, and is
  // reported for the founder, not a ship gate; 6 of 60 is within it.
  const overAsked = summarizeRules([...several(30), ...trials("one_referent", 27, 30, 7), ...trials("unrelated", 15, 15), ...trials("standalone", 15, 15)]);
  assert.deepEqual([overAsked.rules.do_not_over_ask.clarify_trials, overAsked.rules.do_not_over_ask.trials], [7, 60]);
  assert.deepEqual([overAsked.rules.do_not_over_ask.passed, overAsked.follow_ups_ship, overAsked.founder_review], [false, true, true]);
  assert.equal(summarizeRules([...several(30), ...trials("one_referent", 27, 30, 6), ...trials("unrelated", 15, 15), ...trials("standalone", 15, 15)]).rules.do_not_over_ask.passed, true);
});
