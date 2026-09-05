#!/usr/bin/env node

/**
 * Lifecycle primitives for the verifier-owned capacity runner.
 *
 * This is not an Authority benchmark and does not start a candidate, fixture,
 * or server. It makes the ordering and accounting rules executable so the
 * later registry, fixture, oracle, and process supervisor cannot accidentally
 * award a result from a revealed trace or a completion-driven load generator.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightQualificationEnvironment } from "./environment.mjs";
import { generateM1Manifest, loadCapacityContract, plannedWaitDiagnostics } from "./manifest-v1.mjs";
import { createAnchoredRegistry } from "./registry.mjs";

const CANDIDATE_DIGEST = /^[a-f0-9]{64}$/;
const ORDINARY_KINDS = new Set(["source_revision", "direct_user_search", "availability_probe", "history_probe", "answer"]);
const DENOMINATOR_EXCLUDED_KINDS = new Set(["timed_permission_probe", "approval_visibility_poll", "fault_observation"]);
const SEALED_STATE_KIND = "authority-capacity-sealed-run-state-v1";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(`capacity runner: ${message}`);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !CANDIDATE_DIGEST.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function publicOperation(operation) {
  const { internal, peak, verifier_only, ...candidateVisible } = operation;
  return deepFreeze(candidateVisible);
}

function normalPopulation(kind) {
  return ORDINARY_KINDS.has(kind);
}

/**
 * Validate the minimal manifest shape before it is sealed.  All normal work
 * must be predeclared, and no operation can opt out of its population later.
 */
export function validateSealedManifest(manifest, contract, { milestoneId, qualification = false } = {}) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) fail("sealed manifest must be an object");
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) fail("sealed manifest.operations must be non-empty");
  if (!Number.isInteger(manifest.peak_start_ms) || manifest.peak_start_ms < contract.workload.peak_start_window_ms[0] || manifest.peak_start_ms > contract.workload.peak_start_window_ms[1]) {
    fail("sealed manifest peak_start_ms is outside the contract window");
  }
  const seen = new Set();
  const populations = new Map();
  for (const operation of manifest.operations) {
    if (operation === null || typeof operation !== "object" || Array.isArray(operation)) fail("each sealed operation must be an object");
    if (typeof operation.id !== "string" || operation.id.length === 0 || seen.has(operation.id)) fail("operation ids must be unique non-empty strings");
    seen.add(operation.id);
    if (typeof operation.kind !== "string" || (!normalPopulation(operation.kind) && !DENOMINATOR_EXCLUDED_KINDS.has(operation.kind))) {
      fail(`operation ${operation.id} has an unknown kind`);
    }
    if (!Number.isInteger(operation.offset_ms) || operation.offset_ms < 0 || operation.offset_ms > contract.workload.run_duration_ms) {
      fail(`operation ${operation.id} offset_ms is outside the timed run`);
    }
    if (typeof operation.population !== "string" || operation.population.length === 0) fail(`operation ${operation.id} population is required`);
    if (normalPopulation(operation.kind) && operation.denominator !== "ordinary") fail(`ordinary operation ${operation.id} must have denominator=ordinary`);
    if (DENOMINATOR_EXCLUDED_KINDS.has(operation.kind) && operation.denominator !== "excluded") fail(`excluded operation ${operation.id} must have denominator=excluded`);
    populations.set(operation.population, (populations.get(operation.population) ?? 0) + 1);
  }
  for (const kind of ["direct_user_search", "availability_probe", "answer"]) {
    if (!manifest.operations.some((operation) => operation.kind === kind && operation.denominator === "ordinary")) {
      fail(`sealed manifest has no ordinary ${kind} operations`);
    }
  }
  if (!manifest.operations.some((operation) => operation.kind === "timed_permission_probe" && operation.denominator === "excluded")) {
    fail("sealed manifest has no timed permission probe");
  }
  if (!manifest.operations.some((operation) => operation.kind === "fault_observation" && operation.fault === "candidate-cgroup-kill")) {
    fail("sealed manifest has no candidate-cgroup kill observation");
  }
  if (qualification) {
    const milestone = contract.milestones.find((entry) => entry.id === milestoneId);
    if (milestone === undefined) fail(`qualification manifest has an unknown milestone ${milestoneId}`);
    const expectedCounts = new Map([
      ["source_revision", milestone.peak_day_meetings],
      ["direct_user_search", milestone.peak_day_user_searches],
      ["availability_probe", contract.workload.run_duration_ms / contract.workload.availability_probe_interval_ms],
      ["history_probe", milestone.history_probe_count + contract.workload.history_negative_probes_extra],
      ["answer", milestone.peak_day_answers],
      ["timed_permission_probe", contract.correctness.timed_permission_cases],
    ]);
    for (const [kind, expected] of expectedCounts) {
      const actual = manifest.operations.filter((operation) => operation.kind === kind).length;
      if (actual !== expected) fail(`qualification manifest ${milestoneId} must contain exactly ${expected} ${kind} operations; found ${actual}`);
    }
    const kills = manifest.operations.filter((operation) => operation.kind === "fault_observation" && operation.fault === "candidate-cgroup-kill").length;
    if (kills !== contract.correctness.timed_kill.count) fail(`qualification manifest ${milestoneId} must contain exactly ${contract.correctness.timed_kill.count} candidate-cgroup kill observation`);
  }
  return deepFreeze({ ...manifest, operations: [...manifest.operations].sort((left, right) => left.offset_ms - right.offset_ms || left.id.localeCompare(right.id)) });
}

function createNonce(randomBytes) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail("nonce source did not return bytes");
  if (bytes.byteLength < 32) fail("nonce source returned fewer than 32 bytes");
  return Buffer.from(bytes).subarray(0, 32).toString("hex");
}

function diagnosticPlan(contract, milestoneId) {
  const milestone = contract.milestones.find((candidate) => candidate.id === milestoneId);
  if (milestone === undefined) fail(`unknown milestone ${milestoneId}`);
  return deepFreeze({
    kind: "authority-capacity-dry-run-plan-v1",
    milestone: milestone.id,
    verdict: "not-run",
    run_duration_ms: contract.workload.run_duration_ms,
    hidden_peak_window_ms: contract.workload.peak_start_window_ms,
    required_preconditions: contract.qualification_prerequisites,
    expected_peak_day_counts: {
      source_revisions: milestone.peak_day_meetings,
      answers: milestone.peak_day_answers,
      direct_user_searches: milestone.peak_day_user_searches,
      availability_probes: contract.workload.run_duration_ms / contract.workload.availability_probe_interval_ms,
      timed_permission_probes: contract.correctness.timed_permission_cases,
      candidate_cgroup_kills: contract.correctness.timed_kill.count,
    },
    note: "No candidate, manifest, fixture, oracle, or metric result was run.",
  });
}

/**
 * `registry`, `externalRegistry`, and `ledger` are deliberately injected
 * verifier-owned ports. A local append-only registry is not sufficient to
 * qualify: externalRegistry.verifyRegistration must independently verify each
 * registration/commitment receipt before the candidate can progress.
 * Required registry methods: registerCandidate, commitManifest, revealManifest.
 * Required externalRegistry method: verifyRegistration.
 * Required ledger methods: appendOffer, appendCompletion.
 */
export function createQualificationLifecycle({ contract, registry, externalRegistry, ledger, randomBytes = nodeRandomBytes, monotonicNow = () => performance.now() } = {}) {
  if (contract === undefined) fail("metric contract is required");
  let phase = "new";
  let candidate;
  let sealed;
  let runStartedAt;
  let lastOfferAt;
  const offered = new Map();
  const completions = new Map();

  const assertPhase = (...allowed) => {
    if (!allowed.includes(phase)) fail(`operation is not allowed in lifecycle phase ${phase}`);
  };
  const requireRegistry = (name) => {
    if (registry === undefined || typeof registry[name] !== "function") fail(`verifier-owned registry.${name} is required`);
  };
  const requireLedger = (name) => {
    if (ledger === undefined || typeof ledger[name] !== "function") fail(`external ledger.${name} is required`);
  };
  const verifyExternalRegistration = async (value) => {
    if (externalRegistry === undefined || typeof externalRegistry.verifyRegistration !== "function") {
      fail("independent externalRegistry.verifyRegistration is required before qualification can proceed");
    }
    if (await externalRegistry.verifyRegistration(value) !== true) {
      fail(`independent external registry rejected ${value.stage}`);
    }
  };

  return Object.freeze({
    get phase() { return phase; },
    get candidate() { return candidate === undefined ? undefined : deepFreeze({ ...candidate }); },
    get manifestCommitment() { return sealed?.commitment; },

    exportSealedState() {
      assertPhase("sealed", "preflight-ready");
      return deepFreeze({
        kind: SEALED_STATE_KIND,
        metric_contract_digest: contract.profile_pin.sha256,
        candidate,
        manifest: sealed.manifest,
        manifest_digest: sealed.manifest_digest,
        commitment: sealed.commitment,
        salt: sealed.salt,
        manifest_commitment: sealed.commitment_receipt,
        generator: "authority-capacity-manifest-v1",
      });
    },

    async registerCandidate(registration) {
      assertPhase("new");
      if (registration === null || typeof registration !== "object") fail("candidate registration is required");
      const candidateDigest = assertDigest(registration.candidate_digest, "candidate_digest");
      assertDigest(registration.source_digest, "source_digest");
      assertDigest(registration.config_digest, "config_digest");
      if (!contract.milestones.some((milestone) => milestone.id === registration.milestone)) fail("candidate registration milestone must be a metric-contract milestone");
      requireRegistry("registerCandidate");
      const submitted = deepFreeze({
        candidate_digest: candidateDigest,
        source_digest: registration.source_digest,
        config_digest: registration.config_digest,
        metric_contract_digest: contract.profile_pin.sha256,
        milestone: registration.milestone,
      });
      const receipt = await registry.registerCandidate(submitted);
      if (receipt === undefined || receipt === null || typeof receipt !== "object") fail("registry did not return a candidate registration receipt");
      await verifyExternalRegistration(deepFreeze({
        stage: "candidate-registration",
        candidate: submitted,
        receipt,
      }));
      candidate = deepFreeze({ ...submitted, registry_receipt: receipt });
      phase = "candidate-registered";
      return candidate;
    },

    /** Generate only after candidate registration, then commit before start. */
    async sealManifest(generateManifest) {
      assertPhase("candidate-registered");
      if (typeof generateManifest !== "function") fail("sealed manifest generator is required");
      requireRegistry("commitManifest");
      const sealingMaterial = randomBytes(32);
      if (!Buffer.isBuffer(sealingMaterial) && !(sealingMaterial instanceof Uint8Array)) fail("sealing material source did not return bytes");
      const generated = await generateManifest(deepFreeze({ ...candidate }), Buffer.from(sealingMaterial));
      const manifest = validateSealedManifest(generated, contract, { milestoneId: candidate.milestone, qualification: true });
      const manifestDigest = sha256(canonicalJson(manifest));
      const salt = createNonce(randomBytes);
      const commitment = sha256(`${manifestDigest}:${salt}`);
      const receipt = await registry.commitManifest(deepFreeze({
        candidate_registration: candidate.registry_receipt,
        manifest_digest: manifestDigest,
        commitment,
      }));
      if (receipt === undefined || receipt === null || typeof receipt !== "object") fail("registry did not return a manifest commitment receipt");
      await verifyExternalRegistration(deepFreeze({
        stage: "manifest-commitment",
        candidate_registration: candidate.registry_receipt,
        manifest_digest: manifestDigest,
        commitment,
        receipt,
      }));
      sealed = deepFreeze({ manifest, manifest_digest: manifestDigest, commitment, commitment_receipt: receipt, salt });
      phase = "sealed";
      return deepFreeze({ manifest_digest: manifestDigest, commitment, commitment_receipt: receipt });
    },

    async preflight(environment) {
      assertPhase("sealed");
      const result = await preflightQualificationEnvironment({ ...environment, contract, candidateDigest: candidate.candidate_digest });
      if (!result.qualifying) return result;
      phase = "preflight-ready";
      return result;
    },

    startTimedRun(now = monotonicNow()) {
      assertPhase("preflight-ready");
      if (!Number.isFinite(now)) fail("timed run must start with an external monotonic timestamp");
      runStartedAt = now;
      lastOfferAt = now;
      phase = "running";
      return deepFreeze({ run_started_monotonic_ms: now, operations_planned: sealed.manifest.operations.length });
    },

    /**
     * Offers are selected solely by elapsed monotonic time. This never looks at
     * completions, so candidate back-pressure cannot delete scheduled load.
     */
    async offerDue(now = monotonicNow()) {
      assertPhase("running");
      if (!Number.isFinite(now)) fail("offer time must be monotonic milliseconds");
      if (now < lastOfferAt) fail("offer time moved backwards; monotonic driver time is required");
      requireLedger("appendOffer");
      const elapsed = now - runStartedAt;
      const due = sealed.manifest.operations.filter((operation) => operation.offset_ms <= elapsed && !offered.has(operation.id));
      const results = [];
      for (const operation of due) {
        const nonce = createNonce(randomBytes);
        const offeredAt = now;
        const offer = deepFreeze({
          operation_id: operation.id,
          nonce,
          offered_monotonic_ms: offeredAt,
          scheduled_monotonic_ms: runStartedAt + operation.offset_ms,
          offer_lag_ms: offeredAt - (runStartedAt + operation.offset_ms),
          operation: publicOperation(operation),
        });
        const receipt = await ledger.appendOffer(offer);
        if (receipt === undefined || receipt === null) fail(`external ledger did not acknowledge offer ${operation.id}`);
        offered.set(operation.id, deepFreeze({ ...offer, ledger_receipt: receipt }));
        results.push(offer);
      }
      lastOfferAt = now;
      return deepFreeze(results);
    },

    async recordCompletion({ operation_id: operationId, nonce, completed_monotonic_ms: completedAt = monotonicNow(), correct, response_digest: responseDigest, release_audit_digest: auditDigest, status } = {}) {
      assertPhase("running");
      requireLedger("appendCompletion");
      const offer = offered.get(operationId);
      if (offer === undefined) fail(`cannot complete unoffered operation ${operationId}`);
      if (offer.nonce !== nonce) fail(`nonce does not match offer ${operationId}`);
      if (completions.has(operationId)) fail(`operation ${operationId} already has a completion`);
      if (!Number.isFinite(completedAt) || completedAt < offer.offered_monotonic_ms) fail(`completion ${operationId} has an invalid monotonic timestamp`);
      if (typeof correct !== "boolean" || typeof status !== "string") fail(`completion ${operationId} must provide boolean correct and status`);
      assertDigest(responseDigest, `completion ${operationId} response_digest`);
      assertDigest(auditDigest, `completion ${operationId} release_audit_digest`);
      const completion = deepFreeze({
        operation_id: operationId,
        nonce,
        completed_monotonic_ms: completedAt,
        latency_ms: correct ? completedAt - offer.scheduled_monotonic_ms : Infinity,
        response_after_offer_ms: completedAt - offer.offered_monotonic_ms,
        correct,
        status,
        response_digest: responseDigest,
        release_audit_digest: auditDigest,
      });
      const receipt = await ledger.appendCompletion(completion);
      if (receipt === undefined || receipt === null) fail(`external ledger did not acknowledge completion ${operationId}`);
      completions.set(operationId, deepFreeze({ ...completion, ledger_receipt: receipt }));
      return completion;
    },

    /** Freeze accounting. Unoffered and unfinished ordinary work are retained. */
    closeTimedRun(now = monotonicNow()) {
      assertPhase("running");
      if (!Number.isFinite(now) || now < lastOfferAt) fail("run close time must be a monotonic timestamp after the final offer");
      if (now < runStartedAt + contract.workload.run_duration_ms) fail("cannot close a timed run before its scheduled eight-hour arrival trace ends");
      phase = "closed";
      const operations = sealed.manifest.operations.map((operation) => {
        const offer = offered.get(operation.id);
        const completion = completions.get(operation.id);
        const normal = operation.denominator === "ordinary";
        return deepFreeze({
          operation_id: operation.id,
          kind: operation.kind,
          population: operation.population,
          denominator: operation.denominator,
          scheduled_monotonic_ms: runStartedAt + operation.offset_ms,
          offered: offer !== undefined,
          completed: completion !== undefined,
          correct: completion?.correct ?? false,
        latency_ms: completion?.latency_ms ?? Infinity,
        response_after_offer_ms: completion?.response_after_offer_ms ?? Infinity,
          ordinary_unfinished: normal && completion === undefined,
          offer_lag_ms: offer?.offer_lag_ms ?? Infinity,
        });
      });
      const ordinary = operations.filter((entry) => entry.denominator === "ordinary");
      const requiredCorrectness = operations.filter((entry) => entry.kind === "timed_permission_probe" || entry.kind === "fault_observation");
      const hardFailure = requiredCorrectness.some((entry) => !entry.completed || !entry.correct);
      const report = deepFreeze({
        kind: "authority-capacity-run-accounting-v1",
        verdict: hardFailure ? "fail" : "pending-oracle-verification",
        run_started_monotonic_ms: runStartedAt,
        closed_monotonic_ms: now,
        planned_operations: operations.length,
        offered_operations: offered.size,
        completed_operations: completions.size,
        ordinary_offered: ordinary.filter((entry) => entry.offered).length,
        ordinary_total: ordinary.length,
        ordinary_unfinished: ordinary.filter((entry) => entry.ordinary_unfinished).length,
        required_correctness_total: requiredCorrectness.length,
        required_correctness_unfinished_or_incorrect: requiredCorrectness.filter((entry) => !entry.completed || !entry.correct).length,
        operations,
        note: "This accounting does not evaluate percentile and reliability gates or the independent oracle. Ordinary missing or incorrect work remains in its denominator with infinite latency; only mandatory correctness probes fail this preliminary accounting directly.",
      });
      return report;
    },

    async anchorRunClosure({ run_closure_digest: runClosureDigest } = {}) {
      assertPhase("closed");
      assertDigest(runClosureDigest, "run_closure_digest");
      requireRegistry("recordRunClosure");
      const receipt = await registry.recordRunClosure(deepFreeze({
        candidate_registration: candidate.registry_receipt,
        manifest_commitment: sealed.commitment_receipt,
        run_closure_digest: runClosureDigest,
      }));
      if (receipt === undefined || receipt === null || typeof receipt !== "object") fail("registry did not return a run closure receipt");
      await verifyExternalRegistration(deepFreeze({
        stage: "run-closure",
        candidate_registration: candidate.registry_receipt,
        manifest_commitment: sealed.commitment_receipt,
        run_closure_digest: runClosureDigest,
        receipt,
      }));
      sealed = deepFreeze({ ...sealed, run_closure_receipt: receipt });
      phase = "closure-anchored";
      return receipt;
    },

    async revealManifest() {
      assertPhase("closure-anchored");
      requireRegistry("revealManifest");
      const receipt = await registry.revealManifest(deepFreeze({
        candidate_registration: candidate.registry_receipt,
        manifest_digest: sealed.manifest_digest,
        commitment: sealed.commitment,
        salt: sealed.salt,
        manifest: sealed.manifest,
        run_closure: sealed.run_closure_receipt,
      }));
      if (receipt === undefined || receipt === null) fail("registry did not acknowledge manifest reveal");
      phase = "revealed";
      return deepFreeze({ manifest: sealed.manifest, manifest_digest: sealed.manifest_digest, commitment: sealed.commitment, reveal_receipt: receipt });
    },
  });
}

function readContract() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(resolve(here, "metrics.v1.json"), "utf8"));
}

function securePrivateFile(path, { create = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("sealed state path must be absolute");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) {
    fail("sealed state parent must be a real mode-0700 directory");
  }
  if (process.getuid && directory.uid !== process.getuid()) fail("sealed state parent must belong to the verifier user");
  if (create) return absolute;
  const state = lstatSync(absolute);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) fail("sealed state must be a real mode-0600 file");
  if (process.getuid && state.uid !== process.getuid()) fail("sealed state must belong to the verifier user");
  return absolute;
}

export function writeSealedRunState(path, state) {
  const target = securePrivateFile(path, { create: true });
  if (state?.kind !== SEALED_STATE_KIND) fail("only a sealed runner state may be persisted");
  const fd = openSync(target, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(state)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(target), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return target;
}

export function readSealedRunState(path, contract = readContract()) {
  const target = securePrivateFile(path);
  const state = JSON.parse(readFileSync(target, "utf8"));
  if (state?.kind !== SEALED_STATE_KIND || state.metric_contract_digest !== contract.profile_pin.sha256 || state.generator !== "authority-capacity-manifest-v1") {
    fail("sealed state does not match the pinned M1 runner format");
  }
  assertDigest(state.manifest_digest, "sealed state manifest_digest");
  assertDigest(state.commitment, "sealed state commitment");
  if (typeof state.salt !== "string" || !CANDIDATE_DIGEST.test(state.salt)) fail("sealed state salt is invalid");
  const manifest = validateSealedManifest(state.manifest, contract, { milestoneId: "M1", qualification: true });
  if (manifest.milestone !== "M1" || sha256(canonicalJson(manifest)) !== state.manifest_digest || sha256(`${state.manifest_digest}:${state.salt}`) !== state.commitment) {
    fail("sealed state manifest or commitment does not verify");
  }
  return deepFreeze(state);
}

/**
 * The only preparation path exposed by the orchestration layer uses the
 * pinned generator. Callers cannot inject a simpler fixture manifest here.
 */
export async function preparePinnedM1Qualification({ registry, contract = loadCapacityContract(), candidate, randomBytes = nodeRandomBytes } = {}) {
  const lifecycle = createQualificationLifecycle({ contract, registry, externalRegistry: registry, randomBytes });
  await lifecycle.registerCandidate(candidate);
  const seal = await lifecycle.sealManifest((registeredCandidate, sealingMaterial) => generateM1Manifest({ candidate: registeredCandidate, sealing_material: sealingMaterial, contract }));
  const state = lifecycle.exportSealedState();
  return deepFreeze({
    kind: "authority-capacity-m1-preparation-v1",
    verdict: "not-run",
    candidate_registration: state.candidate.registry_receipt,
    manifest_digest: seal.manifest_digest,
    commitment: seal.commitment,
    commitment_receipt: seal.commitment_receipt,
    state,
    diagnostics: plannedWaitDiagnostics(state.manifest),
    remaining_prerequisites: [
      "verified reference environment lock and isolation attestation",
      "real Authority candidate with production-client fixture transport and durable nonce/audit binding",
      "independent record/index/oracle and provider-effect observations",
      "whole-cgroup crash, storage-fault, final-drain and repository-check evidence",
      "external run-closure digest before manifest reveal and grading",
    ],
  });
}

export async function revealPinnedM1Qualification({ registry, contract = loadCapacityContract(), state, runClosureDigest } = {}) {
  if (state?.kind !== SEALED_STATE_KIND) fail("pinned sealed state is required for reveal");
  const checked = readSealedStateValue(state, contract);
  assertDigest(runClosureDigest, "run_closure_digest");
  for (const name of ["recordRunClosure", "revealManifest", "verifyRegistration"]) {
    if (typeof registry?.[name] !== "function") fail(`anchored registry.${name} is required for reveal`);
  }
  const closure = await registry.recordRunClosure({
    candidate_registration: checked.candidate.registry_receipt,
    manifest_commitment: checked.manifest_commitment,
    run_closure_digest: runClosureDigest,
  });
  if (await registry.verifyRegistration({ stage: "run-closure", receipt: closure, run_closure_digest: runClosureDigest }) !== true) fail("external registry rejected run closure");
  const receipt = await registry.revealManifest({
    candidate_registration: checked.candidate.registry_receipt,
    manifest_digest: checked.manifest_digest,
    commitment: checked.commitment,
    salt: checked.salt,
    manifest: checked.manifest,
    run_closure: closure,
  });
  return deepFreeze({
    kind: "authority-capacity-m1-reveal-v1",
    verdict: "not-run",
    manifest_digest: checked.manifest_digest,
    commitment: checked.commitment,
    run_closure: closure,
    reveal_receipt: receipt,
    note: "A sealed manifest reveal proves ordering only. It is not a capacity result without the pinned environment, real integration, independent evidence, and grader verdict.",
  });
}

function readSealedStateValue(state, contract) {
  if (state?.kind !== SEALED_STATE_KIND || state.metric_contract_digest !== contract.profile_pin.sha256 || state.generator !== "authority-capacity-manifest-v1") fail("sealed state does not match the pinned M1 runner format");
  const manifest = validateSealedManifest(state.manifest, contract, { milestoneId: "M1", qualification: true });
  assertDigest(state.manifest_digest, "sealed state manifest_digest");
  assertDigest(state.commitment, "sealed state commitment");
  if (typeof state.salt !== "string" || !CANDIDATE_DIGEST.test(state.salt) || sha256(canonicalJson(manifest)) !== state.manifest_digest || sha256(`${state.manifest_digest}:${state.salt}`) !== state.commitment) fail("sealed state manifest or commitment does not verify");
  return deepFreeze(state);
}

function parseCli(argv) {
  if (argv.length === 0 || argv[0] === "--dry-run") {
    const milestoneIndex = argv.indexOf("--milestone");
    if (argv.length !== 1 && !(argv.length === 3 && milestoneIndex !== -1)) fail("usage: runner.mjs --dry-run [--milestone M1|M2|M3]");
    return { command: "dry-run", milestone: milestoneIndex === -1 ? "M1" : argv[milestoneIndex + 1] };
  }
  const [command, ...rest] = argv;
  if (["prepare-m1", "diagnostics", "reveal-m1"].includes(command)) return { command, options: parseOptions(rest) };
  fail("usage: runner.mjs --dry-run [--milestone M1|M2|M3] | prepare-m1|diagnostics|reveal-m1 <options>");
}

function parseOptions(argv) {
  if (argv.length % 2 !== 0) fail("options must be --name value pairs");
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined || options[name.slice(2)] !== undefined) fail("options must be unique --name value pairs");
    options[name.slice(2)] = value;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string") fail(`--${name} is required`);
  return value;
}

function anchoredRegistryFromOptions(options) {
  return createAnchoredRegistry({
    directory: requiredOption(options, "registry-dir"),
    anchorRoot: requiredOption(options, "anchor-dir"),
    environmentDigest: requiredOption(options, "environment-digest"),
    verifierDigest: requiredOption(options, "verifier-digest"),
  });
}

async function main(argv) {
  const command = parseCli(argv);
  const contract = loadCapacityContract();
  if (command.command === "dry-run") {
    process.stdout.write(`${JSON.stringify(diagnosticPlan(contract, command.milestone), null, 2)}\n`);
    return;
  }
  if (command.command === "prepare-m1") {
    const options = command.options;
    const result = await preparePinnedM1Qualification({
      registry: anchoredRegistryFromOptions(options),
      contract,
      candidate: {
        candidate_digest: requiredOption(options, "candidate-digest"),
        source_digest: requiredOption(options, "source-digest"),
        config_digest: requiredOption(options, "config-digest"),
        milestone: requiredOption(options, "milestone"),
      },
    });
    writeSealedRunState(requiredOption(options, "state-file"), result.state);
    const { state, ...publicResult } = result;
    process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
    return;
  }
  const state = readSealedRunState(requiredOption(command.options, "state-file"), contract);
  if (command.command === "diagnostics") {
    process.stdout.write(`${JSON.stringify({ kind: "authority-capacity-m1-diagnostics-v1", verdict: "not-run", manifest_digest: state.manifest_digest, commitment: state.commitment, diagnostics: plannedWaitDiagnostics(state.manifest), runtime_binding: state.manifest.runtime_binding, note: "No candidate, fixture, oracle, environment, or capacity result was run." }, null, 2)}\n`);
    return;
  }
  const result = await revealPinnedM1Qualification({ registry: anchoredRegistryFromOptions(command.options), contract, state, runClosureDigest: requiredOption(command.options, "run-closure-digest") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
