import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_SOURCE_SHA256 } from "./corpus-v1.mjs";

const ACCEPTED_V2_SHA256 = "6ddeabbb963cfd015e7424a588566c58d547a5ffc733293cf08414220f246160";
const here = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(process.argv[2] ?? resolve(here, "metrics.v2.json"));
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const definitionPath = resolve(process.argv[3] ?? resolve(dirname(contractPath), contract.definition));
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(
  hash(readFileSync(resolve(here, "../../packages/organization-retrieval/src/application/analyzer.ts"))),
  ANALYZER_SOURCE_SHA256,
  "Candidate analyzer changed; verify oracle compatibility before using this profile",
);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const fraction = (value, label) => {
  assert.equal(typeof value, "number", `${label} must be numeric`);
  assert.ok(value >= 0 && value <= 1, `${label} must be a fraction`);
};
const gate = (value, expectedP95, expectedDeadline, expectedFraction, label) => {
  assert.deepEqual(value, {
    p95_ms_max: expectedP95,
    completion_deadline_ms: expectedDeadline,
    verified_success_fraction_min: expectedFraction,
  }, `${label} gate`);
};

assert.equal(contract.schema_version, 2);
assert.equal(contract.kind, "authority-core-capacity-metrics-v2");
assert.equal(contract.status, "frozen-rules-baseline-not-run-full-runner-not-implemented-no-capacity-claim");
assert.equal(contract.evaluation_scope.objective, "authority-core-runtime-capacity");
assert.equal(contract.evaluation_scope.real_runtime_paths_required, true);
assert.equal(contract.evaluation_scope.included.includes("approval-authorization-and-scheduling"), true);
assert.equal(contract.evaluation_scope.included.includes("core-driver-backpressure"), true);
assert.equal(contract.evaluation_scope.fixture_stages, undefined);
assert.equal(contract.provider_profile, undefined);
assert.equal(contract.evaluation_scope.synthetic_template_binding.includes("actual canonical record identities"), true);

const { profile_pin: pin, ...rules } = contract;
assert.ok(pin, "Missing V2 profile pin");
assert.equal(pin.algorithm, "sha256-sorted-json-rules-and-raw-definition-v1");
const definitionSha256 = hash(readFileSync(definitionPath));
assert.equal(pin.definition_sha256, definitionSha256, "Definition digest mismatch");
const actual = hash(canonical({ rules, definition_sha256: definitionSha256 }));
assert.equal(pin.sha256, actual, "Rule digest mismatch");
assert.equal(actual, ACCEPTED_V2_SHA256, "Not the frozen V2 core profile");

const workload = contract.workload;
assert.equal(workload.mean_postings_per_atom, 25);
assert.equal(workload.atoms_per_approved_meeting, 5);
fraction(workload.organization_member_policy_fraction, "organization member policy share");
fraction(workload.restricted_reviewer_policy_fraction, "restricted reviewer policy share");
assert.equal(workload.organization_member_policy_fraction + workload.restricted_reviewer_policy_fraction, 1);
const peakFactor = 1 + (workload.peak_multiplier - 1) * workload.peak_duration_ms / workload.run_duration_ms;
for (const milestone of contract.milestones) {
  const atoms = Math.round(milestone.active_employees * milestone.history_workdays * workload.distinct_meetings_per_employee_per_workday * workload.approved_fraction * workload.atoms_per_approved_meeting);
  assert.equal(milestone.historical_atoms_min, atoms, `${milestone.id} atom formula`);
  assert.equal(milestone.historical_postings_min, atoms * workload.mean_postings_per_atom, `${milestone.id} posting formula`);
  assert.equal(milestone.peak_day_canonical_inputs, Math.ceil(milestone.active_employees * workload.distinct_meetings_per_employee_per_workday * peakFactor), `${milestone.id} input peak formula`);
  assert.equal(milestone.peak_day_answers, Math.ceil(milestone.active_employees * workload.answers_per_employee_per_workday * peakFactor), `${milestone.id} answer peak formula`);
  assert.equal(milestone.peak_day_user_searches, Math.ceil(milestone.active_employees * workload.direct_searches_per_employee_per_workday * peakFactor), `${milestone.id} search peak formula`);
  assert.equal(milestone.history_probe_count, Math.max(200, milestone.active_employees), `${milestone.id} history probes`);
}

gate(contract.thresholds.search, 500, 2000, 0.995, "search");
gate(contract.thresholds.answer, 2000, 5000, 0.995, "answer");
gate(contract.thresholds.source_to_candidate, 1000, 30000, 1, "source-to-candidate");
gate(contract.thresholds.approval_ack, 1000, 5000, 1, "approval acknowledgement");
gate(contract.thresholds.approval_to_search, 60000, 300000, 1, "approval visibility");
assert.equal(contract.thresholds.history_probe_success_fraction_min, 1);
for (const name of [
  "permission_violations_max",
  "acknowledged_durable_work_lost_max",
  "duplicate_canonical_appends_max",
  "partial_or_invalid_generation_publications_max",
  "unapproved_generation_atoms_max",
  "missing_or_wrong_logical_postings_max",
  "audit_after_result_violations_max",
]) assert.equal(contract.thresholds[name], 0, `${name} must be a hard zero gate`);

const oracle = contract.retrieval_oracle;
assert.equal(oracle.vocabulary_size, 4096);
assert.equal(oracle.zipf_exponent, 1.1);
assert.deepEqual(oracle.distinct_terms_per_atom, [20, 30]);
assert.ok(Math.abs(Object.values(oracle.query_class_fractions).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
assert.equal(oracle.head_rule.includes("never-older"), true);
assert.equal(oracle.oracle_imports_candidate_modules, false);
assert.equal(oracle.generation_snapshots_min, 24);

const correctness = contract.correctness;
assert.equal(correctness.timed_permission_cases, correctness.permission_case_classes.length * correctness.seeds_per_permission_class);
assert.equal(correctness.timed_permission_cases, 40);
assert.deepEqual(correctness.permission_case_classes, [
  "wrong-approver", "revoked-member", "revocation-during-answer", "cross-org-session",
  "expired-session", "invalid-canonical-approval-binding", "cross-segment-relationship",
  "unapproved-content", "unreleased-citation", "stale-generation-release",
]);
assert.equal(correctness.fault_proofs.includes("run_integrity"), true);
assert.equal(correctness.fault_proofs.includes("drain_and_new_work"), true);
assert.equal(correctness.audit_before_result_required, true);
assert.equal(correctness.required_assertions_pass_fraction_min, 1);
assert.deepEqual(contract.durability.baseline_sqlite, { journal_mode: "DELETE", synchronous: "FULL" });
assert.equal(contract.durability.weaker_synchronous_modes_forbidden, true);
assert.equal(contract.durability.positive_and_negative_fault_model_controls_required, true);
assert.equal(contract.durability.storage_fault_boundaries.length, 4);
assert.equal(contract.durability.lost_acknowledged_durable_effects_max, 0);
assert.equal(contract.durability.process_kill_proves_power_loss, false);
assert.equal(contract.run_protocol.qualification_duration, "eight-real-hours");
assert.equal(contract.run_protocol.hidden_queries_and_peak, true);
assert.equal(contract.run_protocol.full_runner_implemented, false);
assert.equal(contract.run_protocol.correlation_is_proof_of_computation, false);
assert.equal(contract.reference_hardware.candidate_vcpu_limit, 4);
assert.equal(contract.reference_hardware.candidate_memory_limit_bytes, 8589934592);
assert.equal(contract.reference_hardware.swap_allowed, false);
assert.equal(contract.reference_hardware.instance_type, "c7i.xlarge");
assert.equal(contract.reference_hardware.region, "us-west-2");
assert.equal(contract.reference_hardware.storage.iops, 3000);
assert.equal(contract.reference_hardware.storage.throughput_mib_per_second, 125);

console.log(`Capacity V2 core definition verified: ${actual}`);
console.log("Definition/digest and numeric checks only. Baseline and qualification runner are NOT-RUN.");
