#!/usr/bin/env node

/**
 * Read-only preflight checks for a capacity qualification host.
 *
 * This module intentionally cannot make a host qualifying.  A verifier-owned
 * environment lock and a verifier-side attestation are required in addition
 * to the facts observable from the candidate host.  That keeps a developer
 * laptop useful for diagnostics while preventing it from being reported as a
 * V1 result.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
const REQUIRED_LOCK_KIND = "authority-capacity-environment-lock-v1";
const REQUIRED_ATTESTATION_KIND = "authority-capacity-candidate-environment-attestation-v1";

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readOptional(path, readFile = readFileSync) {
  try {
    return readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function decodeMountPath(value) {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

function pathWithin(path, parent) {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Parse Linux mountinfo without shelling out or trusting a PATH executable. */
export function parseMountInfo(contents) {
  if (typeof contents !== "string") throw new Error("mountinfo must be text");
  const mounts = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    if (before.length < 6 || after.length < 3) continue;
    mounts.push(Object.freeze({
      mount_id: before[0],
      device: before[2],
      root: decodeMountPath(before[3]),
      mount_point: decodeMountPath(before[4]),
      mount_options: before[5].split(","),
      fs_type: after[0],
      source: after[1],
      super_options: after[2].split(","),
    }));
  }
  return Object.freeze(mounts);
}

export function mountForPath(path, mounts) {
  const absolute = resolve(path);
  const candidates = mounts.filter((mount) => pathWithin(absolute, mount.mount_point));
  if (candidates.length === 0) return undefined;
  return candidates.sort((left, right) => right.mount_point.length - left.mount_point.length)[0];
}

export function parseCpuMax(value) {
  const [quota, period, ...extra] = String(value).trim().split(/\s+/);
  if (extra.length !== 0 || quota === undefined || period === undefined) return undefined;
  if (quota === "max") return Object.freeze({ quota: Infinity, period: Number(period), cpus: Infinity });
  const quotaNumber = Number(quota);
  const periodNumber = Number(period);
  if (!Number.isInteger(quotaNumber) || !Number.isInteger(periodNumber) || quotaNumber <= 0 || periodNumber <= 0) return undefined;
  return Object.freeze({ quota: quotaNumber, period: periodNumber, cpus: quotaNumber / periodNumber });
}

export function parseFiniteCgroupLimit(value) {
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const result = Number(trimmed);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function staticCpuIdentity(cpuinfo) {
  return String(cpuinfo ?? "").split("\n")
    .filter((line) => /^(?:vendor_id|model name|cpu family|model|stepping|flags|Features|CPU architecture)\s*:/.test(line))
    .sort()
    .join("\n");
}

function staticMemoryIdentity(meminfo) {
  return String(meminfo ?? "").split("\n").find((line) => /^MemTotal:\s+/.test(line)) ?? "";
}

function canonicalBlockDevice(source, realpath = realpathSync) {
  if (typeof source !== "string" || !source.startsWith("/dev/")) return undefined;
  try { return basename(realpath(source)); } catch { return basename(source); }
}

export function fingerprintHost(observation) {
  // Do not fingerprint uptime, CPU frequency, cached memory, process counts,
  // or other changing telemetry. A lock must survive normal observation.
  const stable = JSON.stringify({
    platform: observation.platform,
    arch: observation.arch,
    kernel: observation.kernel,
    machine: observation.machine,
    cpu_identity: observation.cpu_identity,
    memory_identity: observation.memory_identity,
    mount: observation.mount === undefined ? undefined : {
      fs_type: observation.mount.fs_type,
      source: observation.mount.source,
      mount_point: observation.mount.mount_point,
    },
    cgroup: observation.cgroup === undefined ? undefined : {
      cpu_max: observation.cgroup.cpu_max,
      memory_max: observation.cgroup.memory_max,
    },
    state_device_identity: observation.state_device_identity,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Collect only host-visible facts. Values may be injected by tests or a
 * verifier agent; this function does not make any cloud or metadata requests.
 */
export function collectHostObservation({ statePath, cgroupPath, platform = process.platform, arch = process.arch, readFile = readFileSync, realpath = realpathSync, stat = statSync } = {}) {
  const state = typeof statePath === "string" && isAbsolute(statePath) && existsSync(statePath)
    ? realpath(statePath)
    : undefined;
  const cgroup = typeof cgroupPath === "string" && isAbsolute(cgroupPath) ? resolve(cgroupPath) : undefined;
  const mounts = parseMountInfo(readOptional("/proc/self/mountinfo", readFile) ?? "");
  const mount = state === undefined ? undefined : mountForPath(state, mounts);
  const cgroupFiles = cgroup === undefined ? undefined : {
    cpu_max: readOptional(resolve(cgroup, "cpu.max"), readFile),
    memory_max: readOptional(resolve(cgroup, "memory.max"), readFile),
    cgroup_procs: readOptional(resolve(cgroup, "cgroup.procs"), readFile),
  };
  const stateDevice = state === undefined ? undefined : (() => {
    try {
      const details = stat(state);
      return `${details.dev}:${details.rdev}`;
    } catch {
      return undefined;
    }
  })();
  const cpuinfo = readOptional("/proc/cpuinfo", readFile);
  const meminfo = readOptional("/proc/meminfo", readFile);
  const observation = {
    platform,
    arch,
    kernel: readOptional("/proc/sys/kernel/osrelease", readFile)?.trim(),
    machine: readOptional("/etc/machine-id", readFile)?.trim(),
    cpu_identity: staticCpuIdentity(cpuinfo),
    memory_identity: staticMemoryIdentity(meminfo),
    state_path: state,
    mount,
    cgroup_path: cgroup,
    cgroup: cgroupFiles === undefined ? undefined : {
      cpu_max: cgroupFiles.cpu_max,
      memory_max: cgroupFiles.memory_max,
      process_count: cgroupFiles.cgroup_procs?.trim().split("\n").filter(Boolean).length,
    },
    state_device: stateDevice,
    state_device_identity: canonicalBlockDevice(mount?.source, realpath),
    volatile: {
      cpuinfo,
      meminfo,
      cgroup_process_count: cgroupFiles?.cgroup_procs?.trim().split("\n").filter(Boolean).length,
    },
  };
  return Object.freeze({ ...observation, fingerprint: fingerprintHost(observation) });
}

export function validateEnvironmentLock(lock, contract) {
  const value = object(lock, "environment lock");
  if (value.kind !== REQUIRED_LOCK_KIND) throw new Error(`environment lock.kind must be ${REQUIRED_LOCK_KIND}`);
  if (value.profile_id !== contract.reference_hardware.id) throw new Error("environment lock profile does not match the metric contract");
  if (value.contract_digest !== contract.profile_pin.sha256) throw new Error("environment lock contract digest does not match the metric contract");
  if (value.instance_type !== contract.reference_hardware.instance_type) throw new Error("environment lock instance type does not match the metric contract");
  if (value.region !== contract.reference_hardware.region) throw new Error("environment lock region does not match the metric contract");
  if (value.architecture !== "x86_64") throw new Error("environment lock architecture must be x86_64");
  if (value.state_filesystem !== contract.reference_hardware.storage.filesystem) throw new Error("environment lock state filesystem does not match the metric contract");
  if (value.state_size_gib !== contract.reference_hardware.storage.size_gib) throw new Error("environment lock state volume size does not match the metric contract");
  if (value.state_iops !== contract.reference_hardware.storage.iops) throw new Error("environment lock state volume IOPS do not match the metric contract");
  if (value.state_throughput_mib_per_second !== contract.reference_hardware.storage.throughput_mib_per_second) throw new Error("environment lock state volume throughput does not match the metric contract");
  text(value.state_block_device_identity, "environment lock.state_block_device_identity");
  if (!/^ami-[0-9a-f]{8,17}$/.test(value.ami_id ?? "")) throw new Error("environment lock.ami_id must be an exact AMI ID");
  if (!/^[a-f0-9]{64}$/.test(value.host_image_digest ?? "")) throw new Error("environment lock.host_image_digest must be a SHA-256 digest");
  text(value.host_fingerprint, "environment lock.host_fingerprint");
  text(value.verifier_identity, "environment lock.verifier_identity");
  if (!Number.isFinite(Date.parse(text(value.issued_at, "environment lock.issued_at")))) throw new Error("environment lock.issued_at must be an ISO timestamp");
  if (!isAbsolute(text(value.candidate_cgroup_path, "environment lock.candidate_cgroup_path"))) throw new Error("environment lock.candidate_cgroup_path must be absolute");
  if (!isAbsolute(text(value.candidate_cgroup_ancestor, "environment lock.candidate_cgroup_ancestor"))) throw new Error("environment lock.candidate_cgroup_ancestor must be absolute");
  return Object.freeze(value);
}

export function validateCandidateAttestation(attestation, { candidateDigest, statePath, cgroupPath } = {}) {
  const value = object(attestation, "candidate environment attestation");
  if (value.kind !== REQUIRED_ATTESTATION_KIND) throw new Error(`candidate environment attestation.kind must be ${REQUIRED_ATTESTATION_KIND}`);
  if (candidateDigest !== undefined && value.candidate_digest !== candidateDigest) throw new Error("candidate environment attestation digest does not match the registered candidate");
  if (statePath !== undefined && resolve(value.state_path) !== resolve(statePath)) throw new Error("candidate environment attestation state path does not match preflight state path");
  if (cgroupPath !== undefined && resolve(value.cgroup_path) !== resolve(cgroupPath)) throw new Error("candidate environment attestation cgroup path does not match preflight cgroup path");
  if (!/^ami-[0-9a-f]{8,17}$/.test(value.ami_id ?? "")) throw new Error("candidate environment attestation.ami_id must be an exact AMI ID");
  if (!/^[a-f0-9]{64}$/.test(value.host_image_digest ?? "")) throw new Error("candidate environment attestation.host_image_digest must be a SHA-256 digest");
  for (const name of ["candidate_root_filesystem_readonly", "candidate_durable_writes_only_under_state", "all_candidate_children_in_resource_budget", "driver_and_fixture_isolated", "candidate_cannot_access_verifier_files", "candidate_network_only_provider_interfaces"]) {
    if (value[name] !== true) throw new Error(`candidate environment attestation ${name} must be true`);
  }
  text(value.verifier_identity, "candidate environment attestation.verifier_identity");
  return Object.freeze(value);
}

function addFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

/**
 * The return value is deliberately a verdict-shaped object. A local Darwin
 * developer run is NOT-RUN, never a partial PASS or a comparable benchmark.
 */
export async function preflightQualificationEnvironment({ contract, candidateDigest, statePath, cgroupPath, environmentLock, candidateAttestation, verifyEnvironmentLock, verifyCandidateAttestation, observation = collectHostObservation({ statePath, cgroupPath }) } = {}) {
  const failures = [];
  if (contract === undefined) throw new Error("metric contract is required");
  const hardware = contract.reference_hardware;
  addFailure(failures, observation.platform === "linux", `reference qualification requires Linux; observed ${observation.platform}`);
  addFailure(failures, observation.arch === "x64", `reference qualification requires x86_64; observed ${observation.arch}`);
  addFailure(failures, observation.state_path !== undefined, "state path must exist before qualification preflight");
  addFailure(failures, observation.mount?.fs_type === hardware.storage.filesystem, `state must be on ${hardware.storage.filesystem}; observed ${observation.mount?.fs_type ?? "no mount"}`);
  addFailure(failures, observation.mount?.source.startsWith("/dev/"), "state mount must be a named block-device mount, not a virtual filesystem");
  addFailure(failures, observation.mount?.mount_options.includes("rw"), "state mount must be writable");
  addFailure(failures, !["tmpfs", "ramfs", "overlay"].includes(observation.mount?.fs_type), "state may not use tmpfs, ramfs, or overlay storage");
  addFailure(failures, observation.cgroup_path !== undefined, "candidate cgroup path is required");
  addFailure(failures, observation.cgroup_path !== "/sys/fs/cgroup", "candidate cgroup must be a dedicated non-root cgroup");
  const cpu = parseCpuMax(observation.cgroup?.cpu_max ?? "");
  const memory = parseFiniteCgroupLimit(observation.cgroup?.memory_max ?? "");
  addFailure(failures, cpu !== undefined && Number.isFinite(cpu.cpus) && Math.abs(cpu.cpus - hardware.total_candidate_vcpu_limit) < 1e-9, `candidate cpu.max must enforce exactly ${hardware.total_candidate_vcpu_limit} vCPUs`);
  addFailure(failures, memory === hardware.total_candidate_memory_limit_bytes, `candidate memory.max must enforce exactly ${hardware.total_candidate_memory_limit_bytes} bytes`);
  addFailure(failures, observation.cgroup?.process_count !== undefined, "candidate cgroup must expose cgroup.procs");

  let lock;
  try {
    lock = validateEnvironmentLock(environmentLock, contract);
    addFailure(failures, lock.host_fingerprint === observation.fingerprint, "environment lock does not match the observed host fingerprint");
    addFailure(failures, lock.state_block_device_identity === observation.state_device_identity, "environment lock block-device identity does not match the observed state mount");
    addFailure(failures, resolve(lock.candidate_cgroup_path) === observation.cgroup_path, "environment lock cgroup path does not match the observed candidate cgroup");
    addFailure(failures, pathWithin(observation.cgroup_path ?? "", resolve(lock.candidate_cgroup_ancestor)) && observation.cgroup_path !== resolve(lock.candidate_cgroup_ancestor), "candidate cgroup must be a child of the locked cgroup ancestor");
    if (typeof verifyEnvironmentLock !== "function") {
      failures.push("no independent environment-lock verifier was supplied");
    } else if (await verifyEnvironmentLock(lock) !== true) {
      failures.push("independent environment-lock verification failed");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const attestation = validateCandidateAttestation(candidateAttestation, { candidateDigest, statePath, cgroupPath });
    addFailure(failures, attestation.ami_id === lock?.ami_id, "candidate environment attestation AMI does not match the locked AMI");
    addFailure(failures, attestation.host_image_digest === lock?.host_image_digest, "candidate environment attestation image digest does not match the locked image");
    if (typeof verifyCandidateAttestation !== "function") {
      failures.push("no independent candidate-environment attestation verifier was supplied");
    } else if (await verifyCandidateAttestation(attestation) !== true) {
      failures.push("independent candidate-environment attestation verification failed");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return Object.freeze({
    kind: "authority-capacity-environment-preflight-v1",
    verdict: failures.length === 0 ? "ready" : "not-run",
    qualifying: failures.length === 0,
    observed_fingerprint: observation.fingerprint,
    observation,
    failures: Object.freeze(failures),
    note: failures.length === 0
      ? "Environment evidence is present; the runner still requires sealed registry and oracle prerequisites."
      : "This result is diagnostic only. It cannot be used as a capacity claim.",
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(argv) {
  const stateFlag = argv.indexOf("--state");
  const cgroupFlag = argv.indexOf("--cgroup");
  if (argv[0] !== "--preflight" || stateFlag === -1 || cgroupFlag === -1 || argv.length !== 5) {
    throw new Error("usage: environment.mjs --preflight --state <absolute-state-path> --cgroup <absolute-cgroup-path>");
  }
  const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const contract = readJson(resolve(here, "metrics.v1.json"));
  const statePath = argv[stateFlag + 1];
  const cgroupPath = argv[cgroupFlag + 1];
  const report = await preflightQualificationEnvironment({ contract, statePath, cgroupPath });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
