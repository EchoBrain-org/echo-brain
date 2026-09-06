import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nearestRank95, scoreCoreMeasurements } from "../grading.mjs";

const contract = JSON.parse(readFileSync(new URL("../metrics.v2.json", import.meta.url)));
const kinds = [
  "direct_user_search", "availability_probe", "history_probe", "deterministic_answer",
  "canonical_input", "canonical_approval", "approval_visibility",
];
const proofNames = ["run_integrity", "drain_and_new_work", ...contract.correctness.fault_proofs];

function fixture() {
  const manifest = { operations: kinds.map((kind, index) => ({ id: kind, kind, offset_ms: index * 10 })) };
  return {
    contract,
    manifest,
    operations: manifest.operations.map((operation) => ({ operation_id: operation.id, correct: true, completed_monotonic_ms: operation.offset_ms + 100 })),
    run: { started_monotonic_ms: 0, closed_monotonic_ms: contract.workload.run_duration_ms, clock: "real-monotonic" },
  };
}

function independentlyVerifiedProofs(input) {
  input.proofs = Object.fromEntries(proofNames.map((name) => [name, { candidate_verified: true }]));
  input.verifier = Object.fromEntries(proofNames.map((name) => [name, async () => "pass"]));
}

test("nearest-rank p95 retains incorrect work as infinity", () => {
  assert.equal(nearestRank95([]), null);
  assert.equal(nearestRank95([...Array(18).fill(1), Infinity]), Infinity);
});

test("the future V2 metrics contract has every core threshold", () => {
  for (const name of ["search", "answer", "source_to_candidate", "approval_ack", "approval_to_search"]) assert.ok(contract.thresholds[name]);
});

test("candidate self-attestation cannot award a result without independent verifiers", async () => {
  const input = fixture();
  input.proofs = Object.fromEntries(proofNames.map((name) => [name, { verified: true }]));
  const report = await scoreCoreMeasurements(input);
  assert.equal(report.measurement_verdict, "not-run");
  assert.equal(report.gates.find((gate) => gate.gate === "storage_fault_replay").verdict, "not-run");
});

test("independent durable and fault verifiers control the verdict", async () => {
  const input = fixture();
  independentlyVerifiedProofs(input);
  let report = await scoreCoreMeasurements(input);
  assert.equal(report.measurement_verdict, "pass");
  assert.equal(report.qualification, false);
  assert.equal(report.milestone_verdict, "not-run");
  input.verifier.storage_fault_replay = async () => "fail";
  report = await scoreCoreMeasurements(input);
  assert.equal(report.measurement_verdict, "fail");
});

test("missing and incorrect offered work stays in the denominator with infinite latency", async () => {
  const input = fixture();
  input.operations = input.operations.filter((entry) => entry.operation_id !== "direct_user_search");
  input.operations.find((entry) => entry.operation_id === "deterministic_answer").correct = false;
  independentlyVerifiedProofs(input);
  const report = await scoreCoreMeasurements(input);
  assert.equal(report.measurement_verdict, "fail");
  assert.equal(report.gates.find((gate) => gate.gate === "direct_user_search").p95_ms, "infinity");
  assert.equal(report.gates.find((gate) => gate.gate === "deterministic_answer").p95_ms, "infinity");
});

test("a missing population is NOT-RUN and history requires 100 percent success", async () => {
  const input = fixture();
  input.manifest.operations = input.manifest.operations.filter((entry) => entry.kind !== "canonical_approval");
  input.operations = input.operations.filter((entry) => entry.operation_id !== "canonical_approval");
  input.operations.find((entry) => entry.operation_id === "history_probe").correct = false;
  independentlyVerifiedProofs(input);
  const report = await scoreCoreMeasurements(input);
  assert.equal(report.gates.find((gate) => gate.gate === "canonical_approval").verdict, "not-run");
  assert.equal(report.gates.find((gate) => gate.gate === "history_probe").required_success_fraction, 1);
  assert.equal(report.measurement_verdict, "fail");
});

test("late completion is infinity and extra evidence cannot dilute a population", async () => {
  const input = fixture();
  input.operations.find((entry) => entry.operation_id === "direct_user_search").completed_monotonic_ms = 2_001;
  independentlyVerifiedProofs(input);
  const report = await scoreCoreMeasurements(input);
  assert.equal(report.gates.find((gate) => gate.gate === "direct_user_search").p95_ms, "infinity");
  input.operations.push({ operation_id: "extra", correct: true, completed_monotonic_ms: 1 });
  await assert.rejects(() => scoreCoreMeasurements(input), /Unplanned/);
});

test("unknown work, outside-run offers, and post-close completions cannot quietly pass", async () => {
  const input = fixture();
  independentlyVerifiedProofs(input);
  input.manifest.operations[0].kind = "unknown_work";
  await assert.rejects(() => scoreCoreMeasurements(input), /Invalid offered operation/);
  input.manifest.operations[0].kind = "direct_user_search";
  input.manifest.operations[0].offset_ms = contract.workload.run_duration_ms + 1;
  await assert.rejects(() => scoreCoreMeasurements(input), /Invalid offered operation/);
  input.manifest.operations[0].offset_ms = 0;
  input.operations.find((entry) => entry.operation_id === "direct_user_search").completed_monotonic_ms = input.run.closed_monotonic_ms + 1;
  const report = await scoreCoreMeasurements(input);
  assert.equal(report.gates.find((gate) => gate.gate === "direct_user_search").p95_ms, "infinity");
});

test("run-integrity and drain evidence are required, nonempty, and independently verified", async () => {
  const input = fixture();
  independentlyVerifiedProofs(input);
  input.proofs.run_integrity = {};
  let report = await scoreCoreMeasurements(input);
  assert.equal(report.gates.find((gate) => gate.gate === "run_integrity").verdict, "not-run");
  input.proofs.run_integrity = { sealed_trace_digest: "sha256:test" };
  input.verifier.drain_and_new_work = async () => "fail";
  report = await scoreCoreMeasurements(input);
  assert.equal(report.gates.find((gate) => gate.gate === "drain_and_new_work").verdict, "fail");
  assert.equal(report.measurement_verdict, "fail");
});
