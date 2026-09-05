import assert from "node:assert/strict";

export function nearestRank95(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(0.95 * ordered.length) - 1];
}

function encodedLatency(value) { return value === Infinity ? "infinity" : value; }

function prescribedWait(operation, manifest) {
  const root = operation.internal?.semantic_root;
  if (root !== undefined) {
    const samples = (manifest.planned_scripted_wait_samples ?? []).filter((sample) => sample.semantic_root === root);
    if (samples.length > 0 && samples.every((sample) => Number.isFinite(sample.prescribed_wait_ms) && sample.prescribed_wait_ms >= 0)) {
      return samples.reduce((sum, sample) => sum + sample.prescribed_wait_ms, 0);
    }
  }
  if (["direct_user_search", "availability_probe", "history_probe"].includes(operation.kind)) return 0;
  return operation.planned_scripted_wait_ms;
}

/** Dependent actions use the sealed source decision and independently observed complete card. */
function dependentApprovals(manifest, byId, contract, run) {
  const planned = [];
  const known = new Set();
  const missingOffers = [];
  for (const decision of manifest.approval_plan ?? []) {
    assert.ok(!known.has(decision.source_operation_id), "Duplicate dependent decision");
    known.add(decision.source_operation_id);
    const source = manifest.operations.find((entry) => entry.id === decision.source_operation_id);
    assert.equal(source?.kind, "source_revision", "Dependent decision must name a sealed source");
    assert.ok(decision.action === "approve" || decision.action === "reject");
    assert.equal(decision.offer_after_complete_card_ms, contract.workload.approval_delay_after_card_ms);
    const id = `approval:${source.id}`;
    const observed = byId.get(id);
    const card = byId.get(source.id);
    const complete = card?.correct === true && Number.isFinite(card.completed_monotonic_ms);
    if (observed !== undefined) {
      assert.equal(decision.action, "approve", "Reject action cannot create approval latency evidence");
      assert.ok(complete, "Approval requires an independently verified content-complete card");
      assert.ok(Number.isFinite(observed.offered_monotonic_ms) && observed.offered_monotonic_ms >= card.completed_monotonic_ms + decision.offer_after_complete_card_ms, "Approval cannot precede complete card plus the prescribed delay");
      planned.push({ id, kind: "approval", offset_ms: card.completed_monotonic_ms + decision.offer_after_complete_card_ms - run.started_monotonic_ms, internal: { semantic_root: decision.publication_semantic_root } });
    } else if (decision.action === "approve" && complete) {
      missingOffers.push(id);
    }
  }
  return { planned, missingOffers };
}

/**
 * Pure arithmetic over verifier evidence. This cannot authenticate evidence or
 * award qualification on its own. Missing independent proof functions leave
 * the overall result NOT-RUN, even if every reported latency looks excellent.
 */
export async function gradeCapacityRun({ contract, manifest, operations, run, proofs, verifier } = {}) {
  assert.ok(contract && manifest && Array.isArray(manifest.operations) && Array.isArray(operations));
  const byId = new Map();
  for (const operation of operations) {
    assert.ok(!byId.has(operation.operation_id), "Duplicate operation evidence");
    byId.set(operation.operation_id, operation);
  }
  assert.ok(manifest.operations.every((operation) => operation.kind !== "approval"), "Approvals must depend on complete cards, never a fixed manifest offset");
  const dependent = dependentApprovals(manifest, byId, contract, run);
  const allPlanned = [...manifest.operations, ...dependent.planned];
  const plannedIds = new Set(allPlanned.map((operation) => operation.id));
  for (const id of byId.keys()) assert.ok(plannedIds.has(id), "Unplanned operation evidence cannot dilute the denominator");

  const gates = [{ gate: "dependent-approval-offers", verdict: dependent.missingOffers.length === 0 ? "pass" : "fail", missing_offers: dependent.missingOffers }];
  const diagnostics = [];
  const populations = [
    ["direct_user_search", "search", false],
    ["availability_probe", "search", false],
    ["history_probe", "search", true],
    ["answer", "answer", false],
    ["source_revision", "source_to_card", false],
    ["approval", "approval_to_search", false],
  ];
  for (const [population, thresholdName, allMustSucceed] of populations) {
    const planned = allPlanned.filter((operation) => operation.kind === population);
    const threshold = contract.thresholds[thresholdName];
    const latencies = [];
    const prescribed = [];
    const observed = [];
    let successful = 0;
    let failures = 0;
    let missingWaits = 0;
    for (const operation of planned) {
      const result = byId.get(operation.id);
      const finish = result?.completed_monotonic_ms;
      const start = run.started_monotonic_ms + operation.offset_ms;
      const deadline = threshold.completion_deadline_ms ?? threshold.observation_deadline_ms;
      const elapsed = Number.isFinite(finish) && finish >= start && (result.offered_monotonic_ms === undefined || finish >= result.offered_monotonic_ms) ? finish - start : Infinity;
      const latency = result?.correct === true && elapsed <= deadline ? elapsed : Infinity;
      latencies.push(latency);
      if (latency <= deadline) successful += 1;
      else failures += 1;
      const wait = prescribedWait(operation, manifest);
      if (Number.isFinite(wait) && wait >= 0) prescribed.push(wait);
      else missingWaits += 1;
      if (Number.isFinite(result?.observed_provider_wait_ms) && result.observed_provider_wait_ms >= 0) observed.push(result.observed_provider_wait_ms);
    }
    const p95 = nearestRank95(latencies);
    const rate = planned.length === 0 ? null : successful / planned.length;
    const requiredRate = allMustSucceed ? 1 : threshold.verified_success_fraction_min;
    const verdict = planned.length === 0 ? "not-run" : p95 <= threshold.p95_ms_max && (requiredRate === undefined || rate >= requiredRate) ? "pass" : "fail";
    gates.push({ gate: population, verdict, planned: planned.length, successful, failures_or_unfinished: failures, success_fraction: rate, p95_ms: encodedLatency(p95), p95_ms_max: threshold.p95_ms_max, required_success_fraction: requiredRate ?? null });
    diagnostics.push({ population, prescribed_scripted_wait_p95_ms: nearestRank95(prescribed), prescribed_sample_count: prescribed.length, prescribed_missing_count: missingWaits, observed_provider_wait_p95_ms: nearestRank95(observed), observed_sample_count: observed.length, observed_missing_count: planned.length - observed.length });
  }

  const elapsed = run.closed_monotonic_ms - run.started_monotonic_ms;
  gates.push({ gate: "real-eight-hour-run", verdict: run.clock === "real-monotonic" && elapsed >= contract.workload.run_duration_ms ? "pass" : "not-run", elapsed_ms: elapsed });
  gates.push({ gate: "required-scripted-wait-diagnostics", verdict: diagnostics.every((value) => value.prescribed_missing_count === 0) ? "pass" : "not-run" });
  const proofNames = ["registration_and_profile", "environment_and_isolation", "manifest_and_load", "operation_release_and_audit", "corpus_and_generation", "provider_effect_budgets", "timed_permissions_and_crash", "process_and_storage_faults", "drain_and_new_work", "repository_checks"];
  for (const name of proofNames) {
    const evidence = proofs?.[name];
    const check = verifier?.[name];
    if (evidence === undefined || typeof check !== "function") {
      gates.push({ gate: name, verdict: "not-run", reason: "Independent evidence and verifier required" });
      continue;
    }
    const result = await check(evidence, { contract, manifest, operations, run });
    assert.ok(result === "pass" || result === "fail" || result === "inconclusive", "Proof verifier must return an explicit verdict");
    gates.push({ gate: name, verdict: result });
  }
  // A measured failure survives a later missing proof or infrastructure fault.
  const verdict = gates.some((gate) => gate.verdict === "fail") ? "fail"
    : gates.some((gate) => gate.verdict === "not-run") ? "not-run"
      : gates.some((gate) => gate.verdict === "inconclusive") ? "inconclusive" : "pass";
  return Object.freeze({ kind: "authority-capacity-verifier-report-v1", metric_contract_digest: contract.profile_pin.sha256, verdict, gates, diagnostics });
}
