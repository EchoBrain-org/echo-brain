import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { evaluateRehearsal } from "../evaluate-rehearsal.mjs";

const demo = resolve(import.meta.dirname, "..");
const expectations = JSON.parse(readFileSync(resolve(demo, "expectations.json"), "utf8"));
const meetingNames = readdirSync(resolve(demo, "meetings")).filter((name) => name.endsWith(".json")).sort();
const meetingDocuments = meetingNames.map((name) => ({
  path: resolve(demo, "meetings", name),
  document: JSON.parse(readFileSync(resolve(demo, "meetings", name), "utf8"))
}));
const expectedInputPaths = meetingNames.map((name) => resolve(demo, "meetings", name));
const cardFields = [
  "meeting title",
  "decision, action, and rationale text",
  "action dates",
  "evidence excerpt or block reference",
  "Only me and Team policy choices",
  "Approve and Reject controls",
  "raw transcript and rejected suggestions are not released"
];

// Handwritten synthetic spans exercise only the capture contract, not product quality.
const spans = {
  "capacity-duration": "The implementation pod must be reserved through September 16.",
  "preferred-contact-deadline": "Send the preferred escalation details on August 26 (the source meeting's today).",
  "promise-limit": "Do not promise all 28 locations for September 16.",
  "conditional-window": "September 16 is a conditional onboarding window for the first 10 locations.",
  "signed-addendum": "Before production access, the revised data-processing addendum must be signed.",
  "verified-security-contact": "Before production access, the named security contact must be verified.",
  "readiness-review": "Confirm implementation readiness, data-handling status and the location list at the September 12 review before confirming the onboarding window.",
  "adoption-gate": "Later expansion requires at least 8 of the first 10 locations to complete four consecutive weekly workflows without manual correction.",
  "capacity-rationale": "There is no operating plan to staff all 28 locations yet; full-launch wording would lose its qualification when repeated.",
  "wording-deadline": "Corrected customer wording is due September 3.",
  "location-list-deadline": "Confirm the first 10 locations by September 4.",
  "capacity-deadline": "Reserve the implementation pod and send capacity assumptions by September 4.",
  "addendum-deadline": "Send the revised addendum by September 5.",
  "security-deadline": "Verify the named security contact and escalation route by September 8.",
  "dashboard-deadline": "Publish the adoption dashboard by September 11 with workflow completion by location, consecutive-week counts and manual corrections.",
  "expansion-review": "Review expansion only after the four-week adoption evidence exists, not before the September 16 onboarding window.",
  "adoption-rationale": "Initial logins can reflect training or curiosity; repeated workflows demonstrate durable adoption before a broader commitment.",
  "evaluation-price": "$22 per location.",
  "price-scope": "The price covers the first 10 locations only.",
  "evaluation-term": "It is a 30-day evaluation only.",
  "pricing-follow-on": "Standard pricing resumes afterward unless Finance approves a new exception."
};
const pair = { record_generation_id: "generation-1", release_head: "db5153e-synthetic-release" };
const heroId = "after-team-approval-rollout-question";

function passingResult() {
  const meetings = expectations.meeting_expectations;
  const records = meetings.map((meeting, index) => ({
    meeting_id: meeting.meeting_id,
    record_id: `v4-record-${index + 1}`,
    approved: true,
    publication: "approved_v4_reconciled",
    policy: meeting.approval_policy
  }));
  const answers = expectations.retrieval_cases.map((expected) => {
    const claims = expected.material_group_ids.map((group_id) => ({
      group_id,
      outcome: "answered",
      observed_text: spans[group_id],
      citation_meeting_ids: [...expectations.answer_groups.find((group) => group.id === group_id).allowed_source_meeting_ids]
    }));
    return {
      case_id: expected.id,
      principal: expected.principal,
      approval_state: expected.approval_state,
      outcome: expected.expected_outcome,
      answer_text: claims.length ? claims.map((claim) => claim.observed_text).join(" ") : "Insufficient accessible evidence to answer this question.",
      citation_meeting_ids: [...expected.required_citation_meeting_ids],
      retrieved_record_ids: records.filter((record) => expected.required_citation_meeting_ids.includes(record.meeting_id)).map((record) => record.record_id),
      fixture_only_atom_ids: [],
      claims,
      ...pair
    };
  });
  return {
    schema_version: 1,
    document_type: "echo-synthetic-customer-demo-rehearsal-result",
    scenario_id: expectations.scenario.id,
    source_identity: expectations.source_identity,
    operator_checks: {
      natural_attributed_dialogue: true,
      expectations_external_only: true,
      correct_owner_private_dm: true,
      approval_card_complete: true,
      answer_identities_verified: true
    },
    runtime_input_paths: expectedInputPaths,
    intake: meetings.map((meeting) => ({ meeting_id: meeting.meeting_id, canonical_validation_passed: true, canonical_schema_version: 1 })),
    slack_cards: meetings.map((meeting) => ({ meeting_id: meeting.meeting_id, delivery_surface: "private_dm_only", displayed_fields: cardFields })),
    approved_decisions: meetings.flatMap((meeting) => meeting.required_decisions.map((decision) => ({
      meeting_id: meeting.meeting_id,
      status: "decided",
      evidence_block_ids: [...decision.evidence_block_ids, "additional-supporting-evidence"]
    }))),
    approved_records: records,
    answers,
    determinism: answers.filter((answer) => answer.outcome === "answered").map((answer) => ({
      case_id: answer.case_id,
      ...pair,
      trials: Array.from({ length: answer.case_id === heroId ? 6 : 2 }, (_, index) => ({ ...structuredClone(answer), trial_id: `trial-${index + 1}` }))
    }))
  };
}

test("passes a complete captured rehearsal", () => {
  const report = evaluateRehearsal(passingResult(), expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.equal(report.checks.length, 15);
  assert.equal(report.repeatability.length, 22);
  assert.ok(report.repeatability.every((run) => run.stable && run.unavailable_count === 0));
});

test("rejects a duplicate captured case instead of selecting the first answer", () => {
  const result = passingResult();
  result.answers.push(structuredClone(result.answers[1]));
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
});

test("scripted Ask ECHO questions fit the 32-term public contract", () => {
  for (const { id, question } of expectations.retrieval_cases) {
    const terms = new Set(
      (question.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
        term.toLowerCase().normalize("NFC")
      )
    );
    assert.ok(terms.size >= 1 && terms.size <= 32, `${id} has ${terms.size} unique terms`);
  }
});

test("fails closed when required evidence is missing", () => {
  const result = passingResult();
  result.determinism[0].trials.pop();
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "14")?.passed, false);
});

test("keeps action assignment outside the demo oracle", () => {
  for (const meeting of expectations.meeting_expectations) {
    for (const action of meeting.required_actions) {
      assert.equal("owner_participant_id" in action, false);
      assert.equal(typeof action.due_date, "string");
    }
  }
});

test("fails when a required decision has incomplete evidence or is not decided", () => {
  const result = passingResult();
  const decision = result.approved_decisions[0];
  decision.evidence_block_ids = [];
  decision.status = "proposed";
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "06")?.passed, false);
});

test("fails when a private price answer cites a record for a team member", () => {
  const result = passingResult();
  const answerCapture = result.answers.find((item) => item.case_id === "team-member-private-price-question");
  answerCapture.citation_meeting_ids = [expectations.meeting_expectations[3].meeting_id];
  answerCapture.retrieved_record_ids = ["v4-record-4"];
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "11")?.passed, false);
});

test("fails when a mapped fact is not present in the captured answer", () => {
  const result = passingResult();
  result.answers.find((item) => item.case_id === "after-team-approval-rollout-question").claims[0].observed_text = "a fact absent from the answer";
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "08")?.passed, false);
});

test("fails when one unrelated answer fragment is mapped to every fact with case-wide citations", () => {
  const result = passingResult();
  const answerCapture = result.answers.find((item) => item.case_id === "after-team-approval-rollout-question");
  answerCapture.answer_text = "Echo has an approved rollout plan.";
  answerCapture.claims = answerCapture.claims.map((claim) => ({
    ...claim,
    observed_text: "Echo has an approved rollout plan.",
    citation_meeting_ids: answerCapture.citation_meeting_ids
  }));
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "08")?.passed, false);
});

test("fails when a team answer retrieves the Only-me record", () => {
  const result = passingResult();
  result.answers.find((item) => item.case_id === "after-team-approval-rollout-question").retrieved_record_ids.push("v4-record-4");
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "10")?.passed, false);
});

test("fails when the private answer is not captured from the exact approver", () => {
  const result = passingResult();
  result.answers.find((item) => item.case_id === "approver-private-price-question").principal = "normal_team_member";
  const report = evaluateRehearsal(result, expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "12")?.passed, false);
});

function evaluate(result, oracle = expectations) {
  return evaluateRehearsal(result, oracle, meetingDocuments, { expectedInputPaths });
}

function rejects(result, checkId, oracle = expectations) {
  const report = evaluate(result, oracle);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((check) => check.id === checkId)?.passed, false, JSON.stringify(report));
  return report;
}

function capture(result, id = heroId) {
  return result.answers.find((answer) => answer.case_id === id);
}

function syncTrials(result, id) {
  const run = result.determinism.find((run) => run.case_id === id);
  run.trials = run.trials.map((trial) => ({ ...structuredClone(capture(result, id)), trial_id: trial.trial_id }));
}

const heroDeadlineGroups = [
  "wording-deadline",
  "location-list-deadline",
  "capacity-deadline",
  "addendum-deadline",
  "security-deadline",
  "dashboard-deadline",
  "expansion-review"
];

for (const id of [heroId, `${heroId}-paraphrase-1`, `${heroId}-paraphrase-2`]) {
  test(`${id} rejects an answer that omits all remaining-work deadlines`, () => {
    const result = passingResult();
    const answer = capture(result, id);
    for (const groupId of heroDeadlineGroups) {
      const claim = answer.claims.find((item) => item.group_id === groupId);
      if (!claim) continue;
      answer.answer_text = answer.answer_text.replace(claim.observed_text, "");
      answer.claims = answer.claims.filter((item) => item !== claim);
    }
    syncTrials(result, id);
    rejects(result, "09");
  });
}

for (const mutation of ["missing", "unexpected", "duplicate", "replaced"]) {
  test(`rejects ${mutation} captured case inventory`, () => {
    const result = passingResult();
    if (mutation === "missing") result.answers.pop();
    if (mutation === "unexpected") result.answers.push({ ...structuredClone(result.answers[1]), case_id: "unexpected" });
    if (mutation === "duplicate") result.answers.push(structuredClone(result.answers[1]));
    if (mutation === "replaced") result.answers[0] = structuredClone(result.answers[1]);
    rejects(result, "15");
  });
}

for (const expected of expectations.retrieval_cases.filter((item) => item.expected_outcome === "answered")) {
  test(`${expected.id} rejects every omitted material group and phrase`, () => {
    for (const groupId of expected.material_group_ids) {
      const result = passingResult();
      const answer = capture(result, expected.id);
      const missing = answer.claims.find((claim) => claim.group_id === groupId);
      answer.claims = answer.claims.filter((claim) => claim !== missing);
      answer.answer_text = answer.answer_text.replace(missing.observed_text, "");
      syncTrials(result, expected.id);
      rejects(result, "09");
      const group = expectations.answer_groups.find((group) => group.id === groupId);
      for (const phrase of group.required_phrases) {
        const result = passingResult();
        const answer = capture(result, expected.id);
        const claim = answer.claims.find((claim) => claim.group_id === groupId);
        const partial = claim.observed_text.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "[omitted]");
        answer.answer_text = answer.answer_text.replace(claim.observed_text, partial);
        claim.observed_text = partial;
        syncTrials(result, expected.id);
        rejects(result, "09");
      }
    }
  });
}

for (const mutation of ["duplicate", "unknown", "unmapped", "missing span", "same span", "case-wide citations", "wrong source", "missing source", "duplicate source"]) {
  test(`rejects group evidence with ${mutation}`, () => {
    const result = passingResult();
    const answer = capture(result);
    const claim = answer.claims[0];
    if (mutation === "duplicate") answer.claims[1] = structuredClone(claim);
    if (mutation === "unknown") claim.group_id = "unknown-group";
    if (mutation === "unmapped") claim.group_id = "evaluation-price";
    if (mutation === "missing span") claim.observed_text = "absent span";
    if (mutation === "same span") for (const group of answer.claims) group.observed_text = answer.answer_text;
    if (mutation === "case-wide citations") claim.citation_meeting_ids = [...answer.citation_meeting_ids];
    if (mutation === "wrong source") claim.citation_meeting_ids = [expectations.meeting_expectations[0].meeting_id];
    if (mutation === "missing source") claim.citation_meeting_ids = [];
    if (mutation === "duplicate source") claim.citation_meeting_ids.push(claim.citation_meeting_ids[0]);
    syncTrials(result, heroId);
    rejects(result, "09");
  });
}

for (const field of ["material_group_ids", "required_citation_meeting_ids", "principal", "approval_state", "expected_outcome", "must_not_reveal", "primary_case_id"]) {
  test(`rejects a paraphrase oracle that changes ${field}`, () => {
    const oracle = structuredClone(expectations);
    const paraphrase = oracle.retrieval_cases.find((item) => item.id !== item.primary_case_id);
    if (Array.isArray(paraphrase[field])) paraphrase[field].pop();
    else paraphrase[field] = "changed";
    rejects(passingResult(), "15", oracle);
  });
}

for (const mutation of ["duplicate group", "unknown group", "duplicate mapping", "duplicate case", "bad category", "empty checks", "invalid source", "missing insufficient policy"]) {
  test(`rejects malformed oracle: ${mutation}`, () => {
    const oracle = structuredClone(expectations);
    if (mutation === "duplicate group") oracle.answer_groups.push(structuredClone(oracle.answer_groups[0]));
    if (mutation === "unknown group") oracle.retrieval_cases[1].material_group_ids[0] = "unknown";
    if (mutation === "duplicate mapping") oracle.retrieval_cases[1].material_group_ids.push(oracle.retrieval_cases[1].material_group_ids[0]);
    if (mutation === "duplicate case") oracle.retrieval_cases.push(structuredClone(oracle.retrieval_cases[0]));
    if (mutation === "bad category") oracle.answer_groups[0].category = "anything";
    if (mutation === "empty checks") oracle.answer_groups[0].required_phrases = [];
    if (mutation === "invalid source") oracle.answer_groups[0].allowed_source_meeting_ids = ["unknown"];
    if (mutation === "missing insufficient policy") delete oracle.answer_groups[0].allow_insufficient;
    rejects(passingResult(), "15", oracle);
  });
}

for (const caseId of ["before-approval-rollout-question", "team-member-private-price-question"]) {
  for (const mutation of ["citation", "retrieval", "price", "scope", "term", "follow-on", "existence hint", "claim", "outcome", "approval state"]) {
    test(`${caseId} rejects ${mutation}`, () => {
      const result = passingResult();
      const answer = capture(result, caseId);
      const disclosures = { price: "$22", scope: "first 10 locations", term: "30 days", "follow-on": "standard pricing", "existence hint": "A private record exists, but you cannot access it." };
      if (mutation === "citation") answer.citation_meeting_ids.push(expectations.meeting_expectations[3].meeting_id);
      if (mutation === "retrieval") answer.retrieved_record_ids.push("v4-record-4");
      if (mutation in disclosures) answer.answer_text += ` ${disclosures[mutation]}`;
      if (mutation === "claim") answer.claims.push(structuredClone(capture(result).claims[0]));
      if (mutation === "outcome") answer.outcome = "answered";
      if (mutation === "approval state") answer.approval_state = expectations.retrieval_cases[1].approval_state;
      rejects(result, "09");
    });
  }
}

test("corrects an accessible false premise and accepts neutral supporting wording with evidence", () => {
  const result = passingResult();
  assert.equal(evaluate(result).passed, true);
  for (const id of ["confirmed-launch-premise-question", "safe-commitment-question", "first-10-prerequisites-question"]) {
    for (const text of ["Yes, all 28 locations are confirmed for September 16.", "Insufficient accessible evidence to answer this question."]) {
      const modified = structuredClone(result);
      const answer = capture(modified, id);
      answer.answer_text = text;
      answer.outcome = text.startsWith("Yes") ? "answered" : "insufficient_approved_information";
      syncTrials(modified, id);
      rejects(modified, "09");
    }
  }
  const assent = structuredClone(result);
  capture(assent, "confirmed-launch-premise-question").answer_text += " Yes, all 28 locations are confirmed.";
  rejects(assent, "09");
});

test("allows an explicit group-level insufficiency only when the oracle permits it", () => {
  const result = passingResult();
  const id = "approver-private-price-question";
  const claim = capture(result, id).claims[0];
  const prior = claim.observed_text;
  claim.outcome = "insufficient_approved_information";
  claim.observed_text = "Insufficient accessible evidence to establish the evaluation price.";
  claim.citation_meeting_ids = [];
  capture(result, id).answer_text = capture(result, id).answer_text.replace(prior, claim.observed_text);
  syncTrials(result, id);
  rejects(result, "09");
  const oracle = structuredClone(expectations);
  const group = oracle.answer_groups.find((item) => item.id === claim.group_id);
  group.allow_insufficient = true;
  group.insufficient_answer = claim.observed_text;
  assert.equal(evaluate(result, oracle).passed, true);
  claim.observed_text = "I cannot answer.";
  rejects(result, "09", oracle);
});

for (const mutation of ["missing case", "duplicate case", "unexpected case", "duplicate trial", "missing pair", "generation", "head", "run generation", "run head", "capture head", "outcome", "text", "groups", "citations", "records", "trial case", "trial principal", "trial approval"]) {
  test(`rejects repeatability evidence with changed or missing ${mutation}`, () => {
    const result = passingResult();
    const run = result.determinism.at(-1); // Supporting paraphrases receive the same proof as the hero.
    const trial = run.trials[0];
    if (mutation === "missing case") result.determinism.pop();
    if (mutation === "duplicate case") result.determinism.push(structuredClone(run));
    if (mutation === "unexpected case") result.determinism.push({ ...structuredClone(run), case_id: "unknown" });
    if (mutation === "duplicate trial") run.trials[1].trial_id = trial.trial_id;
    if (mutation === "missing pair") delete trial.record_generation_id;
    if (mutation === "generation") trial.record_generation_id = "generation-2";
    if (mutation === "head") trial.release_head = "release-2";
    if (mutation === "run generation") run.record_generation_id = "generation-2";
    if (mutation === "run head") run.release_head = "release-2";
    if (mutation === "capture head") capture(result, run.case_id).release_head = "release-2";
    if (mutation === "outcome") trial.outcome = "insufficient_approved_information";
    if (mutation === "text") trial.answer_text += " A different answer.";
    if (mutation === "groups") trial.claims.pop();
    if (mutation === "citations") trial.citation_meeting_ids.pop();
    if (mutation === "records") trial.retrieved_record_ids = ["unapproved-record"];
    if (mutation === "trial case") trial.case_id = heroId;
    if (mutation === "trial principal") trial.principal = "exact_owner_approver";
    if (mutation === "trial approval") trial.approval_state = "no meeting approved";
    rejects(result, "13");
  });
}

test("does not demand byte-identical answers across different paraphrases or case-wide generations", () => {
  const result = passingResult();
  const answer = capture(result, `${heroId}-paraphrase-1`);
  answer.answer_text += " Those are the approved limits.";
  answer.release_head = "another-release";
  answer.record_generation_id = "another-generation";
  const run = result.determinism.find((run) => run.case_id === answer.case_id);
  Object.assign(run, { release_head: answer.release_head, record_generation_id: answer.record_generation_id });
  syncTrials(result, answer.case_id);
  assert.equal(evaluate(result).passed, true);
});

function unavailable(trialId) {
  return { trial_id: trialId, ...pair, outcome: "unavailable", http_status: 503, reason_code: "unavailable" };
}

test("reports all attempts and 503 reasons separately from a stable successful subset", () => {
  const result = passingResult();
  result.determinism[0].trials.unshift(unavailable("outage-1"), unavailable("outage-2"));
  const report = evaluate(result);
  assert.equal(report.passed, true);
  assert.deepEqual(report.repeatability[0], {
    case_id: heroId, trial_count: 8, success_count: 6, unavailable_count: 2, status_503_count: 2,
    reason_counts: { unavailable: 2 }, stable: true
  });
});

test("an unavailable attempt interrupts the required consecutive hero proof", () => {
  const result = passingResult();
  result.determinism[0].trials.splice(3, 0, unavailable("outage"));
  const report = rejects(result, "14");
  assert.equal(report.repeatability[0].unavailable_count, 1);
  assert.equal(report.repeatability[0].stable, true);
});

test("unavailable attempts cannot replace successful repeatability evidence", () => {
  const result = passingResult();
  result.determinism[1].trials = [unavailable("one"), unavailable("two")];
  const report = rejects(result, "13");
  assert.equal(report.repeatability[1].success_count, 0);
  assert.equal(report.repeatability[1].unavailable_count, 2);
});

for (const mutation of ["status", "reason", "pair", "answer evidence"]) {
  test(`rejects unavailable trial with invalid ${mutation}`, () => {
    const result = passingResult();
    const trial = unavailable("outage");
    if (mutation === "status") trial.http_status = 200;
    if (mutation === "reason") trial.reason_code = "private answer content";
    if (mutation === "pair") trial.record_generation_id = "changed";
    if (mutation === "answer evidence") trial.answer_text = "private answer content";
    result.determinism[0].trials.unshift(trial);
    const report = rejects(result, "13");
    assert.ok(!JSON.stringify(report).includes("private answer content"));
  });
}

test("distinguishes missing retrieval evidence from omitted answer groups without claiming context absence", () => {
  const missingRecord = passingResult();
  capture(missingRecord).retrieved_record_ids = [];
  rejects(missingRecord, "10");
  const omission = passingResult();
  capture(omission).claims.pop();
  const report = rejects(omission, "09");
  assert.equal(report.checks.find((check) => check.id === "10").passed, true);
  assert.ok(!JSON.stringify(report).includes("context_absent"));
});

for (const field of ["claims", "citation_meeting_ids", "retrieved_record_ids", "answer_text"]) {
  test(`fails closed without logging malformed ${field}`, () => {
    const result = passingResult();
    capture(result)[field] = { private: "DO_NOT_LOG_CAPTURE_CONTENT" };
    const report = rejects(result, "09");
    assert.ok(!JSON.stringify(report).includes("DO_NOT_LOG_CAPTURE_CONTENT"));
  });
}

test("the captured-result CLI returns failure without printing answer content", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "echo-rehearsal-test-"));
  try {
    const result = passingResult();
    capture(result).answer_text = "DO_NOT_LOG_CAPTURE_CONTENT";
    const path = resolve(directory, "result.json");
    writeFileSync(path, JSON.stringify(result));
    const child = spawnSync(process.execPath, [resolve(demo, "evaluate-rehearsal.mjs"), "--result", path], { encoding: "utf8" });
    assert.equal(child.status, 1);
    assert.match(child.stdout, /FAIL 09/);
    assert.ok(!(child.stdout + child.stderr).includes("DO_NOT_LOG_CAPTURE_CONTENT"));
    writeFileSync(path, '{"answer_text": DO_NOT_LOG_CAPTURE_CONTENT}');
    const malformed = spawnSync(process.execPath, [resolve(demo, "evaluate-rehearsal.mjs"), "--result", path], { encoding: "utf8" });
    assert.equal(malformed.status, 1);
    assert.ok(!(malformed.stdout + malformed.stderr).includes("DO_NOT_LOG_CAPTURE_CONTENT"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the existing required CI check job runs this Node suite without masking failures", () => {
  const workflow = readFileSync(resolve(demo, "../.github/workflows/ci.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  check:"), workflow.indexOf("  person-client-package:"));
  assert.match(job, /^        run: node --test demo\/test\/rehearsal-evaluator\.test\.mjs$/m);
  assert.doesNotMatch(job, /continue-on-error:|if:/);
  assert.match(workflow, /needs: \[check,/);
  assert.ok(workflow.includes('test "$CHECK_RESULT" = success'));
});

test("reports context absence only from captured content-free counts, independently of missing groups", () => {
  for (const contextCount of [undefined, 0, 2]) {
    const result = passingResult();
    const answer = capture(result);
    const omitted = answer.claims.pop();
    if (contextCount !== undefined) answer.retrieval = { released_atom_count: 3, context_atom_count: contextCount };
    const report = rejects(result, "09");
    assert.deepEqual(report.coverage.find((item) => item.case_id === heroId), {
      case_id: heroId,
      context_state: contextCount === undefined ? "not_captured" : contextCount === 0 ? "empty" : "nonempty",
      missing_group_ids: [omitted.group_id]
    });
  }
  const result = passingResult();
  capture(result).retrieval = { released_atom_count: 3, context_atom_count: 2 };
  assert.equal(evaluate(result).passed, true);
});

for (const counts of [{ released_atom_count: 1, context_atom_count: 2 }, { released_atom_count: -1, context_atom_count: 0 }, { released_atom_count: 2, context_atom_count: "private" }]) {
  test(`rejects contradictory or malformed content-free counts ${JSON.stringify(counts)}`, () => {
    const result = passingResult();
    capture(result).retrieval = counts;
    rejects(result, "09");
  });
}

test("counts unavailable attempts even after malformed successful evidence", () => {
  const result = passingResult();
  const run = result.determinism[0];
  run.trials[0].claims = null;
  run.trials.push(unavailable("outage"));
  const report = rejects(result, "13");
  assert.equal(report.repeatability[0].trial_count, 7);
  assert.equal(report.repeatability[0].success_count, 6);
  assert.equal(report.repeatability[0].unavailable_count, 1);
  assert.equal(report.repeatability[0].status_503_count, 1);
});

test("does not accept free text disguised as a symbolic unavailable reason", () => {
  const result = passingResult();
  result.determinism[0].trials.push({ ...unavailable("outage"), reason_code: "the_private_price_is_22" });
  const report = rejects(result, "13");
  assert.ok(!JSON.stringify(report).includes("the_private_price_is_22"));
});

test("a changed paraphrase group source fails even with unchanged answer-level citations", () => {
  const result = passingResult();
  const answer = capture(result, `${heroId}-paraphrase-1`);
  answer.claims[0].citation_meeting_ids = [expectations.meeting_expectations[0].meeting_id];
  syncTrials(result, answer.case_id);
  rejects(result, "09");
});

for (const text of [
  "The implementation pod is reserved through September 16.",
  "The implementation pod has been reserved through September 16.",
  "The preferred escalation details were sent on August 26.",
]) {
  test(`rejects a completed-state claim unsupported by the assigned actions: ${text}`, () => {
    const result = passingResult();
    capture(result, "safe-commitment-question").answer_text += ` ${text}`;
    syncTrials(result, "safe-commitment-question");
    rejects(result, "09");
  });
}

test("requires independent capacity duration and preferred-contact deadline groups", () => {
  for (const id of [heroId, "remaining-work-question", "approved-commitments-question"]) {
    const expected = expectations.retrieval_cases.find((item) => item.id === id);
    assert.ok(expected, `${id} must have a captured case`);
    for (const group of ["capacity-duration", "preferred-contact-deadline"]) {
      assert.ok(expected.material_group_ids.includes(group), `${id} must include ${group}`);
    }
  }
});

test("does not map overlapping answer text to independent task/deadline groups", () => {
  const result = passingResult();
  const answer = capture(result);
  const security = answer.claims.find((claim) => claim.group_id === "security-deadline");
  const addendum = answer.claims.find((claim) => claim.group_id === "addendum-deadline");
  addendum.observed_text += ` ${security.observed_text}`;
  syncTrials(result, heroId);
  rejects(result, "09");
});

test("rejects private retrieval for an owner who is not the exact private approver", () => {
  const result = passingResult();
  // This is a synthetic authorization mutation, not an extra live persona in
  // the documented team-member rehearsal.
  const oracle = structuredClone(expectations);
  for (const expected of oracle.retrieval_cases.filter((item) => item.primary_case_id === "approved-commitments-question")) {
    expected.principal = "organization_owner_without_private_approval";
    capture(result, expected.id).principal = expected.principal;
    syncTrials(result, expected.id);
  }
  assert.equal(evaluate(result, oracle).passed, true);
  capture(result, "approved-commitments-question").retrieved_record_ids.push("v4-record-4");
  rejects(result, "10", oracle);
});

test("rejects comprehensive-summary abstention and preferred-contact deadline conflation", () => {
  const abstention = passingResult();
  const summary = capture(abstention, "approved-commitments-question");
  Object.assign(summary, { outcome: "insufficient_approved_information", answer_text: "Insufficient accessible evidence to answer this question.", claims: [], citation_meeting_ids: [] });
  syncTrials(abstention, summary.case_id);
  rejects(abstention, "09");
  const conflated = passingResult();
  const answer = capture(conflated, "remaining-work-question");
  const claim = answer.claims.find((item) => item.group_id === "preferred-contact-deadline");
  const text = "Send the preferred escalation details by September 8.";
  answer.answer_text = answer.answer_text.replace(claim.observed_text, text);
  claim.observed_text = text;
  syncTrials(conflated, answer.case_id);
  rejects(conflated, "09");
});

for (const contextCount of [undefined, 0, 1]) {
  test(`unsupported control accepts irrelevant Team retrieval with context count ${contextCount}`, () => {
    const result = passingResult();
    const answer = capture(result, "unsupported-question");
    answer.retrieved_record_ids = ["v4-record-1"];
    if (contextCount !== undefined) answer.retrieval = { released_atom_count: 1, context_atom_count: contextCount };
    const report = evaluate(result);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.deepEqual(report.coverage.find((item) => item.case_id === answer.case_id), {
      case_id: answer.case_id,
      context_state: contextCount === undefined ? "not_captured" : contextCount === 0 ? "empty" : "nonempty",
      missing_group_ids: [],
    });
  });
}

test("summary captures follow the documented team-member rehearsal persona", () => {
  const queries = readFileSync(resolve(demo, "QUERIES.md"), "utf8");
  assert.match(queries, /Queries 1-4 are asked by Audrey\s+Ortiz, the team-member persona/);
  const result = passingResult();
  const cases = expectations.retrieval_cases.filter((item) => item.primary_case_id === "approved-commitments-question");
  assert.equal(cases.length, 3);
  const documentedQuestion = queries.slice(queries.indexOf("### 4."), queries.indexOf("### 5.")).replace(/^> /gm, "").replace(/\s+/g, " ");
  assert.ok(documentedQuestion.includes(cases[0].question));
  for (const expected of cases) {
    capture(result, expected.id).principal = "normal_team_member";
    syncTrials(result, expected.id);
  }
  const report = evaluate(result);
  assert.equal(report.passed, true, JSON.stringify(report));
});

test("unsupported control permits each declared Team meeting without answer facts or citations", () => {
  const result = passingResult();
  const answer = capture(result, "unsupported-question");
  answer.retrieved_record_ids = ["v4-record-1", "v4-record-2", "v4-record-3"];
  answer.retrieval = { released_atom_count: 3, context_atom_count: 3 };
  assert.equal(evaluate(result).passed, true);
});

for (const mutation of ["private record", "unapproved record", "undeclared Team record", "citation", "claim", "disclosure", "nonneutral text", "missing record provenance", "zero count", "capture allowance"]) {
  test(`unsupported control still rejects ${mutation}`, () => {
    const result = passingResult();
    const oracle = structuredClone(expectations);
    const expected = oracle.retrieval_cases.find((item) => item.id === "unsupported-question");
    const answer = capture(result, expected.id);
    answer.retrieved_record_ids = ["v4-record-1"];
    answer.retrieval = { released_atom_count: 1, context_atom_count: 1 };
    let check = "09";
    if (mutation === "private record" || mutation === "capture allowance") {
      answer.retrieved_record_ids = ["v4-record-4"];
      check = "10";
      if (mutation === "capture allowance") answer.neutral_retrieval_meeting_ids = [expectations.meeting_expectations[3].meeting_id];
    }
    if (mutation === "unapproved record") { answer.retrieved_record_ids = ["unknown-record"]; check = "10"; }
    if (mutation === "undeclared Team record") { expected.neutral_retrieval_meeting_ids = [expectations.meeting_expectations[1].meeting_id]; check = "10"; }
    if (mutation === "citation") answer.citation_meeting_ids = [expectations.meeting_expectations[0].meeting_id];
    if (mutation === "claim") answer.claims = [structuredClone(capture(result).claims[0])];
    if (mutation === "disclosure") answer.answer_text += " A private price exists.";
    if (mutation === "nonneutral text") answer.answer_text = "No schedule was agreed.";
    if (mutation === "missing record provenance") answer.retrieved_record_ids = [];
    if (mutation === "zero count") answer.retrieval = { released_atom_count: 0, context_atom_count: 0 };
    rejects(result, check, oracle);
  });
}

for (const id of ["before-approval-rollout-question", "team-member-private-price-question"]) {
  test(`${id} retains its strict empty-retrieval expectation`, () => {
    const result = passingResult();
    const answer = capture(result, id);
    answer.retrieved_record_ids = ["v4-record-1"];
    answer.retrieval = { released_atom_count: 1, context_atom_count: 1 };
    rejects(result, "09");
  });
}

for (const allowance of [null, "any", ["unknown"], [expectations.meeting_expectations[3].meeting_id], [expectations.meeting_expectations[0].meeting_id, expectations.meeting_expectations[0].meeting_id]]) {
  test(`rejects a malformed or non-Team neutral retrieval allowance: ${JSON.stringify(allowance)}`, () => {
    const oracle = structuredClone(expectations);
    oracle.retrieval_cases.find((item) => item.id === "unsupported-question").neutral_retrieval_meeting_ids = allowance;
    rejects(passingResult(), "15", oracle);
  });
}

test("rejects a neutral retrieval allowance on an answered case", () => {
  const oracle = structuredClone(expectations);
  oracle.retrieval_cases.find((item) => item.id === heroId).neutral_retrieval_meeting_ids = [expectations.meeting_expectations[0].meeting_id];
  rejects(passingResult(), "15", oracle);
});

test("a neutral paraphrase cannot change the primary retrieval allowance", () => {
  const result = passingResult();
  const oracle = structuredClone(expectations);
  const primary = oracle.retrieval_cases.find((item) => item.id === "unsupported-question");
  const id = "unsupported-question-paraphrase";
  oracle.retrieval_cases.push({ ...structuredClone(primary), id, question: "When is the unrelated customer's rollout?", neutral_retrieval_meeting_ids: [] });
  result.answers.push({ ...structuredClone(capture(result, primary.id)), case_id: id });
  rejects(result, "15", oracle);
});
