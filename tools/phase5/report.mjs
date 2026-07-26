/**
 * Machine checks that a darwin/x64 one-machine rehearsal can complete.
 * Their order is part of the report contract so reports are deterministic.
 */
export const PASSING_CHECK_IDS = Object.freeze([
  "P5-ART-001",
  "P5-ART-002",
  "P5-ART-003",
  "P5-ART-004",
  "P5-ISO-001",
  "P5-ISO-002",
  "P5-EDGE-001",
  "P5-ENR-001",
  "P5-ENR-002",
  "P5-ENR-003",
  "P5-ACC-001",
  "P5-ACC-002",
  "P5-ACC-003",
  "P5-RST-001",
  "P5-RST-002",
  "P5-RST-003",
  "P5-STO-001",
  "P5-REV-001",
  "P5-REV-002",
  "P5-REV-003",
  "P5-REV-004",
  "P5-SEC-001",
  "P5-SEC-002",
]);

/**
 * Physical/target checks that this report must leave visibly blocked. A
 * one-machine rehearsal is useful evidence, but it can never close Phase 5.
 */
export const BLOCKED_CHECK_REASON_BY_ID = Object.freeze({
  "P5-PLAT-001": "declared_arm64_runtime_unavailable",
  "P5-KEY-001": "secure_enclave_unavailable",
  "P5-PHY-001": "single_physical_host",
  "P5-NET-001": "rehearsal_edge_not_production_tls",
  "P5-TRUST-001": "pin_handoff_not_independent",
});

export const BLOCKED_CHECK_IDS = Object.freeze(
  Object.keys(BLOCKED_CHECK_REASON_BY_ID),
);

export const ALL_CHECK_IDS = Object.freeze([
  ...PASSING_CHECK_IDS,
  ...BLOCKED_CHECK_IDS,
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Builds the fixed check vector from safe, hash-only evidence bindings.
 *
 * `passingEvidence` must contain exactly one object for every passing check:
 * `{ observed_at: string, evidence_sha256: string }`.
 */
export function buildOneMachineRehearsalChecks({
  passingEvidence,
  blockedObservedAt,
}) {
  if (!isRecord(passingEvidence)) {
    throw new Error("passingEvidence must be one object");
  }
  const supplied = Object.keys(passingEvidence);
  const unexpected = supplied.filter((id) => !PASSING_CHECK_IDS.includes(id));
  if (unexpected.length > 0) {
    throw new Error(
      `passingEvidence contains unexpected checks: ${unexpected.sort().join(", ")}`,
    );
  }
  const missing = PASSING_CHECK_IDS.filter(
    (id) => !Object.hasOwn(passingEvidence, id),
  );
  if (missing.length > 0) {
    throw new Error(`passingEvidence is missing checks: ${missing.join(", ")}`);
  }

  const passing = PASSING_CHECK_IDS.map((id) => {
    const evidence = passingEvidence[id];
    if (!isRecord(evidence)) {
      throw new Error(`passingEvidence ${id} must be one object`);
    }
    return {
      id,
      status: "pass",
      observed_at: evidence.observed_at,
      evidence_sha256: evidence.evidence_sha256,
    };
  });
  const blocked = BLOCKED_CHECK_IDS.map((id) => ({
    id,
    status: "blocked",
    observed_at: blockedObservedAt,
    reason_code: BLOCKED_CHECK_REASON_BY_ID[id],
  }));
  return [...passing, ...blocked];
}

/**
 * Creates the closed, non-qualifying Phase 5 rehearsal record. Call
 * `validateOneMachineRehearsalReport` before persisting it.
 */
export function createOneMachineRehearsalReport(input) {
  if (!isRecord(input)) {
    throw new Error("one-machine rehearsal report input must be one object");
  }
  return {
    schema_version: 1,
    kind: "echo-phase5-one-machine-rehearsal",
    result: "rehearsal_passed",
    phase5_gate: "incomplete",
    source_sha: input.source_sha,
    run_id: input.run_id,
    started_at: input.started_at,
    completed_at: input.completed_at,
    host: clone(input.host),
    artifacts: clone(input.artifacts),
    topology: clone(input.topology),
    unexpected_skip_count: 0,
    checks: buildOneMachineRehearsalChecks({
      passingEvidence: input.passing_evidence,
      blockedObservedAt: input.completed_at,
    }),
  };
}
