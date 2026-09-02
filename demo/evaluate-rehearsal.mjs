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

function validateAnsweredClaims(require, answer, expected, label) {
  const facts = expected?.required_answer_facts;
  const factChecks = expected?.required_answer_fact_checks;
  require(Array.isArray(answer?.claims), `${label} claims must be an array`);
  require(Array.isArray(facts), `${label} expected facts must be an array`);
  require(Array.isArray(factChecks) && factChecks.length === facts?.length, `${label} fact checks must match expected facts`);
  require(answer?.claims?.length === facts?.length, `${label} requires exactly one claim per expected fact`);

  const seen = new Map();
  for (const claim of answer?.claims ?? []) {
    const validIndex = Number.isInteger(claim?.fact_index) && claim.fact_index >= 0 && claim.fact_index < (facts?.length ?? 0);
    require(validIndex, `${label} claim has invalid fact_index`);
    if (!validIndex) continue;

    seen.set(claim.fact_index, (seen.get(claim.fact_index) ?? 0) + 1);
    const factCheck = factChecks?.[claim.fact_index];
    require(isObject(factCheck) && strings(factCheck.required_phrases) && factCheck.required_phrases.length > 0, `${label} fact ${claim.fact_index} has invalid required phrases`);
    require(strings(factCheck?.required_citation_meeting_ids), `${label} fact ${claim.fact_index} has invalid required citations`);
    const observed = claim?.observed_text;
    require(typeof observed === "string" && observed.trim().length > 0, `${label} claim lacks observed answer text`);
    require(typeof answer?.answer_text === "string" && typeof observed === "string" && answer.answer_text.includes(observed), `${label} claim text is not present in the captured answer`);
    for (const phrase of factCheck?.required_phrases ?? []) require(typeof observed === "string" && normalized(observed).includes(normalized(phrase)), `${label} fact ${claim.fact_index} lacks required phrase ${phrase}`);
    require(sameStringSet(claim?.citation_meeting_ids, factCheck?.required_citation_meeting_ids), `${label} fact ${claim.fact_index} citations do not match`);
    for (const meetingId of claim?.citation_meeting_ids ?? []) require(answer?.citation_meeting_ids?.includes(meetingId), `${label} fact ${claim.fact_index} citation is not in the answer citations`);
  }
  for (let index = 0; index < (facts?.length ?? 0); index += 1) require(seen.get(index) === 1, `${label} requires exactly one claim for fact ${index}`);
}

function digestTrial(trial) {
  return createHash("sha256")
    .update(JSON.stringify({
      answer_text: trial.answer_text,
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
    } catch (error) {
      failures.push(`invalid evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    checks.push({ id, name, passed: failures.length === 0, failures });
  };

  const validTopLevel = isObject(result) && isObject(expectations) && Array.isArray(meetingDocuments);
  const expectedMeetings = validTopLevel && Array.isArray(expectations.meeting_expectations)
    ? expectations.meeting_expectations
    : [];
  const expectedById = new Map(expectedMeetings.map((meeting) => [meeting.meeting_id, meeting]));
  const records = new Map();

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

  check("07", "Before approval, the main question returns no facts or citations.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "before-approval-rollout-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing before-approval answer capture or expectation");
    require(answer?.principal === expected?.principal, "before-approval answer used the wrong principal");
    require(answer?.outcome === "insufficient_approved_information", "before-approval outcome is not insufficient information");
    require(strings(answer?.citation_meeting_ids) && answer.citation_meeting_ids.length === 0, "before-approval answer has citations");
    require(strings(answer?.retrieved_record_ids) && answer.retrieved_record_ids.length === 0, "before-approval answer retrieved records");
    require(answer?.answer_text?.trim() === INSUFFICIENT_ANSWER, "before-approval answer is not the required non-disclosing response");
    for (const forbidden of expectations?.retrieval_cases?.[0]?.must_not_reveal ?? []) {
      require(!normalized(answer.answer_text).includes(normalized(forbidden)), `before-approval answer reveals ${forbidden}`);
    }
  });

  check("08", "After Team approval, the main answer contains every required proposition.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "after-team-approval-rollout-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing post-approval answer capture or expectation");
    require(answer?.principal === expected?.principal, "post-approval answer used the wrong principal");
    require(answer?.outcome === "answered", "post-approval outcome is not answered");
    validateAnsweredClaims(require, answer, expected, "post-approval");
    for (const forbidden of expected?.must_not_reveal ?? []) require(!normalized(answer?.answer_text ?? "").includes(normalized(forbidden)), `post-approval answer reveals ${forbidden}`);
    const maximumWords = expectations?.quality_gate?.maximum_target_words_for_rollout_answer;
    if (Number.isInteger(maximumWords)) require(answer.answer_text.trim().split(/\s+/).length <= maximumWords, `post-approval answer exceeds ${maximumWords} words`);
  });

  check("09", "Each proposition cites the correct source meeting.", (require) => {
    for (const expected of expectations?.retrieval_cases ?? []) {
      const answer = (result?.answers ?? []).find((item) => item?.case_id === expected.id);
      require(isObject(answer), `missing answer capture ${expected.id}`);
      require(strings(answer?.citation_meeting_ids), `${expected.id} citations must be a string array`);
      require(sameStringSet(answer?.citation_meeting_ids, expected.required_citation_meeting_ids ?? []), `${expected.id} citations do not match required meetings`);
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
      if (expected?.principal === "normal_team_member") {
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
    require(answer?.outcome === "insufficient_approved_information", "team private-price outcome is not insufficient information");
    require(strings(answer?.citation_meeting_ids) && answer.citation_meeting_ids.length === 0, "team private-price answer has citations");
    require(strings(answer?.retrieved_record_ids) && answer.retrieved_record_ids.length === 0, "team private-price answer retrieved records");
    require(answer?.answer_text?.trim() === INSUFFICIENT_ANSWER, "team private-price answer is not the required non-disclosing response");
    for (const forbidden of expected?.must_not_reveal ?? []) require(!normalized(answer.answer_text).includes(normalized(forbidden)), `team private-price answer reveals ${forbidden}`);
  });

  check("12", "The exact Only-me approver can retrieve the private price.", (require) => {
    const expected = expectations?.retrieval_cases?.find((item) => item.id === "approver-private-price-question");
    const answer = (result?.answers ?? []).find((item) => item?.case_id === expected?.id);
    require(isObject(answer) && isObject(expected), "missing approver private-price answer capture");
    require(result?.operator_checks?.answer_identities_verified === true, "operator did not confirm the Ask ECHO identities");
    require(answer?.principal === expected?.principal, "approver price answer did not use the exact owner/approver principal");
    require(answer?.outcome === "answered", "approver private-price outcome is not answered");
    validateAnsweredClaims(require, answer, expected, "approver private-price");
    require(strings(answer?.citation_meeting_ids) && answer.citation_meeting_ids.includes("synthetic-demo-northstar-commercial-exception-2026-08-29"), "approver answer lacks commercial citation");
    const commercialRecordIds = new Set((result?.approved_records ?? []).filter((record) => record?.meeting_id === "synthetic-demo-northstar-commercial-exception-2026-08-29").map((record) => record.record_id));
    require(strings(answer?.retrieved_record_ids) && answer.retrieved_record_ids.length > 0 && answer.retrieved_record_ids.every((recordId) => commercialRecordIds.has(recordId)), "approver price answer did not use only the commercial record");
  });

  check("13", "Repeated queries are deterministic for the same record generation.", (require) => {
    require(Array.isArray(result?.determinism), "determinism must be an array");
    for (const caseId of ["after-team-approval-rollout-question", "approver-private-price-question"]) {
      const run = result?.determinism?.find((item) => item?.case_id === caseId);
      require(isObject(run), `missing determinism evidence for ${caseId}`);
      require(typeof run?.record_generation_id === "string" && run.record_generation_id.length > 0, `${caseId} record generation is missing`);
      require(Array.isArray(run?.trials) && run.trials.length >= 2, `${caseId} requires at least two trials`);
      const trialDigests = new Set();
      for (const trial of run?.trials ?? []) {
        require(isObject(trial) && typeof trial.answer_text === "string" && strings(trial.citation_meeting_ids) && strings(trial.retrieved_record_ids), `${caseId} trial is invalid`);
        if (isObject(trial) && typeof trial.answer_text === "string" && strings(trial.citation_meeting_ids) && strings(trial.retrieved_record_ids)) trialDigests.add(digestTrial(trial));
      }
      require(trialDigests.size === 1, `${caseId} trials are not deterministic`);
    }
  });

  check("14", "The hero question returns the required answer in six consecutive post-approval trials.", (require) => {
    const hero = result?.determinism?.find((item) => item?.case_id === "after-team-approval-rollout-question");
    const captured = result?.answers?.find((item) => item?.case_id === "after-team-approval-rollout-question");
    require(Array.isArray(hero?.trials) && hero.trials.length >= 6, "hero question requires six consecutive trials");
    require(isObject(captured) && captured?.outcome === "answered", "captured hero answer is missing");
    const expectedCitationIds = expectations?.retrieval_cases?.find((item) => item.id === "after-team-approval-rollout-question")?.required_citation_meeting_ids ?? [];
    for (const trial of hero?.trials ?? []) {
      require(trial?.answer_text === captured?.answer_text, "a hero trial differs from the evaluated captured answer");
      require(JSON.stringify([...(trial?.citation_meeting_ids ?? [])].sort()) === JSON.stringify([...expectedCitationIds].sort()), "a hero trial has incorrect citations");
      require((trial?.retrieved_record_ids ?? []).length > 0, "a hero trial did not retrieve approved records");
    }
  });

  return { passed: checks.every((item) => item.passed), checks };
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
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL evaluator input: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
