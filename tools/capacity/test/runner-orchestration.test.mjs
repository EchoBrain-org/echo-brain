import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnchoredRegistry, readRegistry } from "../registry.mjs";
import { preparePinnedM1Qualification, readSealedRunState, revealPinnedM1Qualification, writeSealedRunState } from "../runner.mjs";

const candidate = Object.freeze({
  candidate_digest: "a".repeat(64),
  source_digest: "b".repeat(64),
  config_digest: "c".repeat(64),
  milestone: "M1",
});

function temp() { return realpathSync(mkdtempSync(join(tmpdir(), "capacity-runner-orchestration-"))); }

function anchoredRegistryForTest() {
  const directory = temp();
  const anchorRoot = temp();
  const proofs = new Map();
  const registry = createAnchoredRegistry({
    directory,
    anchorRoot,
    environmentDigest: "d".repeat(64),
    verifierDigest: "e".repeat(64),
    anchorTransport: async ({ digest, directory: anchorDirectory }) => {
      const proof = Object.freeze({ kind: "test-external-anchor-v1", digest, directory: anchorDirectory });
      proofs.set(digest, proof);
      return proof;
    },
    verifyAnchor: ({ digest, directory: anchorDirectory }) => {
      assert.deepEqual(proofs.get(digest), { kind: "test-external-anchor-v1", digest, directory: anchorDirectory });
      return true;
    },
  });
  return { registry, directory, proofs };
}

test("pinned M1 orchestration registers before generating, seals with external anchors, and remains not-run", async () => {
  const { registry, directory, proofs } = anchoredRegistryForTest();
  const preparation = await preparePinnedM1Qualification({ registry, candidate, randomBytes: (length) => Buffer.alloc(length, 7) });
  assert.equal(preparation.verdict, "not-run");
  assert.equal(preparation.state.generator, "authority-capacity-manifest-v1");
  assert.equal(preparation.state.manifest.runtime_binding.status, "integration-required-before-run");
  assert.equal(proofs.size, 2);
  assert.deepEqual(readRegistry(directory).map((entry) => entry.body.kind), ["candidate-registration", "manifest-commitment"]);
  assert.ok(preparation.diagnostics.every((entry) => Number.isInteger(entry.prescribed_wait_p95_ms)));
});

test("sealed state is private, self-verifying, and cannot be replaced by a custom fixture manifest", async () => {
  const { registry } = anchoredRegistryForTest();
  const preparation = await preparePinnedM1Qualification({ registry, candidate, randomBytes: (length) => Buffer.alloc(length, 9) });
  const statePath = join(temp(), "sealed.json");
  writeSealedRunState(statePath, preparation.state);
  const restored = readSealedRunState(statePath);
  assert.equal(restored.commitment, preparation.commitment);
  const replaced = structuredClone(restored);
  replaced.manifest.fixture_packet_templates = [];
  await assert.rejects(
    () => revealPinnedM1Qualification({ registry, state: replaced, runClosureDigest: "f".repeat(64) }),
    /manifest or commitment does not verify/,
  );
});

test("manifest reveal requires an anchored run closure and still makes no capacity claim", async () => {
  const { registry, directory, proofs } = anchoredRegistryForTest();
  const preparation = await preparePinnedM1Qualification({ registry, candidate, randomBytes: (length) => Buffer.alloc(length, 11) });
  const revealed = await revealPinnedM1Qualification({ registry, state: preparation.state, runClosureDigest: "f".repeat(64) });
  assert.equal(revealed.verdict, "not-run");
  assert.equal(proofs.size, 4);
  assert.deepEqual(readRegistry(directory).map((entry) => entry.body.kind), ["candidate-registration", "manifest-commitment", "run-closure", "manifest-reveal"]);
  await assert.rejects(
    () => revealPinnedM1Qualification({ registry, state: preparation.state, runClosureDigest: "f".repeat(64) }),
    /Run closure already recorded/,
  );
});
