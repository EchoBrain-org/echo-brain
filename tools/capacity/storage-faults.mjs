#!/usr/bin/env node

/**
 * Fail-closed planning and evidence validation for the V1 storage-fault gate.
 *
 * This deliberately never opens a device mapper target, mounts a device, kills
 * a process, or writes a block. The eventual host operator owns those actions.
 * A process kill and this modeled planner are not power-loss evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = /^[a-f0-9]{64}$/;
const EXPECTED_BOUNDARIES = Object.freeze([
  "acknowledged-approval-receipt",
  "acknowledged-v4-append",
  "committed-active-generation-pointer",
  "answer-audit-before-first-response-byte",
]);

function fail(message) { throw new Error(`storage faults: ${message}`); }
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}
function stringSet(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(value).size !== value.length) fail(`${label} must be a unique non-empty string array`);
  return value;
}
function equalStrings(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} differs from the V1 contract`);
}

/** Exact four V1 boundaries, plus the positive and negative model controls. */
export function storageFaultCases(contract) {
  const durability = object(contract?.durability, "contract.durability");
  equalStrings(stringSet(durability.storage_fault_boundaries, "storage_fault_boundaries"), EXPECTED_BOUNDARIES, "storage fault boundaries");
  if (durability.storage_fault_case_count_min !== EXPECTED_BOUNDARIES.length) fail("storage fault case count must be exactly four for V1");
  if (durability.storage_fault_model !== "independent-flush-aware-volatile-layer-discard; preserve-completed-flushes-and-drop-only-unflushed-data-and-metadata; restart-with-caches-gone") fail("storage fault model is not the accepted flush-aware V1 model");
  if (durability.positive_and_negative_fault_model_controls_required !== true) fail("both fault-model controls are required");
  if (durability.process_kill_proves_power_loss !== false || durability.dm_flakey_drop_writes_alone_sufficient !== false) fail("V1 rejects process-kill or dm-flakey-only power-loss claims");
  return Object.freeze([
    ...EXPECTED_BOUNDARIES.map((boundary) => Object.freeze({ kind: "storage-fault-case-v1", boundary, action: "discard-unflushed-data-and-metadata-then-cold-replay" })),
    Object.freeze({ kind: "storage-fault-control-v1", control: "synced-write-survival", expected: "survives-cold-replay" }),
    Object.freeze({ kind: "storage-fault-control-v1", control: "unsynced-write-loss", expected: "absent-after-cold-replay" }),
  ]);
}

/**
 * Validate independently collected write-log/cold-replay observations. This
 * accepts evidence only; it cannot itself collect evidence or make a PASS.
 */
export function validateAcknowledgementOracle(contract, evidence) {
  storageFaultCases(contract);
  const value = object(evidence, "storage fault evidence");
  if (value.kind !== "authority-capacity-storage-fault-cold-replay-evidence-v1") fail("unexpected storage fault evidence kind");
  if (value.independently_collected !== true) fail("cold replay evidence must be independently collected");
  if (value.flush_aware_observer !== "dm-log-writes") fail("evidence must identify dm-log-writes as the flush-aware observer");
  if (value.caches_gone_before_recovery !== true) fail("cold replay must occur with caches gone");
  if (typeof value.write_log_sha256 !== "string" || !DIGEST.test(value.write_log_sha256)) fail("write-log digest is required");
  if (!Array.isArray(value.controls) || value.controls.length !== 2) fail("both model controls are required");
  const controls = new Map(value.controls.map((control) => [control?.control, control]));
  if (controls.get("synced-write-survival")?.outcome !== "survived") fail("synced-write survival control did not survive");
  if (controls.get("unsynced-write-loss")?.outcome !== "lost") fail("unsynced-write loss control did not lose");
  if (!Array.isArray(value.cases) || value.cases.length !== EXPECTED_BOUNDARIES.length) fail("exactly four storage fault cases are required");
  equalStrings(value.cases.map((entry) => string(entry?.boundary, "case boundary")), EXPECTED_BOUNDARIES, "observed storage fault boundaries");
  for (const entry of value.cases) {
    const acknowledged = stringSet(entry.acknowledged_effect_ids, `${entry.boundary}.acknowledged_effect_ids`);
    const recovered = stringSet(entry.recovered_effect_ids, `${entry.boundary}.recovered_effect_ids`);
    const missing = acknowledged.filter((id) => !recovered.includes(id));
    if (missing.length !== 0) fail(`${entry.boundary} lost acknowledged durable effects: ${missing.join(",")}`);
    if (entry.duplicate_canonical_appends !== 0 || entry.invalid_generation_publications !== 0 || entry.unexpected_provider_effects !== 0) fail(`${entry.boundary} recovery invariants failed`);
  }
  return Object.freeze({
    kind: "authority-capacity-storage-fault-acknowledgement-oracle-v1",
    verdict: "evidence-valid-not-a-capacity-verdict",
    verified_boundaries: Object.freeze([...EXPECTED_BOUNDARIES]),
    acknowledged_durable_work_lost: 0,
  });
}

function flattenLsblk(nodes, parent = undefined, result = []) {
  for (const node of nodes ?? []) {
    if (node !== null && typeof node === "object") {
      result.push({ path: node.path, type: node.type, mountpoints: (node.mountpoints ?? []).filter((value) => typeof value === "string" && value.length > 0), parent });
      flattenLsblk(node.children, node.path, result);
    }
  }
  return result;
}

/** Reject the root device, a mounted device, and any device with mounted descendants. */
export function validateDedicatedDevice(device, lsblk) {
  string(device, "device");
  const entries = flattenLsblk(object(lsblk, "lsblk").blockdevices);
  const target = entries.find((entry) => entry.path === device);
  if (target === undefined) fail("dedicated device is not present in lsblk output");
  if (!new Set(["disk", "part"]).has(target.type)) fail("dedicated device must be a disk or partition, not a mapper/loop/virtual device");
  const descendants = new Set([device]);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of entries) if (entry.parent !== undefined && descendants.has(entry.parent) && !descendants.has(entry.path)) { descendants.add(entry.path); changed = true; }
  }
  const mounted = entries.filter((entry) => descendants.has(entry.path) && entry.mountpoints.length > 0);
  if (mounted.length !== 0) fail(`dedicated device or descendant is mounted: ${mounted.map((entry) => `${entry.path}:${entry.mountpoints.join(",")}`).join(";")}`);
  return Object.freeze({ device, type: target.type, inspected_paths: Object.freeze([...descendants].sort()) });
}

export function preflightStorageFaultHost({ platform = process.platform, exists = existsSync, exec = execFileSync, device, realpath = realpathSync } = {}) {
  const failures = [];
  if (platform !== "linux") failures.push("storage fault runner requires Linux");
  if (!exists("/sys/module/dm_log_writes")) failures.push("dm_log_writes kernel module is not already loaded");
  if (!exists("/dev/mapper/control")) failures.push("device-mapper control node is unavailable");
  let lsblk;
  try {
    const targets = String(exec("dmsetup", ["targets"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    if (!/^log-writes\s/m.test(targets)) failures.push("dmsetup does not advertise log-writes target");
    const requested = realpath(device);
    lsblk = JSON.parse(String(exec("lsblk", ["--json", "--output", "PATH,TYPE,MOUNTPOINTS"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
    validateDedicatedDevice(requested, lsblk);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({ kind: "authority-capacity-storage-fault-host-preflight-v1", verdict: "not-run", device, ready_for_operator_review: failures.length === 0, failures: Object.freeze(failures), note: "No device-mapper target was created and no block device was modified." });
}

export function storageFaultDryPlan({ contract, device, preflight } = {}) {
  string(device, "device");
  const checked = preflight ?? preflightStorageFaultHost({ device });
  return Object.freeze({
    kind: "authority-capacity-storage-fault-dry-plan-v1",
    verdict: "not-run",
    device,
    preflight: checked,
    cases: storageFaultCases(contract),
    required_evidence: "independently collected dm-log-writes write-log digest and cold-replay observations validated by validateAcknowledgementOracle",
    gap_requiring_host: "A dedicated Linux host must create and control the dm-log-writes stack, force cache-free recovery, and retain an independently collected write log. This planner cannot observe kernel flush completion or prove power loss.",
  });
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--dry-plan") fail("usage: storage-faults.mjs --dry-plan <dedicated-unmounted-block-device>");
  const here = dirname(fileURLToPath(import.meta.url));
  const contract = JSON.parse(readFileSync(resolve(here, "metrics.v1.json"), "utf8"));
  process.stdout.write(`${JSON.stringify(storageFaultDryPlan({ contract, device: argv[1] }), null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
