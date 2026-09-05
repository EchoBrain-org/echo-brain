import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gradeCapacityRun, nearestRank95 } from "../grading.mjs";

const contract = JSON.parse(readFileSync(new URL("../metrics.v1.json", import.meta.url)));
function fixture() {
  const operations = ["direct_user_search", "availability_probe", "history_probe", "answer", "source_revision"].map((kind, index) => ({ id: String(index), kind, offset_ms: index * 100, planned_scripted_wait_ms: kind === "answer" ? 10000 : 0 }));
  return {
    contract,
    manifest: { operations, approval_plan: [{ source_operation_id: "4", action: "approve", offer_after_complete_card_ms: 30000, publication_semantic_root: "publication:4" }], planned_scripted_wait_samples: [{ semantic_root: "publication:4", prescribed_wait_ms: 2000 }] },
    operations: [...operations.map((operation) => ({ operation_id: operation.id, correct: true, completed_monotonic_ms: operation.offset_ms + (operation.kind === "answer" ? 11000 : 100), observed_provider_wait_ms: operation.planned_scripted_wait_ms })), { operation_id: "approval:4", correct: true, offered_monotonic_ms: 30500, completed_monotonic_ms: 33000, observed_provider_wait_ms: 2000 }],
    run: { started_monotonic_ms: 0, closed_monotonic_ms: contract.workload.run_duration_ms, clock: "real-monotonic" },
  };
}

test("nearest-rank p95 counts failures as infinity rather than dropping them", () => {
  assert.equal(nearestRank95([]), null);
  assert.equal(nearestRank95([...Array(18).fill(1), Infinity]), Infinity);
});

test("excellent latency numbers and self-reported flags cannot award a milestone", async () => {
  const input = fixture();
  input.proofs = { all_good: true };
  const report = await gradeCapacityRun(input);
  assert.equal(report.verdict, "not-run");
  assert.equal(report.gates.find((gate) => gate.gate === "operation_release_and_audit").verdict, "not-run");
});

test("missing and wrong results remain in the offered denominator", async () => {
  const input = fixture();
  input.operations = input.operations.filter((operation) => operation.operation_id !== "0");
  input.operations.find((operation) => operation.operation_id === "3").correct = false;
  const report = await gradeCapacityRun(input);
  assert.equal(report.verdict, "fail");
  assert.equal(report.gates.find((gate) => gate.gate === "direct_user_search").p95_ms, "infinity");
  assert.equal(report.gates.find((gate) => gate.gate === "answer").success_fraction, 0);
});

test("scripted waits are diagnostic and never subtracted from end-to-end latency", async () => {
  const input = fixture();
  input.operations.find((operation) => operation.operation_id === "3").completed_monotonic_ms = 16300;
  const report = await gradeCapacityRun(input);
  assert.equal(report.gates.find((gate) => gate.gate === "answer").verdict, "fail");
  assert.equal(report.diagnostics.find((value) => value.population === "answer").prescribed_scripted_wait_p95_ms, 10000);
});

test("unexpected extra successful operations cannot dilute rates", async () => {
  const input = fixture();
  input.operations.push({ operation_id: "unplanned", correct: true });
  await assert.rejects(() => gradeCapacityRun(input), /Unplanned/);
});

test("a shortened run cannot qualify despite successful samples", async () => {
  const input = fixture();
  input.run.closed_monotonic_ms = 1000;
  const report = await gradeCapacityRun(input);
  assert.equal(report.gates.find((gate) => gate.gate === "real-eight-hour-run").verdict, "not-run");
});

test("a missing card creates no approval sample; skipping an available card fails", async () => {
  const input = fixture();
  input.operations = input.operations.filter((operation) => operation.operation_id !== "approval:4");
  const skipped = await gradeCapacityRun(input);
  assert.equal(skipped.gates.find((gate) => gate.gate === "dependent-approval-offers").verdict, "fail");
  input.operations = input.operations.filter((operation) => operation.operation_id !== "4");
  const missing = await gradeCapacityRun(input);
  assert.equal(missing.gates.find((gate) => gate.gate === "approval").planned, 0);
  assert.equal(missing.gates.find((gate) => gate.gate === "source_revision").verdict, "fail");
});

test("approval must follow a complete card and includes driver dispatch delay", async () => {
  const input = fixture();
  const approval = input.operations.find((operation) => operation.operation_id === "approval:4");
  approval.offered_monotonic_ms = 100;
  await assert.rejects(() => gradeCapacityRun(input), /cannot precede/);
  approval.offered_monotonic_ms = 80000;
  approval.completed_monotonic_ms = 91000;
  const report = await gradeCapacityRun(input);
  assert.equal(report.gates.find((gate) => gate.gate === "approval").p95_ms, 60500);
  assert.equal(report.gates.find((gate) => gate.gate === "approval").verdict, "fail");
});

test("a correct result after its deadline is a timeout with infinite latency", async () => {
  const input = fixture();
  input.operations.find((operation) => operation.operation_id === "0").completed_monotonic_ms = 2001;
  const report = await gradeCapacityRun(input);
  const gate = report.gates.find((entry) => entry.gate === "direct_user_search");
  assert.equal(gate.p95_ms, "infinity");
  assert.equal(gate.successful, 0);
});
