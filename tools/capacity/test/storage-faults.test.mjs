import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightStorageFaultHost,
  storageFaultCases,
  storageFaultDryPlan,
  validateAcknowledgementOracle,
  validateDedicatedDevice,
} from "../storage-faults.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(resolve(here, "..", "metrics.v1.json"), "utf8"));
const boundaries = contract.durability.storage_fault_boundaries;

function evidence() {
  return {
    kind: "authority-capacity-storage-fault-cold-replay-evidence-v1",
    independently_collected: true,
    flush_aware_observer: "dm-log-writes",
    caches_gone_before_recovery: true,
    write_log_sha256: "a".repeat(64),
    controls: [
      { control: "synced-write-survival", outcome: "survived" },
      { control: "unsynced-write-loss", outcome: "lost" },
    ],
    cases: boundaries.map((boundary, index) => ({
      boundary,
      acknowledged_effect_ids: [`ack-${index}`],
      recovered_effect_ids: [`ack-${index}`],
      duplicate_canonical_appends: 0,
      invalid_generation_publications: 0,
      unexpected_provider_effects: 0,
    })),
  };
}

test("storage planner requires the exact four V1 boundaries and both controls", () => {
  const cases = storageFaultCases(contract);
  assert.deepEqual(cases.slice(0, 4).map((entry) => entry.boundary), boundaries);
  assert.deepEqual(cases.slice(4).map((entry) => entry.control), ["synced-write-survival", "unsynced-write-loss"]);
  const changed = structuredClone(contract);
  changed.durability.storage_fault_boundaries.pop();
  assert.throws(() => storageFaultCases(changed), /differs from the V1 contract/);
});

test("acknowledgement oracle requires independent write-log cold replay evidence", () => {
  const result = validateAcknowledgementOracle(contract, evidence());
  assert.equal(result.verdict, "evidence-valid-not-a-capacity-verdict");
  const lost = evidence();
  lost.cases[1].recovered_effect_ids = [];
  assert.throws(() => validateAcknowledgementOracle(contract, lost), /lost acknowledged durable effects/);
  const local = evidence();
  local.independently_collected = false;
  assert.throws(() => validateAcknowledgementOracle(contract, local), /independently collected/);
});

test("dedicated-device inspection rejects mounted and root-bearing descendants", () => {
  const safe = { blockdevices: [{ path: "/dev/vdb", type: "disk", mountpoints: [], children: [{ path: "/dev/vdb1", type: "part", mountpoints: [] }] }] };
  assert.equal(validateDedicatedDevice("/dev/vdb", safe).device, "/dev/vdb");
  const root = structuredClone(safe);
  root.blockdevices[0].children[0].mountpoints = ["/"];
  assert.throws(() => validateDedicatedDevice("/dev/vdb", root), /mounted/);
});

test("host preflight is read-only, fail-closed, and dry plan cannot become a run", () => {
  const report = preflightStorageFaultHost({
    platform: "linux",
    device: "/dev/vdb",
    exists: (path) => ["/sys/module/dm_log_writes", "/dev/mapper/control"].includes(path),
    realpath: (path) => path,
    exec: (command) => command === "dmsetup"
      ? "log-writes v1.0.0\n"
      : JSON.stringify({ blockdevices: [{ path: "/dev/vdb", type: "disk", mountpoints: [] }] }),
  });
  assert.equal(report.verdict, "not-run");
  assert.equal(report.ready_for_operator_review, true);
  const plan = storageFaultDryPlan({ contract, device: "/dev/vdb", preflight: report });
  assert.equal(plan.verdict, "not-run");
  assert.match(plan.gap_requiring_host, /kernel flush/);
  const unsupported = preflightStorageFaultHost({ platform: "darwin", device: "/dev/vdb", exists: () => false, exec: () => "", realpath: (path) => path });
  assert.equal(unsupported.ready_for_operator_review, false);
  assert.match(unsupported.failures.join("\n"), /requires Linux/);
});
