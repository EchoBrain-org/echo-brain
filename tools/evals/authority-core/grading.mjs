import assert from "node:assert/strict";

const POPULATIONS = Object.freeze([
  ["direct_user_search", "search", false],
  ["availability_probe", "search", false],
  ["history_probe", "search", true],
  ["deterministic_answer", "answer", false],
  ["canonical_input", "source_to_candidate", false],
  ["canonical_approval", "approval_ack", false],
  ["approval_visibility", "approval_to_search", false],
]);

export function nearestRank95(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

function encoded(value) { return value === Infinity ? "infinity" : value; }
function validTime(value) { return Number.isFinite(value) && value >= 0; }

function latency(operation, result, run, threshold) {
  const started = run.started_monotonic_ms + operation.offset_ms;
  const finished = result?.completed_monotonic_ms;
  const elapsed = validTime(finished) && finished >= started && finished <= run.closed_monotonic_ms ? finished - started : Infinity;
  const deadline = threshold.completion_deadline_ms ?? threshold.observation_deadline_ms;
  return result?.correct === true && elapsed <= deadline ? elapsed : Infinity;
}

function populationGate(name, thresholdName, history, planned, observed, run, thresholds) {
  const threshold = thresholds[thresholdName];
  assert.ok(threshold, `Missing threshold ${thresholdName}`);
  if (planned.length === 0) return { gate: name, verdict: "not-run", planned: 0, reason: "No offered population" };
  const values = planned.map((operation) => latency(operation, observed.get(operation.id), run, threshold));
  const successful = values.filter(Number.isFinite).length;
  const fraction = successful / planned.length;
  const p95 = nearestRank95(values);
  const minimum = history ? 1 : threshold.verified_success_fraction_min;
  return {
    gate: name,
    verdict: p95 <= threshold.p95_ms_max && fraction >= minimum ? "pass" : "fail",
    planned: planned.length,
    successful,
    failures_or_unfinished: planned.length - successful,
    success_fraction: fraction,
    required_success_fraction: minimum,
    p95_ms: encoded(p95),
    p95_ms_max: threshold.p95_ms_max,
  };
}

async function proofGates({ contract, manifest, operations, run, proofs, verifier }) {
  const faultProofs = contract.correctness?.fault_proofs;
  assert.ok(Array.isArray(faultProofs) && faultProofs.length > 0, "correctness.fault_proofs is required");
  const names = faultProofs;
  assert.ok(names.includes("run_integrity") && names.includes("drain_and_new_work"), "run integrity and drain proofs are required");
  assert.equal(new Set(names).size, names.length, "Independent proof names must be unique");
  const gates = [];
  for (const name of names) {
    const evidence = proofs?.[name];
    const check = verifier?.[name];
    const nonEmpty = evidence !== null && evidence !== undefined &&
      (typeof evidence !== "object" || Array.isArray(evidence) ? Boolean(evidence?.length) : Object.keys(evidence).length > 0);
    if (!nonEmpty || typeof check !== "function") {
      gates.push({ gate: name, verdict: "not-run", reason: "Independent evidence and verifier required" });
      continue;
    }
    const verdict = await check(evidence, { contract, manifest, operations, run });
    assert.ok(["pass", "fail", "inconclusive"].includes(verdict), "Proof verifier must return an explicit verdict");
    gates.push({ gate: name, verdict });
  }
  return gates;
}

/**
 * Diagnostic arithmetic over supplied measurements. `run_integrity` must be a
 * real verifier of the artifact, profile, sealed trace, environment, resource
 * budget, offered population, and result evidence. The milestone protocol and
 * that verifier are intentionally not implemented here, so this function can
 * never issue a qualification result.
 */
export async function scoreCoreMeasurements({ contract, manifest, operations, run, proofs, verifier } = {}) {
  assert.ok(contract?.thresholds && Array.isArray(manifest?.operations) && Array.isArray(operations));
  assert.ok(validTime(run?.started_monotonic_ms) && validTime(run?.closed_monotonic_ms) && run.closed_monotonic_ms >= run.started_monotonic_ms, "Run clock is invalid");
  const allowedKinds = contract.correctness?.operation_kinds;
  assert.ok(Array.isArray(allowedKinds) && allowedKinds.length > 0, "correctness.operation_kinds is required");
  const observed = new Map();
  for (const result of operations) {
    assert.ok(typeof result?.operation_id === "string" && result.operation_id.length > 0 && !observed.has(result.operation_id), "Duplicate or invalid operation evidence");
    observed.set(result.operation_id, result);
  }
  const plannedIds = new Set();
  for (const operation of manifest.operations) {
    assert.ok(
      typeof operation?.id === "string" && operation.id.length > 0 &&
      !plannedIds.has(operation.id) && allowedKinds.includes(operation.kind) &&
      validTime(operation.offset_ms) && operation.offset_ms <= contract.workload.run_duration_ms,
      "Invalid offered operation",
    );
    plannedIds.add(operation.id);
  }
  for (const id of observed.keys()) assert.ok(plannedIds.has(id), "Unplanned operation evidence cannot dilute the denominator");

  const gates = POPULATIONS.map(([name, threshold, history]) => populationGate(
    name, threshold, history, manifest.operations.filter((operation) => operation.kind === name), observed, run, contract.thresholds,
  ));
  const elapsed = run.closed_monotonic_ms - run.started_monotonic_ms;
  gates.push({ gate: "run_duration", verdict: run.clock === "real-monotonic" && elapsed >= contract.workload.run_duration_ms ? "pass" : "not-run", elapsed_ms: elapsed });
  gates.push(...await proofGates({ contract, manifest, operations, run, proofs, verifier }));
  const verdict = gates.some((gate) => gate.verdict === "fail") ? "fail"
    : gates.some((gate) => gate.verdict === "not-run") ? "not-run"
      : gates.some((gate) => gate.verdict === "inconclusive") ? "inconclusive" : "pass";
  return Object.freeze({
    kind: "authority-core-runtime-measurement-v2",
    metric_contract_digest: contract.profile_pin?.sha256 ?? null,
    qualification: false,
    milestone_verdict: "not-run",
    measurement_verdict: verdict,
    gates,
  });
}
