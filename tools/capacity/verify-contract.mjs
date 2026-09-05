import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The trusted runner must pin this verifier independently of the candidate.
const ACCEPTED_V1_SHA256 = "a8d4e85f3d15cf9b35a6968a1849829ea6b167dc25030102005f5e1d0620cbfc";
const here = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(process.argv[2] ?? resolve(here, "metrics.v1.json"));
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const definitionPath = resolve(process.argv[3] ?? resolve(dirname(contractPath), contract.definition));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const { profile_pin: pin, ...rules } = contract;
assert.ok(pin, "Missing accepted profile pin");
assert.equal(pin.algorithm, "sha256-sorted-json-rules-and-raw-definition-v1");
const definitionSha256 = hash(readFileSync(definitionPath));
assert.equal(pin.definition_sha256, definitionSha256, "Definition digest mismatch");
const actual = hash(canonical({ rules, definition_sha256: definitionSha256 }));
assert.equal(pin.sha256, actual, "Rule digest mismatch");
assert.equal(actual, ACCEPTED_V1_SHA256, "Not the independently accepted V1 profile");

assert.equal(contract.evaluation_scope.live_llm_calls_allowed, false);
assert.equal(contract.evaluation_scope.llm_quality_scoring_enabled, false);
const workload = contract.workload;
const peakFactor = 1 + (workload.peak_multiplier - 1) * workload.peak_duration_ms / workload.run_duration_ms;
for (const milestone of contract.milestones) {
  const atoms = Math.round(milestone.active_employees * milestone.history_workdays * workload.distinct_meetings_per_employee_per_workday * workload.approved_fraction * workload.atoms_per_approved_meeting);
  assert.equal(milestone.historical_atoms_min, atoms, `${milestone.id} atom formula`);
  assert.equal(milestone.historical_postings_min, atoms * workload.mean_postings_per_atom, `${milestone.id} postings formula`);
  assert.equal(milestone.peak_day_meetings, Math.ceil(milestone.active_employees * workload.distinct_meetings_per_employee_per_workday * peakFactor));
  assert.equal(milestone.peak_day_answers, Math.ceil(milestone.active_employees * workload.answers_per_employee_per_workday * peakFactor));
  assert.equal(milestone.peak_day_user_searches, Math.ceil(milestone.active_employees * workload.direct_searches_per_employee_per_workday * peakFactor));
  assert.equal(milestone.history_probe_count, Math.max(200, milestone.active_employees));
}
const search = contract.search_workload;
assert.ok(Math.abs(search.selective_query_fraction + search.medium_query_fraction + search.broad_query_fraction + search.negative_query_fraction - 1) < 1e-12);
assert.equal(contract.correctness.process_death_case_count, contract.correctness.process_death_boundaries.length * contract.correctness.process_death_positions.length);
assert.equal(contract.correctness.timed_permission_cases, contract.correctness.permission_case_classes.length * contract.correctness.seeds_per_permission_class);
assert.equal(contract.durability.storage_fault_case_count_min, contract.durability.storage_fault_boundaries.length);
assert.equal(contract.run_protocol.nonce_is_proof_of_computation, false);
assert.equal(contract.grading.ordinary_work_affected_by_injected_crash_in_normal_denominator, true);
assert.equal(contract.publication_evidence.retrospective_publication_credit, false);
assert.equal(contract.durability.process_kill_proves_power_loss, false);
console.log(`Capacity V1 definition verified: ${actual}`);
console.log("Definition/digest checks only. No capacity run or milestone pass is implied.");
