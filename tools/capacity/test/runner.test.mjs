import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQualificationLifecycle, validateSealedManifest } from "../runner.mjs";
import { fingerprintHost, preflightQualificationEnvironment } from "../environment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(resolve(here, "..", "metrics.v1.json"), "utf8"));
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

function deterministicBytes() {
  let value = 0;
  return (length) => Buffer.alloc(length, ++value);
}

function registry() {
  const calls = [];
  return {
    calls,
    async registerCandidate(value) { calls.push(["candidate", value]); return { id: "candidate-1" }; },
    async commitManifest(value) { calls.push(["commit", value]); return { id: "manifest-1" }; },
    async revealManifest(value) { calls.push(["reveal", value]); return { id: "reveal-1" }; },
  };
}

function ledger() {
  const offers = [];
  const completions = [];
  return {
    offers,
    completions,
    async appendOffer(value) { offers.push(value); return { sequence: offers.length }; },
    async appendCompletion(value) { completions.push(value); return { sequence: completions.length }; },
  };
}

function externalRegistry() {
  const checks = [];
  return {
    checks,
    async verifyRegistration(value) { checks.push(value); return true; },
  };
}

function manifest() {
  return {
    peak_start_ms: contract.workload.peak_start_window_ms[0],
    operations: [
      { id: "source", kind: "source_revision", population: "source", denominator: "ordinary", offset_ms: 0, internal: { source: "sealed" } },
      { id: "direct", kind: "direct_user_search", population: "direct_user_search", denominator: "ordinary", offset_ms: 10, internal: { peak: true } },
      { id: "availability", kind: "availability_probe", population: "availability_probe", denominator: "ordinary", offset_ms: 20 },
      { id: "answer", kind: "answer", population: "answer", denominator: "ordinary", offset_ms: 30 },
      { id: "deny", kind: "timed_permission_probe", population: "permission", denominator: "excluded", offset_ms: 40 },
      { id: "kill", kind: "fault_observation", population: "fault", denominator: "excluded", offset_ms: 50, fault: "candidate-cgroup-kill", verifier_only: { signal: "SIGKILL" } },
    ],
  };
}

function qualificationManifest() {
  const operations = manifest().operations;
  const add = (kind, population, count, prefix) => {
    const already = operations.filter((entry) => entry.kind === kind).length;
    for (let index = already; index < count; index += 1) {
      operations.push({
        id: `${prefix}-${index}`,
        kind,
        population,
        denominator: kind === "timed_permission_probe" ? "excluded" : "ordinary",
        offset_ms: 1000 + index,
      });
    }
  };
  const milestone = contract.milestones.find((entry) => entry.id === "M1");
  add("source_revision", "source", milestone.peak_day_meetings, "source");
  add("direct_user_search", "direct_user_search", milestone.peak_day_user_searches, "direct");
  add("availability_probe", "availability_probe", contract.workload.run_duration_ms / contract.workload.availability_probe_interval_ms, "availability");
  add("history_probe", "history_probe", milestone.history_probe_count + contract.workload.history_negative_probes_extra, "history");
  add("answer", "answer", milestone.peak_day_answers, "answer");
  add("timed_permission_probe", "permission", contract.correctness.timed_permission_cases, "deny");
  return { ...manifest(), operations };
}

async function preparedLifecycle() {
  const registryPort = registry();
  const ledgerPort = ledger();
  const lifecycle = createQualificationLifecycle({ contract, registry: registryPort, externalRegistry: externalRegistry(), ledger: ledgerPort, randomBytes: deterministicBytes(), monotonicNow: () => 0 });
  await lifecycle.registerCandidate({ candidate_digest: DIGEST, source_digest: OTHER_DIGEST, config_digest: "c".repeat(64), milestone: "M1" });
  await lifecycle.sealManifest(async () => qualificationManifest());
  return { lifecycle, registryPort, ledgerPort };
}

test("candidate registration happens before manifest generation and registry commitment", async () => {
  const registryPort = registry();
  const externalRegistryPort = externalRegistry();
  const lifecycle = createQualificationLifecycle({ contract, registry: registryPort, externalRegistry: externalRegistryPort, ledger: ledger(), randomBytes: deterministicBytes() });
  await assert.rejects(() => lifecycle.sealManifest(async () => manifest()), /lifecycle phase new/);
  await lifecycle.registerCandidate({ candidate_digest: DIGEST, source_digest: OTHER_DIGEST, config_digest: "c".repeat(64), milestone: "M1" });
  let generatedFor;
  await lifecycle.sealManifest(async (candidate) => {
    generatedFor = candidate.candidate_digest;
    return qualificationManifest();
  });
  assert.equal(generatedFor, DIGEST);
  assert.deepEqual(registryPort.calls.map(([name]) => name), ["candidate", "commit"]);
  assert.deepEqual(externalRegistryPort.checks.map((entry) => entry.stage), ["candidate-registration", "manifest-commitment"]);
});

test("a local registry receipt without independent verification cannot reach sealing", async () => {
  const lifecycle = createQualificationLifecycle({ contract, registry: registry(), ledger: ledger(), randomBytes: deterministicBytes() });
  await assert.rejects(
    () => lifecycle.registerCandidate({ candidate_digest: DIGEST, source_digest: OTHER_DIGEST, config_digest: "c".repeat(64), milestone: "M1" }),
    /externalRegistry\.verifyRegistration/,
  );
  assert.equal(lifecycle.phase, "new");
});

test("open-loop offers do not wait for completion and do not reveal verifier-only peak state", async () => {
  const { lifecycle, ledgerPort } = await preparedLifecycle();
  // A test-only qualifying preflight result is obtained through the public method below.
  const result = await lifecycle.preflight({
    observation: qualifyingObservation(),
    environmentLock: qualifyingLock(),
    candidateAttestation: qualifyingAttestation(),
    verifyEnvironmentLock: async () => true,
    verifyCandidateAttestation: async () => true,
  });
  assert.equal(result.qualifying, true);
  lifecycle.startTimedRun(100);
  const first = await lifecycle.offerDue(130);
  assert.deepEqual(first.map((entry) => entry.operation_id), ["source", "direct", "availability", "answer"]);
  assert.equal("peak_start_ms" in first[1].operation, false);
  assert.equal("internal" in first[1].operation, false);
  const second = await lifecycle.offerDue(160);
  assert.deepEqual(second.map((entry) => entry.operation_id), ["deny", "kill"]);
  assert.equal(ledgerPort.offers.length, 6);
});

test("missing and incorrect ordinary work stays in the denominator with infinite latency", async () => {
  const { lifecycle } = await preparedLifecycle();
  await lifecycle.preflight({
    observation: qualifyingObservation(), environmentLock: qualifyingLock(), candidateAttestation: qualifyingAttestation(),
    verifyEnvironmentLock: async () => true, verifyCandidateAttestation: async () => true,
  });
  lifecycle.startTimedRun(0);
  const offers = await lifecycle.offerDue(100);
  const direct = offers.find((entry) => entry.operation_id === "direct");
  const availability = offers.find((entry) => entry.operation_id === "availability");
  const denial = offers.find((entry) => entry.operation_id === "deny");
  const kill = offers.find((entry) => entry.operation_id === "kill");
  await lifecycle.recordCompletion({ operation_id: "direct", nonce: direct.nonce, completed_monotonic_ms: 100, correct: false, status: "wrong", response_digest: DIGEST, release_audit_digest: OTHER_DIGEST });
  const delayed = await lifecycle.recordCompletion({ operation_id: "availability", nonce: availability.nonce, completed_monotonic_ms: 150, correct: true, status: "ok", response_digest: DIGEST, release_audit_digest: OTHER_DIGEST });
  await lifecycle.recordCompletion({ operation_id: "deny", nonce: denial.nonce, completed_monotonic_ms: 150, correct: true, status: "denied", response_digest: DIGEST, release_audit_digest: OTHER_DIGEST });
  await lifecycle.recordCompletion({ operation_id: "kill", nonce: kill.nonce, completed_monotonic_ms: 150, correct: true, status: "recovered", response_digest: DIGEST, release_audit_digest: OTHER_DIGEST });
  assert.equal(delayed.latency_ms, 130, "scheduled time, rather than delayed offer emission, starts latency");
  assert.equal(delayed.response_after_offer_ms, 50);
  const end = contract.workload.run_duration_ms;
  const remaining = await lifecycle.offerDue(end);
  for (const offer of remaining.filter((entry) => entry.operation.kind === "timed_permission_probe")) {
    await lifecycle.recordCompletion({ operation_id: offer.operation_id, nonce: offer.nonce, completed_monotonic_ms: end, correct: true, status: "denied", response_digest: DIGEST, release_audit_digest: OTHER_DIGEST });
  }
  const report = lifecycle.closeTimedRun(end);
  assert.equal(report.verdict, "pending-oracle-verification");
  assert.equal(report.ordinary_total, 3216);
  assert.equal(report.ordinary_offered, 3216);
  assert.equal(report.ordinary_unfinished, 3214);
  assert.equal(report.operations.find((entry) => entry.operation_id === "direct").latency_ms, Infinity);
  assert.equal(report.operations.find((entry) => entry.operation_id === "answer").latency_ms, Infinity);
});

test("manifest validation rejects attempts to remove ordinary populations or hide the timed kill", () => {
  const noAnswer = manifest();
  noAnswer.operations = noAnswer.operations.filter((entry) => entry.kind !== "answer");
  assert.throws(() => validateSealedManifest(noAnswer, contract), /answer/);
  const noKill = manifest();
  noKill.operations = noKill.operations.filter((entry) => entry.fault !== "candidate-cgroup-kill");
  assert.throws(() => validateSealedManifest(noKill, contract), /kill/);
});

test("qualification manifests cannot omit the contract population counts", () => {
  const truncated = qualificationManifest();
  truncated.operations = truncated.operations.filter((entry) => entry.kind !== "history_probe");
  assert.throws(
    () => validateSealedManifest(truncated, contract, { milestoneId: "M1", qualification: true }),
    /history_probe/,
  );
});

function qualifyingObservation() {
  const base = {
    platform: "linux",
    arch: "x64",
    kernel: "6.8.0",
    machine: "machine",
    cpu_identity: "model name\t: test-cpu",
    memory_identity: "MemTotal:        8192 kB",
    state_path: "/mnt/state",
    mount: { fs_type: "ext4", source: "/dev/nvme1n1", mount_options: ["rw"] },
    cgroup_path: "/sys/fs/cgroup/candidate",
    cgroup: { cpu_max: "400000 100000", memory_max: "8589934592", process_count: 1 },
    state_device: "1:0",
    state_device_identity: "nvme1n1",
  };
  return { ...base, fingerprint: "test-host-fingerprint" };
}

function qualifyingLock() {
  return {
    kind: "authority-capacity-environment-lock-v1",
    profile_id: contract.reference_hardware.id,
    contract_digest: contract.profile_pin.sha256,
    instance_type: contract.reference_hardware.instance_type,
    region: contract.reference_hardware.region,
    architecture: "x86_64",
    state_filesystem: contract.reference_hardware.storage.filesystem,
    state_size_gib: contract.reference_hardware.storage.size_gib,
    state_iops: contract.reference_hardware.storage.iops,
    state_throughput_mib_per_second: contract.reference_hardware.storage.throughput_mib_per_second,
    state_block_device_identity: "nvme1n1",
    ami_id: "ami-0123456789abcdef0",
    host_fingerprint: "test-host-fingerprint",
    host_image_digest: DIGEST,
    verifier_identity: "independent-verifier",
    issued_at: "2026-09-05T00:00:00.000Z",
    candidate_cgroup_path: "/sys/fs/cgroup/candidate",
    candidate_cgroup_ancestor: "/sys/fs/cgroup",
  };
}

function qualifyingAttestation() {
  return {
    kind: "authority-capacity-candidate-environment-attestation-v1",
    candidate_digest: DIGEST,
    state_path: "/mnt/state",
    cgroup_path: "/sys/fs/cgroup/candidate",
    candidate_root_filesystem_readonly: true,
    candidate_durable_writes_only_under_state: true,
    all_candidate_children_in_resource_budget: true,
    driver_and_fixture_isolated: true,
    candidate_cannot_access_verifier_files: true,
    candidate_network_only_provider_interfaces: true,
    verifier_identity: "independent-verifier",
    ami_id: "ami-0123456789abcdef0",
    host_image_digest: DIGEST,
  };
}

test("Darwin and missing independent lock verifier are honest not-run outcomes", async () => {
  const report = await preflightQualificationEnvironment({
    contract,
    candidateDigest: DIGEST,
    observation: { ...qualifyingObservation(), platform: "darwin" },
    environmentLock: qualifyingLock(),
    candidateAttestation: qualifyingAttestation(),
  });
  assert.equal(report.verdict, "not-run");
  assert.equal(report.qualifying, false);
  assert.match(report.failures.join("\n"), /Linux/);
  assert.match(report.failures.join("\n"), /independent environment-lock verifier/);
});

test("environment fingerprint ignores volatile CPU, memory, and process telemetry", () => {
  const host = qualifyingObservation();
  const first = fingerprintHost({ ...host, volatile: { cpuinfo: "cpu MHz: 3200", meminfo: "MemAvailable: 1", cgroup_process_count: 2 } });
  const second = fingerprintHost({ ...host, volatile: { cpuinfo: "cpu MHz: 1800", meminfo: "MemAvailable: 2", cgroup_process_count: 99 } });
  assert.equal(first, second);
});
