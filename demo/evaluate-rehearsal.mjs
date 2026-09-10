#!/usr/bin/env node
/**
 * External-only evaluator for the Echo rehearsal.
 *
 * This file deliberately has no imports from the product runtime. It consumes
 * a captured result after a run and the static expectations oracle.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_EXPECTATIONS = resolve(here, "expectations.json");
const DEFAULT_MEETINGS = resolve(here, "meetings");
const INSUFFICIENT_ANSWER = "Insufficient accessible evidence to answer this question.";
// Existing public unavailable outcome / content-free Layer 4 failure classes.
// Kept external: do not import the runtime to interpret a captured diagnostic.
const UNAVAILABLE_REASONS = new Set([
  "unavailable", "adapter_timeout", "adapter_transport", "adapter_http",
  "adapter_provider_error", "adapter_finish", "adapter_refusal", "adapter_response",
  "adapter_json", "core_validation"
]);
const CARD_FIELDS = [
  "meeting title",
  "decision, action, and rationale text",
  "action dates",
  "evidence excerpt or block reference",
  "Only me and Team policy choices",
  "Approve and Reject controls",
  "raw transcript and rejected suggestions are not released"
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalized(value) {
  return value.toLocaleLowerCase("en-US");
}

function sameStringSet(actual, expected) {
  return strings(actual) && strings(expected) &&
    new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(value) {
  return strings(value) && value.every(nonempty) && new Set(value).size === value.length;
}

function validateAnsweredClaims(require, answer, expected, groups, label) {
  require(Array.isArray(answer?.claims), `${label} claims must be an array`);
  require(answer?.claims?.length === expected.material_group_ids.length, `${label} requires exactly one mapping per material group`);
  const seen = new Set();
  const spans = new Set();
  const ranges = [];
  for (const claim of answer?.claims ?? []) {
    const group = groups.find((item) => item.id === claim?.group_id);
    const mapped = group && expected.material_group_ids.includes(group.id);
    require(mapped, `${label} has an unknown or unmapped group`);
    require(!seen.has(claim?.group_id), `${label} has a duplicate group mapping`);
    seen.add(claim?.group_id);
    if (!mapped) continue;
    const observed = claim?.observed_text;
    require(nonempty(observed), `${label} group ${group.id} lacks observed answer text`);
    require(typeof answer?.answer_text === "string" && nonempty(observed) && answer.answer_text.includes(observed), `${label} group ${group.id} span is absent from the answer`);
    require(!spans.has(observed), `${label} maps one span to multiple groups`);
    spans.add(observed);
    // Independent material groups need separate evidence spans. A broad span
    // containing another task's date must not stand in for that task's mapping.
    if (typeof answer?.answer_text === "string" && nonempty(observed)) {
      const start = answer.answer_text.indexOf(observed);
      const end = start + observed.length;
      require(start >= 0 && ranges.every(([left, right]) => end <= left || start >= right), `${label} group ${group.id} overlaps another material group`);
      if (start >= 0) ranges.push([start, end]);
    }
    if (claim?.outcome === "insufficient_approved_information") {
      require(group.allow_insufficient === true, `${label} group ${group.id} must be answered`);
      require(nonempty(group.insufficient_answer) && observed === group.insufficient_answer, `${label} group ${group.id} lacks its explicit insufficient-evidence statement`);
      require(sameStringSet(claim.citation_meeting_ids, []), `${label} insufficient group has citations`);
    } else {
      require(claim?.outcome === "answered", `${label} group ${group.id} has invalid outcome`);
      for (const phrase of group.required_phrases) require(typeof observed === "string" && normalized(observed).includes(normalized(phrase)), `${label} group ${group.id} lacks a required phrase`);
      require(uniqueStrings(claim?.citation_meeting_ids) && claim.citation_meeting_ids.length > 0, `${label} group ${group.id} lacks unique source provenance`);
      for (const meetingId of claim?.citation_meeting_ids ?? []) {
        require(group.allowed_source_meeting_ids.includes(meetingId), `${label} group ${group.id} has invalid source provenance`);
        require(answer?.citation_meeting_ids?.includes(meetingId), `${label} group ${group.id} source is absent from answer citations`);
      }
    }
  }
  for (const id of expected.material_group_ids) require(seen.has(id), `${label} is missing group ${id}`);
}

function validateAnswer(require, answer, expected, groups) {
  const label = expected.id;
  require(isObject(answer), `${label} capture is missing`);
  require(answer?.principal === expected.principal, `${label} used the wrong principal`);
  require(answer?.approval_state === expected.approval_state, `${label} used the wrong approval state`);
  require(answer?.outcome === expected.expected_outcome, `${label} has the wrong outcome`);
  require(nonempty(answer?.answer_text), `${label} answer text is missing`);
  require(sameStringSet(answer?.citation_meeting_ids, expected.required_citation_meeting_ids), `${label} citations do not match the expected visible meetings`);
  require(uniqueStrings(answer?.retrieved_record_ids), `${label} retrieved record IDs must be unique strings`);
  require(sameStringSet(answer?.fixture_only_atom_ids, []), `${label} used a fixture-only atom`);
  for (const forbidden of expected.must_not_reveal) require(!normalized(answer?.answer_text ?? "").includes(normalized(forbidden)), `${label} contains forbidden text`);
  if (expected.expected_outcome === "answered") {
    require(nonempty(answer?.record_generation_id) && nonempty(answer?.release_head), `${label} lacks the exact generation and release/head`);
    validateAnsweredClaims(require, answer, expected, groups, label);
  } else {
    require(answer?.answer_text?.trim() === INSUFFICIENT_ANSWER, `${label} is not the required non-disclosing response`);
    require(sameStringSet(answer?.retrieved_record_ids, []), `${label} retrieved inaccessible records`);
    require(Array.isArray(answer?.claims) && answer.claims.length === 0, `${label} neutral answer has group mappings`);
  }
}

function digestTrial(trial) {
  return createHash("sha256")
    .update(JSON.stringify({
      outcome: trial.outcome,
      answer_text: trial.answer_text,
      claims: trial.claims.map((claim) => ({
        group_id: claim.group_id,
        outcome: claim.outcome,
        observed_text: claim.observed_text,
        citation_meeting_ids: [...claim.citation_meeting_ids].sort()
      })).sort((a, b) => a.group_id.localeCompare(b.group_id)),
      citation_meeting_ids: [...trial.citation_meeting_ids].sort(),
      retrieved_record_ids: [...trial.retrieved_record_ids].sort()
    }))
    .digest("hex");
}

function loadMeetings(meetingsDirectory) {
  return readdirSync(meetingsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ path: resolve(meetingsDirectory, name), document: readJson(resolve(meetingsDirectory, name)) }));
}

function expectedInputPaths(meetingsDirectory) {
  return readdirSync(meetingsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => resolve(meetingsDirectory, name));
}

export function evaluateRehearsal(result, expectations, meetingDocuments, options = {}) {
  const checks = [];
  const check = (id, name, verify) => {
    const failures = [];
    const require = (condition, detail) => {
      if (!condition) failures.push(detail);
    };
    try {
      verify(require);
    } catch {
      failures.push("invalid or malformed evidence");
    }
    checks.push({ id, name, passed: failures.length === 0, failures });
  };

  const validTopLevel = isObject(result) && isObject(expectations) && Array.isArray(meetingDocuments);
  const expectedMeetings = validTopLevel && Array.isArray(expectations.meeting_expectations)
    ? expectations.meeting_expectations
    : [];
  const expectedById = new Map(expectedMeetings.map((meeting) => [meeting.meeting_id, meeting]));
  const records = new Map();
  const cases = expectations?.retrieval_cases ?? [];
  const groups = expectations?.answer_groups ?? [];
  const repeatability = [];
  const coverage = [];

  check("01", "Four canonical meetings validate without a demo-only runtime schema.", (require) => {
    require(validTopLevel, "result, expectations, and meeting documents must be objects/arrays");
    require(result?.schema_version === 1, "result.schema_version must be 1");
    require(result?.document_type === "echo-synthetic-customer-demo-rehearsal-result", "unexpected result document_type");
    require(result?.scenario_id === expectations?.scenario?.id, "scenario_id does not match expectations");
    require(
      result?.source_identity?.kind === expectations?.source_identity?.kind &&
        result?.source_identity?.adapter_id === expectations?.source_identity?.adapter_id &&
        result?.source_identity?.instance_id === expectations?.source_identity?.instance_id &&
        result?.source_identity?.version === expectations?.source_identity?.version,
      "source identity does not match expectations"
    );
    require(Array.isArray(result?.intake), "intake must be an array");
    require(result?.intake?.length === expectedMeetings.length, "intake must contain every expected meeting exactly once");
    const seen = new Set();
    for (const item of result?.intake ?? []) {
      require(isObject(item), "each intake item must be an object");
      require(typeof item?.meeting_id === "string" && expectedById.has(item.meeting_id), `unexpected intake meeting ${item?.meeting_id}`);
      require(!seen.has(item?.meeting_id), `duplicate intake meeting ${item?.meeting_id}`);
      seen.add(item?.meeting_id);
      require(item?.canonical_validation_passed === true, `${item?.meeting_id} did not pass canonical validation`);
      require(item?.canonical_schema_version === 1, `${item?.meeting_id} is not canonical schema v1`);
    }
  });

  check("02", "Every meeting has 3-5 participants and attributed dialogue.", (require) => {
    require(meetingDocuments.length === expectedMeetings.length, "meeting directory does not contain the expected four documents");
    for (const { document } of meetingDocuments) {
      require(isObject(document) && expectedById.has(document.id), "meeting document has an unexpected id");
      require(Array.isArray(document?.participants) && document.participants.length >= 3 && document.participants.length <= 5, `${document?.id} does not have 3-5 participants`);
      const participantIds = new Set((document?.participants ?? []).map((participant) => participant?.id));
      const blocks = document?.content?.blocks ?? document?.content ?? [];
      const dialogue = Array.isArray(blocks) ? blocks.filter((block) => block?.speaker_participant_id !== undefined) : [];
      require(dialogue.length > 0 && dialogue.every((block) => participantIds.has(block.speaker_participant_id)), `${document?.id} has an unresolved transcript speaker`);
    }
    require(result?.operator_checks?.natural_attributed_dialogue === true, "operator did not confirm natural attributed dialogue");
  });

  check("03", "No runtime meeting contains extraction labels or oracle input.", (require) => {
    const labels = /^(decision|action|rationale)\s*:/im;
    for (const { document } of meetingDocuments) {
      const blocks = document?.content?.blocks ?? document?.content ?? [];
      const text = Array.isArray(blocks) ? blocks.map((block) => block?.text ?? "").join("\n") : "";
      require(!labels.test(text), `${document?.id} contains an extraction label`);
    }
    require(strings(result?.runtime_input_paths), "runtime_input_paths must be a string array");
    const expectedPaths = options.expectedInputPaths ?? [];
    require(JSON.stringify([...result.runtime_input_paths].sort()) === JSON.stringify([...expectedPaths].sort()), "runtime inputs must be exactly the four meeting files");
    require(expectations?.runtime_input === false, "expectations must declare runtime_input false");
    require(result?.operator_checks?.expectations_external_only === true, "operator did not confirm expectations stayed outside runtime inputs");
  });

  check("04", "The correct canonical owner receives each private DM.", (require) => {
    require(result?.operator_checks?.correct_owner_private_dm === true, "operator did not confirm canonical owner delivery");
    require(Array.isArray(result?.slack_cards) && result.slack_cards.length === expectedMeetings.length, "one Slack card per meeting is required");
    const seen = new Set();
    for (const card of result?.slack_cards ?? []) {
      require(isObject(card) && expectedById.has(card.meeting_id), "Slack card has an unexpected meeting");
      require(!seen.has(card?.meeting_id), `duplicate Slack card for ${card?.meeting_id}`);
      seen.add(card?.meeting_id);
      require(card?.delivery_surface === "private_dm_only", `${card?.meeting_id} was not delivered privately`);
    }
  });

  check("05", "Each DM displays the complete approval bundle and evidence.", (require) => {
    require(result?.operator_checks?.approval_card_complete === true, "operator did not confirm rendered card completeness");
    for (const card of result?.slack_cards ?? []) {
      require(strings(card?.displayed_fields), `${card?.meeting_id} card fields are missing`);
      const fields = new Set(card?.displayed_fields ?? []);
      for (const field of CARD_FIELDS) require(fields.has(field), `${card?.meeting_id} lacks ${field}`);
    }
  });

  check("06", "Required decisions are decided, evidenced, and exclude rejected suggestions.", (require) => {
    require(Array.isArray(result?.approved_decisions), "approved_decisions must be an array");
    for (const expectedMeeting of expectedMeetings) {
      const decisions = result?.approved_decisions?.filter((decision) => decision?.meeting_id === expectedMeeting.meeting_id) ?? [];
      require(decisions.length > 0, `${expectedMeeting.meeting_id} has no captured approved decisions`);
      const rejectedBlocks = new Set(expectedMeeting.must_not_be_current_decisions.flatMap((item) => item.evidence_block_ids));
      for (const decision of decisions) {
        require(strings(decision?.evidence_block_ids), `${expectedMeeting.meeting_id} decision lacks evidence block ids`);
        require(decision?.status === "decided", `${expectedMeeting.meeting_id} decision is not decided`);
        require(!decision.evidence_block_ids.some((id) => rejectedBlocks.has(id)), `${expectedMeeting.meeting_id} approves rejected evidence ${decision.evidence_block_ids.join(", ")}`);
      }
      for (const expectedDecision of expectedMeeting.required_decisions) {
        const match = decisions.some((decision) =>
          decision?.status === "decided" &&
          strings(decision?.evidence_block_ids) &&
          expectedDecision.evidence_block_ids.every((id) => decision.evidence_block_ids.includes(id))
        );
        require(match, `${expectedMeeting.meeting_id} is missing an approved expected decision with all required evidence`);
      }
    }
  });

  check("15", "The oracle and captures have a complete, unique case and group inventory.", (require) => {
    require(Array.isArray(cases) && cases.length >= 4, "case inventory is missing");
    require(uniqueStrings(cases.map((item) => item.id)), "oracle has duplicate or invalid case IDs");
    require(Array.isArray(result?.answers), "answers must be an array");
    require(sameStringSet(result?.answers?.map((item) => item?.case_id), cases.map((item) => item.id)), "captured case IDs contain missing, duplicate, or unexpected cases");
    require(Array.isArray(groups) && groups.length > 0 && uniqueStrings(groups.map((item) => item.id)), "oracle has missing, duplicate, or invalid groups");
    for (const group of groups) {
      require(["conclusion", "condition"].includes(group.category), "oracle group category is invalid");
      require(uniqueStrings(group.required_phrases) && group.required_phrases.length > 0, "oracle group textual checks are missing");
      require(uniqueStrings(group.allowed_source_meeting_ids) && group.allowed_source_meeting_ids.length > 0 && group.allowed_source_meeting_ids.every((id) => expectedById.has(id)), "oracle group source meetings are invalid");
      require(typeof group.allow_insufficient === "boolean", "oracle group insufficient-evidence policy is missing");
      if (group.allow_insufficient) require(nonempty(group.insufficient_answer), "oracle permitted insufficient group lacks explicit wording");
    }
    for (const expected of cases) {
      require(nonempty(expected.question) && nonempty(expected.principal) && nonempty(expected.approval_state), "oracle case question or access context is missing");
      require(["answered", "insufficient_approved_information"].includes(expected.expected_outcome), "oracle case outcome is invalid");
      require(strings(expected.must_not_reveal), "oracle case forbidden-text checks are missing");
      require(uniqueStrings(expected.material_group_ids), "oracle case has duplicate or invalid group mappings");
      const mapped = expected.material_group_ids.map((id) => groups.find((group) => group.id === id));
      require(mapped.every(Boolean), "oracle case maps an unknown group");
      require(expected.expected_outcome === "answered" ? mapped.length > 0 : mapped.length === 0, "oracle groups do not match case outcome");
      require(sameStringSet(expected.required_citation_meeting_ids, [...new Set(mapped.flatMap((group) => group?.allowed_source_meeting_ids ?? []))]), "oracle citations do not match mapped groups");
      const primary = cases.find((item) => item.id === expected.primary_case_id);
      require(primary?.primary_case_id === primary?.id && isObject(primary), "case has no direct primary mapping");
      for (const field of ["principal", "approval_state", "expected_outcome", "material_group_ids", "required_citation_meeting_ids", "must_not_reveal"]) {
        require(JSON.stringify(expected[field]) === JSON.stringify(primary?.[field]), `paraphrase differs from primary in ${field}`);
      }
    }
  });

  check("07", "Before approval, the main question returns no facts or citations.", (require) => {
    const expected = cases.find((item) => item.id === "before-approval-rollout-question");
    const answer = result?.answers?.find((item) => item?.case_id === expected?.id);
    validateAnswer(require, answer, expected, groups);
  });

  check("08", "After Team approval, the main answer contains every required proposition.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "after-team-approval-rollout-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing post-approval answer capture or expectation");
    require(answer?.principal === expected?.principal, "post-approval answer used the wrong principal");
    require(answer?.outcome === "answered", "post-approval outcome is not answered");
    validateAnswer(require, answer, expected, groups);
    const maximumWords = expectations?.quality_gate?.maximum_target_words_for_rollout_answer;
    if (Number.isInteger(maximumWords)) require(answer.answer_text.trim().split(/\s+/).length <= maximumWords, `post-approval answer exceeds ${maximumWords} words`);
  });

  check("09", "Every captured case covers its material groups with visible source provenance.", (require) => {
    for (const expected of cases) {
      const answer = result?.answers?.find((item) => item?.case_id === expected.id);
      // Optional fields copied from existing content-free answer-composition
      // audit evidence. Record retrieval alone does not prove context inclusion.
      const retrieval = answer?.retrieval;
      const validCounts = isObject(retrieval) && [retrieval.released_atom_count, retrieval.context_atom_count].every((count) => Number.isInteger(count) && count >= 0) && retrieval.context_atom_count <= retrieval.released_atom_count;
      if (retrieval !== undefined) require(validCounts, `${expected.id} has invalid captured retrieval counts`);
      const contextState = validCounts ? (retrieval.context_atom_count === 0 ? "empty" : "nonempty") : "not_captured";
      coverage.push({
        case_id: expected.id,
        context_state: contextState,
        missing_group_ids: expected.material_group_ids.filter((id) => !Array.isArray(answer?.claims) || !answer.claims.some((claim) => claim?.group_id === id))
      });
      if (validCounts) require(expected.expected_outcome === "answered" ? retrieval.context_atom_count > 0 : retrieval.released_atom_count === 0, `${expected.id} captured retrieval counts contradict its expected outcome`);
      validateAnswer(require, answer, expected, groups);
    }
  });

  check("10", "No answer uses an unapproved transcript or fixture-only retrieval atom.", (require) => {
    require(Array.isArray(result?.approved_records), "approved_records must be an array");
    for (const record of result?.approved_records ?? []) {
      require(isObject(record) && expectedById.has(record.meeting_id), "approved record has unexpected meeting");
      require(typeof record?.record_id === "string" && record.record_id.length > 0, "approved record id is missing");
      require(record?.publication === "approved_v4_reconciled", `${record?.meeting_id} was not confirmed through V4 reconciliation`);
      require(record?.approved === true, `${record?.meeting_id} is not approved`);
      require(record?.policy === expectedById.get(record.meeting_id)?.approval_policy, `${record?.meeting_id} policy does not match expectation`);
      require(!records.has(record.record_id), `duplicate record id ${record.record_id}`);
      records.set(record.record_id, record);
    }
    require(records.size === expectedMeetings.length, "four approved V4 records are required");
    for (const answer of result?.answers ?? []) {
      require(strings(answer?.retrieved_record_ids), `${answer?.case_id} retrieved_record_ids must be a string array`);
      require(strings(answer?.fixture_only_atom_ids) && answer.fixture_only_atom_ids.length === 0, `${answer?.case_id} used a fixture-only atom`);
      for (const recordId of answer?.retrieved_record_ids ?? []) require(records.has(recordId), `${answer?.case_id} used unapproved record ${recordId}`);
      const expected = expectations?.retrieval_cases?.find((item) => item.id === answer?.case_id);
      for (const meetingId of answer?.citation_meeting_ids ?? []) require(answer?.retrieved_record_ids?.some((id) => records.get(id)?.meeting_id === meetingId), "answer citation has no retrieved approved record");
      if (expected?.principal !== "exact_owner_approver") {
        for (const recordId of answer?.retrieved_record_ids ?? []) require(records.get(recordId)?.policy === "team", `${answer?.case_id} retrieved an Only-me record`);
      }
    }
  });

  check("11", "The normal team member cannot learn the private price or that it exists.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "team-member-private-price-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing team private-price answer capture");
    require(result?.operator_checks?.answer_identities_verified === true, "operator did not confirm the Ask ECHO identities");
    require(answer?.principal === expected?.principal, "team private-price answer used the wrong principal");
    validateAnswer(require, answer, expected, groups);
  });

  check("12", "The exact Only-me approver can retrieve the private price.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "approver-private-price-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing approver private-price answer capture");
    require(result?.operator_checks?.answer_identities_verified === true, "operator did not confirm the Ask ECHO identities");
    require(answer?.principal === expected?.principal, "approver price answer did not use the exact owner/approver principal");
    require(answer?.outcome === "answered", "approver private-price outcome is not answered");
    validateAnswer(require, answer, expected, groups);
    require(strings(answer?.citation_meeting_ids) && answer.citation_meeting_ids.includes("synthetic-demo-northstar-commercial-exception-2026-08-29"), "approver answer lacks commercial citation");
    const commercialRecordIds = new Set((result?.approved_records ?? []).filter((record) => record?.meeting_id === "synthetic-demo-northstar-commercial-exception-2026-08-29").map((record) => record.record_id));
    require(strings(answer?.retrieved_record_ids) && answer.retrieved_record_ids.length > 0 && answer.retrieved_record_ids.every((recordId) => commercialRecordIds.has(recordId)), "approver price answer did not use only the commercial record");
  });

  check("13", "Repeated queries are stable only within one generation and release/head; availability stays visible.", (require) => {
    const answeredCases = cases.filter((item) => item.expected_outcome === "answered");
    require(Array.isArray(result?.determinism), "determinism must be an array");
    require(sameStringSet(result?.determinism?.map((item) => item?.case_id), answeredCases.map((item) => item.id)), "repeatability has missing, duplicate, or unexpected cases");
    for (const expected of answeredCases) {
      const run = result?.determinism?.find((item) => item?.case_id === expected.id);
      const captured = result?.answers?.find((item) => item?.case_id === expected.id);
      require(nonempty(run?.record_generation_id) && nonempty(run?.release_head), `${expected.id} run lacks generation or release/head`);
      require(run?.record_generation_id === captured?.record_generation_id && run?.release_head === captured?.release_head, `${expected.id} run differs from captured generation or release/head`);
      require(Array.isArray(run?.trials), `${expected.id} trials must be an array`);
      require(uniqueStrings(run?.trials?.map((trial) => trial?.trial_id)), `${expected.id} trials require unique IDs`);
      const summary = { case_id: expected.id, trial_count: run?.trials?.length ?? 0, success_count: 0, unavailable_count: 0, status_503_count: 0, reason_counts: {}, stable: false };
      repeatability.push(summary);
      const digests = new Set();
      let validTrials = uniqueStrings(run?.trials?.map((trial) => trial?.trial_id));
      const requireTrial = (condition, detail) => {
        require(condition, detail);
        if (!condition) validTrials = false;
      };
      for (const trial of run?.trials ?? []) {
        try {
          const samePair = trial?.record_generation_id === run.record_generation_id && trial?.release_head === run.release_head;
          requireTrial(samePair, `${expected.id} trial changed generation or release/head`);
          if (trial?.outcome === "unavailable") {
            summary.unavailable_count += 1;
            if (trial.http_status === 503) summary.status_503_count += 1;
            requireTrial(Number.isInteger(trial.http_status) && trial.http_status >= 400 && trial.http_status <= 599, `${expected.id} unavailable trial lacks error status`);
            // Reasons are captured symbolic codes, never provider messages or answer text.
            const validReason = UNAVAILABLE_REASONS.has(trial.reason_code);
            requireTrial(validReason, `${expected.id} unavailable trial lacks a content-free reason code`);
            if (validReason) summary.reason_counts[trial.reason_code] = (Object.hasOwn(summary.reason_counts, trial.reason_code) ? summary.reason_counts[trial.reason_code] : 0) + 1;
            requireTrial(!["answer_text", "claims", "citation_meeting_ids", "retrieved_record_ids"].some((key) => Object.hasOwn(trial, key)), `${expected.id} unavailable trial contains answer evidence`);
            continue;
          }
          summary.success_count += 1;
          validateAnswer(requireTrial, trial, expected, groups);
          requireTrial(trial?.case_id === expected.id, `${expected.id} trial used another case`);
          // Never compare text or records across a changed pair.
          if (samePair && run.record_generation_id === captured?.record_generation_id && run.release_head === captured?.release_head) {
            const digest = digestTrial(trial);
            digests.add(digest);
            requireTrial(digest === digestTrial(captured), `${expected.id} trial differs from the evaluated capture`);
          }
        } catch {
          requireTrial(false, `${expected.id} trial has malformed evidence`);
        }
      }
      require(summary.success_count >= 2, `${expected.id} requires at least two successful trials`);
      summary.stable = validTrials && digests.size === 1 && summary.success_count >= 2 && run.trials.every((trial) => trial.record_generation_id === run.record_generation_id && trial.release_head === run.release_head) && [...digests][0] === digestTrial(captured);
      require(summary.stable, `${expected.id} successful trials are not stable for the captured pair`);
    }
  });

  check("14", "The hero question returns the required answer in six consecutive post-approval trials.", (require) => {
    const hero = result?.determinism?.find((item) => item?.case_id === "after-team-approval-rollout-question");
    let consecutive = 0;
    let longest = 0;
    for (const trial of hero?.trials ?? []) {
      consecutive = trial?.outcome === "answered" ? consecutive + 1 : 0;
      longest = Math.max(longest, consecutive);
    }
    require(longest >= 6, "hero question requires six consecutive successful trials; unavailable attempts break the sequence");
  });

  return { passed: checks.every((item) => item.passed), checks, coverage, repeatability };
}

function printUsage() {
  console.log("Usage: node demo/evaluate-rehearsal.mjs --result path/to/rehearsal-result.json [--expectations demo/expectations.json] [--meetings-dir demo/meetings]");
}

function main(argv) {
  if (argv.includes("--help")) return printUsage();
  const valueFor = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${flag} requires a path`);
    return resolve(argv[index + 1]);
  };
  const resultPath = valueFor("--result", null);
  if (!resultPath) throw new Error("--result is required");
  const expectationsPath = valueFor("--expectations", DEFAULT_EXPECTATIONS);
  const meetingsDirectory = valueFor("--meetings-dir", DEFAULT_MEETINGS);
  const report = evaluateRehearsal(readJson(resultPath), readJson(expectationsPath), loadMeetings(meetingsDirectory), {
    expectedInputPaths: expectedInputPaths(meetingsDirectory)
  });
  for (const item of report.checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.name}`);
    for (const failure of item.failures) console.log(`  - ${failure}`);
  }
  for (const summary of report.coverage) console.log(`COVERAGE ${JSON.stringify(summary)}`);
  for (const summary of report.repeatability) console.log(`REPEAT ${JSON.stringify(summary)}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error("FAIL evaluator input: unable to read or validate captured evidence");
    process.exitCode = 1;
  }
}
