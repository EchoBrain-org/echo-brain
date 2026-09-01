import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

function answer(caseId, answerText, citations, recordIds, claims = []) {
  const expected = expectations.retrieval_cases.find((item) => item.id === caseId);
  return { case_id: caseId, principal: expected.principal, outcome: claims.length ? "answered" : "insufficient_approved_information", answer_text: answerText, citation_meeting_ids: citations, retrieved_record_ids: recordIds, fixture_only_atom_ids: [], claims };
}

function passingResult() {
  const meetings = expectations.meeting_expectations;
  const records = meetings.map((meeting, index) => ({
    meeting_id: meeting.meeting_id,
    record_id: `v4-record-${index + 1}`,
    approved: true,
    publication: "approved_v4_reconciled",
    policy: meeting.approval_policy
  }));
  const recordIds = records.map((record) => record.record_id);
  const rollout = expectations.retrieval_cases[1];
  const price = expectations.retrieval_cases[3];
  const rolloutClaims = rollout.required_answer_facts.map((_, fact_index) => ({
    fact_index,
    observed_text: `observed rollout fact ${fact_index}`,
    citation_meeting_ids: rollout.required_answer_fact_checks[fact_index].required_citation_meeting_ids
  }));
  const rolloutText = rollout.required_answer_facts.join(" ");
  const priceText = price.required_answer_facts.join(" ");
  for (const claim of rolloutClaims) claim.observed_text = rollout.required_answer_facts[claim.fact_index];
  const priceClaims = price.required_answer_facts.map((fact, fact_index) => ({
    fact_index,
    observed_text: fact,
    citation_meeting_ids: price.required_answer_fact_checks[fact_index].required_citation_meeting_ids
  }));
  const rolloutTrial = { answer_text: rolloutText, citation_meeting_ids: rollout.required_citation_meeting_ids, retrieved_record_ids: recordIds.slice(0, 3) };
  const priceTrial = { answer_text: priceText, citation_meeting_ids: price.required_citation_meeting_ids, retrieved_record_ids: [recordIds[3]] };
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
    answers: [
      answer("before-approval-rollout-question", "Insufficient accessible evidence to answer this question.", [], []),
      answer(rollout.id, rolloutText, rollout.required_citation_meeting_ids, recordIds.slice(0, 3), rolloutClaims),
      answer("team-member-private-price-question", "Insufficient accessible evidence to answer this question.", [], []),
      answer(price.id, priceText, price.required_citation_meeting_ids, [recordIds[3]], priceClaims)
    ],
    determinism: [
      { case_id: rollout.id, record_generation_id: "generation-1", trials: Array.from({ length: 6 }, () => ({ ...rolloutTrial })) },
      { case_id: price.id, record_generation_id: "generation-1", trials: [{ ...priceTrial }, { ...priceTrial }] }
    ]
  };
}

test("passes a complete captured rehearsal", () => {
  const report = evaluateRehearsal(passingResult(), expectations, meetingDocuments, { expectedInputPaths });
  assert.equal(report.passed, true, JSON.stringify(report, null, 2));
  assert.equal(report.checks.length, 14);
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
  answerCapture.answer_text = "Northstar has an approved rollout plan.";
  answerCapture.claims = answerCapture.claims.map((claim) => ({
    ...claim,
    observed_text: "Northstar has an approved rollout plan.",
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
